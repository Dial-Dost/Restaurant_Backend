// Status - Bill
//   1. bill verification
//   2. paid
//   3. cancelled

// Bill workflow metadata (stored on Bills)
//   payment_method
//   waiter_confirmed_at / waiter_confirmed_by_username
//   admin_approved_at / admin_approved_by_username
//   closed_at / closed_by_username

// Status - order
//   1. preparing
//   2. served
//   3. bill verification
//   4. paid
//   5. cancelled
//   6. payment pending approval
//   7. closed

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { hashPassword, verifyPassword, isHashedPassword } from "./auth/password.js";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import sharp from "sharp";
import { downloadFile } from "./storage_bucket_supabase.js";
import { signTable, encodeTableToken } from "./qr_signing.js";
import {
  round2,
  computeBillTaxes,
  computeBillCharges,
  computeCouponDiscount,
  computeBillSplit,
  type BillTaxLine,
  type BillDiscount,
} from "./billing_math.js";
// Re-exported so existing importers of these from "./database_supabase.js" keep working.
export { round2, computeBillTaxes, computeBillCharges, computeCouponDiscount, computeBillSplit } from "./billing_math.js";
export type { BillTaxLine, BillDiscount } from "./billing_math.js";
import { logger } from "./observability.js";

export const CORE_ROLES = {
  admin: ["*"],
  employee: ["0a98cf2b-8b42-47a7-a523-b7bb73cb870e", "1f176202-d5e7-4bb0-802c-275a42425394", "3ec33182-ceb4-4d07-ac7e-84214adcf104"],
  valet: [
    "ae8ce7c0-1e06-4722-8a06-817267eec785",
    "6e9be65f-4081-4b86-8ba0-0592ee26f7f2",
    "2caeab74-5941-424d-9c3a-5c68ef0186e1",
    "2ff51c3d-f18c-406c-9f49-7c54f468c835",
    "892b50f3-51fc-4099-8f31-01e8dd8c3d44",
    "9e37297d-408b-446d-a51b-7892ad216b7d",
    "b8e02c25-b91c-427c-b462-8df009ede055",
    "5ef876a7-eb92-4602-b4d3-5590ce379540",
  ],
  cashier: ["9186e53e-0fda-4ec8-ad20-2f9feaadb77f", "2393edd7-cdd9-439c-9ff3-d563d5216967", "fc57d407-4bba-442c-97a2-9e6f3c57f288", "a953d044-31ba-4e31-b96f-99304fe43dfa", "4ad474d4-5230-449c-874f-6a238b833bca"],
  // Waiter: front-of-house — place & approve orders, manage tables, assign booking
  // tables, and VIEW the menu (f4177b38…) so they can actually take orders.
  waiter: ["4ad474d4-5230-449c-874f-6a238b833bca", "090ea8d4-e348-4e1b-9723-11131a73a085", "c7699d46-0e2f-4448-b325-8ca490a5296b", "b7f78d0f-323d-4622-8d05-aa2f82d54b2e", "f4177b38-77fa-4d8c-9fbd-c4f06bf28610"],
  captain: ["4ad474d4-5230-449c-874f-6a238b833bca", "9186e53e-0fda-4ec8-ad20-2f9feaadb77f", "c7699d46-0e2f-4448-b325-8ca490a5296b", "f4177b38-77fa-4d8c-9fbd-c4f06bf28610"],
  manager: ["faf2745b-580c-4529-bbe1-033200cbcf67", "daf1d71f-2b37-4cd1-b951-28fece7719cd"],
};

export enum Audit_log_category {
  General = "General",
  Bill = "Bill",
  Orders = "Orders",
  Valet = "Valet",
  Inventory = "Inventory",
  Tables = "Tables",
  Roles = "Roles",
  Customer = "Customer",
  Bookings = "Bookings",
  Menu = "Menu"
}

type CoreRoleKey = keyof typeof CORE_ROLES

const connectionString =
  process.env.SUPABASE_DIRECT_URL ??
  process.env.DATABASE_URL ??
  process.env.DIRECT_URL;

const ipv4FallbackString = process.env.SUPABASE_IPV4_URL;

if (!connectionString) {
  throw new Error(
    "SUPABASE_DIRECT_URL (or DATABASE_URL / DIRECT_URL) is required for Postgres access.",
  );
}

// Managed Postgres (Supabase/Railway) needs SSL; a local/CI Postgres (localhost)
// doesn't speak it. Use SSL only for remote hosts so the backend also runs against a
// local dev / integration-test DB. Override via sslmode=require / sslmode=disable.
function pgSslFor(cs: string | undefined): false | { rejectUnauthorized: boolean } {
  if (!cs) return false;
  if (/[?&]sslmode=require/i.test(cs)) return { rejectUnauthorized: false };
  if (/[?&]sslmode=disable/i.test(cs) || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(cs)) return false;
  return { rejectUnauthorized: false };
}

// Pool sizing is env-driven so the per-replica connection budget can be tuned to
// (db_max_connections - headroom) / replica_count. Defaults are conservative.
const POOL_MAX = Math.max(1, Number(process.env.PG_POOL_MAX) || 10);
const POOL_IDLE_TIMEOUT_MS = Math.max(0, Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000);
const POOL_CONN_TIMEOUT_MS = Math.max(0, Number(process.env.PG_CONNECTION_TIMEOUT_MS) || 10_000);

const pool = new Pool({
  connectionString,
  ssl: pgSslFor(connectionString),
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: POOL_CONN_TIMEOUT_MS,
});

const ipv4pool = new Pool({
  connectionString: ipv4FallbackString,
  ssl: pgSslFor(ipv4FallbackString),
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: POOL_CONN_TIMEOUT_MS,
});

// node-pg emits 'error' on idle clients when the backend drops them (DB restart,
// network blip, Supabase failover). Without a listener that error is an unhandled
// EventEmitter 'error' and terminates the process. Log and let the pool self-heal.
pool.on("error", (err) => {
  logger.error({ err: err?.message ?? err }, "[pg] idle client error on primary pool:");
});
ipv4pool.on("error", (err) => {
  logger.error({ err: err?.message ?? err }, "[pg] idle client error on ipv4 fallback pool:");
});

// The pool-level 'error' above only fires for clients sitting IDLE in the pool. A
// client that drops while CHECKED OUT (mid-request — flaky uplink, Supabase
// failover, laptop on a phone hotspot) emits 'error' on ITSELF, and with no
// listener that becomes an uncaughtException that exits the whole process. Attach
// exactly one error guard per physical connection at creation (the 'connect' event
// fires once per new client and the listener lives with that connection, so no
// per-checkout listener leak). pg evicts the broken client and the next request
// transparently opens a fresh one — the server rides through transient DB drops.
const attachCheckedOutClientGuard = (poolName: string) => (client: PoolClient) => {
  client.on("error", (err) => {
    logger.error({ err: err?.message ?? err }, `[pg] checked-out client error on ${poolName} pool (contained):`);
  });
};
pool.on("connect", attachCheckedOutClientGuard("primary"));
ipv4pool.on("connect", attachCheckedOutClientGuard("ipv4 fallback"));

// Graceful-shutdown hook: drain both pools so in-flight transactions can finish
// and sockets close cleanly when the platform sends SIGTERM (e.g. Railway deploys).
export async function closePools(): Promise<void> {
  await Promise.allSettled([pool.end(), ipv4pool.end()]);
}

let isipv4Fallback = false;

// --- Tenant context (multi-tenant isolation) ---------------------------------
// Every authenticated request runs inside withTenant(), which checks out one pg
// client, opens a transaction, sets the `app.*` GUCs that RLS policies read, and
// stashes the client in AsyncLocalStorage so all runQuery() calls made during
// that request automatically use the tenant-scoped connection.
export type TenantContext = {
	res_id: string;
	outlet_id: string;
	employeeId: string;
	role: string;
	// ALL-OUTLETS aggregate read mode (admins/managers only). When true, tenant
	// READ functions drop their `and outlet_id = $2` predicate so they span every
	// outlet of the res_id. The connection is still bound to a CONCRETE default
	// outlet (outlet_id above), so app.outlet_id is a real value; RLS keys only on
	// res_id, so this stays within the tenant. WRITES are rejected while set (see
	// the write guard in index.ts requireAuth).
	allOutlets?: boolean;
};

type TenantStore = { client: PoolClient; ctx: TenantContext; txnDepth: number };
const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function currentTenant(): TenantContext | null {
	return tenantStorage.getStore()?.ctx ?? null;
}

// True when the ambient request is an admin/manager ALL-OUTLETS aggregate read.
// Read functions mirror how they read the bound outlet_id: a local
// `const og = isAllOutlets() ? "true" : "false";` is inlined into the outlet
// predicate as `and (${og} or <alias>outlet_id = $2)`, so the clause spans every
// outlet when true and stays pinned to the bound outlet otherwise. `og` is a
// server-derived literal (never user input), so inlining it is injection-safe
// and keeps every existing $-parameter position unchanged.
export function isAllOutlets(): boolean {
	return tenantStorage.getStore()?.ctx.allOutlets === true;
}

type RestaurantContext = {
  inputId: string;
  res_id: string;
  restaurant_slug: string;
  restaurant_name: string;
  restaurant_main_office_add: string | null;
  restaurant_logo_url: string | null;

  outlet_id: string;
};

// Reservation deposit held inside the booking's slot JSON. Lifecycle:
// pending (Razorpay order created, unpaid) -> paid (signature verified) ->
// refund_due (cancelled outside the cancel window; refunded MANUALLY from the
// restaurant's Razorpay dashboard) | forfeited (late cancel). No auto-refund
// call by design — refunds are a deliberate staff action.
export type BookingDeposit = {
  amount: number;
  status: "pending" | "paid" | "refund_due" | "forfeited";
  order_id?: string | null;
  payment_id?: string | null;
  paid_at?: string | null;
  resolved_at?: string | null;
};

type SlotPayload = {
  start: string;
  duration: number;
  source?: string | null;
  status?: string | null;
  from?: string | null;
  notes?: string | null;
  deposit?: BookingDeposit | null;
  // Informational minimum spend (₹) promised for this booking — shown to the
  // guest + staff; NOT enforced at billing.
  min_spend?: number | null;
  // Set once the automated booking reminder has been sent (dedupe across the
  // 30-min sweep). Rides the slot JSON like deposit/min_spend, so every slot
  // read-modify-write path MUST round-trip it (encodeSlot/decodeSlot do).
  reminder_sent?: boolean | null;
};

type RestaurantUser = {
  id: string,
  res_id: string,
  outlet_id: string,
  employee_id: string,
  employee_Username: string,
  emp_Fname: string,
  emp_Lname?: string | null,
  // name: string;
  password: string;
  role: "admin" | "employee" | "valet" | "waiter" | "cashier" | "captain" | "manager";
  role_all?: string[];
  // True for the restaurant owner (the first admin created at registration). The
  // superadmin is shown with a crown and cannot be removed/demoted by others.
  is_superadmin?: boolean;
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
  nps?: number | null; // optional 0–10 "would you recommend us?" answer
};

export type FeedbackEntry = {
  id: string;
  restaurant_id: string;
  employeeId: string; // uuid of Employees.id
  employeeUsername: string; // login username
  name: string;
  role: "admin" | "employee" | "valet" | "waiter" | "cashier" | "captain" | "manager";
  role_all: string[];
  restaurantId: string;
  restaurantName: string;
  res_id: string;
  outlet_id: string;
  emp_Fname: string | null;
  emp_Lname: string | null;
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
  deposit?: BookingDeposit | null;
  min_spend?: number | null;
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
  // Valet ops depth (lazy columns; see ensureValetOpsColumns).
  parking_location: string | null;
  key_holder: string | null;
  key_updated_at: string | null;
  condition_notes: string | null;
  condition_photo_url: string | null;
  eta_minutes: number | null;
  requested_at: string | null;
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
  category: string;
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
  expiry_date: string | null; // "YYYY-MM-DD" when set
};

export type MenuItemRecord = {
  id: string;
  name: string;
  price: number;
  category: string;
  image_url?: string | null;
  available?: boolean;
  modifiers?: MenuModifierGroup[];
  recipe?: RecipeItem[];
  // Prep station that cooks this dish (KOT routing), e.g. "tandoor" / "grill" /
  // "bar". Free-form text; null/absent = unassigned.
  station?: string | null;
  // Allergen tags shown on the public QR menu, e.g. ["gluten", "nuts"].
  // Free-form strings (the UI offers a fixed suggestion set); [] / absent = none.
  allergens?: string[];
};

export type OrderItemRecord = {
  id: string;
  name: string;
  quantity: number;
  price: number;
  orderedAt: string;
  note?: string | null;
  // Prep station (KOT routing) — enriched at read time from the menu item.
  station?: string | null;
  // Course hold-and-fire: a held item waits (dimmed on KDS, timer not started)
  // until it is fired; firing stamps fired_at and clears the hold.
  course_hold?: boolean;
  fired_at?: string | null;
};

export type OrderRecord = {
  id: string;
  table: string;
  customer: string;
  note?: string | null;
  order_type?: string;
  customer_phone?: string | null;
  delivery_address?: string | null;
  taken_by_employee_id?: string | null;
  taken_by_employee_name?: string | null;
  taken_by_employee_role?: string | null;
  items: OrderItemRecord[];
  subtotal: number;
  serviceChargePercentage?: number;
  taxes?: Array<{ id: string; name: string; percentage: number }>;
  applyServiceCharge: boolean;
  total: number;
  status:
  | "Pending"
  | "Preparing"
  | "Served"
  | "Bill Verification"
  | "Payment Pending Approval"
  | "Paid"
  | "Closed"
  | "Cancelled";
  // "Barked" step: when the expo announced (barked) the order to the kitchen.
  // Null = awaiting bark (prep timers idle); pre-feature rows are backfilled.
  barked_at?: string | null;
  payment_method?: PaymentMethod | null;
  payment_proof_screenshot_url?: string | null;
  payment_waiter_confirmed_at?: string | null;
  payment_waiter_confirmed_by?: string | null;
  payment_admin_approved_at?: string | null;
  payment_admin_approved_by?: string | null;
  bill_closed_at?: string | null;
  bill_closed_by?: string | null;
  bill_id?: string | null;
};

export type PaymentMethod =
  | "Upi"       // 1
  | "Cash"      // 2
  | "Card"      // 3
  | "Dineout"   // 4 (screenshot)
  | "Zomato"    // 5 (screenshot)
  | "Eazydiner" // 6 (screenshot)
  | "District"  // 7 (screenshot)
  | "Razorpay"  // online (auto-verified)
  | "Split";    // split tender — real modes live in Bills.payment_splits

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
  period: "day" | "week" | "month";
  period_start: string;
  period_end: string;
  monthly_apc: number;
  total_revenue: number;
  total_covers: number;
  yellow_band_percent: number;
  orders: OrderApcInsight[];
  employee_incentives: EmployeeApcIncentive[];
};

type ApcInsightOptions = {
  period?: "day" | "week" | "month";
  periodStart?: Date;
  employeeId?: string;
};

export type RestaurantProfileRecord = {
  res_id: string;
  restaurant_username: string;
  restaurant_main_office_add: string | null;
  restaurant_logo_url: string | null;

  outlet_id: string;
  outlet_name: string;

  restaurant_name: string;
  outlet_add: string;
  outlet_phone: string;
  email: string;
  outlet_hours: string;
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

// --- Timezone-aware wall-clock parsing --------------------------------------
// Reservation times are entered as WALL-CLOCK date+time in the restaurant's
// local zone. Parsing them with `new Date("YYYY-MM-DDTHH:mm")` interprets them
// in the SERVER's zone — correct on an IST dev box but 5.5h off on a UTC prod
// server. These helpers convert a wall-clock time in a named IANA zone to the
// correct UTC instant, library-free and DST-safe.

// Validate an IANA zone id; fall back to Asia/Kolkata for empty/invalid input.
export function sanitizeTimezone(raw: unknown): string {
  const tz = typeof raw === "string" ? raw.trim() : "";
  if (!tz) return "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Kolkata";
  }
}

// Interpret Y-M-D h:mi as wall-clock time in `tz` and return the UTC instant.
export function zonedWallToUtc(Y: number, M: number, D: number, h: number, mi: number, tz: string): Date {
  const utc = Date.UTC(Y, M - 1, D, h, mi);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = new Map<string, string>(dtf.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  const g = (t: string) => Number(p.get(t) ?? 0);
  const asUTC = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  const off = asUTC - utc;
  return new Date(utc - off);
}

// Parse a reservation date string. A BARE wall-clock string (YYYY-MM-DDTHH:mm
// with optional seconds and NO timezone designator) is interpreted in `tz`; a
// string that already carries a zone (…Z or ±HH:mm offset) is an absolute
// instant and is left untouched.
export function parseWallClockInZone(value: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(
    String(value ?? "").trim(),
  );
  if (!m) return new Date(value);
  return zonedWallToUtc(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    sanitizeTimezone(tz),
  );
}

// A booking in one of these slot states no longer holds its table and is no
// longer an "active" reservation: cancelled (kept as a row for its deposit
// record), completed, seated/arrived (the party arrived — the table is tracked
// separately via is_occupied), or a no-show. Substring match tolerates mixed
// case and legacy labels. Shared by the floor-grid reserved/booked filter and
// the get-bookings `active` flag so both agree on what "still holds a table" means.
export function isTerminalBookingStatus(status: unknown): boolean {
  const s = String(status ?? "").toLowerCase();
  return ["cancel", "complet", "seated", "arrived", "no show", "no_show", "noshow", "done"].some((t) =>
    s.includes(t),
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
  if (role === "admin" || role === "employee" || role === "valet" || role === "waiter" || role === "cashier" || role === "captain" || role === "manager") {
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
  // primary should always be a core role name (admin/employee/valet/waiter)
  let primaryRaw = String(parsed?.primary ?? "employee").trim();
  if (isUuid(primaryRaw)) {
    // legacy or invalid value: fall back to employee
    primaryRaw = "employee";
  } else {
    primaryRaw = primaryRaw.toLowerCase() || "employee";
  }

  const allRaw = Array.isArray(parsed?.all) ? parsed!.all.map((entry) => String(entry).trim()).filter(Boolean) : [];

  // Normalize entries: if an entry is a UUID, keep as-is (custom role id), otherwise lowercase core role name
  const normalizedAll = allRaw.map((entry) => (isUuid(entry) ? entry : entry.toLowerCase()));

  const all = Array.from(new Set([primaryRaw, ...normalizedAll]));
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

export type MenuModifierGroup = {
  name: string;
  multi: boolean;
  required: boolean;
  options: Array<{ name: string; price: number }>;
};

export type RecipeItem = { inventory_id: string; qty: number; note?: string };
// Recipe = inventory ingredients consumed per unit sold (for auto-deduction).
export function sanitizeRecipe(raw: unknown): RecipeItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeItem[] = [];
  for (const r of raw) {
    const ing = (r ?? {}) as Record<string, unknown>;
    const inventory_id = typeof ing.inventory_id === "string" ? ing.inventory_id.trim() : "";
    const qty = parseNumeric(ing.qty);
    const note = typeof ing.note === "string" ? ing.note.trim().slice(0, 120) : "";
    if (inventory_id && qty > 0) out.push({ inventory_id, qty, ...(note ? { note } : {}) });
  }
  return out;
}

// Coerce arbitrary input into clean modifier groups (drops empties).
export function sanitizeModifiers(raw: unknown): MenuModifierGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: MenuModifierGroup[] = [];
  for (const g of raw) {
    const grp = (g ?? {}) as Record<string, unknown>;
    const name = typeof grp.name === "string" ? grp.name.trim() : "";
    if (!name) continue;
    const optsRaw = Array.isArray(grp.options) ? grp.options : [];
    const options = optsRaw
      .map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        return { name: typeof opt.name === "string" ? opt.name.trim() : "", price: parseNumeric(opt.price) };
      })
      .filter((o) => o.name.length > 0);
    if (options.length === 0) continue;
    groups.push({ name, multi: grp.multi === true, required: grp.required === true, options });
  }
  return groups;
}

// Coerce arbitrary input into clean allergen tags: trimmed, lowercased,
// deduped, capped in count and length. Free-form by design — the UI offers a
// fixed suggestion set (gluten/dairy/nuts/…) but any tag is allowed.
export function sanitizeAllergens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const a of raw) {
    const tag = typeof a === "string" ? a.trim().toLowerCase().slice(0, 24) : "";
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

function encodeMenuDescription(payload: { price: number; image_url?: string | null; available?: boolean; modifiers?: unknown; recipe?: unknown; station?: unknown; allergens?: unknown }): string {
  const out: Record<string, unknown> = { price: Number.isFinite(payload.price) ? payload.price : 0 };
  const img = typeof payload.image_url === "string" ? payload.image_url.trim() : "";
  if (img) out.image_url = img;
  if (payload.available === false) out.available = false; // default true (omit)
  const mods = sanitizeModifiers(payload.modifiers);
  if (mods.length > 0) out.modifiers = mods;
  const recipe = sanitizeRecipe(payload.recipe);
  if (recipe.length > 0) out.recipe = recipe;
  const station = typeof payload.station === "string" ? payload.station.trim().slice(0, 40) : "";
  if (station) out.station = station;
  const allergens = sanitizeAllergens(payload.allergens);
  if (allergens.length > 0) out.allergens = allergens;
  return JSON.stringify(out);
}

function parseMenuDescription(description: string | null): { price: number; image_url: string | null; available: boolean; modifiers: MenuModifierGroup[]; recipe: RecipeItem[]; station: string | null; allergens: string[] } {
  if (!description) return { price: 0, image_url: null, available: true, modifiers: [], recipe: [], station: null, allergens: [] };
  const parsed = parseJsonObject(description);
  if (!parsed) return { price: 0, image_url: null, available: true, modifiers: [], recipe: [], station: null, allergens: [] };
  const img = typeof parsed.image_url === "string" ? parsed.image_url : null;
  return {
    price: parseNumeric(parsed.price),
    image_url: img,
    available: parsed.available === false ? false : true,
    modifiers: sanitizeModifiers(parsed.modifiers),
    recipe: sanitizeRecipe(parsed.recipe),
    station: typeof parsed.station === "string" && parsed.station.trim() ? parsed.station.trim() : null,
    allergens: sanitizeAllergens(parsed.allergens),
  };
}

function toOrderStatusCode(status: string | undefined): number {
  const lowered = String(status ?? "preparing").trim().toLowerCase();
  if (lowered === "pending" || lowered === "awaiting approval" || lowered === "awaiting_approval") return 8;
  if (lowered === "cancelled" || lowered === "canceled") return 5;
  if (lowered === "closed") return 7;
  if (lowered === "paid") return 4;
  if (
    lowered === "payment pending approval"
    || lowered === "payment_pending_approval"
    || lowered === "pending approval"
    || lowered === "pending_approval"
  ) return 6;
  if (lowered === "bill verification" || lowered === "bill_verification" || lowered === "verification") return 3;
  if (lowered === "served") return 2;
  return 1; // Preparing
}

function fromOrderStatusCode(status: unknown): OrderRecord["status"] {
  const code = Math.round(parseNumeric(status));
  switch (code) {
    case 8:
      return "Pending";
    case 1:
      return "Preparing";
    case 2:
      return "Served";
    case 3:
      return "Bill Verification";
    case 6:
      return "Payment Pending Approval";
    case 4:
      return "Paid";
    case 7:
      return "Closed";
    case 5:
      return "Cancelled";
    default:
      return "Preparing";
  }
}

function normalizePaymentMethod(raw: unknown): PaymentMethod | null {
  const n = String(raw ?? "").trim().toLowerCase();
  if (!n) return null;
  if (n === "upi") return "Upi";
  if (n === "cash") return "Cash";
  if (n === "card") return "Card";
  if (n === "dineout" || n === "dine out") return "Dineout";
  if (n === "zomato" || n === "zomato pay" || n === "zomatopay") return "Zomato";
  if (n === "eazydiner" || n === "easydiner" || n === "easy diner") return "Eazydiner";
  if (n === "district") return "District";
  if (n === "razorpay") return "Razorpay";
  if (n === "split") return "Split";
  return null;
}

// Alternate / third-party methods (4-7) that require a payment-proof screenshot.
const PROOF_REQUIRED_METHODS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>([
  "Dineout",
  "Zomato",
  "Eazydiner",
  "District",
]);

function paymentRequiresProof(method: PaymentMethod | null): boolean {
  return method !== null && PROOF_REQUIRED_METHODS.has(method);
}

function encodeSlot(payload: SlotPayload): string {
  return JSON.stringify({
    start: payload.start,
    duration: Math.max(1, Math.round(payload.duration)),
    source: payload.source ?? null,
    status: payload.status ?? null,
    from: payload.from ?? null,
    notes: payload.notes ?? null,
    // Deposit + min-spend + reminder flag ride in the slot JSON; every slot
    // read-modify-write path goes through decode/encode, so they MUST
    // round-trip here or a mere status change would silently wipe a paid
    // deposit (or re-send a reminder).
    deposit: payload.deposit ?? null,
    min_spend: payload.min_spend ?? null,
    reminder_sent: payload.reminder_sent === true ? true : null,
  });
}

// Validate an arbitrary parsed value into a BookingDeposit (or null).
function parseBookingDeposit(raw: unknown): BookingDeposit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const amount = Number(o.amount);
  const status = String(o.status ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!["pending", "paid", "refund_due", "forfeited"].includes(status)) return null;
  return {
    amount: Math.round(amount * 100) / 100,
    status: status as BookingDeposit["status"],
    order_id: typeof o.order_id === "string" ? o.order_id : null,
    payment_id: typeof o.payment_id === "string" ? o.payment_id : null,
    paid_at: typeof o.paid_at === "string" ? o.paid_at : null,
    resolved_at: typeof o.resolved_at === "string" ? o.resolved_at : null,
  };
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
    const minSpend = Number(parsed.min_spend);
    return {
      start: Number.isNaN(startDate.getTime())
        ? (fallbackCreatedAt ?? new Date()).toISOString()
        : startDate.toISOString(),
      duration: Number.isFinite(duration) ? Math.max(1, Math.round(duration)) : 120,
      source: parsed.source ?? null,
      status: parsed.status ?? "Confirmed",
      from: parsed.from ?? null,
      notes: parsed.notes ?? null,
      deposit: parseBookingDeposit(parsed.deposit),
      min_spend: Number.isFinite(minSpend) && minSpend > 0 ? minSpend : null,
      reminder_sent: parsed.reminder_sent === true ? true : null,
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
  const runner = client ?? tenantStorage.getStore()?.client ?? (isipv4Fallback ? ipv4pool : pool);
  const result = await runner.query<TRow>(sql, params);
  return result.rows;
}

// --- Lazy table provisioning -------------------------------------------------
// Several feature tables are created on first use rather than in migrations. Two
// hazards the helpers below address:
//   1) DDL must run AT MOST once per process — the old per-table boolean flags
//      were bypassed whenever a transaction client was passed, so CREATE/ALTER
//      re-ran on the request hot path (even inside money transactions).
//   2) A freshly-created table must be fail-closed under RLS immediately, not
//      only after migration 007 is re-run by hand.
// We also tolerate a least-privilege (app_runtime) connection that cannot run
// DDL: in that mode the schema is expected to come from migrations, so an
// insufficient-privilege error is treated as "already provisioned".
const ddlEnsured = new Set<string>();

function isInsufficientPrivilege(err: any): boolean {
  return err?.code === "42501"; // insufficient_privilege (e.g. not the table owner)
}

// Run a lazy table's DDL once per process. `key` is the logical table group.
async function ensureLazyTable(key: string, run: () => Promise<void>): Promise<void> {
  if (ddlEnsured.has(key)) return;
  try {
    await run();
  } catch (err) {
    if (!isInsufficientPrivilege(err)) throw err;
    // Running as app_runtime: schema comes from migrations; nothing to do.
  }
  ddlEnsured.add(key);
}

// Make a lazily-created tenant table fail-closed under RLS the instant it exists,
// matching migration 003's policy form exactly. Idempotent. `tableName` is an
// internal constant (never user input). Benign no-op under a non-owner connection.
async function applyTenantRls(tableName: string): Promise<void> {
  const lit = `'${tableName.replace(/'/g, "''")}'`;
  try {
    await runQuery(
      `DO $$
       DECLARE predicate text := 'res_id::text = current_setting(''app.res_id'', true)';
       BEGIN
         EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', ${lit});
         EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', ${lit});
         EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', ${lit});
         EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)', ${lit}, predicate, predicate);
       END $$;`,
    );
  } catch (err) {
    if (!isInsufficientPrivilege(err)) throw err;
  }
}

// Boot-time fail-closed guard: every tenant (res_id) table must have RLS enabled.
// Warns and lists offenders by default; set ENFORCE_RLS_AT_BOOT=true to refuse to
// start when isolation is not actually enforced. Safe to call before serving.
export async function verifyTenantRlsAtBoot(): Promise<void> {
  // Even with policies in place, RLS is INERT if the app connects as a superuser
  // or a BYPASSRLS role. Surface that explicitly — it's the silent failure mode
  // (everything works, nothing is isolated). Hard-fail under ENFORCE_RLS_AT_BOOT.
  try {
    const r = await runQuery<{ role: string; su: string; bypass: boolean | null }>(
      `select current_user as role, current_setting('is_superuser') as su,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass`,
    );
    const row = r[0];
    if (row && (row.su === "on" || row.bypass === true)) {
      const m =
        `[rls-check] runtime DB role "${row.role}" BYPASSES row-level security ` +
        `(is_superuser=${row.su}, bypassrls=${row.bypass}). Tenant isolation is NOT enforced — ` +
        `repoint the runtime connection to the app_runtime (NOBYPASSRLS) role.`;
      if (process.env.ENFORCE_RLS_AT_BOOT === "true") throw new Error(m);
      logger.warn(m + " (set ENFORCE_RLS_AT_BOOT=true to refuse to start)");
    } else if (row) {
      logger.info(`[rls-check] OK — runtime role "${row.role}" does not bypass RLS.`);
    }
  } catch (err) {
    if (process.env.ENFORCE_RLS_AT_BOOT === "true") throw err;
    logger.warn({ err: (err as any)?.message ?? err }, "[rls-check] could not verify runtime role privileges:");
  }

  let offenders: string[] = [];
  try {
    const rows = await runQuery<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
          and exists (
            select 1 from information_schema.columns col
             where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'res_id'
          )
        order by c.relname`,
    );
    offenders = rows.map((r) => r.relname);
  } catch (err) {
    logger.warn({ err: (err as any)?.message ?? err }, "[rls-check] could not verify RLS coverage:");
    return;
  }
  if (offenders.length === 0) {
    logger.info("[rls-check] OK — all tenant tables have row-level security enabled.");
    return;
  }
  const msg =
    `[rls-check] ${offenders.length} tenant table(s) WITHOUT row-level security: ` +
    `${offenders.join(", ")}. Run \`npm run migrate\` to apply migrations 003/007/008.`;
  if (process.env.ENFORCE_RLS_AT_BOOT === "true") {
    throw new Error(msg);
  }
  logger.warn(msg + " (set ENFORCE_RLS_AT_BOOT=true to refuse to start)");
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  // Inside a request (or another withTenant), reuse the request's bound client
  // so the work runs on the same tenant-scoped connection. Nesting is handled
  // with savepoints since that connection may already be in a transaction.
  const existing = tenantStorage.getStore();
  if (existing) {
    const client = existing.client;
    const depth = existing.txnDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) {
      await client.query("BEGIN");
    } else {
      await client.query(`SAVEPOINT ${savepoint}`);
    }
    existing.txnDepth = depth + 1;
    try {
      const value = await work(client);
      if (depth === 0) {
        await client.query("COMMIT");
      } else {
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return value;
    } catch (error) {
      if (depth === 0) {
        await client.query("ROLLBACK");
      } else {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      existing.txnDepth = depth;
    }
  }

  let client;
  try {
    client = await pool.connect();
    isipv4Fallback = false;
  }
  catch (error) {
    client = await ipv4pool.connect();
    isipv4Fallback = true;
  }
  if (!client) {
    throw new Error("Failed to acquire database client");
  }
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

// Run `work` inside a tenant-scoped transaction. Sets the Postgres session GUCs
// that RLS policies key on and binds a dedicated client to AsyncLocalStorage so
// nested runQuery() calls use it. Transaction-local (`set_config(..., true)`),
// so the context clears automatically and never leaks across pooled connections.
export async function withTenant<T>(ctx: TenantContext, work: () => Promise<T>): Promise<T> {
  // Defend against accidental nesting: reuse the active tenant transaction
  // rather than checking out a second client (which would exhaust the pool).
  if (tenantStorage.getStore()) {
    return work();
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
    isipv4Fallback = false;
  } catch {
    client = await ipv4pool.connect();
    isipv4Fallback = true;
  }

  try {
    await client.query("BEGIN");
    await client.query(
      `select
        set_config('app.res_id', $1, true),
        set_config('app.outlet_id', $2, true),
        set_config('app.employee_id', $3, true),
        set_config('app.role', $4, true)`,
      [ctx.res_id ?? "", ctx.outlet_id ?? "", ctx.employeeId ?? "", ctx.role ?? ""],
    );
    const value = await tenantStorage.run({ client, ctx, txnDepth: 1 }, work);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw error;
  } finally {
    client.release();
  }
}

// Bind a tenant-scoped connection for the lifetime of an HTTP request: sets the
// `app.*` GUCs (session-level) that RLS reads, exposes run() to execute the
// route handler chain inside the AsyncLocalStorage context, and release() to
// reset and return the connection to the pool.
export async function openTenantConnection(ctx: TenantContext): Promise<{
  run: <T>(fn: () => T) => T;
  release: () => Promise<void>;
}> {
  let client: PoolClient;
  try {
    client = await pool.connect();
    isipv4Fallback = false;
  } catch {
    client = await ipv4pool.connect();
    isipv4Fallback = true;
  }
  await client.query(
    `select
      set_config('app.res_id', $1, false),
      set_config('app.outlet_id', $2, false),
      set_config('app.employee_id', $3, false),
      set_config('app.role', $4, false)`,
    [ctx.res_id ?? "", ctx.outlet_id ?? "", ctx.employeeId ?? "", ctx.role ?? ""],
  );
  let released = false;
  return {
    run: (fn) => tenantStorage.run({ client, ctx, txnDepth: 0 }, fn),
    release: async () => {
      if (released) return;
      released = true;
      try {
        // Close any stray open transaction first (ROLLBACK is a harmless no-op
        // otherwise), then clear the tenant GUCs so the pooled connection can
        // never carry one tenant's context into another tenant's request.
        await client.query("ROLLBACK").catch(() => {});
        await client.query(
          `select
            set_config('app.res_id', '', false),
            set_config('app.outlet_id', '', false),
            set_config('app.employee_id', '', false),
            set_config('app.role', '', false)`,
        );
      } catch (err) {
        logger.error({ err }, "tenant_connection_reset_failed");
      } finally {
        client.release();
      }
    },
  };
}

async function resolveRestaurantContext(
  restaurantId: string,
  client?: PoolClient,
  outletOverride?: string,
): Promise<RestaurantContext | null> {
  const normalized = normalizeRestaurantId(restaurantId);

  // When no explicit outlet override is given, fall back to the outlet bound to
  // the ambient tenant request (the session's / the admin-selected outlet) so
  // every data-layer call scopes to the ACTIVE outlet. Single-outlet restaurants
  // are unaffected — their bound outlet IS the only outlet.
  let effectiveOverride = outletOverride && outletOverride.trim() ? outletOverride.trim() : "";
  if (!effectiveOverride) {
    const ambient = tenantStorage.getStore()?.ctx.outlet_id;
    if (typeof ambient === "string" && isUuid(ambient.trim())) effectiveOverride = ambient.trim();
  }

  if (effectiveOverride) {
    // Resolve the specific (bound or explicitly-overridden) outlet for this restaurant.
    const rows = await runQuery<{
      res_id: string;
      outlet_id: string | null;
      restaurant_slug: string;
      restaurant_name: string;
      restaurant_main_office_add: string | null;
      restaurant_logo_url: string | null;
    }>(
      `
        select
          r.id as res_id,
          o.id as outlet_id,
          r.res_username as restaurant_slug,
          r.res_name as restaurant_name,
          r.main_office_add as restaurant_main_office_add,
          r.logo as restaurant_logo_url
        from "Restaurant" r
        left join "Outlets" o on o.res_id = r.id
        where
          (lower(r.res_username) = lower($1)
            or lower(r.res_username) = lower($2)
            or r.id::text = $3)
          and (o.id::text = $4 or lower(o.outlet_name) = lower($4))
        limit 1
      `,
      [restaurantId, normalized, restaurantId, effectiveOverride],
      client,
    );

    const row = rows[0];
    if (row && row.outlet_id) {
      return {
        inputId: restaurantId,
        res_id: row.res_id,
        outlet_id: row.outlet_id,
        restaurant_slug: row.restaurant_slug,
        restaurant_name: row.restaurant_name,
        restaurant_main_office_add: row.restaurant_main_office_add,
        restaurant_logo_url: row.restaurant_logo_url,
      };
    }
    // The bound/override outlet didn't resolve for this restaurant (stale or
    // cross-restaurant) — fall through to the default first-outlet resolution
    // rather than failing the request.
  }

  const rows = await runQuery<{
    res_id: string;
    outlet_id: string | null;
    restaurant_slug: string;
    restaurant_name: string;
    restaurant_main_office_add: string | null;
    restaurant_logo_url: string | null;
  }>(
    `
      select
        r.id as res_id,
        o.id as outlet_id,
        r.res_username as restaurant_slug,
        r.res_name as restaurant_name,
        r.main_office_add as restaurant_main_office_add,
        r.logo as restaurant_logo_url
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
    restaurant_main_office_add: row.restaurant_main_office_add,
    restaurant_logo_url: row.restaurant_logo_url,
  };
}

async function requireRestaurantContext(
  restaurantId: string,
  client?: PoolClient,
  outletOverride?: string,
): Promise<RestaurantContext> {
  const context = await resolveRestaurantContext(restaurantId, client, outletOverride);
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

async function findEmployeeIdByUsername(
  context: RestaurantContext,
  _username: string,
  fallbackDisplayName: string,
  client: PoolClient,
): Promise<string> {
  const username = _username.trim();

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

  throw new Error(`Employee with username '${_username}' not found in restaurant '${context.restaurant_name}', '${context.res_id}'`);

  const parts = splitName(fallbackDisplayName || _username);
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
    [employeeUuid, context.res_id, context.outlet_id, _username, "changeme"],
    client,
  );

  return employeeUuid;
}

export async function getRestaurantIdFromUsername(res_username: string): Promise<string | null> {
  return withTransaction(async (client) => {
    const existingId = await runQuery<{ res_id: string }>(
      `select id::text as res_id from "Restaurant" where lower(res_username) = lower($1) or id::text = $1 limit 1`,
      [res_username],
      client,
    );
    return existingId[0]?.res_id ?? null;
  });
}

export async function AddRestaurantUser(
  restaurantId: string,
  outletId: string | null,
  payload: {
    emp_Fname: string;
    emp_Lname?: string | null;
    email?: string | null;
    role?: string | null;
    password?: string | null;
    employeeId?: string | null;
    username?: string | null;
    ph?: string | null;
    add?: string | null;
  },
): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletId ?? undefined);

    const username = (payload.username ?? "").trim();
    if (!username) {
      throw new Error("username is required");
    }

    // ensure username not already taken for this restaurant/outlet
    const existing = await runQuery<{ emp_id: string }>(
      `select emp_id from "Login" where res_id = $1 and outlet_id = $2 and lower(emp_username) = lower($3) limit 1`,
      [context.res_id, context.outlet_id, username],
      client,
    );
    if (existing[0]) {
      throw new Error("username already exists");
    }

    const employeeUuid = payload.employeeId && isUuid(payload.employeeId) ? payload.employeeId : randomUUID();

    const empRoles = JSON.stringify({ primary: toRole(payload.role), all: [toRole(payload.role)] });

    try {
      await runQuery(
        `
      insert into "Employees"
        (id, created_at, "emp_Fname", "emp_email", "emp_ph", "emp_add", emp_roles, res_id, outlet_id, "emp_Lname")
      values
        ($1, now(), $2, $3, $4, $5, $6::json, $7, $8, $9)
    `,
        [
          employeeUuid,
          payload.emp_Fname.trim(),
          payload.email?.trim() || null,
          payload.ph?.trim() || null,
          payload.add?.trim() || null,
          empRoles,
          context.res_id,
          context.outlet_id,
          payload.emp_Lname?.trim() || null,
        ],
        client,
      );
    } catch (err: any) {
      // Detect unique constraint on outlet_id which indicates a schema problem
      if (err && (err.code === "23505" || err.constraint === "Employees_outlet_id_key")) {
        throw new Error(
          "Database constraint violation: the Employees table has a unique constraint on outlet_id. Multiple employees cannot share the same outlet_id. Please remove or fix the constraint (see README).",
        );
      }
      throw err;
    }

    const pass = payload.password?.trim() || "changeme";
    const passHash = await hashPassword(pass);

    await runQuery(
      `
      insert into "Login" (emp_id, created_at, res_id, outlet_id, emp_username, emp_pass)
      values ($1, now(), $2, $3, $4, $5)
    `,
      [employeeUuid, context.res_id, context.outlet_id, username, passHash],
      client,
    );

    const rows = await runQuery<Record<string, unknown>>(
      `select id, created_at, "emp_Fname", "emp_Lname", "emp_email", "emp_ph", "emp_add", "emp_roles", "res_id", "outlet_id" from "Employees" where id = $1 limit 1`,
      [employeeUuid],
      client,
    );

    const created = rows[0] ?? null;
    if (!created) throw new Error("failed to create employee");

    // attach employee_id for compatibility with callers
    return { ...created, employee_id: employeeUuid };
  });
}

export async function CheckDatabaseHealth(): Promise<boolean> {
  try {
    await runQuery("select 1 as ok");
    return true;
  } catch {
    return false;
  }
}

// Optional, PII-light demographic tags on customers (aggregated in analytics —
// never shown per-person to staff). All free-form-but-normalized text columns.
export type CustomerDemographics = { gender?: string | null; age_group?: string | null; pincode?: string | null };

async function ensureCustomerDemographicCols(): Promise<void> {
  await ensureLazyTable("Customers.demographics", async () => {
    await runQuery(`alter table "Customers" add column if not exists gender text`);
    await runQuery(`alter table "Customers" add column if not exists age_group text`);
    await runQuery(`alter table "Customers" add column if not exists pincode text`);
  });
}

const GENDERS = ["male", "female", "other"];
const AGE_GROUPS = ["<18", "18-25", "26-35", "36-50", "51+"];
function normalizeDemographics(demo?: CustomerDemographics | null): { gender: string | null; age_group: string | null; pincode: string | null } {
  const gender = demo?.gender && GENDERS.includes(demo.gender.trim().toLowerCase()) ? demo.gender.trim().toLowerCase() : null;
  const age = demo?.age_group && AGE_GROUPS.includes(demo.age_group.trim()) ? demo.age_group.trim() : null;
  const pin = demo?.pincode?.trim().replace(/[^0-9A-Za-z-]/g, "").slice(0, 10) || null;
  return { gender, age_group: age, pincode: pin };
}

export async function AddCustomer(
  restaurantId: string,
  name: string,
  number: string,
  email?: string,
  demographics?: CustomerDemographics | null,
): Promise<{ _id: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCustomerDemographicCols();
  const id = randomUUID();
  const parsedName = splitName(name);
  const phoneDigits = normalizePhone(number);
  const demo = normalizeDemographics(demographics);

  await runQuery(
    `
      insert into "Customers"
        (id, created_at, res_id, outlet_id, "cust_Fname", "cust_Lname", cust_ph, cust_email, country_of_origin, gender, age_group, pincode)
      values
        ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      demo.gender,
      demo.age_group,
      demo.pincode,
    ],
  );

  return { _id: id };
}

// Fill in demographic tags on an existing customer (only overwrites blanks-with-values).
export async function UpdateCustomerDemographics(
  restaurantId: string,
  customerId: string,
  demographics: CustomerDemographics,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCustomerDemographicCols();
  const demo = normalizeDemographics(demographics);
  if (!demo.gender && !demo.age_group && !demo.pincode) return;
  await runQuery(
    `update "Customers" set
       gender = coalesce($3, gender),
       age_group = coalesce($4, age_group),
       pincode = coalesce($5, pincode)
     where id = $1 and res_id = $2`,
    [customerId, context.res_id, demo.gender, demo.age_group, demo.pincode],
  );
}

export async function AddTable(
  restaurantId: string,
  table_name: string,
  capacity?: number,
): Promise<{ _id: string; table_name: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();
  const normalized = table_name.trim();
  const cap = Math.max(1, Number(capacity ?? 1));

  const existing = await runQuery<{ id: string; is_deleted: boolean }>(
    `
      select id, coalesce(is_deleted, false) as is_deleted
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (existing[0]) {
    if (!existing[0].is_deleted) {
      throw new Error("Table already exists");
    }
    // A same-named table was previously soft-deleted; revive that row so its
    // historical Orders/Bills stay attached rather than orphaning a new id.
    await runQuery(
      `
        update "Tables"
        set is_deleted = false, is_occupied = false, num_covers = 1,
            linked_order_id = null, table_name = $4, capacity = $5
        where id = $1 and res_id = $2 and outlet_id = $3
      `,
      [existing[0].id, context.res_id, context.outlet_id, normalized, cap],
    );
    return { _id: existing[0].id, table_name: normalized };
  }

  const id = randomUUID();
  await runQuery(
    `
      insert into "Tables" (id, created_at, res_id, outlet_id, table_name, capacity)
      values ($1, now(), $2, $3, $4, $5)
    `,
    [id, context.res_id, context.outlet_id, normalized, cap],
  );

  return { _id: id, table_name: normalized };
}

export type RemoveTableResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "blocked"; message: string };

export async function RemoveTable(
  restaurantId: string,
  table_name: string,
): Promise<RemoveTableResult> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();
  const normalized = table_name.trim();

  const tableRows = await runQuery<{ id: string; is_occupied: boolean }>(
    `
      select id, coalesce(is_occupied, false) as is_occupied
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  const table = tableRows[0];
  if (!table) {
    return { status: "not_found" };
  }

  // Refuse while the table is still in active use: a seated party or an open
  // bill (not yet settled/closed) would lose its link if the table vanished.
  if (table.is_occupied) {
    return { status: "blocked", message: "Settle or release the table before deleting it." };
  }

  const openBill = await runQuery<{ id: string }>(
    `
      select id
      from "Bills"
      where table_id = $1 and res_id = $2 and outlet_id = $3
        and closed_at is null and status <> 3
      limit 1
    `,
    [table.id, context.res_id, context.outlet_id],
  );
  if (openBill[0]) {
    return { status: "blocked", message: "Settle or release the table before deleting it." };
  }

  // A hard delete would violate the NOT NULL FKs on Orders.table_id /
  // Bills.table_id, so only hard-delete tables with no history at all. Tables
  // that carry closed history are soft-deleted to preserve those records.
  const history = await runQuery<{ has_history: boolean }>(
    `
      select
        exists(select 1 from "Orders" where table_id = $1 and res_id = $2 and outlet_id = $3)
        or exists(select 1 from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3)
        as has_history
    `,
    [table.id, context.res_id, context.outlet_id],
  );

  if (history[0]?.has_history) {
    await runQuery(
      `
        update "Tables"
        set is_deleted = true, is_occupied = false, num_covers = 1, linked_order_id = null
        where id = $1 and res_id = $2 and outlet_id = $3
      `,
      [table.id, context.res_id, context.outlet_id],
    );
    return { status: "deleted" };
  }

  await runQuery(
    `
      delete from "Tables"
      where id = $1 and res_id = $2 and outlet_id = $3
    `,
    [table.id, context.res_id, context.outlet_id],
  );
  return { status: "deleted" };
}

async function ensureTableOccupancyColumns(client?: PoolClient): Promise<void> {
  // Run the ALTERs at most ONCE per process (ACCESS EXCLUSIVE locks on the
  // hot-polled Tables) and tolerate a non-owner (app_runtime) 42501 post-cutover.
  await ensureLazyTable("Tables.occupancy_cols", async () => {
  await runQuery(
    `
      alter table "Tables"
      add column if not exists is_occupied boolean default false
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Tables"
      add column if not exists num_covers integer default 1
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Tables"
      add column if not exists linked_order_id text default null
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Tables"
      add column if not exists is_deleted boolean default false
    `,
    [],
    client,
  );
  // Virtual tables back takeaway/delivery orders (no physical table) — hidden from
  // the floor grid and soft-deleted once their bill closes.
  await runQuery(
    `
      alter table "Tables"
      add column if not exists is_virtual boolean default false
    `,
    [],
    client,
  );
  await ensureTableSessionsTable(client);
  });
}

// --- Table sessions (turnaround time) ----------------------------------------
// One row per seating: seated_at when a table flips to occupied, left_at when it
// flips back. Written by a DB trigger on "Tables" so EVERY occupy/release path
// (POS occupy, QR order, queue seating, reservations, settle, release, cancel)
// is captured without instrumenting each call site. TAT = left_at − seated_at.
async function ensureTableSessionsTable(client?: PoolClient): Promise<void> {
  await ensureLazyTable("TableSessions", async () => {
    await runQuery(
      `create table if not exists "TableSessions" (
         id uuid primary key default gen_random_uuid(),
         res_id uuid not null,
         outlet_id uuid,
         table_id uuid not null,
         table_name text,
         covers integer default 1,
         seated_at timestamptz not null default now(),
         left_at timestamptz
       )`,
      [], client,
    );
    await runQuery(`create index if not exists table_sessions_lookup_idx on "TableSessions" (res_id, outlet_id, seated_at desc)`, [], client);
    await runQuery(`create index if not exists table_sessions_open_idx on "TableSessions" (table_id) where left_at is null`, [], client);
    await runQuery(
      `create or replace function table_session_track() returns trigger as $fn$
       begin
         if coalesce(old.is_occupied, false) = false and new.is_occupied = true then
           insert into "TableSessions" (res_id, outlet_id, table_id, table_name, covers, seated_at)
           values (new.res_id, new.outlet_id, new.id, new.table_name, greatest(1, coalesce(new.num_covers, 1)), now());
         elsif coalesce(old.is_occupied, false) = true and new.is_occupied = false then
           update "TableSessions" set left_at = now(),
                  covers = greatest(coalesce(covers, 1), coalesce(old.num_covers, 1))
            where id = (select id from "TableSessions"
                         where table_id = new.id and left_at is null
                         order by seated_at desc limit 1);
         elsif new.is_occupied = true and coalesce(new.num_covers, 1) <> coalesce(old.num_covers, 1) then
           update "TableSessions" set covers = greatest(1, coalesce(new.num_covers, 1))
            where id = (select id from "TableSessions"
                         where table_id = new.id and left_at is null
                         order by seated_at desc limit 1);
         end if;
         return new;
       end $fn$ language plpgsql`,
      [], client,
    );
    await runQuery(`drop trigger if exists table_sessions_trg on "Tables"`, [], client);
    await runQuery(`create trigger table_sessions_trg after update on "Tables" for each row execute function table_session_track()`, [], client);
    await applyTenantRls("TableSessions");
  });
}

export async function OccupyTable(
  restaurantId: string,
  table_name: string,
  num_covers: number | null = null,
  linkedOrderId?: string | null,
  actorEmployeeId?: string | null,
): Promise<{ table_id: string; is_occupied: boolean; num_covers: number; linked_order_id?: string | null }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const normalized = table_name.trim();
  if (!normalized) {
    throw new Error("Table name is required");
  }

  // num_covers is optional: a positive number sets the guest count for this table;
  // null/undefined (the order-linking call, or a QR order that doesn't know the
  // party size) PRESERVES the covers already recorded, so adding an order never
  // silently resets a table's covers back to 1.
  const coversParam = typeof num_covers === "number" && num_covers >= 1 ? Math.round(num_covers) : null;

  const rows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (!rows[0]) {
    throw new Error("Table not found");
  }

  const tableId = rows[0].id;

  const updatedRows = await runQuery<{ is_occupied: boolean; num_covers: number; linked_order_id: string | null }>(
    `
      update "Tables"
      set is_occupied = true,
          num_covers = case when $4::int is null then coalesce(num_covers, 1) else greatest(1, $4::int) end,
          linked_order_id = $5
      where id = $1 and res_id = $2 and outlet_id = $3
      returning is_occupied, num_covers, linked_order_id
    `,
    [tableId, context.res_id, context.outlet_id, coversParam, linkedOrderId ?? null],
  );

  // Seating a guest auto-assigns the acting employee to the table so APC and
  // feedback ratings are attributed to whoever is serving it. Best-effort.
  if (actorEmployeeId && isUuid(actorEmployeeId)) {
    try {
      await assignTableById(context, tableId, actorEmployeeId);
    } catch (err) {
      logger.warn({ err: (err as any)?.message ?? err }, "auto-assign table on occupy failed");
    }
  }

  const result = updatedRows[0];
  return {
    table_id: tableId,
    is_occupied: result?.is_occupied ?? true,
    num_covers: result?.num_covers ?? coversParam ?? 1,
    linked_order_id: result?.linked_order_id ?? null,
  };
}

export async function UpdateTableCovers(
  restaurantId: string,
  table_name: string,
  num_covers: number,
): Promise<{ table_id: string; num_covers: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const normalized = table_name.trim();
  if (!normalized) {
    throw new Error("Table name is required");
  }

  if (num_covers < 1) {
    throw new Error("Number of covers must be at least 1");
  }

  const rows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (!rows[0]) {
    throw new Error("Table not found");
  }

  const tableId = rows[0].id;

  const updatedRows = await runQuery<{ num_covers: number }>(
    `
      update "Tables"
      set num_covers = $4
      where id = $1 and res_id = $2 and outlet_id = $3
      returning num_covers
    `,
    [tableId, context.res_id, context.outlet_id, Math.max(1, Math.round(num_covers))],
  );

  const result = updatedRows[0];
  return {
    table_id: tableId,
    num_covers: result?.num_covers ?? num_covers,
  };
}

export async function ReleaseTable(
  restaurantId: string,
  table_name: string,
): Promise<{ table_id: string; is_occupied: boolean }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const normalized = table_name.trim();
  if (!normalized) {
    throw new Error("Table name is required");
  }

  const rows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (!rows[0]) {
    throw new Error("Table not found");
  }

  const tableId = rows[0].id;

  // Releasing without payment voids the table's still-active orders so they don't
  // carry into the next session.
  await runQuery(
    `update "Orders" set status = 5
       where res_id = $1 and outlet_id = $2 and table_id = $3
         and coalesce(status::text, '1') not in ('4','5','7')`,
    [context.res_id, context.outlet_id, tableId],
  );

  // Close any OPEN bill too, otherwise the table stays in a payment-pending state
  // (a lingering open bill keeps payment_pending=true) and looks un-releasable.
  await runQuery(
    `update "Bills" set closed_at = now(), closed_by_username = 'released'
       where res_id = $1 and outlet_id = $2 and table_id = $3 and closed_at is null`,
    [context.res_id, context.outlet_id, tableId],
  );

  // Mark any booking seated at this table as Completed.
  await completeSeatedBookingsForTable(context, tableId);

  const updatedRows = await runQuery<{ is_occupied: boolean }>(
    `
      update "Tables"
      set is_occupied = false, num_covers = 1, linked_order_id = null
      where id = $1 and res_id = $2 and outlet_id = $3
      returning is_occupied
    `,
    [tableId, context.res_id, context.outlet_id],
  );

  // Table is free again — drop its waiter assignment.
  await unassignTableById(context, tableId);

  // Takeaway/delivery (virtual) tables are one-shot — remove on release.
  await softDeleteIfVirtual(context, tableId);

  const result = updatedRows[0];
  return {
    table_id: tableId,
    is_occupied: result?.is_occupied ?? false,
  };
}

export async function GetTableStatus(
  restaurantId: string,
  table_name: string,
): Promise<{ table_id: string; table_name: string; capacity: number | null; is_occupied: boolean; num_covers: number; linked_order_id: string | null } | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const normalized = table_name.trim();
  if (!normalized) {
    throw new Error("Table name is required");
  }

  const rows = await runQuery<{
    id: string;
    table_name: string;
    capacity: unknown;
    is_occupied: boolean;
    num_covers: number;
    linked_order_id: string | null;
  }>(
    `
      select id, table_name, capacity, is_occupied, num_covers, linked_order_id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (!rows[0]) {
    return null;
  }

  const row = rows[0];
  return {
    table_id: row.id,
    table_name: row.table_name,
    capacity: parseNumeric(row.capacity),
    is_occupied: row.is_occupied ?? false,
    num_covers: row.num_covers ?? 1,
    linked_order_id: row.linked_order_id ?? null,
  };
}

// Infer a menu category's course from its name (no typed courses in the schema).
type Course = "starter" | "main" | "dessert" | "drink" | "other";
function classifyCourse(category: string): Course {
  const c = String(category ?? "").toLowerCase();
  if (/start|appet|tikka|kebab|soup|salad|snack|finger|bite/.test(c)) return "starter";
  if (/dessert|sweet|ice cream|icecream|cake|pastry|gulab|kulfi|brownie|pudding/.test(c)) return "dessert";
  if (/drink|beverage|juice|shake|coffee|tea|mocktail|cocktail|soda|water|lassi|smoothie|beer|wine|mojito/.test(c)) return "drink";
  if (/main|course|biry|curry|rice|pizza|burger|pasta|noodle|thali|bread|naan|roti|gravy|combo|meal|sandwich|wrap|dosa/.test(c)) return "main";
  return "other";
}

// green = at/above target; yellow = within 20% below; red = well below; neutral = no target.
function apcColor(tableApc: number, target: number): "green" | "yellow" | "red" | "neutral" {
  if (target <= 0 || tableApc <= 0) return "neutral";
  if (tableApc >= target) return "green";
  if (tableApc >= target * 0.8) return "yellow";
  return "red";
}

// Restaurant's monthly APC = monthly revenue / Σ(per-table covers). Used as the
// benchmark each open table is compared against.
async function getTargetApc(context: RestaurantContext): Promise<number> {
  const now = await currentDbTime();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rows = await runQuery<{ table_id: string | null; num_covers: number; food: unknown; status: unknown }>(
    `select o.table_id, coalesce(t.num_covers, 1) as num_covers, o.food, o.status
       from "Orders" o
       left join "Tables" t on t.id = o.table_id and t.res_id = o.res_id and t.outlet_id = o.outlet_id
       where o.res_id = $1 and o.outlet_id = $2 and o.created_at >= $3 and o.created_at < $4`,
    [context.res_id, context.outlet_id, monthStart.toISOString(), monthEnd.toISOString()],
  );
  // Benchmark = SETTLED business only (paid/closed). Active/in-progress tables
  // must not inflate the target they're being measured against (circularity).
  let revenue = 0;
  const coversByTable = new Map<string, number>();
  for (const r of rows) {
    const st = String(fromOrderStatusCode(r.status) ?? "").toLowerCase();
    if (st !== "paid" && st !== "closed") continue;
    const p = parseJsonObject(r.food) ?? {};
    revenue += parseNumeric(p.total) > 0 ? parseNumeric(p.total) : parseNumeric(p.subtotal);
    if (r.table_id) coversByTable.set(r.table_id, Math.max(1, Number(r.num_covers ?? 1)));
  }
  const totalCovers = [...coversByTable.values()].reduce((a, b) => a + b, 0);
  return totalCovers > 0 ? round2(revenue / totalCovers) : 0;
}

// Build "what to push" suggestions: expected course composition for the covers
// minus what's been ordered, recommending high-value available items to upsell.
function buildApcSuggestions(
  covers: number,
  orderedByCourse: Record<Course, number>,
  menu: MenuItemRecord[],
  tableTotal: number,
  target: number,
): string[] {
  const out: string[] = [];
  const expected: Record<Course, number> = {
    starter: covers,
    main: covers,
    dessert: Math.ceil(covers / 2),
    drink: covers,
    other: 0,
  };
  const pick = (course: Course) =>
    menu
      .filter((m) => m.available !== false && classifyCourse(m.category) === course)
      .sort((a, b) => b.price - a.price)
      .slice(0, 2)
      .map((m) => m.name);
  for (const course of ["starter", "main", "dessert", "drink"] as Course[]) {
    const need = expected[course] - (orderedByCourse[course] ?? 0);
    if (need > 0) {
      const picks = pick(course);
      const label = `${course}${need > 1 ? "s" : ""}`;
      out.push(picks.length ? `Add ${need} ${label} — try ${picks.join(", ")}` : `Add ${need} ${label}`);
    }
  }
  const gap = target * covers - tableTotal;
  if (out.length === 0 && gap > 0) {
    const picks = menu.filter((m) => m.available !== false).sort((a, b) => b.price - a.price).slice(0, 2).map((m) => m.name);
    out.push(picks.length ? `₹${Math.round(gap)} below target — upsell ${picks.join(", ")}` : `₹${Math.round(gap)} below target`);
  }
  return out;
}

export async function GetBillForTable(
  restaurantId: string,
  table_name: string,
): Promise<{ bill_id: string | null; table_id: string; total_amt: number; subtotal: number; discount: number; discount_type: "percent" | "flat" | null; discount_value: number; service_charge: number; service_charge_percent: number; taxes: BillTaxLine[]; tax_total: number; grand_total: number; covers: number; apc: number; order_ids: string[]; items: Array<{ name: string; price: number; quantity: number; note?: string }>; target_apc: number; apc_status: string; apc_suggestions: string[]; payment_method: string | null; payment_status: string | null; screenshot_url: string | null; bill_no: string | null; customer: string | null; coupon_code: string | null } | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const normalized = table_name.trim();
  if (!normalized) {
    throw new Error("Table name is required");
  }

  const tableRows = await runQuery<{ id: string; num_covers: number }>(
    `
      select id, coalesce(num_covers, 1) as num_covers
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (!tableRows[0]) {
    throw new Error("Table not found");
  }

  const tableId = tableRows[0].id;
  const covers = Math.max(1, Number(tableRows[0].num_covers ?? 1));

  // The single open bill for this table, if one has been generated.
  const billRows = await runQuery<{
    id: string;
    bill_no: string | null;
    coupon_code: string | null;
    payment_method: string | null;
    payment_proof_screenshot_url: string | null;
    waiter_confirmed_at: Date | null;
    admin_approved_at: Date | null;
  }>(
    `
      select b.id, b.bill_no, b.coupon_code, b.payment_method, b.payment_proof_screenshot_url,
             b.waiter_confirmed_at, b.admin_approved_at
      from "Bills" b
      where b.table_id = $1 and b.res_id = $2 and b.outlet_id = $3
        and b.status != 3 and b.closed_at is null
      order by b.created_at desc
      limit 1
    `,
    [tableId, context.res_id, context.outlet_id],
  );

  // Only ACTIVE orders (not paid/cancelled/closed) belong to the current bill.
  const orderRows = await runQuery<{ id: string; food: unknown }>(
    `
      select id, food
      from "Orders"
      where res_id = $1 and outlet_id = $2 and table_id = $3
        and coalesce(status::text, '1') not in ('4', '5', '7')
      order by created_at asc
    `,
    [context.res_id, context.outlet_id, tableId],
  );

  // Nothing to bill yet (no active orders and no generated bill).
  if (orderRows.length === 0 && !billRows[0]) {
    return null;
  }

  // Aggregate the placed line items (merged by name + price) for the bill view.
  // Per-item notes are carried through (distinct notes joined) so the kitchen/
  // waiter sees any special instructions on the bill.
  const itemMap = new Map<string, { name: string; price: number; quantity: number; note?: string }>();
  let billCustomer = "";
  for (const o of orderRows) {
    const f = parseJsonObject(o.food) ?? {};
    // Use the first non-empty, non-placeholder customer name for the bill header.
    if (!billCustomer) {
      const c = String((f as Record<string, unknown>).customer ?? "").trim();
      if (c && c.toLowerCase() !== "guest" && c.toLowerCase() !== "qr guest") billCustomer = c;
    }
    const list = Array.isArray((f as Record<string, unknown>).items) ? (f as { items: unknown[] }).items : [];
    for (const raw of list) {
      const it = (raw ?? {}) as Record<string, unknown>;
      const name = String(it.name ?? "Item");
      const price = parseNumeric(it.price);
      const quantity = Math.max(1, Math.round(parseNumeric(it.quantity) || 1));
      const note = String(it.note ?? "").trim();
      const key = `${name.toLowerCase()}@@${price}`;
      const existing = itemMap.get(key);
      if (existing) {
        existing.quantity += quantity;
        if (note) existing.note = existing.note && !existing.note.includes(note) ? `${existing.note}; ${note}` : note;
      } else {
        itemMap.set(key, { name, price, quantity, note: note || undefined });
      }
    }
  }
  const items = [...itemMap.values()];

  // Running bill total = sum of the table's active orders; APC = total / covers.
  // APC stays on the pre-tax subtotal (per-cover spend convention).
  const total = await sumOrderTotalsForTable(context, tableId);
  const tableApc = covers > 0 ? round2(total / covers) : 0;

  // Apply the optional service charge + the outlet's taxes to get the grand total.
  const taxRows = await runQuery<{ default_tax: any }>(
    `select default_tax from "Outlets" where id = $1 and res_id = $2 limit 1`,
    [context.outlet_id, context.res_id],
  );
  const scPct = await getServiceChargePercent(context.res_id);
  const discount = await getOpenBillDiscount(context, tableId);
  const {
    discount: discountAmount,
    discount_type: discountType,
    discount_value: discountValue,
    service_charge,
    service_charge_percent,
    taxes,
    tax_total,
    grand_total,
  } = computeBillCharges(total, taxRows[0]?.default_tax ?? null, scPct, true, discount);
  const bill = billRows[0];
  const paymentStatus = bill == null
    ? null
    : bill.admin_approved_at
      ? "approved"
      : bill.waiter_confirmed_at
        ? "pending_approval"
        : null;

  // APC benchmark + push suggestions (only worth computing for an active table).
  let targetApc = 0;
  let apcStatusVal = "neutral";
  let apcSuggestions: string[] = [];
  if (total > 0) {
    targetApc = await getTargetApc(context);
    apcStatusVal = apcColor(tableApc, targetApc);
    if (apcStatusVal === "yellow" || apcStatusVal === "red") {
      const menu = await GetMenuItems(restaurantId).catch(() => [] as MenuItemRecord[]);
      const catByName = new Map<string, string>();
      for (const m of menu) catByName.set(m.name.toLowerCase(), m.category);
      const orderedByCourse: Record<Course, number> = { starter: 0, main: 0, dessert: 0, drink: 0, other: 0 };
      for (const it of items) {
        const course = classifyCourse(catByName.get(it.name.toLowerCase()) ?? "");
        orderedByCourse[course] += it.quantity;
      }
      apcSuggestions = buildApcSuggestions(covers, orderedByCourse, menu, total, targetApc);
    }
  }

  return {
    bill_id: bill?.id ?? null,
    table_id: tableId,
    total_amt: total,
    subtotal: total,
    discount: discountAmount,
    discount_type: discountType,
    discount_value: discountValue,
    service_charge,
    service_charge_percent,
    taxes,
    tax_total,
    grand_total,
    covers,
    apc: tableApc,
    order_ids: orderRows.map((row) => row.id),
    items,
    target_apc: targetApc,
    apc_status: apcStatusVal,
    apc_suggestions: apcSuggestions,
    payment_method: bill?.payment_method ?? null,
    payment_status: paymentStatus,
    screenshot_url: bill?.payment_proof_screenshot_url ?? null,
    bill_no: bill?.bill_no ?? null,
    customer: billCustomer || null,
    coupon_code: bill?.coupon_code ?? null,
  };
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
  deposit?: BookingDeposit | null,
  min_spend?: number | null,
): Promise<{ _id: string }> {
  ensureValidDate(booking_date_time);
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

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
        and coalesce(is_deleted, false) = false
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
    deposit: deposit ?? null,
    min_spend: min_spend ?? null,
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
): Promise<Array<{ table_id: string; slot: string; created_at: string }>> {
  const rows = await runQuery<{
    table_id: string;
    slot: string;
    created_at: string;
  }>(
    `
      select table_id, slot, created_at
      from "Bookings"
      where res_id = $1 and outlet_id = $2
      order by created_at asc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows;
}

export async function GetTables(
  restaurantId: string,
  time?: string | Date | null,
): Promise<Array<{ table_name: string; capacity: number | null; booked?: boolean; reserved?: boolean; occupied?: boolean; covers?: number; payment_pending?: boolean; table_total?: number; table_apc?: number; target_apc?: number; apc_status?: string; qr_sig?: string; qr_token?: string }> | null> {
  const at = time ? new Date(time as any) : new Date();
  if (Number.isNaN(at.getTime())) return null;

  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const tableRows = await runQuery<{
    id: string;
    table_name: string;
    capacity: unknown;
    is_occupied: boolean;
    num_covers: unknown;
  }>(
    `
      select id, table_name, capacity,
             coalesce(is_occupied, false) as is_occupied,
             coalesce(num_covers, 1) as num_covers
      from "Tables"
      where res_id = $1 and outlet_id = $2
        and coalesce(is_deleted, false) = false
        and coalesce(is_virtual, false) = false
      order by table_name asc
    `,
    [context.res_id, context.outlet_id],
  );

  const bookings = await runQuery<{
    table_id: string | null;
    slot: string;
    created_at: string;
  }>(
    `
      select table_id, slot, created_at
      from "Bookings"
      where res_id = $1 and outlet_id = $2 and table_id is not null
        -- Floor grid only needs today's active/upcoming reservations; a booking is
        -- always created before its slot, so a 90-day window keeps every realistic
        -- one while bounding the previously all-time scan (this endpoint is polled
        -- continuously). Slot start is JSON text (mixed legacy formats) so it can't
        -- be filtered reliably in SQL; created_at is the safe bound.
        and created_at >= now() - interval '90 days'
    `,
    [context.res_id, context.outlet_id],
  );

  const dayEnd = new Date(at);
  dayEnd.setHours(23, 59, 59, 999);

  const active = [] as typeof bookings;
  const upcoming = [] as typeof bookings;
  for (const booking of bookings) {
    const slot = decodeSlot(booking.slot, new Date(booking.created_at));
    // A booking only holds its table while the party is still expected. Terminal
    // states free it: cancelled (kept as a row for its deposit record), completed
    // or seated/arrived (the party came and the table is cleared on release), or a
    // no-show. Without this, a completed booking whose slot time is still in the
    // future kept the table stuck showing "reserved" after it was cleared.
    if (isTerminalBookingStatus(slot.status)) continue;
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + slot.duration * MINUTE_IN_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (start <= at && end > at) {
      active.push(booking);
      continue;
    }
    if (start > at && start <= dayEnd) {
      upcoming.push(booking);
    }
  }

  const bookedTables = new Set(active.map((b) => b.table_id).filter(Boolean));
  const reservedTables = new Set(upcoming.map((b) => b.table_id).filter(Boolean));

  // Tables whose open bill is awaiting staff approval (customer paid via QR).
  const pendingRows = await runQuery<{ table_id: string | null }>(
    `
      select distinct table_id
      from "Bills"
      where res_id = $1 and outlet_id = $2 and table_id is not null
        and closed_at is null and status <> 3
        and waiter_confirmed_at is not null and admin_approved_at is null
    `,
    [context.res_id, context.outlet_id],
  ).catch(() => [] as { table_id: string | null }[]);
  const pendingTables = new Set(pendingRows.map((r) => r.table_id).filter(Boolean));

  // Per-table running total (active orders) → APC status vs the restaurant target.
  const target = await getTargetApc(context).catch(() => 0);
  const activeOrders = await runQuery<{ table_id: string | null; food: unknown }>(
    `select table_id, food from "Orders"
       where res_id = $1 and outlet_id = $2 and coalesce(status::text, '1') not in ('4', '5', '7')`,
    [context.res_id, context.outlet_id],
  ).catch(() => [] as { table_id: string | null; food: unknown }[]);
  const totalByTable = new Map<string, number>();
  for (const o of activeOrders) {
    if (!o.table_id) continue;
    const p = parseJsonObject(o.food) ?? {};
    const t = parseNumeric(p.total) > 0 ? parseNumeric(p.total) : parseNumeric(p.subtotal);
    totalByTable.set(o.table_id, (totalByTable.get(o.table_id) ?? 0) + t);
  }

  return tableRows.map((row) => {
    const occupied = row.is_occupied === true;
    const tCovers = Math.max(1, parseNumeric(row.num_covers) ?? 1);
    const tTotal = totalByTable.get(row.id) ?? 0;
    const tApc = occupied && tTotal > 0 ? round2(tTotal / tCovers) : 0;
    return {
      table_name: row.table_name,
      capacity: parseNumeric(row.capacity),
      booked: bookedTables.has(row.id),
      reserved: reservedTables.has(row.id),
      occupied,
      covers: parseNumeric(row.num_covers),
      payment_pending: pendingTables.has(row.id),
      table_total: tTotal,
      table_apc: tApc,
      target_apc: target,
      apc_status: occupied && tTotal > 0 ? apcColor(tApc, target) : "neutral",
      qr_sig: signTable(context.res_id, row.table_name),
      qr_token: encodeTableToken(context.res_id, row.table_name),
    };
  });
}

export async function GetAvailableTablesForInterval(
  restaurantId: string,
  start: Date,
  durationMins: number,
): Promise<Array<{ table_name: string; capacity: number | null }>> {
  ensureValidDate(start);
  const end = new Date(start.getTime() + durationMins * MINUTE_IN_MS);
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();

  const tableRows = await runQuery<{
    id: string;
    table_name: string;
    capacity: unknown;
  }>(
    `
      select id, table_name, capacity
      from "Tables"
      where res_id = $1 and outlet_id = $2
        and coalesce(is_deleted, false) = false
    `,
    [context.res_id, context.outlet_id],
  );

  const bookings = await getBookingsWithTableMeta(context);
  const busyIds = new Set<string>();

  for (const booking of bookings) {
    const slot = decodeSlot(booking.slot, new Date(booking.created_at));
    // Cancelled bookings are kept as rows when they carry a deposit (the
    // refund_due/forfeited record must survive) — they no longer hold a table.
    if (String(slot.status ?? "").toLowerCase().includes("cancel")) continue;
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
  const og = isAllOutlets() ? "true" : "false";
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
      where b.res_id = $1 and (${og} or b.outlet_id = $2)
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
      deposit: slot.deposit ?? null,
      min_spend: slot.min_spend ?? null,
    });
  }

  result.sort((a, b) => a.booking_date_time.getTime() - b.booking_date_time.getTime());
  return result;
}

// Single-booking lookup (same shape as GetBookingsAfterTime rows) — used by the
// public deposit-verify endpoint and the cancellation path.
export async function GetBookingSummaryById(
  restaurantId: string,
  booking_id: string,
): Promise<BookingSummary | null> {
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
      where b.id = $1 and b.res_id = $2 and b.outlet_id = $3
      limit 1
    `,
    [booking_id, context.res_id, context.outlet_id],
  );
  const row = rows[0];
  if (!row) return null;
  const slot = decodeSlot(row.slot, row.created_at);
  return {
    booking_id: row.booking_id,
    customer_id: row.customer_id,
    customer_name: `${row.cust_fname} ${row.cust_lname}`.trim(),
    table_name: row.table_name,
    booking_date_time: new Date(slot.start),
    duration_mins: slot.duration,
    number_of_people: Math.max(1, Math.round(parseNumeric(row.num_adults))),
    source: slot.source ?? null,
    status: slot.status ?? "Confirmed",
    from: slot.from ?? null,
    notes: slot.notes ?? null,
    deposit: slot.deposit ?? null,
    min_spend: slot.min_spend ?? null,
  };
}

// Transition a booking's deposit (and optionally the booking status) in one
// read-modify-write of the slot JSON. Returns false when the booking doesn't
// exist or carries no deposit.
export async function UpdateBookingDeposit(
  restaurantId: string,
  booking_id: string,
  updates: {
    deposit_status: BookingDeposit["status"];
    payment_id?: string | null;
    slot_status?: string | null;
  },
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ slot: string; created_at: Date }>(
    `select slot, created_at from "Bookings" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [booking_id, context.res_id, context.outlet_id],
  );
  const row = rows[0];
  if (!row) return false;
  const slot = decodeSlot(row.slot, row.created_at);
  if (!slot.deposit) return false;
  slot.deposit.status = updates.deposit_status;
  if (updates.payment_id !== undefined) slot.deposit.payment_id = updates.payment_id;
  if (updates.deposit_status === "paid") slot.deposit.paid_at = new Date().toISOString();
  if (updates.deposit_status === "refund_due" || updates.deposit_status === "forfeited") {
    slot.deposit.resolved_at = new Date().toISOString();
  }
  if (updates.slot_status) slot.status = updates.slot_status;
  await runQuery(
    `update "Bookings" set slot = $4 where id = $1 and res_id = $2 and outlet_id = $3`,
    [booking_id, context.res_id, context.outlet_id, encodeSlot(slot)],
  );
  return true;
}

export async function UpdateBookingStatus(
  restaurantId: string,
  booking_id: string,
  status: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);

  const rows = await runQuery<{ slot: string; created_at: Date; table_id: string | null; num_adults: unknown; num_kids: unknown }>(
    `
      select slot, created_at, table_id, num_adults, num_kids
      from "Bookings"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [booking_id, context.res_id, context.outlet_id],
  );

  const row = rows[0];
  if (!row) return false;

  const slot = decodeSlot(row.slot, row.created_at);
  const prevStatus = String(slot.status ?? "").trim().toLowerCase();
  slot.status = status;

  await runQuery(
    `
      update "Bookings"
      set slot = $4
      where id = $1 and res_id = $2 and outlet_id = $3
    `,
    [booking_id, context.res_id, context.outlet_id, encodeSlot(slot)],
  );

  const normalizedStatus = status.trim().toLowerCase();
  const isSeating = (s: string) => s === "seated" || s === "arrived";
  if (isSeating(normalizedStatus) && row.table_id) {
    // Seating/arriving a booking occupies its assigned table (so the floor view +
    // ordering reflect it). Covers default to the party size.
    const covers = Math.max(1, toNonNegativeInt(row.num_adults) + toNonNegativeInt(row.num_kids));
    try {
      await ensureTableOccupancyColumns();
      await runQuery(
        `update "Tables" set is_occupied = true, num_covers = $4
           where id = $1 and res_id = $2 and outlet_id = $3 and coalesce(is_deleted, false) = false`,
        [row.table_id, context.res_id, context.outlet_id, covers],
      );
    } catch (err) {
      logger.warn({ err }, "occupy_table_on_seat_failed");
    }
  } else if (!isSeating(normalizedStatus) && isSeating(prevStatus) && row.table_id) {
    // The booking was holding its table (it had been seated/arrived) and is now
    // moving to a NON-seating status (cancelled / completed / no-show / back to
    // confirmed) — the party is no longer there, so release the table instead of
    // leaving it stuck "occupied" with the party's covers. Gated on the PRIOR
    // status so cancelling a never-seated booking can't clear a walk-in that
    // independently occupied the same table.
    try {
      await ensureTableOccupancyColumns();
      await runQuery(
        `update "Tables" set is_occupied = false, num_covers = 1, linked_order_id = null
           where id = $1 and res_id = $2 and outlet_id = $3 and coalesce(is_deleted, false) = false`,
        [row.table_id, context.res_id, context.outlet_id],
      );
    } catch (err) {
      logger.warn({ err }, "release_table_on_unseat_failed");
    }
  }

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
  await ensureTableOccupancyColumns();

  if (!table_name?.trim()) {
    throw new Error("Table name cannot be null");
  }

  const tableRows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
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

// --- Guest CRM insights -------------------------------------------------------
export type CustomerInsight = {
  customer_id: string;
  name: string;
  phone: string;
  visits: number;            // distinct order days
  total_spend: number;
  last_visit: string | null; // "YYYY-MM-DD"
  avg_rating: number | null; // from feedback matched by guest name
  feedbacks: number;
  segment: "new" | "regular" | "high-spend" | "dormant";
  history: Array<{ day: string; orders: number; spend: number }>; // recent visit days, newest first
};

// Per-customer visit/spend/rating + segment for the CRM page. Order identity:
// a direct cust_id link when the order has one (orders are now linked to a
// Customers row at placement time when they carry a phone), else the captured
// phone, else the non-"Guest" customer name from the order JSON. Each order
// lands in exactly ONE identity bucket (cust_id > phone > name), and a customer
// merges its cust_id + phone + name buckets, so nothing is double-counted.
// Feedback is matched by guest name (cust_name).
export async function GetCustomerInsights(
  restaurantId: string,
): Promise<{ customers: CustomerInsight[] }> {
  const context = await requireRestaurantContext(restaurantId);
  const rid = context.res_id, oid = context.outlet_id;
  const og = isAllOutlets() ? "true" : "false";

  const custRows = await runQuery<{ id: string; fname: string | null; lname: string | null; phone: string | null }>(
    `select id, "cust_Fname" as fname, "cust_Lname" as lname, cast(cust_ph as text) as phone
       from "Customers" where res_id = $1 and (${og} or outlet_id = $2)`,
    [rid, oid],
  );

  // Visit-day buckets per identity (last 365 days; voided orders excluded).
  const orderRows = await runQuery<{ ident: string; day: string; orders: number; spend: number }>(
    `with it as (
       select case when o.cust_id is not null then 'c:' || o.cust_id::text
                   else coalesce(nullif((o.food)::jsonb->>'customer_phone',''), nullif((o.food)::jsonb->>'customer','')) end as ident,
              to_char(o.created_at, 'YYYY-MM-DD') as day,
              coalesce(((o.food)::jsonb->>'total')::numeric, 0) as total
         from "Orders" o
        where o.res_id = $1 and (${og} or o.outlet_id = $2)
          and o.created_at >= now() - interval '365 days'
          and coalesce(o.status::text, '1') <> '5'
     )
     select ident, day, count(*)::int as orders, coalesce(sum(total),0)::float as spend
       from it where ident is not null and lower(ident) <> 'guest'
       group by ident, day`,
    [rid, oid],
  );
  // Key each identity bucket by cust_id (when the order is directly linked),
  // normalized phone (when the ident IS a phone) or lower-cased name, so
  // customer matching is format-insensitive.
  const buckets = new Map<string, Array<{ day: string; orders: number; spend: number }>>();
  for (const r of orderRows) {
    let key: string;
    if (r.ident.startsWith("c:")) {
      key = r.ident; // direct Orders.cust_id link
    } else {
      const digits = normalizePhone(r.ident);
      // ≥7 digits → the ident was a captured phone; anything else is a name.
      key = digits.length >= 7 ? `p:${digits}` : `n:${r.ident.trim().toLowerCase()}`;
    }
    const list = buckets.get(key) ?? [];
    list.push({ day: r.day, orders: r.orders, spend: round2(r.spend) });
    buckets.set(key, list);
  }

  const fbRows = await runQuery<{ nm: string; avg_rating: number | null; n: number }>(
    `select lower(trim(cust_name)) as nm, avg(overall_rating)::float as avg_rating, count(*)::int as n
       from "Feedback_entries"
      where res_id = $1 and (${og} or outlet_id = $2) and cust_name is not null and trim(cust_name) <> ''
      group by 1`,
    [rid, oid],
  );
  const fbByName = new Map(fbRows.map((r) => [r.nm, r]));

  const todayMs = Date.now();
  const raw = custRows.map((c) => {
    const name = `${c.fname ?? ""} ${c.lname ?? ""}`.replace(/\s+/g, " ").trim();
    const digits = normalizePhone(c.phone ?? "");
    // Merge the cust_id, phone and name buckets (disjoint order sets — every
    // order lands in exactly one of them).
    const days = new Map<string, { orders: number; spend: number }>();
    for (const key of [`c:${c.id}`, digits ? `p:${digits}` : "", name ? `n:${name.toLowerCase()}` : ""]) {
      if (!key) continue;
      for (const b of buckets.get(key) ?? []) {
        const cur = days.get(b.day) ?? { orders: 0, spend: 0 };
        cur.orders += b.orders;
        cur.spend = round2(cur.spend + b.spend);
        days.set(b.day, cur);
      }
    }
    const history = [...days.entries()]
      .map(([day, v]) => ({ day, orders: v.orders, spend: v.spend }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    const total_spend = round2(history.reduce((s, h) => s + h.spend, 0));
    const last_visit = history[0]?.day ?? null;
    const fb = fbByName.get(name.toLowerCase());
    return {
      customer_id: c.id,
      name,
      phone: c.phone ?? "",
      visits: history.length,
      total_spend,
      last_visit,
      avg_rating: fb?.avg_rating != null ? round2(fb.avg_rating) : null,
      feedbacks: fb?.n ?? 0,
      history: history.slice(0, 10),
    };
  });

  // High-spend = top quartile of total_spend among customers who spent anything
  // (needs ≥4 spenders for a quartile to mean something).
  const spends = raw.filter((c) => c.total_spend > 0).map((c) => c.total_spend).sort((a, b) => a - b);
  const p75 = spends.length >= 4 ? spends[Math.min(spends.length - 1, Math.floor(spends.length * 0.75))]! : Infinity;

  const customers: CustomerInsight[] = raw.map((c) => {
    let segment: CustomerInsight["segment"] = "new";
    if (c.visits > 0 && c.last_visit) {
      const daysSince = Math.floor((todayMs - new Date(`${c.last_visit}T00:00:00Z`).getTime()) / 86_400_000);
      if (daysSince > 30) segment = "dormant";
      else if (c.total_spend >= p75) segment = "high-spend";
      else if (c.visits >= 3) segment = "regular";
    }
    return { ...c, segment };
  });

  // Biggest spenders first — the natural CRM reading order.
  customers.sort((a, b) => b.total_spend - a.total_spend || a.name.localeCompare(b.name));
  return { customers };
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

async function ensureValetVehicleMetaTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Valet_vehicle_meta", async () => {
    await runQuery(
      `create table if not exists "Valet_vehicle_meta" (
        booking_id uuid primary key,
        res_id uuid not null,
        outlet_id uuid not null,
        number_plate text not null,
        customer_name text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
    );
    await runQuery(
      `create index if not exists valet_vehicle_meta_lookup_idx
       on "Valet_vehicle_meta" (res_id, outlet_id, booking_id)`,
    );
    await applyTenantRls("Valet_vehicle_meta");
  });
}

export async function GetParkingBays(
  restaurantId: string,
  outletOverride?: string,
): Promise<ParkingBayRecord[]> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
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
  outletOverride?: string,
): Promise<ParkingBayRecord> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletOverride);
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
  outletOverride?: string,
): Promise<ParkingBayRecord | null> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletOverride);
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
  outletOverride?: string,
): Promise<{ Bay_id: string; deleted_valet_count: number } | null> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletOverride);

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
  outletOverride?: string,
): Promise<ParkingBayRecord | null> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
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

// Shared row → record mapper for "Valet_vehicle_state" (base + lazy ops columns).
function mapValetStateRow(row: Record<string, any>): ValetVehicleStateRecord {
  return {
    booking_id: row.id,
    state: toNonNegativeInt(row.state),
    entry_time: row.entry_time ? new Date(row.entry_time).toISOString() : null,
    exit_time: row.exit_time ? new Date(row.exit_time).toISOString() : null,
    bay_id: row.bay_id ?? null,
    parking_location: row.parking_location ?? null,
    key_holder: row.key_holder ?? null,
    key_updated_at: row.key_updated_at ? new Date(row.key_updated_at).toISOString() : null,
    condition_notes: row.condition_notes ?? null,
    condition_photo_url: row.condition_photo_url ?? null,
    eta_minutes: row.eta_minutes === null || row.eta_minutes === undefined ? null : toNonNegativeInt(row.eta_minutes),
    requested_at: row.requested_at ? new Date(row.requested_at).toISOString() : null,
  };
}

const VALET_STATE_SELECT_COLS =
  `id, entry_time, exit_time, state, bay_id, parking_location, key_holder, key_updated_at,
   condition_notes, condition_photo_url, eta_minutes, requested_at`;

export async function GetValetVehicleStates(
  restaurantId: string,
  outletOverride?: string,
): Promise<ValetVehicleStateRecord[]> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
  await ensureValetRetrievalColumns();
  await ensureValetOpsColumns();
  const rows = await runQuery<Record<string, any>>(
    `
      select ${VALET_STATE_SELECT_COLS}
      from "Valet_vehicle_state"
      where res_id = $1 and outlet_id = $2
      order by entry_time desc nulls last
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map(mapValetStateRow);
}

export async function GetValetVehicleMetaByBookingIds(
  restaurantId: string,
  bookingIds: string[],
  outletOverride?: string,
): Promise<Record<string, ValetVehicleMetaRecord>> {
  if (bookingIds.length === 0) {
    return {};
  }

  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
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
  outletOverride?: string,
): Promise<ValetVehicleMetaRecord> {
  const normalizedPlate = normalizeVehiclePlate(numberPlate);
  if (!normalizedPlate) {
    throw new Error("number_plate is required");
  }

  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletOverride);
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
  outletOverride?: string,
): Promise<{ booking_id: string; entry_time: string; bay_id: string }> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletOverride);
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
  outletOverride?: string,
): Promise<ValetVehicleStateRecord | null> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
  await ensureValetRetrievalColumns();
  await ensureValetOpsColumns();
  const rows = await runQuery<Record<string, any>>(
    `
      select ${VALET_STATE_SELECT_COLS}
      from "Valet_vehicle_state"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [bookingId, context.res_id, context.outlet_id],
  );

  const row = rows[0];
  if (!row) return null;
  return mapValetStateRow(row);
}

// Retrieval-time telemetry: the base table only records entry_time and exit_time
// (set at state 6), so request→delivered duration was unmeasurable. These two
// timestamps are stamped on the 3 (customer requested car) and 5 (car at
// entrance) transitions so the "Valet Retrieval" KPI can accrue going forward.
let valetRetrievalColsEnsured = false;
async function ensureValetRetrievalColumns(): Promise<void> {
  if (valetRetrievalColsEnsured) return;
  await runQuery(`alter table "Valet_vehicle_state" add column if not exists requested_at timestamptz`);
  await runQuery(`alter table "Valet_vehicle_state" add column if not exists delivered_at timestamptz`);
  valetRetrievalColsEnsured = true;
}

// Valet ops depth (Wave D): parking location ("any attendant can retrieve"),
// digital key custody log, damage/condition notes (+ optional photo), and the
// retrieval ETA quoted to the guest when a car is requested. Lazy columns on the
// per-visit state row (a state row always exists, unlike the Node-only meta
// table). Also seeds the dedicated audit actions so key/charge/ops changes show
// with honest names in the log (same pattern as the discount workflow).
async function ensureValetOpsColumns(): Promise<void> {
  await ensureLazyTable("Valet_vehicle_state_ops", async () => {
    await runQuery(`alter table "Valet_vehicle_state" add column if not exists parking_location text`);
    await runQuery(`alter table "Valet_vehicle_state" add column if not exists key_holder text`);
    await runQuery(`alter table "Valet_vehicle_state" add column if not exists key_updated_at timestamptz`);
    await runQuery(`alter table "Valet_vehicle_state" add column if not exists condition_notes text`);
    await runQuery(`alter table "Valet_vehicle_state" add column if not exists condition_photo_url text`);
    await runQuery(`alter table "Valet_vehicle_state" add column if not exists eta_minutes int`);
    await runQuery(
      `insert into "Actions" (id, action_name, action_desc)
       values ('4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18', 'Valet Key Log', 'Record which attendant holds a valet vehicle''s keys'),
              ('8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413', 'Valet Ops Update', 'Update valet parking location / condition notes / retrieval ETA'),
              ('6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791', 'Valet Charge to Bill', 'Post a valet parking fee onto a table''s open bill')
       on conflict (id) do nothing`,
    ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
  });
}

export type ValetOpsPatch = {
  parking_location?: string | null;
  key_holder?: string | null;
  condition_notes?: string | null;
  condition_photo_url?: string | null;
  eta_minutes?: number | null;
};

// Patch the valet ops fields on a vehicle's state row. Only the keys present on
// the patch are written; passing null clears a field. Setting key_holder (or
// clearing it) also stamps key_updated_at so the custody log is timestamped.
export async function UpdateValetVehicleOps(
  restaurantId: string,
  bookingId: string,
  patch: ValetOpsPatch,
  outletOverride?: string,
): Promise<ValetVehicleStateRecord | null> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
  await ensureValetRetrievalColumns();
  await ensureValetOpsColumns();

  const has = (k: keyof ValetOpsPatch) => Object.prototype.hasOwnProperty.call(patch, k);
  const trimOrNull = (v: string | null | undefined) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s : null;
  };
  const eta =
    patch.eta_minutes === null || patch.eta_minutes === undefined
      ? null
      : Math.min(240, toNonNegativeInt(patch.eta_minutes)) || null;

  const rows = await runQuery<Record<string, any>>(
    `
      update "Valet_vehicle_state"
      set
        parking_location    = case when $4::bool  then $5  else parking_location end,
        key_holder          = case when $6::bool  then $7  else key_holder end,
        key_updated_at      = case when $6::bool  then now() else key_updated_at end,
        condition_notes     = case when $8::bool  then $9  else condition_notes end,
        condition_photo_url = case when $10::bool then $11 else condition_photo_url end,
        eta_minutes         = case when $12::bool then $13::int else eta_minutes end
      where id = $1 and res_id = $2 and outlet_id = $3
      returning ${VALET_STATE_SELECT_COLS}
    `,
    [
      bookingId,
      context.res_id,
      context.outlet_id,
      has("parking_location"), trimOrNull(patch.parking_location),
      has("key_holder"), trimOrNull(patch.key_holder),
      has("condition_notes"), trimOrNull(patch.condition_notes),
      has("condition_photo_url"), trimOrNull(patch.condition_photo_url),
      has("eta_minutes"), eta,
    ],
  );

  const row = rows[0];
  if (!row) return null;
  return mapValetStateRow(row);
}

export async function UpdateValetVehicleState(
  restaurantId: string,
  bookingId: string,
  state: number,
  outletOverride?: string,
): Promise<{ booking_id: string } | null> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);
  const normalizedState = toNonNegativeInt(state);
  await ensureValetRetrievalColumns();

  const rows = await runQuery<{ id: string }>(
    `
      update "Valet_vehicle_state"
      set
        state = $4::int,
        exit_time = case when $4::int = 6 then now() else exit_time end,
        requested_at = case when $4::int = 3 then coalesce(requested_at, now()) else requested_at end,
        delivered_at = case when $4::int = 5 then coalesce(delivered_at, now()) else delivered_at end
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
  outletOverride?: string,
): Promise<{ booking_id: string; bay_id: string | null } | null> {
  const context = await requireRestaurantContext(restaurantId, undefined, outletOverride);

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
    logger.error({ err: error }, "Error counting bookings in range:");
    return null;
  }
}

export async function GetEmployeeDetailsFromEmpID(employeeID: string): Promise<RestaurantUser> {
  const rows = await runQuery<{
    res_id: string,
    outlet_id: string,
    emp_Fname: string,
    emp_Lname?: string | null,
    emp_roles: Record<string, any>,
  }>(
    `
    select res_id, outlet_id, "emp_Fname", "emp_Lname", emp_roles from "Employees" where id = $1 limit 1
    `,
    [employeeID]
  );

  const login_rows = await runQuery<{
    emp_username: string,
  }>(
    `
      select emp_username from "Login" where emp_id = $1 limit 1
    `,
    [employeeID]
  );

  if (login_rows.length === 0 || !login_rows[0]) {
    throw new Error("Login details not found for employee");
  }

  if (rows.length === 0) {
    throw new Error("Employee not found");
  }
  const row = rows[0];
  if (!row) {
    throw new Error("Employee not found");
  }
  const role = row.emp_roles ? typeof row.emp_roles === "object" ? row.emp_roles
    : JSON.parse(row.emp_roles)
    : {};
  return {
    id: employeeID,
    res_id: row.res_id,
    outlet_id: row.outlet_id,
    employee_id: employeeID,
    employee_Username: login_rows[0].emp_username,
    emp_Fname: row.emp_Fname,
    emp_Lname: row.emp_Lname,
    password: "",
    role: role["primary"],
    role_all: role["all"] || []
  };
}

export async function AddAuditLogEntry(
  restaurantId: string,
  OutletId: string,
  employeeId: string,
  actionId: string,
  details: string,
  category: Audit_log_category,
  additional_details?: Record<string, any>
): Promise<boolean> {
  await withTransaction(async (client) => {
    await runQuery(
      `
      insert into "Audit_logs"
          (id, created_at, res_id, outlet_id, employee_id, action_id, reason, category, additional_details)
        values
          ($1, now(), $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        randomUUID(),
        restaurantId,
        OutletId,
        employeeId,
        actionId,
        details,
        category,
        additional_details ? additional_details : null
      ]
    )
  })
  return true;
}

// export async function AddAuditLogEntryLegacy(
//   restaurantId: string,
//   entry: { employee: string; employeeId?: string | null; action: string; category: Audit_log_category; details?: string | null },
// ): Promise<void> {
//   const context = await requireRestaurantContext(restaurantId);

//   await withTransaction(async (client) => {
//     const actorIdentity = String(entry.employeeId ?? entry.employee ?? "").trim();
//     if (!actorIdentity) {
//       throw new Error("Missing employee identity for audit log entry");
//     }

//     const resolvedEmployee = await resolveEmployeeByUsername(context, actorIdentity, client);
//     if (!resolvedEmployee) {
//       throw new Error(
//         `Employee '${actorIdentity}' not found in restaurant '${context.restaurant_name}', '${context.res_id}'`,
//       );
//     }

//     const actionId = await findOrCreateActionId(entry.action, client);

//     await runQuery(
//       `
//         insert into "Audit_logs"
//           (id, created_at, res_id, outlet_id, employee_id, action_id, reason, category)
//         values
//           ($1, now(), $2, $3, $4, $5, $6, $7)
//       `,
//       [
//         randomUUID(),
//         context.res_id,
//         context.outlet_id,
//         resolvedEmployee.id,
//         actionId,
//         entry.details ?? null,
//         entry.category,
//       ],
//       client,
//     );
//   });
// }

export type AuditLogFilter = {
  limit?: number;
  offset?: number;
  category?: string;
  search?: string;
  from?: string; // ISO lower bound (inclusive)
  to?: string;   // ISO upper bound (inclusive)
};

export async function GetAuditLogs(
  restaurantId: string,
  opts: AuditLogFilter = {},
): Promise<AuditLogEntry[]> {
  const context = await requireRestaurantContext(restaurantId);
  const safeLimit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const safeOffset = Math.max(0, Math.round(opts.offset ?? 0));

  // Tenant scope is always $1/$2; optional filters append their own params so the
  // WHERE clause stays parameterized (no string interpolation of user input).
  const where: string[] = ["l.res_id = $1", "l.outlet_id = $2"];
  const params: unknown[] = [context.res_id, context.outlet_id];
  if (opts.category && opts.category !== "All") { params.push(opts.category); where.push(`l.category = $${params.length}::"Audit_log_cat"`); }
  if (opts.from) { params.push(opts.from); where.push(`l.created_at >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`l.created_at <= $${params.length}`); }
  if (opts.search && opts.search.trim()) {
    params.push(`%${opts.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(l.reason ILIKE ${p} OR a.action_name ILIKE ${p} OR e."emp_Fname" ILIKE ${p} OR lg.emp_username ILIKE ${p})`);
  }
  params.push(safeLimit); const limIdx = `$${params.length}`;
  params.push(safeOffset); const offIdx = `$${params.length}`;

  const rows = await runQuery<{
    id: string;
    created_at: Date;
    reason: string | null;
    category: string | null;
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
        l.category,
        a.action_name,
        lg.emp_username,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname
      from "Audit_logs" l
      join "Actions" a on a.id = l.action_id
      left join "Employees" e on e.id = l.employee_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      left join "Login" lg on lg.emp_id = e.id and lg.res_id = e.res_id and lg.outlet_id = e.outlet_id
      where ${where.join(" and ")}
      order by l.created_at desc
      limit ${limIdx} offset ${offIdx}
    `,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    employee:
      (`${row.fname ?? ""} ${row.lname ?? ""}`.trim() || row.emp_username || "Unknown"),
    action: row.action_name,
    category: row.category ?? "General",
    details: row.reason,
    timestamp: new Date(row.created_at),
  }));
}

// Lazy column: expiry tracking on inventory items (expiring-soon alerts).
async function ensureInventoryExpiryColumn(): Promise<void> {
  await ensureLazyTable("Inventory.expiry", async () => {
    await runQuery(`alter table "Inventory" add column if not exists expiry_date date`);
  });
}

// pg hands `date` columns back as a JS Date at LOCAL midnight — format from the
// local parts (toISOString would shift a day for TZs ahead of UTC, e.g. IST).
function formatDateOnly(v: unknown): string | null {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function GetInventoryItems(restaurantId: string): Promise<InventoryItemRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureInventoryExpiryColumn();
  const rows = await runQuery<{
    barcode: string;
    name: string;
    description: string | null;
    quantity: unknown;
    expiry_date: unknown;
  }>(
    `
      select
        barcode,
        name,
        description,
        "Quantity" as quantity,
        expiry_date
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
      expiry_date: formatDateOnly(row.expiry_date),
    };
  });
}

// Set (or clear, with null) the expiry date of an inventory item.
export async function SetInventoryExpiry(
  restaurantId: string,
  inventoryId: string,
  expiryDate: string | null,
): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureInventoryExpiryColumn();
  if (expiryDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    throw new Error("expiry_date must be YYYY-MM-DD or null");
  }
  const rows = await runQuery<{ barcode: string }>(
    `update "Inventory" set expiry_date = $4
       where res_id = $1 and outlet_id = $2 and barcode = $3
       returning barcode`,
    [context.res_id, context.outlet_id, inventoryId.trim(), expiryDate],
  );
  if (rows.length === 0) throw new Error("Inventory item not found");
  return { success: true };
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

// --- Vendors + stock movements (purchases / wastage) ------------------------
async function ensureVendorsTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Vendors", async () => {
    await runQuery(
      `create table if not exists "Vendors" (
         id uuid primary key, res_id uuid not null, outlet_id uuid,
         name text not null, phone text, email text, notes text,
         created_at timestamptz not null default now()
       )`,
    );
    await applyTenantRls("Vendors");
  });
}

export type VendorRecord = { id: string; name: string; phone: string | null; email: string | null; notes: string | null };

export async function GetVendors(restaurantId: string): Promise<VendorRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureVendorsTable();
  return runQuery<VendorRecord>(
    `select id, name, phone, email, notes from "Vendors" where res_id = $1 and outlet_id = $2 order by name asc`,
    [context.res_id, context.outlet_id],
  );
}

export async function AddVendor(restaurantId: string, input: { name: string; phone?: string; email?: string; notes?: string }): Promise<VendorRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureVendorsTable();
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Vendor name is required");
  const id = randomUUID();
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  const notes = input.notes?.trim() || null;
  await runQuery(
    `insert into "Vendors" (id, res_id, outlet_id, name, phone, email, notes) values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, context.res_id, context.outlet_id, name, phone, email, notes],
  );
  return { id, name, phone, email, notes };
}

export async function UpdateVendor(restaurantId: string, id: string, input: { name?: string; phone?: string; email?: string; notes?: string }): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureVendorsTable();
  const sets: string[] = [];
  const params: unknown[] = [id, context.res_id, context.outlet_id];
  let p = 4;
  if (typeof input.name === "string") { sets.push(`name = $${p++}`); params.push(input.name.trim()); }
  if (typeof input.phone === "string") { sets.push(`phone = $${p++}`); params.push(input.phone.trim() || null); }
  if (typeof input.email === "string") { sets.push(`email = $${p++}`); params.push(input.email.trim() || null); }
  if (typeof input.notes === "string") { sets.push(`notes = $${p++}`); params.push(input.notes.trim() || null); }
  if (sets.length === 0) return { success: true };
  await runQuery(`update "Vendors" set ${sets.join(", ")} where id = $1 and res_id = $2 and outlet_id = $3`, params);
  return { success: true };
}

export async function DeleteVendor(restaurantId: string, id: string): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureVendorsTable();
  await runQuery(`delete from "Vendors" where id = $1 and res_id = $2 and outlet_id = $3`, [id, context.res_id, context.outlet_id]);
  return { success: true };
}

async function ensureStockMovementsTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("StockMovements", async () => {
    await runQuery(
      `create table if not exists "StockMovements" (
         id uuid primary key, res_id uuid not null, outlet_id uuid,
         inventory_id text not null, item_name text, delta numeric not null, kind text not null,
         reason text, vendor_id uuid, unit_cost numeric,
         created_at timestamptz not null default now(), created_by text
       )`,
    );
    await applyTenantRls("StockMovements");
  });
}

async function adjustInventoryQty(context: RestaurantContext, inventoryId: string, delta: number, client: PoolClient): Promise<{ name: string; quantity: number } | null> {
  const rows = await runQuery<{ name: string; quantity: number | string }>(
    `update "Inventory" set "Quantity" = greatest(0, coalesce("Quantity", 0) + $4)
       where res_id = $1 and outlet_id = $2 and barcode = $3
       returning name, "Quantity" as quantity`,
    [context.res_id, context.outlet_id, inventoryId, delta],
    client,
  );
  return rows[0] ? { name: rows[0].name, quantity: parseNumeric(rows[0].quantity) } : null;
}

// Receive stock from a vendor (purchase): increments the item + logs a movement.
export async function ReceiveStock(
  restaurantId: string,
  input: { inventory_id: string; qty: number; vendor_id?: string; unit_cost?: number; note?: string; createdBy?: string },
): Promise<{ quantity: number }> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    await ensureStockMovementsTable(client);
    const qty = Math.max(0, Number(input.qty) || 0);
    if (qty <= 0) throw new Error("Quantity must be greater than zero");
    const item = await adjustInventoryQty(context, input.inventory_id, qty, client);
    if (!item) throw new Error("Inventory item not found");
    await runQuery(
      `insert into "StockMovements" (id, res_id, outlet_id, inventory_id, item_name, delta, kind, reason, vendor_id, unit_cost, created_by)
       values ($1, $2, $3, $4, $5, $6, 'purchase', $7, $8, $9, $10)`,
      [randomUUID(), context.res_id, context.outlet_id, input.inventory_id, item.name, qty, input.note?.trim() || null, input.vendor_id || null, input.unit_cost != null ? Number(input.unit_cost) : null, input.createdBy || null],
      client,
    );
    return { quantity: Math.round(item.quantity) };
  });
}

// Record wastage: decrements the item (clamped at 0) + logs a movement.
export async function RecordWastage(
  restaurantId: string,
  input: { inventory_id: string; qty: number; reason?: string; createdBy?: string },
): Promise<{ quantity: number }> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    await ensureStockMovementsTable(client);
    const qty = Math.max(0, Number(input.qty) || 0);
    if (qty <= 0) throw new Error("Quantity must be greater than zero");
    const item = await adjustInventoryQty(context, input.inventory_id, -qty, client);
    if (!item) throw new Error("Inventory item not found");
    await runQuery(
      `insert into "StockMovements" (id, res_id, outlet_id, inventory_id, item_name, delta, kind, reason, created_by)
       values ($1, $2, $3, $4, $5, $6, 'wastage', $7, $8)`,
      [randomUUID(), context.res_id, context.outlet_id, input.inventory_id, item.name, -qty, input.reason?.trim() || null, input.createdBy || null],
      client,
    );
    return { quantity: Math.round(item.quantity) };
  });
}

// Dedicated audit action so kitchen issues show up with an honest name in the log.
export const ISSUE_STOCK_ACTION_ID = "9c4b7d2e-6f18-4a53-b0e9-1d7a3c58f246";
async function ensureIssueStockAction(): Promise<void> {
  await ensureLazyTable("Actions.issue_stock", async () => {
    await runQuery(
      `insert into "Actions" (id, action_name, action_desc)
       values ($1, 'Issue Stock', 'Ingredient issued from store to kitchen')
       on conflict (id) do nothing`,
      [ISSUE_STOCK_ACTION_ID],
    ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
  });
}

// Latest known purchase cost per ingredient (from the StockMovements ledger).
async function getLatestUnitCosts(context: RestaurantContext, client?: PoolClient): Promise<Map<string, number>> {
  await ensureStockMovementsTable(client);
  const rows = await runQuery<{ inventory_id: string; unit_cost: number | string }>(
    `select distinct on (inventory_id) inventory_id, unit_cost
       from "StockMovements"
       where res_id = $1 and outlet_id = $2 and kind = 'purchase' and unit_cost is not null
       order by inventory_id, created_at desc`,
    [context.res_id, context.outlet_id],
    client,
  );
  return new Map(rows.map((r) => [r.inventory_id, parseNumeric(r.unit_cost)]));
}

// Issue stock from the store to the kitchen: decrements the item (clamped at 0)
// and logs a kind='issue' movement. The movement snapshots the latest purchase
// unit cost so the food-cost % KPI can value the issue even after prices move.
export async function IssueStock(
  restaurantId: string,
  input: { inventory_id: string; qty: number; note?: string; createdBy?: string },
): Promise<{ quantity: number; unit_cost: number | null }> {
  await ensureIssueStockAction();
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    await ensureStockMovementsTable(client);
    const qty = Math.max(0, Number(input.qty) || 0);
    if (qty <= 0) throw new Error("Quantity must be greater than zero");
    const item = await adjustInventoryQty(context, input.inventory_id, -qty, client);
    if (!item) throw new Error("Inventory item not found");
    const costRows = await runQuery<{ unit_cost: number | string }>(
      `select unit_cost from "StockMovements"
         where res_id = $1 and outlet_id = $2 and inventory_id = $3 and kind = 'purchase' and unit_cost is not null
         order by created_at desc limit 1`,
      [context.res_id, context.outlet_id, input.inventory_id],
      client,
    );
    const unitCost = costRows[0] ? parseNumeric(costRows[0].unit_cost) : null;
    await runQuery(
      `insert into "StockMovements" (id, res_id, outlet_id, inventory_id, item_name, delta, kind, reason, unit_cost, created_by)
       values ($1, $2, $3, $4, $5, $6, 'issue', $7, $8, $9)`,
      [randomUUID(), context.res_id, context.outlet_id, input.inventory_id, item.name, -qty, input.note?.trim() || null, unitCost, input.createdBy || null],
      client,
    );
    return { quantity: Math.round(item.quantity), unit_cost: unitCost };
  });
}

// Vendor price history for one ingredient: every costed purchase, oldest first.
export type PricePoint = { date: string; qty: number; unit_cost: number; vendor: string | null };
export async function GetVendorPriceHistory(restaurantId: string, inventoryId: string): Promise<{ item_name: string | null; points: PricePoint[] }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureStockMovementsTable();
  await ensureVendorsTable();
  const rows = await runQuery<{ created_at: Date; delta: number | string; unit_cost: number | string; item_name: string | null; vendor: string | null }>(
    `select m.created_at, m.delta, m.unit_cost, m.item_name, v.name as vendor
       from "StockMovements" m
       left join "Vendors" v on v.id = m.vendor_id and v.res_id = m.res_id
       where m.res_id = $1 and m.outlet_id = $2 and m.inventory_id = $3
         and m.kind = 'purchase' and m.unit_cost is not null
       order by m.created_at asc limit 200`,
    [context.res_id, context.outlet_id, inventoryId.trim()],
  );
  return {
    item_name: rows.length > 0 ? rows[rows.length - 1]!.item_name : null,
    points: rows.map((r) => ({
      date: new Date(r.created_at).toISOString(),
      qty: parseNumeric(r.delta),
      unit_cost: parseNumeric(r.unit_cost),
      vendor: r.vendor,
    })),
  };
}

// Theoretical (recipe/BOM) costing per dish. Ingredient unit cost = latest
// recorded purchase cost; dishes whose recipe references uncosted ingredients
// report a partial cost with missing_costs > 0 so the UI can flag it.
export type MenuCostingIngredient = { inventory_id: string; name: string; unit: string; qty: number; note: string | null; unit_cost: number | null; line_cost: number | null };
export type MenuCostingItem = {
  id: string;
  name: string;
  category: string;
  price: number;
  cost: number | null;        // Σ qty×unit_cost over costed ingredients (null without a recipe)
  margin_pct: number | null;  // (price − cost) ÷ price × 100
  missing_costs: number;      // recipe ingredients with no recorded purchase cost
  ingredients: MenuCostingIngredient[];
};
export async function GetMenuCosting(restaurantId: string): Promise<{
  items: MenuCostingItem[];
  ingredients: Array<{ id: string; name: string; unit: string; unit_cost: number | null }>;
}> {
  const context = await requireRestaurantContext(restaurantId);
  const [menu, inventory, unitCosts] = await Promise.all([
    GetMenuItems(restaurantId),
    GetInventoryItems(restaurantId),
    getLatestUnitCosts(context),
  ]);
  const invById = new Map(inventory.map((i) => [i.id, i]));
  const items = menu.map((m) => {
    const recipe = Array.isArray(m.recipe) ? m.recipe : [];
    let cost = 0;
    let costed = 0;
    let missing = 0;
    const ingredients: MenuCostingIngredient[] = recipe.map((r) => {
      const inv = invById.get(r.inventory_id);
      const unitCost = unitCosts.get(r.inventory_id) ?? null;
      const lineCost = unitCost != null ? round2(r.qty * unitCost) : null;
      if (lineCost != null) { cost += lineCost; costed += 1; } else { missing += 1; }
      return {
        inventory_id: r.inventory_id,
        name: inv?.name ?? r.inventory_id,
        unit: inv?.unit ?? "pcs",
        qty: r.qty,
        note: r.note ?? null,
        unit_cost: unitCost,
        line_cost: lineCost,
      };
    });
    const dishCost = costed > 0 ? round2(cost) : null;
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      price: m.price,
      cost: dishCost,
      margin_pct: dishCost != null && m.price > 0 ? round2(((m.price - dishCost) / m.price) * 100) : null,
      missing_costs: missing,
      ingredients,
    };
  });
  return {
    items,
    ingredients: inventory.map((i) => ({ id: i.id, name: i.name, unit: i.unit, unit_cost: unitCosts.get(i.id) ?? null })),
  };
}

export type StockMovementRow = { id: string; inventory_id: string; item_name: string | null; delta: number; kind: string; reason: string | null; vendor_id: string | null; unit_cost: number | null; created_at: string };

export async function GetStockMovements(restaurantId: string, fromIso?: string, toIso?: string): Promise<StockMovementRow[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureStockMovementsTable();
  const range = normalizeReportRange(fromIso, toIso);
  const rows = await runQuery<{ id: string; inventory_id: string; item_name: string | null; delta: number | string; kind: string; reason: string | null; vendor_id: string | null; unit_cost: number | string | null; created_at: Date }>(
    `select id, inventory_id, item_name, delta, kind, reason, vendor_id, unit_cost, created_at
       from "StockMovements"
       where res_id = $1 and outlet_id = $2 and created_at >= $3 and created_at < $4
       order by created_at desc limit 500`,
    [context.res_id, context.outlet_id, range.fromIso, range.toIso],
  );
  return rows.map((r) => ({
    id: r.id,
    inventory_id: r.inventory_id,
    item_name: r.item_name,
    delta: parseNumeric(r.delta),
    kind: r.kind,
    reason: r.reason,
    vendor_id: r.vendor_id,
    unit_cost: r.unit_cost != null ? parseNumeric(r.unit_cost) : null,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

// --- Purchase orders --------------------------------------------------------
// A PO records what was ordered from a vendor. Receiving against it increments
// inventory through the SAME StockMovements ledger as ad-hoc receive-stock and
// tracks qty_received per line, enabling expected-vs-received reconciliation.

export type PurchaseOrderItem = {
  inventory_id: string;
  name: string;
  qty_ordered: number;
  unit_cost: number;
  qty_received: number;
};
export type PurchaseOrderRecord = {
  id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  status: "draft" | "ordered" | "received" | "cancelled";
  items: PurchaseOrderItem[];
  total_cost: number;
  notes: string | null;
  expected_date: string | null;
  created_at: string;
  created_by: string | null;
  ordered_at: string | null;
  received_at: string | null;
  quality_rating: number | null;
};

async function ensurePurchaseOrdersTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("PurchaseOrders", async () => {
    await runQuery(
      `create table if not exists "PurchaseOrders" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         vendor_id uuid,
         vendor_name text,
         status text not null default 'draft',
         items jsonb not null default '[]'::jsonb,
         total_cost numeric not null default 0,
         notes text,
         expected_date date,
         created_at timestamptz not null default now(),
         created_by text,
         ordered_at timestamptz,
         received_at timestamptz
       )`,
    );
    await runQuery(`create index if not exists purchase_orders_lookup_idx on "PurchaseOrders" (res_id, outlet_id, status, created_at desc)`);
    // Delivery quality (1–5), rated when receiving — feeds the supplier score.
    await runQuery(`alter table "PurchaseOrders" add column if not exists quality_rating numeric`);
    await applyTenantRls("PurchaseOrders");
  });
}

function normalizePoItems(raw: unknown): PurchaseOrderItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PurchaseOrderItem[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const inventory_id = String(o.inventory_id ?? o.id ?? "").trim();
    const name = String(o.name ?? "").trim();
    const qty_ordered = Math.max(0, parseNumeric(o.qty_ordered ?? o.quantity ?? o.qty));
    const unit_cost = Math.max(0, parseNumeric(o.unit_cost ?? o.cost ?? 0));
    const qty_received = Math.max(0, parseNumeric(o.qty_received ?? 0));
    if (!inventory_id || qty_ordered <= 0) continue;
    out.push({ inventory_id, name, qty_ordered: round2(qty_ordered), unit_cost: round2(unit_cost), qty_received: round2(qty_received) });
  }
  return out;
}

function poTotal(items: PurchaseOrderItem[]): number {
  return round2(items.reduce((s, it) => s + it.qty_ordered * it.unit_cost, 0));
}

function mapPurchaseOrder(r: Record<string, any>): PurchaseOrderRecord {
  const iso = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  let items: PurchaseOrderItem[] = [];
  try { items = normalizePoItems(typeof r.items === "string" ? JSON.parse(r.items) : r.items); } catch { items = []; }
  const status = ["draft", "ordered", "received", "cancelled"].includes(r.status) ? r.status : "draft";
  return {
    id: r.id,
    vendor_id: r.vendor_id ?? null,
    vendor_name: r.vendor_name ?? null,
    status,
    items,
    total_cost: round2(parseNumeric(r.total_cost)),
    notes: r.notes ?? null,
    expected_date: r.expected_date ? String(r.expected_date).slice(0, 10) : null,
    created_at: iso(r.created_at) ?? "",
    created_by: r.created_by ?? null,
    ordered_at: iso(r.ordered_at),
    received_at: iso(r.received_at),
    quality_rating: r.quality_rating != null ? Number(r.quality_rating) : null,
  };
}

export async function CreatePurchaseOrder(
  restaurantId: string,
  input: { vendor_id?: string; vendor_name?: string; items: unknown; notes?: string; expected_date?: string; status?: string; createdBy?: string },
): Promise<PurchaseOrderRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePurchaseOrdersTable();
  const items = normalizePoItems(input.items);
  if (items.length === 0) throw new Error("A purchase order needs at least one item with a quantity");
  const status = input.status === "ordered" ? "ordered" : "draft";
  const expected = input.expected_date && /^\d{4}-\d{2}-\d{2}$/.test(input.expected_date) ? input.expected_date : null;
  const total = poTotal(items);
  let vendorName = input.vendor_name?.trim() || null;
  const vendorId = input.vendor_id?.trim() || null;
  if (!vendorName && vendorId) {
    await ensureVendorsTable();
    const v = await runQuery<{ name: string }>(`select name from "Vendors" where id = $1 and res_id = $2 limit 1`, [vendorId, context.res_id]);
    vendorName = v[0]?.name ?? null;
  }
  const rows = await runQuery<Record<string, any>>(
    `insert into "PurchaseOrders" (id, res_id, outlet_id, vendor_id, vendor_name, status, items, total_cost, notes, expected_date, created_by, ordered_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::date, $11, case when $6 = 'ordered' then now() else null end)
     returning *`,
    [randomUUID(), context.res_id, context.outlet_id, vendorId, vendorName, status, JSON.stringify(items), total, input.notes?.trim() || null, expected, input.createdBy || null],
  );
  if (!rows[0]) throw new Error("Failed to create purchase order");
  return mapPurchaseOrder(rows[0]);
}

export async function GetPurchaseOrders(restaurantId: string, opts?: { status?: string; from?: string; to?: string }): Promise<PurchaseOrderRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePurchaseOrdersTable();
  const range = normalizeReportRange(opts?.from, opts?.to);
  const params: unknown[] = [context.res_id, context.outlet_id, range.fromDate, range.toDate];
  let statusClause = "";
  if (opts?.status && ["draft", "ordered", "received", "cancelled"].includes(opts.status)) {
    params.push(opts.status);
    statusClause = ` and status = $${params.length}`;
  }
  const rows = await runQuery<Record<string, any>>(
    `select * from "PurchaseOrders"
       where res_id = $1 and outlet_id = $2 and created_at >= $3::date and created_at < ($4::date + interval '1 day')${statusClause}
       order by created_at desc`,
    params,
  );
  return rows.map(mapPurchaseOrder);
}

export async function GetPurchaseOrder(restaurantId: string, id: string): Promise<PurchaseOrderRecord | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePurchaseOrdersTable();
  const rows = await runQuery<Record<string, any>>(
    `select * from "PurchaseOrders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [id, context.res_id, context.outlet_id],
  );
  return rows[0] ? mapPurchaseOrder(rows[0]) : null;
}

export async function SetPurchaseOrderStatus(restaurantId: string, id: string, status: string): Promise<PurchaseOrderRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePurchaseOrdersTable();
  const next = ["draft", "ordered", "cancelled"].includes(status) ? status : null;
  if (!next) throw new Error("Invalid status");
  return withTransaction(async (client) => {
    const cur = await runQuery<{ status: string }>(`select status from "PurchaseOrders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`, [id, context.res_id, context.outlet_id], client);
    if (!cur[0]) throw new Error("Purchase order not found");
    if (cur[0].status === "received") throw new Error("A received purchase order can't change status");
    const rows = await runQuery<Record<string, any>>(
      `update "PurchaseOrders" set status = $1, ordered_at = case when $1 = 'ordered' and ordered_at is null then now() else ordered_at end
         where id = $2 and res_id = $3 and outlet_id = $4 returning *`,
      [next, id, context.res_id, context.outlet_id], client,
    );
    const updated = rows[0];
    if (!updated) throw new Error("Failed to update purchase order");
    return mapPurchaseOrder(updated);
  });
}

export async function ReceivePurchaseOrder(
  restaurantId: string,
  id: string,
  lines: Array<{ inventory_id: string; qty_received: number }>,
  receivedBy?: string,
  qualityRating?: number | null,
): Promise<PurchaseOrderRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePurchaseOrdersTable();
  await ensureStockMovementsTable();
  return withTransaction(async (client) => {
    const rows = await runQuery<Record<string, any>>(`select * from "PurchaseOrders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`, [id, context.res_id, context.outlet_id], client);
    const po = rows[0] ? mapPurchaseOrder(rows[0]) : null;
    if (!po) throw new Error("Purchase order not found");
    if (po.status === "cancelled") throw new Error("Cannot receive a cancelled purchase order");

    const byId = new Map(po.items.map((it) => [it.inventory_id, it]));
    const receiveMap = new Map<string, number>();
    for (const l of lines ?? []) {
      const invId = String(l?.inventory_id ?? "").trim();
      const q = Math.max(0, parseNumeric(l?.qty_received));
      if (invId && q > 0 && byId.has(invId)) receiveMap.set(invId, q);
    }
    if (receiveMap.size === 0) throw new Error("Nothing to receive");

    for (const [invId, q] of receiveMap) {
      const line = byId.get(invId);
      if (!line) continue;
      const item = await adjustInventoryQty(context, invId, q, client);
      await runQuery(
        `insert into "StockMovements" (id, res_id, outlet_id, inventory_id, item_name, delta, kind, reason, vendor_id, unit_cost, created_by)
         values ($1, $2, $3, $4, $5, $6, 'purchase', $7, $8, $9, $10)`,
        [randomUUID(), context.res_id, context.outlet_id, invId, item?.name ?? line.name, q, `PO ${id.slice(0, 8)}`, po.vendor_id, line.unit_cost || null, receivedBy || null],
        client,
      );
      line.qty_received = round2(line.qty_received + q);
    }
    const fullyReceived = po.items.every((it) => it.qty_received >= it.qty_ordered);
    const newStatus = fullyReceived ? "received" : "ordered";
    const rating = typeof qualityRating === "number" && qualityRating >= 1 && qualityRating <= 5 ? round2(qualityRating) : null;
    const out = await runQuery<Record<string, any>>(
      `update "PurchaseOrders"
          set items = $1::jsonb, status = $2,
              ordered_at = coalesce(ordered_at, now()),
              received_at = case when $2 = 'received' then now() else received_at end,
              quality_rating = coalesce($6, quality_rating)
        where id = $3 and res_id = $4 and outlet_id = $5 returning *`,
      [JSON.stringify(po.items), newStatus, id, context.res_id, context.outlet_id, rating], client,
    );
    const updated = out[0];
    if (!updated) throw new Error("Failed to update purchase order");
    return mapPurchaseOrder(updated);
  });
}

export async function DeletePurchaseOrder(restaurantId: string, id: string): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePurchaseOrdersTable();
  const cur = await runQuery<{ status: string }>(`select status from "PurchaseOrders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`, [id, context.res_id, context.outlet_id]);
  if (!cur[0]) return { success: true };
  if (cur[0].status === "received") throw new Error("A received purchase order can't be deleted (it affected stock)");
  await runQuery(`delete from "PurchaseOrders" where id = $1 and res_id = $2 and outlet_id = $3`, [id, context.res_id, context.outlet_id]);
  return { success: true };
}

// --- Marketing campaigns (ROI tracking) --------------------------------------
// A campaign is just a name + spend + date window; ROI compares bill revenue in
// the window against an equal-length window immediately before it.
export type CampaignRecord = {
  id: string;
  name: string;
  cost: number;
  starts_at: string; // YYYY-MM-DD
  ends_at: string;   // YYYY-MM-DD
  notes: string | null;
  created_at: string;
};

async function ensureCampaignsTable(): Promise<void> {
  await ensureLazyTable("Campaigns", async () => {
    await runQuery(
      `create table if not exists "Campaigns" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         name text not null,
         cost numeric not null default 0,
         starts_at date not null,
         ends_at date not null,
         notes text,
         created_at timestamptz not null default now()
       )`,
    );
    await applyTenantRls("Campaigns");
  });
}

function mapCampaign(r: Record<string, any>): CampaignRecord {
  // pg hands `date` columns back as a JS Date at LOCAL midnight — format from the
  // local parts (toISOString would shift a day for TZs ahead of UTC, e.g. IST).
  const d10 = (v: any): string => {
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    }
    return String(v ?? "").slice(0, 10);
  };
  return {
    id: r.id,
    name: r.name,
    cost: round2(parseNumeric(r.cost)),
    starts_at: d10(r.starts_at),
    ends_at: d10(r.ends_at),
    notes: r.notes ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
  };
}

export async function GetCampaigns(restaurantId: string): Promise<CampaignRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCampaignsTable();
  const rows = await runQuery<Record<string, any>>(
    `select * from "Campaigns" where res_id = $1 and outlet_id = $2 order by starts_at desc limit 50`,
    [context.res_id, context.outlet_id],
  );
  return rows.map(mapCampaign);
}

export async function CreateCampaign(
  restaurantId: string,
  input: { name: string; cost: number; starts_at: string; ends_at: string; notes?: string },
): Promise<CampaignRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCampaignsTable();
  const name = (input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Campaign name is required");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(input.starts_at) || !dateRe.test(input.ends_at)) throw new Error("Dates must be YYYY-MM-DD");
  if (input.ends_at < input.starts_at) throw new Error("End date must be on or after the start date");
  const cost = Math.max(0, round2(parseNumeric(input.cost)));
  const rows = await runQuery<Record<string, any>>(
    `insert into "Campaigns" (id, res_id, outlet_id, name, cost, starts_at, ends_at, notes)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8) returning *`,
    [randomUUID(), context.res_id, context.outlet_id, name, cost, input.starts_at, input.ends_at, input.notes?.trim() || null],
  );
  if (!rows[0]) throw new Error("Failed to create campaign");
  return mapCampaign(rows[0]);
}

export async function DeleteCampaign(restaurantId: string, id: string): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCampaignsTable();
  await runQuery(`delete from "Campaigns" where id = $1 and res_id = $2 and outlet_id = $3`, [id, context.res_id, context.outlet_id]);
  return { success: true };
}

// --- Payroll -------------------------------------------------------------------
// Per-employee pay configuration + one payment record per employee per month.
// Hourly staff are paid from Attendance hours (shifts capped at 16h to guard
// forgotten clock-outs); recording a payment also books a "Payroll" expense so
// P&L and the expense report stay truthful.
export type PayrollProfile = {
  emp_id: string;
  pay_type: "monthly" | "hourly";
  base_salary: number;   // per month (monthly staff)
  hourly_rate: number;   // per hour (hourly staff)
  allowances: number;    // added per month
  deductions: number;    // subtracted per month
  pf_pct: number;        // statutory PF %, applied to the gross (base / hours×rate)
  esi_pct: number;       // statutory ESI %, applied to the gross (base / hours×rate)
};

export type PayrollRow = {
  emp_id: string;
  name: string;
  role: string;
  profile: PayrollProfile | null;
  hours_worked: number;
  computed_pay: number | null; // null until a profile is configured
  pf_amount: number | null;    // statutory PF deducted this month
  esi_amount: number | null;   // statutory ESI deducted this month
  paid: boolean;
  paid_amount: number | null;
  paid_at: string | null;
};

async function ensurePayrollTables(): Promise<void> {
  await ensureLazyTable("Payroll", async () => {
    await runQuery(
      `create table if not exists "PayrollProfiles" (
         id uuid primary key default gen_random_uuid(),
         res_id uuid not null,
         outlet_id uuid,
         emp_id uuid not null,
         pay_type text not null default 'monthly',
         base_salary numeric not null default 0,
         hourly_rate numeric not null default 0,
         allowances numeric not null default 0,
         deductions numeric not null default 0,
         updated_at timestamptz not null default now(),
         unique (res_id, outlet_id, emp_id)
       )`,
    );
    await runQuery(
      `create table if not exists "PayrollPayments" (
         id uuid primary key default gen_random_uuid(),
         res_id uuid not null,
         outlet_id uuid,
         emp_id uuid not null,
         period text not null,
         amount numeric not null default 0,
         note text,
         paid_by text,
         paid_at timestamptz not null default now(),
         unique (res_id, outlet_id, emp_id, period)
       )`,
    );
    // Statutory deduction percentages (PF/ESI) — lazy columns so existing
    // installs pick them up on first use after deploy.
    await runQuery(`alter table "PayrollProfiles" add column if not exists pf_pct numeric not null default 0`);
    await runQuery(`alter table "PayrollProfiles" add column if not exists esi_pct numeric not null default 0`);
    await applyTenantRls("PayrollProfiles");
    await applyTenantRls("PayrollPayments");
  });
}

// Gross (base for monthly staff, hours×rate for hourly), statutory PF/ESI on
// that gross, and the net pay after allowances/deductions/statutory.
function payrollComputedPay(p: PayrollProfile, hours: number): { gross: number; pf: number; esi: number; net: number } {
  const gross = round2(p.pay_type === "hourly" ? hours * p.hourly_rate : p.base_salary);
  const pf = round2(gross * (p.pf_pct || 0) / 100);
  const esi = round2(gross * (p.esi_pct || 0) / 100);
  const net = round2(Math.max(0, gross + p.allowances - p.deductions - pf - esi));
  return { gross, pf, esi, net };
}

export async function GetPayroll(restaurantId: string, period: string): Promise<{ period: string; rows: PayrollRow[]; total_due: number; total_paid: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePayrollTables();
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("period must be YYYY-MM");
  const rid = context.res_id, oid = context.outlet_id;

  const emps = await runQuery<{ id: string; fname: string | null; lname: string | null; role: string | null }>(
    `select id, "emp_Fname" fname, "emp_Lname" lname, emp_roles->>'primary' role
       from "Employees" where res_id=$1 and outlet_id=$2 order by "emp_Fname"`,
    [rid, oid],
  );
  const profiles = await runQuery<PayrollProfile & { emp_id: string }>(
    `select emp_id, pay_type, base_salary::float base_salary, hourly_rate::float hourly_rate,
            allowances::float allowances, deductions::float deductions,
            coalesce(pf_pct, 0)::float pf_pct, coalesce(esi_pct, 0)::float esi_pct
       from "PayrollProfiles" where res_id=$1 and outlet_id=$2`,
    [rid, oid],
  );
  const hours = await runQuery<{ emp_id: string; hours: number }>(
    `select emp_id, coalesce(sum(least(extract(epoch from (clock_out - clock_in))/3600, 16)), 0)::float hours
       from "Attendance"
       where res_id=$1 and outlet_id=$2 and clock_out is not null and clock_out > clock_in
         and ${ATTENDANCE_COUNTED}
         and clock_in >= ($3 || '-01')::date and clock_in < (($3 || '-01')::date + interval '1 month')
       group by emp_id`,
    [rid, oid, period],
  );
  const payments = await runQuery<{ emp_id: string; amount: number; paid_at: Date }>(
    `select emp_id, amount::float amount, paid_at from "PayrollPayments" where res_id=$1 and outlet_id=$2 and period=$3`,
    [rid, oid, period],
  );

  const profByEmp = new Map(profiles.map((p) => [p.emp_id, p]));
  const hoursByEmp = new Map(hours.map((h) => [h.emp_id, h.hours]));
  const payByEmp = new Map(payments.map((p) => [p.emp_id, p]));

  const rows: PayrollRow[] = emps.map((e) => {
    const profile = profByEmp.get(e.id) ?? null;
    const hrs = round2(hoursByEmp.get(e.id) ?? 0);
    const pay = payByEmp.get(e.id);
    const prof: PayrollProfile | null = profile
      ? { emp_id: e.id, pay_type: profile.pay_type === "hourly" ? "hourly" : "monthly", base_salary: round2(profile.base_salary), hourly_rate: round2(profile.hourly_rate), allowances: round2(profile.allowances), deductions: round2(profile.deductions), pf_pct: round2(profile.pf_pct ?? 0), esi_pct: round2(profile.esi_pct ?? 0) }
      : null;
    const computed = prof ? payrollComputedPay(prof, hrs) : null;
    return {
      emp_id: e.id,
      name: `${e.fname ?? ""} ${e.lname ?? ""}`.trim() || "Employee",
      role: (e.role ?? "employee").trim(),
      profile: prof,
      hours_worked: hrs,
      computed_pay: computed ? computed.net : null,
      pf_amount: computed ? computed.pf : null,
      esi_amount: computed ? computed.esi : null,
      paid: !!pay,
      paid_amount: pay ? round2(pay.amount) : null,
      paid_at: pay ? pay.paid_at.toISOString() : null,
    };
  });
  const total_due = round2(rows.filter((r) => !r.paid && r.computed_pay != null).reduce((s, r) => s + (r.computed_pay ?? 0), 0));
  const total_paid = round2(rows.filter((r) => r.paid).reduce((s, r) => s + (r.paid_amount ?? 0), 0));
  return { period, rows, total_due, total_paid };
}

export async function SetPayrollProfile(
  restaurantId: string,
  empId: string,
  cfg: { pay_type?: string; base_salary?: number; hourly_rate?: number; allowances?: number; deductions?: number; pf_pct?: number; esi_pct?: number },
): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePayrollTables();
  if (!isUuid(empId)) throw new Error("Invalid employee");
  const payType = cfg.pay_type === "hourly" ? "hourly" : "monthly";
  const nn = (v: unknown) => round2(Math.max(0, Number(v) || 0));
  const pct = (v: unknown) => round2(Math.min(100, Math.max(0, Number(v) || 0)));
  await runQuery(
    `insert into "PayrollProfiles" (res_id, outlet_id, emp_id, pay_type, base_salary, hourly_rate, allowances, deductions, pf_pct, esi_pct, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     on conflict (res_id, outlet_id, emp_id) do update set
       pay_type=$4, base_salary=$5, hourly_rate=$6, allowances=$7, deductions=$8, pf_pct=$9, esi_pct=$10, updated_at=now()`,
    [context.res_id, context.outlet_id, empId, payType, nn(cfg.base_salary), nn(cfg.hourly_rate), nn(cfg.allowances), nn(cfg.deductions), pct(cfg.pf_pct), pct(cfg.esi_pct)],
  );
  return { success: true };
}

export async function RecordPayrollPayment(
  restaurantId: string,
  input: { emp_id: string; period: string; amount: number; note?: string; paidBy?: string },
): Promise<{ success: true; amount: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePayrollTables();
  if (!isUuid(input.emp_id)) throw new Error("Invalid employee");
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error("period must be YYYY-MM");
  const amount = round2(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw new Error("A positive amount is required");

  const inserted = await runQuery<{ id: string }>(
    `insert into "PayrollPayments" (res_id, outlet_id, emp_id, period, amount, note, paid_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (res_id, outlet_id, emp_id, period) do nothing
     returning id`,
    [context.res_id, context.outlet_id, input.emp_id, input.period, amount, input.note?.trim() || null, input.paidBy || null],
  );
  if (!inserted[0]) throw new Error("Salary for this month is already recorded for this employee");

  // Book it as a Payroll expense so P&L / expense reports include salaries.
  const emp = await runQuery<{ fname: string | null; lname: string | null }>(
    `select "emp_Fname" fname, "emp_Lname" lname from "Employees" where id=$1 and res_id=$2 limit 1`,
    [input.emp_id, context.res_id],
  );
  const empName = `${emp[0]?.fname ?? ""} ${emp[0]?.lname ?? ""}`.trim() || "employee";
  try {
    await AddExpense(restaurantId, {
      amount,
      category: "Payroll",
      note: `Salary ${input.period} — ${empName}${input.note ? ` (${input.note})` : ""}`,
      spent_on: new Date().toISOString().slice(0, 10),
      createdBy: input.paidBy,
    });
  } catch (err) {
    logger.warn({ err }, "payroll_expense_booking_failed"); // payment stands; expense is best-effort
  }
  return { success: true, amount };
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
      image_url: parsed.image_url,
      available: parsed.available,
      modifiers: parsed.modifiers,
      recipe: parsed.recipe,
      station: parsed.station,
      allergens: parsed.allergens,
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

  // Description-JSON fields the caller did NOT send (undefined) are preserved
  // from the stored row instead of being reset — a partial client (e.g. a price
  // edit or drag-reorder) must never silently wipe recipes/modifiers/images.
  // An explicit null/[] still clears the field.
  let merged = { image_url: item.image_url, available: item.available, modifiers: item.modifiers as unknown, recipe: item.recipe as unknown, station: item.station as unknown, allergens: item.allergens as unknown };
  if (
    itemId === item.id &&
    (item.image_url === undefined || item.available === undefined || item.modifiers === undefined || item.recipe === undefined || item.station === undefined || item.allergens === undefined)
  ) {
    const existingRows = await runQuery<{ description: string | null }>(
      `select description from "Menu" where id = $1 and res_id = $2 and outlet_id = $3`,
      [itemId, context.res_id, context.outlet_id],
      client,
    );
    if (existingRows[0]) {
      const existing = parseMenuDescription(existingRows[0].description);
      merged = {
        image_url: item.image_url === undefined ? existing.image_url : item.image_url,
        available: item.available === undefined ? existing.available : item.available,
        modifiers: item.modifiers === undefined ? existing.modifiers : item.modifiers,
        recipe: item.recipe === undefined ? existing.recipe : item.recipe,
        station: item.station === undefined ? existing.station : item.station,
        allergens: item.allergens === undefined ? existing.allergens : item.allergens,
      };
    }
  }

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
      encodeMenuDescription({ price: item.price, image_url: merged.image_url, available: merged.available, modifiers: merged.modifiers, recipe: merged.recipe, station: merged.station, allergens: merged.allergens }),
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
      // Pass the item through wholesale — UpsertMenuItem preserves any
      // description-JSON fields (recipe/modifiers/image/availability) the
      // caller left undefined, so bulk saves don't strip them.
      const upserted = await UpsertMenuItem(restaurantId, item, client);
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

// Rename a kitchen section ACROSS the menu: every item whose station matches
// `from` (case-insensitive) is re-encoded with station = `to`, in one
// transaction, preserving every other description-JSON field verbatim.
// Returns how many items were updated.
export async function RenameMenuStation(
  restaurantId: string,
  from: string,
  to: string,
): Promise<{ updated: number }> {
  const fromKey = from.trim().toLowerCase();
  const toName = to.trim().slice(0, 40);
  if (!fromKey || !toName) return { updated: 0 };
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const rows = await runQuery<{ id: string; description: string | null }>(
      `select id, description from "Menu" where res_id = $1 and outlet_id = $2`,
      [context.res_id, context.outlet_id],
      client,
    );
    let updated = 0;
    for (const row of rows) {
      const parsed = parseJsonObject(row.description);
      const station = typeof parsed?.station === "string" ? parsed.station.trim() : "";
      if (!station || station.toLowerCase() !== fromKey) continue;
      const next = JSON.stringify({ ...(parsed ?? {}), station: toName });
      await runQuery(
        `update "Menu" set description = $4 where id = $1 and res_id = $2 and outlet_id = $3`,
        [row.id, context.res_id, context.outlet_id, next],
        client,
      );
      updated += 1;
    }
    return { updated };
  });
}

// Rename an inventory category ACROSS the inventory: every item whose stored
// category matches `from` (case-insensitive) is re-encoded with category = `to`,
// in one transaction, preserving every other description-JSON field (e.g. unit).
// Mirrors RenameMenuStation (category lives in Inventory.description.category).
// Returns how many items were updated.
export async function RenameInventoryCategory(
  restaurantId: string,
  from: string,
  to: string,
): Promise<{ updated: number }> {
  const fromKey = from.trim().toLowerCase();
  const toName = to.trim().slice(0, 40);
  if (!fromKey || !toName) return { updated: 0 };
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const rows = await runQuery<{ barcode: string; description: string | null }>(
      `select barcode, description from "Inventory" where res_id = $1 and outlet_id = $2`,
      [context.res_id, context.outlet_id],
      client,
    );
    let updated = 0;
    for (const row of rows) {
      const parsed = parseJsonObject(row.description);
      const category = typeof parsed?.category === "string" ? parsed.category.trim() : "";
      if (!category || category.toLowerCase() !== fromKey) continue;
      const next = JSON.stringify({ ...(parsed ?? {}), category: toName });
      await runQuery(
        `update "Inventory" set description = $4 where barcode = $1 and res_id = $2 and outlet_id = $3`,
        [row.barcode, context.res_id, context.outlet_id, next],
        client,
      );
      updated += 1;
    }
    return { updated };
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

export async function DeleteMenuCategory(
  restaurantId: string,
  categoryName: string,
): Promise<{ deletedItems: number }> {
  const normalizedCategory = categoryName.trim();
  if (!normalizedCategory) {
    return { deletedItems: 0 };
  }

  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const categoryRows = await runQuery<{ id: string }>(
      `
        select id
        from "Menue_sub_cat"
        where res_id = $1 and outlet_id = $2 and lower(name) = lower($3)
      `,
      [context.res_id, context.outlet_id, normalizedCategory],
      client,
    );

    if (categoryRows.length === 0) {
      return { deletedItems: 0 };
    }

    const subCategoryIds = categoryRows.map((row) => row.id);
    const deletedMenuRows = await runQuery<{ id: string }>(
      `
        delete from "Menu"
        where res_id = $1 and outlet_id = $2 and sub_cat_id = any($3::uuid[])
        returning id
      `,
      [context.res_id, context.outlet_id, subCategoryIds],
      client,
    );

    await runQuery(
      `
        delete from "Menue_sub_cat"
        where res_id = $1 and outlet_id = $2 and id = any($3::uuid[])
      `,
      [context.res_id, context.outlet_id, subCategoryIds],
      client,
    );

    await runQuery(
      `
        delete from "Menue_main_cat" mm
        where mm.res_id = $1
          and mm.outlet_id = $2
          and not exists (
            select 1
            from "Menue_sub_cat" ms
            where ms.res_id = mm.res_id
              and ms.outlet_id = mm.outlet_id
              and ms.main_cat_id = mm.id
          )
      `,
      [context.res_id, context.outlet_id],
      client,
    );

    return { deletedItems: deletedMenuRows.length };
  });
}

export async function GetOrders(restaurantId: string, station?: string): Promise<OrderRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const og = isAllOutlets() ? "true" : "false";
  await ensureBillWorkflowColumns();
  await ensureOrderTimingColumn();
  await ensureOrderBarkColumns();
  const rows = await runQuery<{
    id: string;
    food: unknown;
    status: unknown;
    timing: unknown;
    barked_at: Date | string | null;
    table_name: string | null;
    bill_id: string | null;
    bill_status: number | null;
    payment_method: string | null;
    payment_proof_screenshot_url: string | null;
    waiter_confirmed_at: Date | null;
    waiter_confirmed_by_username: string | null;
    admin_approved_at: Date | null;
    admin_approved_by_username: string | null;
    closed_at: Date | null;
    closed_by_username: string | null;
  }>(
    `
      select
        o.id,
        o.food,
        o.status,
        o.timing,
        o.barked_at,
        t.table_name,
        b.bill_id,
        b.status as bill_status,
        b.payment_method,
        b.payment_proof_screenshot_url,
        b.waiter_confirmed_at,
        b.waiter_confirmed_by_username,
        b.admin_approved_at,
        b.admin_approved_by_username,
        b.closed_at,
        b.closed_by_username
      from "Orders" o
      left join "Tables" t
        on t.id = o.table_id and t.res_id = o.res_id and t.outlet_id = o.outlet_id
      left join lateral (
        select
          b.id as bill_id,
          b.status,
          b.payment_method,
          b.payment_proof_screenshot_url,
          b.waiter_confirmed_at,
          b.waiter_confirmed_by_username,
          b.admin_approved_at,
          b.admin_approved_by_username,
          b.closed_at,
          b.closed_by_username
        from "Bills" b
        where b.order_id = o.id and b.res_id = o.res_id and b.outlet_id = o.outlet_id
        order by b.created_at desc, b.id desc
        limit 1
      ) b on true
      where o.res_id = $1 and (${og} or o.outlet_id = $2)
        -- Live orders grid: recent OR any still-open bill (never hide an unsettled
        -- order). Old, closed orders belong to reports, not this hot-polled list —
        -- this bounds the previously all-time scan + per-row lateral join.
        and (o.created_at >= now() - interval '3 days' or b.closed_at is null)
      order by o.created_at desc
      limit 5000
    `,
    [context.res_id, context.outlet_id],
  );

  // Station lookup (KOT routing): order-item JSON does not persist the station —
  // it is enriched at read time from the menu (by menu id, then by dish name),
  // so re-assigning a dish's station retroactively fixes every open ticket.
  const stationById = new Map<string, string>();
  const stationByName = new Map<string, string>();
  try {
    const menu = await GetMenuItems(restaurantId);
    for (const m of menu) {
      if (!m.station) continue;
      stationById.set(String(m.id), m.station);
      stationByName.set(m.name.trim().toLowerCase(), m.station);
    }
  } catch {/* menu unavailable — orders still render, just without stations */}

  const mapEntry = (entry: any): OrderItemRecord => {
    const name = String(entry.name ?? "Unknown");
    return {
      id: String(entry.id ?? randomUUID()),
      name,
      quantity: Math.max(1, Math.round(parseNumeric(entry.quantity))),
      price: parseNumeric(entry.price),
      orderedAt: String(entry.orderedAt ?? new Date().toISOString()),
      note: typeof entry.note === "string" && entry.note.trim().length > 0 ? entry.note.trim() : null,
      station: stationById.get(String(entry.id ?? "")) ?? stationByName.get(name.trim().toLowerCase()) ?? null,
      course_hold: entry.course_hold === true,
      fired_at: typeof entry.fired_at === "string" && entry.fired_at ? entry.fired_at : null,
    };
  };

  // Optional per-station filter (locked kitchen display): keep only items whose
  // enriched station matches, case-insensitively. Applied AFTER enrichment; an
  // empty/unknown filter is a no-op. entryStation mirrors mapEntry's lookup so
  // it also works on the raw items_split tuples (which aren't run through mapEntry).
  const stationFilter = String(station ?? "").trim().toLowerCase();
  const entryStation = (entry: any): string =>
    String(stationById.get(String(entry?.id ?? "")) ?? stationByName.get(String(entry?.name ?? "").trim().toLowerCase()) ?? "").trim().toLowerCase();
  const entryMatches = (entry: any): boolean => entryStation(entry) === stationFilter;

  const result = rows.map((row) => {
    const payload = parseJsonObject(row.food) ?? {};
    // payload may contain a tuple-form items_split or legacy items array
    let items: OrderItemRecord[] = [];
    let items_split: any[] | undefined = undefined;
    if (Array.isArray(payload.items_split) && payload.items_split.length > 0) {
      items_split = payload.items_split;
      items = (payload.items_split as any[]).flatMap((t) => Array.isArray(t[1]) ? t[1] : []).map(mapEntry);
    } else if (Array.isArray(payload.items)) {
      // detect tuple form in payload.items for backward compatibility
      if (payload.items.length > 0 && Array.isArray(payload.items[0]) && typeof payload.items[0][0] === 'string' && Array.isArray(payload.items[0][1])) {
        items_split = payload.items;
        items = (payload.items as any[]).flatMap((t) => Array.isArray(t[1]) ? t[1] : []).map(mapEntry);
      } else {
        items = payload.items.map(mapEntry);
      }
    }

    // Drop items outside the requested station; drop empty split tuples too. An
    // order with nothing left for this station is omitted below (return null).
    if (stationFilter) {
      items = items.filter((it) => String(it.station ?? "").trim().toLowerCase() === stationFilter);
      if (items_split) {
        items_split = (items_split as any[])
          .map((t) => (Array.isArray(t) ? [t[0], (Array.isArray(t[1]) ? t[1] : []).filter(entryMatches)] : t))
          .filter((t) => Array.isArray(t) && Array.isArray(t[1]) && t[1].length > 0);
      }
      if (items.length === 0) return null;
    }

    const subtotal = parseNumeric(payload.subtotal);
    const total = parseNumeric(payload.total);
    // Prefer authoritative status from the DB row status column; fall back to embedded JSON payload.status
    const statusFromRow = fromOrderStatusCode(row.status);
    const statusFromPayload = (String(payload.status ?? "").trim() as OrderRecord["status"]) || undefined;
    const finalStatus = statusFromRow || statusFromPayload || 'Preparing';

    const resultObj: any = {
      id: row.id,
      table: String(payload.table ?? row.table_name ?? ""),
      customer: String(payload.customer ?? "Guest"),
      note: typeof payload.note === "string" && payload.note.trim().length > 0 ? payload.note.trim() : null,
      order_type: typeof payload.order_type === "string" && payload.order_type.trim().length > 0 ? payload.order_type.trim() : "dine_in",
      customer_phone: typeof payload.customer_phone === "string" && payload.customer_phone.trim().length > 0 ? payload.customer_phone.trim() : null,
      delivery_address: typeof payload.delivery_address === "string" && payload.delivery_address.trim().length > 0 ? payload.delivery_address.trim() : null,
      taken_by_employee_id:
        typeof payload.taken_by_employee_id === "string" && payload.taken_by_employee_id.trim().length > 0
          ? payload.taken_by_employee_id.trim()
          : null,
      taken_by_employee_name:
        typeof payload.taken_by_employee_name === "string" && payload.taken_by_employee_name.trim().length > 0
          ? payload.taken_by_employee_name.trim()
          : null,
      taken_by_employee_role:
        typeof payload.taken_by_employee_role === "string" && payload.taken_by_employee_role.trim().length > 0
          ? payload.taken_by_employee_role.trim()
          : null,
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
      status: finalStatus,
      payment_method: normalizePaymentMethod(row.payment_method),
      payment_proof_screenshot_url:
        typeof row.payment_proof_screenshot_url === "string" ? row.payment_proof_screenshot_url : null,
      payment_waiter_confirmed_at: row.waiter_confirmed_at ? new Date(row.waiter_confirmed_at).toISOString() : null,
      payment_waiter_confirmed_by: row.waiter_confirmed_by_username,
      payment_admin_approved_at: row.admin_approved_at ? new Date(row.admin_approved_at).toISOString() : null,
      payment_admin_approved_by: row.admin_approved_by_username,
      bill_closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
      bill_closed_by: row.closed_by_username,
      bill_id: row.bill_id ?? null,
      timing: parseJsonObject(row.timing) ?? null,
      barked_at: row.barked_at ? new Date(row.barked_at).toISOString() : null,
    };

    // include flattened and split representations if available
    if (items_split) {
      resultObj.items_split = items_split;
      resultObj.items_flattened = items;
    } else {
      // if no split available, still provide flattened
      resultObj.items_flattened = items;
    }

    return resultObj;
  });

  // Orders with no items for the requested station were mapped to null — drop them.
  return (stationFilter ? result.filter((o) => o !== null) : result) as OrderRecord[];
}

// ======================= Order / item preparation timing ===================
// Each order has a `timing` jsonb column: order-level + per-item timers tracking
// ordered -> preparing -> served durations, with pause/resume (excluded time).
type OrderTimer = { started_at: string | null; ended_at: string | null; paused: boolean; pause_started_at: string | null; paused_ms: number };
type OrderTiming = { ordered_at: string; order: OrderTimer; items: Record<string, OrderTimer> };

let orderTimingColEnsured = false;
async function ensureOrderTimingColumn(): Promise<void> {
  if (orderTimingColEnsured) return;
  await runQuery(`alter table "Orders" add column if not exists timing jsonb`);
  orderTimingColEnsured = true;
}

// "Barked" step: barked_at marks when the expo announced (barked) the order to
// the kitchen — every channel's orders arrive un-barked and dish prep timers
// only start at bark time. On first creation of the column, every pre-existing
// order is backfilled as already barked (created_at) so live restaurants keep
// their old timer semantics and nothing gets stuck behind the new step.
async function ensureOrderBarkColumns(): Promise<void> {
  await ensureLazyTable("Orders.bark_cols", async () => {
    const existing = await runQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'Orders' and column_name = 'barked_at'`,
    );
    await runQuery(`alter table "Orders" add column if not exists barked_at timestamptz`);
    await runQuery(`alter table "Orders" add column if not exists barked_by text`);
    if (!existing[0]) {
      // One-time backfill at column creation only — never on later boots, or a
      // restart would silently bark every order still awaiting its bark.
      await runQuery(`update "Orders" set barked_at = created_at where barked_at is null`);
    }
  });
}

// True when the order row has been barked to the kitchen (missing row → true so
// the caller's own not-found handling reports the better error).
async function isOrderBarked(context: RestaurantContext, orderId: string, client?: PoolClient): Promise<boolean> {
  await ensureOrderBarkColumns();
  const rows = await runQuery<{ barked_at: unknown }>(
    `select barked_at from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [orderId, context.res_id, context.outlet_id],
    client,
  );
  if (!rows[0]) return true;
  return Boolean(rows[0].barked_at);
}

async function assertOrderBarked(context: RestaurantContext, orderId: string, client?: PoolClient): Promise<void> {
  if (!(await isOrderBarked(context, orderId, client))) {
    throw new Error("Order has not been barked to the kitchen yet — bark it first.");
  }
}

function newTimer(started: boolean): OrderTimer {
  const now = new Date().toISOString();
  return { started_at: started ? now : null, ended_at: null, paused: false, pause_started_at: null, paused_ms: 0 };
}
function startTimer(t: OrderTimer | undefined): void { if (t && !t.started_at) t.started_at = new Date().toISOString(); }
function endTimer(t: OrderTimer | undefined): void {
  if (!t || !t.started_at || t.ended_at) return;
  if (t.paused && t.pause_started_at) { t.paused_ms += Date.now() - Date.parse(t.pause_started_at); t.paused = false; t.pause_started_at = null; }
  t.ended_at = new Date().toISOString();
}
function pauseTimer(t: OrderTimer | undefined): void { if (t && t.started_at && !t.ended_at && !t.paused) { t.paused = true; t.pause_started_at = new Date().toISOString(); } }
function resumeTimer(t: OrderTimer | undefined): void { if (t && t.paused && t.pause_started_at) { t.paused_ms += Date.now() - Date.parse(t.pause_started_at); t.paused = false; t.pause_started_at = null; } }
function timerElapsedMs(t: OrderTimer | undefined, nowMs: number): number {
  if (!t?.started_at) return 0;
  const end = t.ended_at ? Date.parse(t.ended_at) : nowMs;
  let paused = t.paused_ms ?? 0;
  if (t.paused && t.pause_started_at) paused += nowMs - Date.parse(t.pause_started_at);
  return Math.max(0, end - Date.parse(t.started_at) - paused);
}

function extractItemIds(food: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const collect = (arr: unknown) => { for (const it of (Array.isArray(arr) ? arr : [])) { const id = String((it as any)?.id ?? ""); if (id) ids.push(id); } };
  if (Array.isArray((food as any).items_split)) for (const t of (food as any).items_split) collect((t as any)?.[1]);
  else if (Array.isArray((food as any).items)) {
    const items = (food as any).items;
    if (items.length && Array.isArray(items[0])) for (const t of items) collect((t as any)?.[1]);
    else collect(items);
  }
  return ids;
}

// Item ids currently HELD (course_hold, not yet fired) — their prep timers must
// not start until the course is fired.
function extractHeldItemIds(food: Record<string, unknown>): Set<string> {
  const held = new Set<string>();
  const collect = (arr: unknown) => {
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const e = it as any;
      const id = String(e?.id ?? "");
      if (id && e?.course_hold === true && !e?.fired_at) held.add(id);
    }
  };
  if (Array.isArray((food as any).items_split)) for (const t of (food as any).items_split) collect((t as any)?.[1]);
  if (Array.isArray((food as any).items)) {
    const items = (food as any).items;
    if (items.length && Array.isArray(items[0])) for (const t of items) collect((t as any)?.[1]);
    else collect(items);
  }
  return held;
}

async function loadOrderTiming(context: RestaurantContext, orderId: string): Promise<OrderTiming | null> {
  await ensureOrderTimingColumn();
  await ensureOrderBarkColumns();
  const rows = await runQuery<{ timing: unknown; food: unknown; status: unknown; created_at: Date | string; barked_at: unknown }>(
    `select timing, food, status, created_at, barked_at from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [orderId, context.res_id, context.outlet_id],
  );
  if (!rows[0]) return null;
  const existing = parseJsonObject(rows[0].timing) as OrderTiming | null;
  if (existing && existing.order && existing.items) return existing;
  // Lazy init from current food + status. Un-barked orders never age.
  const food = parseJsonObject(rows[0].food) ?? {};
  const orderedAt = new Date((rows[0].created_at as string) ?? Date.now()).toISOString();
  const started = Boolean(rows[0].barked_at)
    && ["preparing", "served"].includes(String(fromOrderStatusCode(rows[0].status)).toLowerCase());
  const timing: OrderTiming = {
    ordered_at: orderedAt,
    order: { started_at: started ? orderedAt : null, ended_at: null, paused: false, pause_started_at: null, paused_ms: 0 },
    items: {},
  };
  const held = extractHeldItemIds(food);
  for (const id of extractItemIds(food)) timing.items[id] = { started_at: started && !held.has(id) ? orderedAt : null, ended_at: null, paused: false, pause_started_at: null, paused_ms: 0 };
  return timing;
}
async function saveOrderTiming(context: RestaurantContext, orderId: string, timing: OrderTiming): Promise<void> {
  await runQuery(`update "Orders" set timing = $1::jsonb where id = $2 and res_id = $3 and outlet_id = $4`,
    [JSON.stringify(timing), orderId, context.res_id, context.outlet_id]);
}

// Hook from SetOrderStatus / AddOrder: start timers on Preparing, end on Served.
// Held (course_hold) items are excluded from the start — they only begin ageing
// when the course is fired. Un-barked orders never start ageing here: their
// timers are (re)based at the moment of the bark instead.
async function applyTimingForStatus(context: RestaurantContext, orderId: string, status: string): Promise<void> {
  const s = status.toLowerCase();
  if (s !== "preparing" && s !== "served") return;
  const timing = await loadOrderTiming(context, orderId);
  if (!timing) return;
  if (s === "preparing") {
    const rows = await runQuery<{ food: unknown; barked_at: unknown }>(
      `select food, barked_at from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
      [orderId, context.res_id, context.outlet_id],
    );
    if (!rows[0] || !rows[0].barked_at) return; // awaiting bark — timers stay idle
    const held = extractHeldItemIds(parseJsonObject(rows[0].food) ?? {});
    startTimer(timing.order);
    for (const k of Object.keys(timing.items)) if (!held.has(k)) startTimer(timing.items[k]);
  } else {
    endTimer(timing.order);
    for (const k of Object.keys(timing.items)) endTimer(timing.items[k]);
  }
  await saveOrderTiming(context, orderId, timing);
}

// Pause/resume an order or a single item; mark an item served.
export async function OrderTimingAction(
  restaurantId: string,
  orderId: string,
  action: "pause" | "resume" | "serve" | "start",
  itemId?: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  // Kitchen/timer actions are meaningless on a settled (Paid/Closed) order and
  // would mutate a locked bill's order JSON — block them.
  await assertOrderStatusEditable(context, orderId);
  // Nothing is cooking before the bark — serve/start would fake prep times.
  if (action === "serve" || action === "start") await assertOrderBarked(context, orderId);
  const timing = await loadOrderTiming(context, orderId);
  if (!timing) return false;
  let target: OrderTimer;
  if (itemId) {
    if (!timing.items[itemId]) timing.items[itemId] = newTimer(true);
    target = timing.items[itemId];
  } else {
    target = timing.order;
  }
  switch (action) {
    case "pause": pauseTimer(target); break;
    case "resume": resumeTimer(target); break;
    case "start": startTimer(target); break;
    case "serve": startTimer(target); endTimer(target); break;
    default: return false;
  }
  await saveOrderTiming(context, orderId, timing);
  return true;
}

// Average prep time (bark -> served, pause-excluded) for served orders this
// month. timing.order.started_at is (re)based at bark time, so this measures
// honest kitchen time; legacy rows (pre-bark feature) start at Preparing.
export async function GetTimingStats(restaurantId: string): Promise<{ avg_prep_ms: number; max_prep_ms: number; count: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOrderTimingColumn();
  const now = await currentDbTime();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const rows = await runQuery<{ timing: unknown }>(
    `select timing from "Orders" where res_id = $1 and outlet_id = $2 and created_at >= $3 and timing is not null`,
    [context.res_id, context.outlet_id, monthStart],
  );
  let sum = 0, count = 0, max = 0;
  for (const r of rows) {
    const t = parseJsonObject(r.timing) as OrderTiming | null;
    if (!t?.order?.ended_at) continue;
    const e = timerElapsedMs(t.order, Date.now());
    sum += e; count += 1; if (e > max) max = e;
  }
  return { avg_prep_ms: count ? Math.round(sum / count) : 0, max_prep_ms: max, count };
}

// ======================= Course hold-and-fire + expo =======================

// Dedicated audit action so fired courses show up with an honest name in the log.
export const FIRE_COURSE_ACTION_ID = "a4b8f0d2-6c3e-4f7a-9b1d-5e8c2a7f4d90";
let fireCourseActionSeeded = false;
async function ensureFireCourseAction(): Promise<void> {
  if (fireCourseActionSeeded) return;
  await runQuery(
    `insert into "Actions" (id, action_name, action_desc)
     values ($1, 'Fire Course', 'Fired a held course to the kitchen')
     on conflict (id) do nothing`,
    [FIRE_COURSE_ACTION_ID],
  ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
  fireCourseActionSeeded = true;
}

// Fire held course items: stamp fired_at, clear course_hold (in both the flat
// items[] and the items_split tuples) and start their prep timers so KDS ageing
// begins at the moment of firing.
export async function FireOrderItems(
  restaurantId: string,
  orderId: string,
  itemIds: string[],
): Promise<{ fired: string[] }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureFireCourseAction();
  await assertOrderStatusEditable(context, orderId);
  // Courses fire into a kitchen that has the order — bark comes first.
  await assertOrderBarked(context, orderId);
  const rows = await runQuery<{ food: unknown }>(
    `select food from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [orderId, context.res_id, context.outlet_id],
  );
  if (!rows[0]) throw new Error("Order not found");

  const payload = parseJsonObject(rows[0].food) ?? {};
  const wanted = new Set(itemIds.map((i) => String(i).trim()).filter(Boolean));
  if (wanted.size === 0) throw new Error("item_ids is required");
  const nowIso = new Date().toISOString();
  const fired = new Set<string>();

  const touch = (arr: unknown) => {
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const e = it as any;
      const id = String(e?.id ?? "");
      if (!id || !wanted.has(id)) continue;
      if (e?.course_hold === true && !e?.fired_at) fired.add(id);
      e.course_hold = false;
      if (!e.fired_at) e.fired_at = nowIso;
    }
  };
  if (Array.isArray((payload as any).items_split)) for (const t of (payload as any).items_split) touch((t as any)?.[1]);
  if (Array.isArray((payload as any).items)) {
    const items = (payload as any).items;
    if (items.length && Array.isArray(items[0])) for (const t of items) touch((t as any)?.[1]);
    else touch(items);
  }
  if (fired.size === 0) throw new Error("No held items matched — they may already be fired");

  await runQuery(
    `update "Orders" set food = $1::json where id = $2 and res_id = $3 and outlet_id = $4`,
    [JSON.stringify(payload), orderId, context.res_id, context.outlet_id],
  );

  // Start the fired items' prep timers now.
  try {
    const timing = await loadOrderTiming(context, orderId);
    if (timing) {
      for (const id of fired) {
        if (!timing.items[id]) timing.items[id] = newTimer(true);
        else startTimer(timing.items[id]);
      }
      startTimer(timing.order);
      await saveOrderTiming(context, orderId, timing);
    }
  } catch (err) {
    logger.warn({ orderId, err }, "fire_course_timer_start_failed");
  }

  return { fired: Array.from(fired) };
}

// Dedicated audit action so barked orders show up with an honest name in the log.
export const BARK_ORDER_ACTION_ID = "3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63";
let barkOrderActionSeeded = false;
async function ensureBarkOrderAction(): Promise<void> {
  if (barkOrderActionSeeded) return;
  await runQuery(
    `insert into "Actions" (id, action_name, action_desc)
     values ($1, 'Bark Order', 'Barked (announced) an order to the kitchen')
     on conflict (id) do nothing`,
    [BARK_ORDER_ACTION_ID],
  ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
  barkOrderActionSeeded = true;
}

// Bark an order: the expo announces it to the kitchen — the visible step after
// acceptance (or straight after ordering when auto-push is on). Stamps
// barked_at (+ who barked), promotes a Pending order to Preparing, and
// (re)bases the order + non-held item prep timers at the bark instant so dish
// time only counts from the bark. Idempotent: re-barking returns the original
// timestamp untouched.
export async function BarkOrder(
  restaurantId: string,
  orderId: string,
  barkedBy?: string | null,
): Promise<{ barked_at: string; already_barked: boolean }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOrderBarkColumns();
  await ensureBarkOrderAction();
  await assertOrderStatusEditable(context, orderId);
  const rows = await runQuery<{ status: unknown; barked_at: Date | string | null; food: unknown }>(
    `select status, barked_at, food from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [orderId, context.res_id, context.outlet_id],
  );
  if (!rows[0]) throw new Error("Order not found");
  if (rows[0].barked_at) {
    return { barked_at: new Date(rows[0].barked_at).toISOString(), already_barked: true };
  }
  if (Number(rows[0].status ?? 0) === 5) throw new Error("A cancelled order cannot be barked");

  const nowIso = new Date().toISOString();
  // Barking a Pending order implies acceptance — it moves to Preparing too
  // (status expressions read the OLD row values, so both refer to pre-update 8).
  await runQuery(
    `
      update "Orders"
      set barked_at = $1,
          barked_by = $2,
          status = case when status = 8 then 1 else status end,
          food = case when status = 8
            then jsonb_set(coalesce(food::jsonb, '{}'::jsonb), '{status}', to_jsonb('Preparing'::text), true)
            else food::jsonb end
      where id = $3 and res_id = $4 and outlet_id = $5
    `,
    [nowIso, barkedBy ?? null, orderId, context.res_id, context.outlet_id],
  );

  // Rebase the prep timers on the bark instant: order timer + every non-held
  // item (held courses still start when fired), clearing any stale pause state.
  try {
    const timing = await loadOrderTiming(context, orderId);
    if (timing) {
      const food = parseJsonObject(rows[0].food) ?? {};
      const held = extractHeldItemIds(food);
      const rebase = (t: OrderTimer) => {
        if (t.ended_at) return; // an already-finished timer keeps its record
        t.started_at = nowIso;
        t.paused = false;
        t.pause_started_at = null;
        t.paused_ms = 0;
      };
      rebase(timing.order);
      for (const itemId of extractItemIds(food)) {
        if (held.has(itemId)) continue;
        if (!timing.items[itemId]) timing.items[itemId] = newTimer(false);
        rebase(timing.items[itemId]);
      }
      await saveOrderTiming(context, orderId, timing);
    }
  } catch (err) {
    logger.warn({ orderId, err }, "bark_timer_start_failed");
  }

  return { barked_at: nowIso, already_barked: false };
}

// Expo/pass screen: one card per active table consolidating every order's items
// with their kitchen state (served / preparing / held) + station.
export type ExpoItem = { name: string; qty: number; station: string | null; status: "served" | "preparing" | "held" | "unbarked" };
export type ExpoTable = { table: string; items: ExpoItem[]; ready_count: number; pending_count: number; source: string | null };
export async function GetExpoView(restaurantId: string): Promise<{ tables: ExpoTable[] }> {
  const orders = await GetOrders(restaurantId);
  const byTable = new Map<string, Map<string, ExpoItem>>();
  // Order channel per table (swiggy/zomato/takeaway/delivery) for the source badge.
  const sourceByTable = new Map<string, string>();

  for (const order of orders as any[]) {
    const status = String(order.status ?? "").toLowerCase();
    if (status !== "preparing" && status !== "served") continue; // settled/pending orders are not on the pass
    const table = String(order.table ?? "").trim() || "—";
    const channel = String(order.order_type ?? "").trim().toLowerCase();
    if (channel && channel !== "dine_in" && !sourceByTable.has(table)) sourceByTable.set(table, channel);

    // Ids sitting in a "Served" tuple count as served even without a timer.
    const servedIds = new Set<string>();
    for (const tup of (Array.isArray(order.items_split) ? order.items_split : [])) {
      const label = String(tup?.[0] ?? "").toLowerCase();
      if (!label.startsWith("serv")) continue;
      for (const it of (Array.isArray(tup?.[1]) ? tup[1] : [])) {
        const id = String((it as any)?.id ?? "");
        if (id) servedIds.add(id);
      }
    }
    const timers = ((order.timing as any)?.items ?? {}) as Record<string, any>;

    const bucket = byTable.get(table) ?? new Map<string, ExpoItem>();
    byTable.set(table, bucket);
    // Orders awaiting their bark sit greyed on the pass — nothing is cooking yet.
    const orderBarked = Boolean(order.barked_at);
    for (const item of (Array.isArray(order.items) ? order.items : []) as OrderItemRecord[]) {
      let state: ExpoItem["status"] = "preparing";
      if (!orderBarked) state = "unbarked";
      else if (item.course_hold === true && !item.fired_at) state = "held";
      else if (servedIds.has(item.id) || timers[item.id]?.ended_at) state = "served";
      const key = `${item.name.toLowerCase()}::${item.station ?? ""}::${state}`;
      const existing = bucket.get(key);
      if (existing) existing.qty += item.quantity;
      else bucket.set(key, { name: item.name, qty: item.quantity, station: item.station ?? null, status: state });
    }
  }

  const tables: ExpoTable[] = [];
  for (const [table, bucket] of byTable.entries()) {
    const items = Array.from(bucket.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 0) continue;
    const ready = items.filter((i) => i.status === "served").reduce((s, i) => s + i.qty, 0);
    const pending = items.filter((i) => i.status !== "served").reduce((s, i) => s + i.qty, 0);
    tables.push({ table, items, ready_count: ready, pending_count: pending, source: sourceByTable.get(table) ?? null });
  }
  tables.sort((a, b) => a.table.localeCompare(b.table, undefined, { numeric: true }));
  return { tables };
}

export async function UpdateOrderItemsSplit(
  restaurantId: string,
  orderId: string,
  items_split: any[],
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  if (!Array.isArray(items_split)) throw new Error('items_split must be an array');
  await assertOrderStatusEditable(context, orderId);

  // build flattened items
  const flattened = (items_split as any[]).flatMap((t) => Array.isArray(t[1]) ? t[1] : []);

  // fetch existing order to preserve other fields
  const existing = await runQuery<{ food: unknown }>(
    `select food from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [orderId, context.res_id, context.outlet_id],
  );
  if (!existing[0]) throw new Error('Order not found');

  const payload = parseJsonObject(existing[0].food) ?? {};
  // determine order status: if any Preparing tuple contains one or more items -> Preparing, else Served
  const hasPreparingItems = Array.isArray(items_split) && (items_split as any[]).some((t) => {
    const label = String(t?.[0] ?? "").toLowerCase();
    const list = Array.isArray(t?.[1]) ? t[1] : [];
    return label.includes('prepar') && list.length > 0;
  });
  const newStatus = hasPreparingItems ? 'Preparing' : 'Served';
  // Drag-dropping every item into Served must not skip the bark step.
  if (newStatus === 'Served') await assertOrderBarked(context, orderId);

  // include status in the food JSON payload so UI can read textual status
  const newPayload = { ...payload, items: flattened, items_split, status: newStatus };
  // update both the JSON food column and the numeric status column
  await runQuery(
    `update "Orders" set food = $1::json, status = $2 where id = $3 and res_id = $4 and outlet_id = $5`,
    [JSON.stringify(newPayload), toOrderStatusCode(newStatus), orderId, context.res_id, context.outlet_id],
  );

  return true;
}

const LOW_STOCK_THRESHOLD = 5;
// Auto-deduct inventory for sold items per their menu recipe; notify on low stock.
async function consumeInventory(restaurantId: string, context: RestaurantContext, soldItems: unknown[]): Promise<void> {
  if (!Array.isArray(soldItems) || soldItems.length === 0) return;
  const menu = await GetMenuItems(restaurantId).catch(() => [] as MenuItemRecord[]);
  if (menu.length === 0) return;
  const byId = new Map(menu.map((m) => [m.id, m]));
  const byName = new Map(menu.map((m) => [m.name.toLowerCase(), m]));
  const deltas = new Map<string, number>();
  for (const raw of soldItems) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const m = byId.get(String(it.id ?? "")) ?? byName.get(String(it.name ?? "").toLowerCase());
    const recipe = m?.recipe;
    if (!Array.isArray(recipe) || recipe.length === 0) continue;
    const qty = Math.max(1, Math.round(parseNumeric(it.quantity) || 1));
    for (const ing of recipe) deltas.set(ing.inventory_id, (deltas.get(ing.inventory_id) ?? 0) + ing.qty * qty);
  }
  if (deltas.size === 0) return;
  // Deduct ALL ingredients in ONE statement (was N awaited UPDATEs inside the
  // order transaction, which lengthened lock-hold time with menu complexity).
  const invIds = [...deltas.keys()];
  const amounts = invIds.map((k) => deltas.get(k) ?? 0);
  const rows = await runQuery<{ name: string; quantity: number; inv_id: string; delta: number }>(
    `update "Inventory" inv
        set "Quantity" = greatest(0, coalesce(inv."Quantity", 0) - d.delta)
       from unnest($1::text[], $2::numeric[]) as d(inv_id, delta)
      where inv.barcode = d.inv_id and inv.res_id = $3 and inv.outlet_id = $4
      returning inv.name as name, inv."Quantity" as quantity, d.inv_id as inv_id, d.delta as delta`,
    [invIds, amounts, context.res_id, context.outlet_id],
  ).catch(() => [] as { name: string; quantity: number; inv_id: string; delta: number }[]);
  for (const row of rows) {
    const newQty = parseNumeric(row.quantity);
    const delta = parseNumeric(row.delta);
    // Notify only when crossing below the threshold (avoids per-order spam).
    if (newQty <= LOW_STOCK_THRESHOLD && newQty + delta > LOW_STOCK_THRESHOLD) {
      try {
        await AddNotification(restaurantId, {
          type: "stock",
          title: `Low stock: ${row.name}`,
          body: `${Math.round(newQty)} left — reorder soon`,
          meta: { inventory_id: row.inv_id },
        });
      } catch {/* ignore */}
    }
  }
}

export async function AddOrder(
  restaurantId: string,
  order: Partial<OrderRecord>,
): Promise<{ id: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableOccupancyColumns();
  await ensureOrderBarkColumns();
  const tableName = String(order.table ?? "").trim();
  if (!tableName) {
    throw new Error("Order table is required");
  }

  const tableRows = await runQuery<{ id: string; is_occupied: boolean }>(
    `
      select id, coalesce(is_occupied, false) as is_occupied
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
      limit 1
    `,
    [context.res_id, context.outlet_id, tableName],
  );
  const table = tableRows[0];
  if (!table) {
    throw new Error("Table not found for order");
  }

  if (!table.is_occupied) {
    throw new Error("Cannot add order to unoccupied table. Please occupy the table first.");
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
  const existingOrderRows = await runQuery<{ food: unknown; barked_at: Date | string | null }>(
    `
      select food, barked_at
      from "Orders"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [id, context.res_id, context.outlet_id],
  );
  const existingPayload = parseJsonObject(existingOrderRows[0]?.food) ?? {};
  const existingBarkedAt = existingOrderRows[0]?.barked_at
    ? new Date(existingOrderRows[0].barked_at).toISOString()
    : null;
  const isNewOrder = !existingOrderRows[0];
  // An upsert must never resurrect/overwrite a settled (Paid/Closed) order — the
  // bill is view-once after settlement.
  if (!isNewOrder) await assertOrderStatusEditable(context, id);


  const takenByEmployeeIdRaw = String(
    (order as Record<string, unknown>).taken_by_employee_id
    ?? existingPayload.taken_by_employee_id
    ?? "",
  ).trim();
  const takenByEmployeeNameRaw = String(
    (order as Record<string, unknown>).taken_by_employee_name
    ?? existingPayload.taken_by_employee_name
    ?? "",
  ).trim();
  const takenByEmployeeRoleRaw = String(
    (order as Record<string, unknown>).taken_by_employee_role
    ?? existingPayload.taken_by_employee_role
    ?? "",
  ).trim();

  let statusCode = toOrderStatusCode(String(order.status ?? "Preparing"));
  // Support two shapes for items:
  // 1) legacy: items = [ { id, name, quantity, price, orderedAt, note? }, ... ]
  // 2) split: items = [ ["Served", [ ... ]], ["Preparing", [ ... ]] ]
  let itemsForStore: unknown[] = [];
  let itemsSplitForStore: unknown = undefined;
  if (Array.isArray(order.items) && order.items.length > 0 && Array.isArray(order.items[0]) && typeof (order.items[0] as any)[0] === 'string' && Array.isArray((order.items[0] as any)[1])) {
    // tuple format
    itemsSplitForStore = order.items;
    itemsForStore = (order.items as any[]).flatMap((t) => Array.isArray(t[1]) ? t[1] : []);
  } else {
    itemsForStore = Array.isArray(order.items) ? order.items : [];
  }

  // If this is an update to an existing order (upsert) and caller provided a legacy items array,
  // merge incoming items with existing items_split (or existing items) so that:
  // - newly added items are appended to the Preparing tuple
  // - existing items keep their previous Served/Preparing assignment
  // - if incoming quantity for an existing item is larger than previous, the delta is added as a new Preparing item
  if (existingOrderRows[0]) {
    try {
      const existingItems: any[] = Array.isArray(existingPayload.items_split) && existingPayload.items_split.length > 0
        ? (existingPayload.items_split as any[]).flatMap((t) => Array.isArray(t[1]) ? t[1] : [])
        : Array.isArray(existingPayload.items) ? existingPayload.items : [];

      const existingById = new Map<string, any>();
      for (const it of existingItems) {
        const idStr = String(it?.id ?? "");
        if (idStr) existingById.set(idStr, { ...it });
      }

      // incoming items (from the request) as parsed earlier into itemsForStore
      const incoming = Array.isArray(itemsForStore) ? (itemsForStore as any[]) : [];

      const preparedNewItems: any[] = [];

      // build merged flattened map: start from existing, then apply incoming quantities
      const mergedById = new Map<string, any>();
      for (const [id, it] of existingById.entries()) {
        mergedById.set(id, { ...it });
      }

      for (const inc of incoming) {
        const incId = String(inc?.id ?? "");
        const incQty = Number(inc?.quantity ?? 1) || 1;
        if (incId && mergedById.has(incId)) {
          const prev = mergedById.get(incId);
          const prevQty = Number(prev.quantity ?? 0) || 0;
          if (incQty > prevQty) {
            const delta = incQty - prevQty;
            // keep merged quantity as the incoming total
            mergedById.set(incId, { ...prev, quantity: incQty });
            // create a distinct new item representing the added quantity and append to Preparing
            preparedNewItems.push({ ...inc, id: randomUUID(), quantity: delta });
          } else {
            // incoming does not increase quantity -> keep prev or update to incoming
            mergedById.set(incId, { ...prev, quantity: incQty });
          }
        } else {
          // entirely new item -> ensure it has a unique id and mark as new (Preparing)
          const newId = incId || randomUUID();
          mergedById.set(newId, { ...inc, id: newId });
          preparedNewItems.push({ ...inc, id: newId });
        }
      }

      // final flattened array
      const mergedFlattened = Array.from(mergedById.values()).map((it) => ({ ...it }));

      // start from existing tuples if present else synthesize default Served/Preparing
      const rawSplit = Array.isArray(existingPayload.items_split) && existingPayload.items_split.length > 0
        ? JSON.parse(JSON.stringify(existingPayload.items_split)) as any[]
        : [["Served", mergedFlattened], ["Preparing", []]] as any[];

      // normalize and dedupe existing tuples (preserve first occurrence)
      const seen = new Set<string>();
      const normalized: any[] = [];
      for (const tup of rawSplit) {
        const label = String(tup?.[0] ?? "").trim() || "";
        const arr = Array.isArray(tup?.[1]) ? tup[1] : [];
        const filtered: any[] = [];
        for (const it of arr) {
          const id = String(it?.id ?? "");
          if (!id) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          // prefer merged quantity if available
          const merged = mergedById.get(id);
          filtered.push(merged ? { ...merged } : { ...it });
        }
        normalized.push([label, filtered]);
      }

      // ensure Preparing tuple exists
      let preparingIndex = normalized.findIndex((t: any) => String(t?.[0] ?? "").toLowerCase().includes('prepar'));
      if (preparingIndex === -1) {
        normalized.push(["Preparing", []]);
        preparingIndex = normalized.length - 1;
      }

      // append new prepared items (these represent newly added quantities)
      normalized[preparingIndex][1] = normalized[preparingIndex][1] || [];
      for (const it of preparedNewItems) {
        // avoid duplicates
        const id = String(it.id ?? "");
        if (!seen.has(id)) {
          seen.add(id);
          normalized[preparingIndex][1].push(it);
        }
      }

      // set itemsSplitForStore and itemsForStore to merged values for storage
      itemsSplitForStore = normalized;
      itemsForStore = mergedFlattened;

      // if any new items were added, ensure status becomes Preparing
      if (preparedNewItems.length > 0) {
        // override status so the order shows Preparing
        (order as any).status = 'Preparing';
        statusCode = toOrderStatusCode('Preparing');
      }
    } catch (err) {
      // non-fatal: fall back to original behavior
      logger.warn({ err }, 'merge_incoming_items_failed');
    }
  }

  // "Barked" step: new orders always arrive UN-barked — the expo barks them to
  // the kitchen and only then do prep timers run. Exceptions already past the
  // kitchen queue: a caller-supplied barked_at (moved/auto-barked lines) and a
  // brand-new order born Served (e.g. the valet fee line).
  const barkedAtInput = typeof (order as Record<string, unknown>).barked_at === "string" && String((order as Record<string, unknown>).barked_at).trim()
    ? new Date(String((order as Record<string, unknown>).barked_at)).toISOString()
    : null;
  const barkedAt = existingBarkedAt
    ?? barkedAtInput
    ?? (isNewOrder && statusCode === 2 ? new Date().toISOString() : null);
  // An un-barked order cannot be pushed past the kitchen queue.
  if (!barkedAt && (statusCode === 2 || statusCode === 3)) {
    throw new Error("Order has not been barked to the kitchen yet — bark it first.");
  }

  const payload: any = {
    id,
    table: tableName,
    customer: customerName || "Guest",
    taken_by_employee_id: takenByEmployeeIdRaw || null,
    taken_by_employee_name: takenByEmployeeNameRaw || null,
    taken_by_employee_role: takenByEmployeeRoleRaw || null,
    items: itemsForStore,
    subtotal: parseNumeric(order.subtotal),
    serviceChargePercentage: parseNumeric(order.serviceChargePercentage),
    taxes: Array.isArray(order.taxes) ? order.taxes : [],
    applyServiceCharge: Boolean(order.applyServiceCharge),
    total: parseNumeric(order.total),
    status: String(order.status ?? "Preparing"),
    // Free-text order note / special instructions (kitchen + bill). Preserved on
    // upsert when the caller doesn't supply one.
    note:
      typeof (order as Record<string, unknown>).note === "string"
        ? String((order as Record<string, unknown>).note).trim().slice(0, 500)
        : (typeof existingPayload.note === "string" ? existingPayload.note : null),
    // Order channel: dine_in (default) / takeaway / delivery, plus optional
    // delivery contact details. Preserved on upsert.
    order_type:
      typeof (order as Record<string, unknown>).order_type === "string" && String((order as Record<string, unknown>).order_type).trim()
        ? String((order as Record<string, unknown>).order_type).trim().toLowerCase()
        : (typeof existingPayload.order_type === "string" ? existingPayload.order_type : "dine_in"),
    customer_phone:
      typeof (order as Record<string, unknown>).customer_phone === "string"
        ? String((order as Record<string, unknown>).customer_phone).trim()
        : (typeof existingPayload.customer_phone === "string" ? existingPayload.customer_phone : null),
    delivery_address:
      typeof (order as Record<string, unknown>).delivery_address === "string"
        ? String((order as Record<string, unknown>).delivery_address).trim()
        : (typeof existingPayload.delivery_address === "string" ? existingPayload.delivery_address : null),
  };
  if (itemsSplitForStore !== undefined) payload.items_split = itemsSplitForStore;

  await runQuery(
    `
      insert into "Orders"
        (id, created_at, res_id, outlet_id, food, table_id, status, cust_id, barked_at)
      values
        ($1, now(), $2, $3, $4::json, $5, $6, $7, $8)
      on conflict (id, res_id, outlet_id)
      do update set
        food = excluded.food,
        table_id = excluded.table_id,
        status = excluded.status,
        cust_id = coalesce(excluded.cust_id, "Orders".cust_id),
        barked_at = coalesce("Orders".barked_at, excluded.barked_at)
    `,
    [id, context.res_id, context.outlet_id, JSON.stringify(payload), table.id, statusCode, customerId, barkedAt],
  );

  // Ensure the Tables.row linked_order_id is updated to point to this order
  try {
    await runQuery(
      `
        update "Tables"
        set linked_order_id = $1
        where id = $2 and res_id = $3 and outlet_id = $4
      `,
      [id, table.id, context.res_id, context.outlet_id],
    );
  } catch (err) {
    logger.warn({ id, err }, 'failed to update Tables.linked_order_id for order');
  }

  // Keep the table's open bill (if one exists) in sync with all its orders, so
  // every order placed on an occupied table is reflected in its single bill.
  try {
    const openBill = await runQuery<{ id: string }>(
      `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
      [table.id, context.res_id, context.outlet_id],
    );
    if (openBill[0]) {
      const consolidated = await sumOrderTotalsForTable(context, table.id);
      await runQuery(
        `update "Bills" set total_amt = $1 where id = $2 and res_id = $3 and outlet_id = $4`,
        [consolidated, openBill[0].id, context.res_id, context.outlet_id],
      );
    }
  } catch (err) {
    logger.warn({ id, err }, 'failed to sync table bill for order');
  }

  // Seed / sync preparation timing (order + per-item timers). Held
  // (course_hold) items stay unstarted — they begin ageing only when fired.
  // Un-barked orders (every new one) stay unstarted too: bark starts the clock.
  try {
    const timing = await loadOrderTiming(context, id);
    if (timing) {
      const started = statusCode === 1 && barkedAt !== null;
      const held = extractHeldItemIds(payload);
      for (const itemId of extractItemIds(payload)) {
        if (!timing.items[itemId]) timing.items[itemId] = newTimer(started && !held.has(itemId));
      }
      if (started) {
        startTimer(timing.order);
        for (const k of Object.keys(timing.items)) if (!held.has(k)) startTimer(timing.items[k]);
      }
      await saveOrderTiming(context, id, timing);
    }
  } catch (err) {
    logger.warn({ id, err }, 'failed to seed order timing for order');
  }

  // Auto-deduct inventory for the items just placed (new orders only).
  if (isNewOrder) {
    try { await consumeInventory(restaurantId, context, itemsForStore); } catch (err) { logger.warn({ id, err }, 'inventory deduct failed for order'); }
  }

  return { id };
}

// Link an order to a Customers row (guest CRM). Used by the best-effort
// order→customer registration in the QR / staff order routes.
export async function SetOrderCustomerId(
  restaurantId: string,
  orderId: string,
  custId: string,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await runQuery(
    `update "Orders" set cust_id = $4 where id = $1 and res_id = $2 and outlet_id = $3`,
    [orderId, context.res_id, context.outlet_id, custId],
  );
}

export async function DeleteOrder(
  restaurantId: string,
  orderId: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  // Must return (and await via return) the transaction — a floating promise here
  // ran the DELETE detached on the request's pooled client (racing connection
  // release) and the route always saw `false` → a spurious 404 on every delete.
  return withTransaction(async (client) => {
    const rows = await runQuery<{ id: string }>(
      `
        delete from "Orders"
        where id = $1 and res_id = $2 and outlet_id = $3
        returning id
      `,
      [orderId.trim(), context.res_id, context.outlet_id],
      client,
    );

    if (rows.length === 0) return false;

    await runQuery<{}>(
      `
        update "Tables"
        set linked_order_id = null
        where linked_order_id = $1 and res_id = $2 and outlet_id = $3
      `,
      [orderId.trim(), context.res_id, context.outlet_id],
      client,
    );

    return rows.length > 0;
  });
}

// important: convert the whole proceess to atomic
// The consolidated bill for a table = sum of all its non-cancelled orders.
// Used so a table has exactly ONE bill that always reflects every order placed,
// computed idempotently (re-billing or editing an order never double-counts).
async function sumOrderTotalsForTable(
  context: RestaurantContext,
  tableId: string,
  client?: PoolClient,
): Promise<number> {
  const rows = await runQuery<{ food: unknown; status: unknown }>(
    `select food, status from "Orders" where res_id = $1 and outlet_id = $2 and table_id = $3`,
    [context.res_id, context.outlet_id, tableId],
    client,
  );
  let sum = 0;
  for (const r of rows) {
    // Only the CURRENT occupancy counts: skip cancelled/paid/closed orders so a
    // re-occupied table never re-sums a previous session's (closed) orders.
    const st = String(fromOrderStatusCode(r.status) ?? "").toLowerCase();
    if (st === "cancelled" || st === "paid" || st === "closed") continue;
    const p = parseJsonObject(r.food) ?? {};
    const total = parseNumeric(p.total) > 0 ? parseNumeric(p.total) : parseNumeric(p.subtotal);
    sum += total;
  }
  return round2(sum);
}

// Resolve a table id by name within a tenant context.
async function tableIdByName(context: RestaurantContext, tableName: string, client?: PoolClient): Promise<string | null> {
  const rows = await runQuery<{ id: string }>(
    `select id from "Tables" where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3) and coalesce(is_deleted, false) = false limit 1`,
    [context.res_id, context.outlet_id, tableName.trim()],
    client,
  );
  return rows[0]?.id ?? null;
}

// Remove a line item (matched by name + price, as shown on the consolidated
// bill) from a table's active orders — across however many orders it spans.
// Recomputes order totals (voids empty orders) and re-syncs the open bill.
// Returns the removed aggregate, or null if nothing matched.
async function removeItemFromTableOrders(
  context: RestaurantContext,
  tableId: string,
  itemName: string,
  itemPrice: number,
  client: PoolClient,
): Promise<{ name: string; price: number; quantity: number } | null> {
  const orders = await runQuery<{ id: string; food: unknown }>(
    `select id, food from "Orders"
       where res_id = $1 and outlet_id = $2 and table_id = $3
         and coalesce(status::text, '1') not in ('4','5','7')
     order by created_at asc`,
    [context.res_id, context.outlet_id, tableId],
    client,
  );
  const wantName = itemName.trim().toLowerCase();
  const matches = (it: any) =>
    String(it?.name ?? "").trim().toLowerCase() === wantName &&
    (!Number.isFinite(itemPrice) || itemPrice <= 0 || Math.abs((Number(it?.price) || 0) - itemPrice) < 0.005);

  let removedName = "";
  let removedPrice = 0;
  let removedQty = 0;

  for (const o of orders) {
    const f = (parseJsonObject(o.food) ?? {}) as Record<string, any>;
    const items: any[] = Array.isArray(f.items) ? f.items : [];
    const keep = items.filter((it) => !matches(it));
    if (keep.length === items.length) continue; // nothing removed from this order
    for (const it of items) {
      if (matches(it)) { removedName = String(it?.name ?? "Item"); removedPrice = Number(it?.price) || 0; removedQty += Math.max(1, Math.round(Number(it?.quantity) || 1)); }
    }
    let split = f.items_split;
    if (Array.isArray(split)) {
      split = split.map((t: any) => Array.isArray(t) ? [t[0], (Array.isArray(t[1]) ? t[1] : []).filter((it: any) => !matches(it))] : t);
    }
    const subtotal = round2(keep.reduce((s, it) => s + (Number(it?.price) || 0) * Math.max(1, Math.round(Number(it?.quantity) || 1)), 0));
    const newFood: Record<string, any> = { ...f, items: keep, subtotal, total: subtotal };
    if (split !== undefined) newFood.items_split = split;
    if (keep.length === 0) {
      await runQuery(`update "Orders" set food = $4::json, status = 5 where id = $1 and res_id = $2 and outlet_id = $3`,
        [o.id, context.res_id, context.outlet_id, JSON.stringify(newFood)], client);
    } else {
      await runQuery(`update "Orders" set food = $4::json where id = $1 and res_id = $2 and outlet_id = $3`,
        [o.id, context.res_id, context.outlet_id, JSON.stringify(newFood)], client);
    }
  }

  if (removedQty === 0) return null;

  const openBill = await runQuery<{ id: string }>(
    `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
    [tableId, context.res_id, context.outlet_id], client);
  if (openBill[0]) {
    const consolidated = await sumOrderTotalsForTable(context, tableId, client);
    await runQuery(`update "Bills" set total_amt = $1 where id = $2 and res_id = $3 and outlet_id = $4`,
      [consolidated, openBill[0].id, context.res_id, context.outlet_id], client);
  }
  return { name: removedName || itemName, price: removedPrice, quantity: removedQty };
}

// Admin: remove a wrongly-added item (by name+price) from a table's bill.
// A bill that has been admin-approved (or closed) is FINAL — no further edits by
// anyone. Throws on the table's most-recent bill once it's locked.
async function assertBillEditable(context: RestaurantContext, tableId: string, client?: PoolClient): Promise<void> {
  await ensureBillWorkflowColumns(client);
  // Only the table's OPEN bill can lock edits — a previously settled (closed)
  // bill from an earlier seating must never freeze the table's next session.
  const rows = await runQuery<{ admin_approved_at: Date | null }>(
    `select admin_approved_at from "Bills"
       where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null
       order by created_at desc limit 1`,
    [tableId, context.res_id, context.outlet_id],
    client,
  );
  if (rows[0]?.admin_approved_at) {
    throw new Error("This bill has been approved and is locked — it can no longer be modified.");
  }
}

// The id of the table's current open (un-closed) bill, or null. Used to reuse a
// bill that a concurrent request just created (the `bills_one_open_per_table`
// unique index from migration 007 guarantees there's at most one).
async function existingOpenBillId(context: RestaurantContext, tableId: string, client?: PoolClient): Promise<string | null> {
  const rows = await runQuery<{ id: string }>(
    `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
    [tableId, context.res_id, context.outlet_id],
    client,
  );
  return rows[0]?.id ?? null;
}

export async function RemoveBillItem(
  restaurantId: string,
  tableName: string,
  itemName: string,
  itemPrice: number,
): Promise<{ success: true; removed: { name: string; price: number; quantity: number } }> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const tableId = await tableIdByName(context, tableName, client);
    if (!tableId) throw new Error("Table not found");
    await assertBillEditable(context, tableId, client);
    const removed = await removeItemFromTableOrders(context, tableId, itemName, itemPrice, client);
    if (!removed) throw new Error("Item not found on this table's bill");
    return { success: true, removed };
  });
}

// Set (or clear, when blank) the kitchen note on a bill item (matched by name +
// price) across the table's active orders. Lets staff add/edit an item note at
// ANY time, not just at order entry. A locked (approved/closed) bill is rejected.
export async function SetBillItemNote(
  restaurantId: string,
  tableName: string,
  itemName: string,
  itemPrice: number,
  note: string,
): Promise<{ success: true; updated: number; note: string }> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const tableId = await tableIdByName(context, tableName, client);
    if (!tableId) throw new Error("Table not found");
    await assertBillEditable(context, tableId, client);

    const trimmedNote = String(note ?? "").trim().slice(0, 280);
    const wantName = itemName.trim().toLowerCase();
    const matches = (it: any) =>
      String(it?.name ?? "").trim().toLowerCase() === wantName &&
      (!Number.isFinite(itemPrice) || itemPrice <= 0 || Math.abs((Number(it?.price) || 0) - itemPrice) < 0.005);
    const withNote = (it: any) => {
      const c = { ...it };
      if (matches(c)) { if (trimmedNote) c.note = trimmedNote; else delete c.note; }
      return c;
    };

    const orders = await runQuery<{ id: string; food: unknown }>(
      `select id, food from "Orders"
         where res_id = $1 and outlet_id = $2 and table_id = $3
           and coalesce(status::text, '1') not in ('4','5','7')
       order by created_at asc`,
      [context.res_id, context.outlet_id, tableId],
      client,
    );

    let updated = 0;
    for (const o of orders) {
      const f = (parseJsonObject(o.food) ?? {}) as Record<string, any>;
      const items: any[] = Array.isArray(f.items) ? f.items : [];
      if (!items.some(matches)) continue;
      updated += items.filter(matches).length;
      const newItems = items.map(withNote);
      let split = f.items_split;
      if (Array.isArray(split)) {
        split = split.map((t: any) =>
          Array.isArray(t) ? [t[0], (Array.isArray(t[1]) ? t[1] : []).map(withNote)] : t);
      }
      const newFood: Record<string, any> = { ...f, items: newItems };
      if (split !== undefined) newFood.items_split = split;
      await runQuery(`update "Orders" set food = $4::json where id = $1 and res_id = $2 and outlet_id = $3`,
        [o.id, context.res_id, context.outlet_id, JSON.stringify(newFood)], client);
    }
    if (updated === 0) throw new Error("Item not found on this table's bill");
    return { success: true, updated, note: trimmedNote };
  });
}

// Move a wrongly-placed item from one table to another: removes it from the
// source bill and appends it as a fresh order on the destination (occupying it
// if needed).
export async function MoveBillItem(
  restaurantId: string,
  fromTable: string,
  toTable: string,
  itemName: string,
  itemPrice: number,
): Promise<{ success: true; moved: { name: string; price: number; quantity: number } }> {
  return withTransaction(async (client) => {
    await ensureTableOccupancyColumns(client);
    await ensureOrderBarkColumns();
    const context = await requireRestaurantContext(restaurantId, client);
    const fromId = await tableIdByName(context, fromTable, client);
    const toId = await tableIdByName(context, toTable, client);
    if (!fromId) throw new Error("Source table not found");
    if (!toId) throw new Error("Destination table not found");
    if (fromId === toId) throw new Error("Pick a different destination table");
    await assertBillEditable(context, fromId, client);
    await assertBillEditable(context, toId, client);

    const moved = await removeItemFromTableOrders(context, fromId, itemName, itemPrice, client);
    if (!moved) throw new Error("Item not found on the source table");

    // Ensure the destination table is occupied so the order/bill attaches.
    await runQuery(`update "Tables" set is_occupied = true where id = $1 and res_id = $2 and outlet_id = $3`,
      [toId, context.res_id, context.outlet_id], client);

    const newOrderId = randomUUID();
    const lineTotal = round2(moved.price * moved.quantity);
    const food = {
      id: newOrderId,
      table: toTable.trim(),
      customer: "Moved item",
      items: [{ id: randomUUID(), name: moved.name, price: moved.price, quantity: moved.quantity }],
      subtotal: lineTotal,
      total: lineTotal,
      taxes: [],
      applyServiceCharge: false,
      status: "Preparing",
    };
    // A moved item was already barked/cooking on its source table — keep it so.
    await runQuery(
      `insert into "Orders" (id, created_at, res_id, outlet_id, food, table_id, status, barked_at) values ($1, now(), $2, $3, $4::json, $5, 1, now())`,
      [newOrderId, context.res_id, context.outlet_id, JSON.stringify(food), toId],
      client,
    );

    const toBill = await runQuery<{ id: string }>(
      `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
      [toId, context.res_id, context.outlet_id], client);
    if (toBill[0]) {
      const consolidated = await sumOrderTotalsForTable(context, toId, client);
      await runQuery(`update "Bills" set total_amt = $1 where id = $2 and res_id = $3 and outlet_id = $4`,
        [consolidated, toBill[0].id, context.res_id, context.outlet_id], client);
    }
    return { success: true, moved };
  });
}

// --- POS everyday ops: discount, split, merge, refund -----------------------

// The table's open bill id, creating the bill from the table's orders if one
// hasn't been generated yet (shared by the discount / coupon / request paths).
async function ensureOpenBillIdForTable(
  context: RestaurantContext,
  tableId: string,
  client: PoolClient,
): Promise<string> {
  const existing = await runQuery<{ id: string }>(
    `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
    [tableId, context.res_id, context.outlet_id],
    client,
  );
  let billId = existing[0]?.id;
  if (!billId) {
    const total = await sumOrderTotalsForTable(context, tableId, client);
    billId = randomUUID();
    const billNo = await nextBillNo(context, client);
    const ins = await runQuery<{ id: string }>(
      `insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no)
       values ($1, now(), $2, $3, $4, null, 1, null, $5, '[]'::jsonb, $6)
       on conflict do nothing returning id`,
      [billId, context.res_id, context.outlet_id, tableId, total, billNo],
      client,
    );
    // If a concurrent request already opened the bill, reuse it (the unique
    // index made our insert a no-op).
    billId = ins[0]?.id ?? (await existingOpenBillId(context, tableId, client)) ?? billId;
  }
  return billId;
}

// Write a discount onto the table's open bill (the single code path used by both
// the direct discount and an approved discount request).
async function applyDiscountToOpenBill(
  context: RestaurantContext,
  tableId: string,
  type: "percent" | "flat" | null,
  value: number,
  client: PoolClient,
): Promise<string> {
  // A manual discount supersedes any applied coupon — revert the coupon first.
  await clearBillCoupon(context, tableId, client);
  const billId = await ensureOpenBillIdForTable(context, tableId, client);
  await runQuery(
    `update "Bills" set discount_type = $1, discount_value = $2 where id = $3 and res_id = $4 and outlet_id = $5`,
    [type, value, billId, context.res_id, context.outlet_id],
    client,
  );
  return billId;
}

// Set (or clear, when value<=0) a discount on a table's open bill. Creates the
// bill from the table's orders if one hasn't been generated yet.
export async function SetBillDiscount(
  restaurantId: string,
  tableName: string,
  typeRaw: unknown,
  valueRaw: unknown,
): Promise<{ success: true; discount_type: "percent" | "flat" | null; discount_value: number }> {
  const r = await SetBillDiscountWithApproval(restaurantId, tableName, typeRaw, valueRaw, { isAdmin: true });
  return { success: true, discount_type: r.discount_type ?? null, discount_value: r.discount_value ?? 0 };
}

// --- Discount approval workflow ----------------------------------------------
// When the restaurant sets discount_approval_threshold > 0, a NON-admin discount
// whose computed amount exceeds it is parked as a pending DiscountRequests row
// (nothing changes on the bill) until an admin approves or rejects it.

async function ensureDiscountRequestsTable(): Promise<void> {
  await ensureLazyTable("DiscountRequests", async () => {
    await runQuery(
      `create table if not exists "DiscountRequests" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         bill_id uuid not null,
         table_name text,
         requested_by text,
         discount_type text not null,
         discount_value numeric not null,
         amount numeric,
         reason text,
         status text not null default 'pending',
         decided_by text,
         decided_at timestamptz,
         created_at timestamptz not null default now()
       )`,
    );
    await runQuery(
      `create index if not exists discount_requests_res_idx on "DiscountRequests" (res_id, status, created_at desc)`,
    );
    await applyTenantRls("DiscountRequests");
  });
}

export type DiscountRequestRecord = {
  id: string;
  bill_id: string;
  table_name: string | null;
  requested_by: string | null;
  discount_type: "percent" | "flat";
  discount_value: number;
  amount: number;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

function mapDiscountRequest(r: Record<string, any>): DiscountRequestRecord {
  return {
    id: r.id,
    bill_id: r.bill_id,
    table_name: r.table_name ?? null,
    requested_by: r.requested_by ?? null,
    discount_type: r.discount_type === "flat" ? "flat" : "percent",
    discount_value: round2(parseNumeric(r.discount_value)),
    amount: round2(parseNumeric(r.amount)),
    reason: r.reason ?? null,
    status: r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending",
    decided_by: r.decided_by ?? null,
    decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
  };
}

export type BillDiscountOutcome = {
  success: true;
  // applied path
  applied?: boolean;
  discount_type?: "percent" | "flat" | null;
  discount_value?: number;
  // pending-approval path
  pending?: boolean;
  request_id?: string;
  amount?: number;
  threshold?: number;
};

// Discount entry point with the approval gate. Admins (and clears) always apply
// directly; a non-admin discount above the configured threshold becomes a
// pending request instead.
export async function SetBillDiscountWithApproval(
  restaurantId: string,
  tableName: string,
  typeRaw: unknown,
  valueRaw: unknown,
  opts: { isAdmin: boolean; requestedBy?: string | null; reason?: string | null },
): Promise<BillDiscountOutcome> {
  await ensureDiscountRequestsTable();
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const tableId = await tableIdByName(context, tableName, client);
    if (!tableId) throw new Error("Table not found");
    await assertBillEditable(context, tableId, client);

    const value = Math.max(0, Number(valueRaw) || 0);
    const type: "percent" | "flat" | null = value <= 0 ? null : typeRaw === "flat" ? "flat" : "percent";
    if (type === "percent" && value > 100) throw new Error("A percentage discount cannot exceed 100%");

    if (type !== null && !opts.isAdmin) {
      const threshold = await getDiscountApprovalThreshold(context.res_id, client);
      if (threshold > 0) {
        // Size the discount the same way the bill math will (percent off the
        // items subtotal, flat clamped to it) so the gate matches what would be given.
        const subtotal = await sumOrderTotalsForTable(context, tableId, client);
        const amount = type === "flat" ? round2(Math.min(value, subtotal)) : round2((subtotal * Math.min(value, 100)) / 100);
        if (amount > threshold) {
          const billId = await ensureOpenBillIdForTable(context, tableId, client);
          const requestedBy = opts.requestedBy
            ? (await resolveEmployeeByUsername(context, opts.requestedBy, client))?.username ?? opts.requestedBy
            : null;
          const requestId = randomUUID();
          await runQuery(
            `insert into "DiscountRequests" (id, res_id, outlet_id, bill_id, table_name, requested_by, discount_type, discount_value, amount, reason, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
            [requestId, context.res_id, context.outlet_id, billId, tableName.trim(), requestedBy, type, value, amount, opts.reason?.trim() || null],
            client,
          );
          return { success: true, pending: true, request_id: requestId, amount, threshold };
        }
      }
    }

    await applyDiscountToOpenBill(context, tableId, type, value, client);
    return { success: true, applied: true, discount_type: type, discount_value: value };
  });
}

async function getDiscountApprovalThreshold(resId: string, client?: PoolClient): Promise<number> {
  try {
    const rows = await runQuery<{ discount_approval_threshold: number | string | null }>(
      `select discount_approval_threshold from "Restaurant" where id = $1 limit 1`,
      [resId],
      client,
    );
    return Math.max(0, Number(rows[0]?.discount_approval_threshold ?? 0) || 0);
  } catch {
    return 0;
  }
}

export async function GetDiscountRequests(
  restaurantId: string,
  status?: string,
): Promise<DiscountRequestRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureDiscountRequestsTable();
  const wanted = ["pending", "approved", "rejected"].includes(String(status ?? "").toLowerCase())
    ? String(status).toLowerCase()
    : null;
  const rows = await runQuery<Record<string, any>>(
    `select * from "DiscountRequests"
       where res_id = $1 and outlet_id = $2 and ($3::text is null or status = $3)
       order by created_at desc limit 100`,
    [context.res_id, context.outlet_id, wanted],
  );
  return rows.map(mapDiscountRequest);
}

// Admin approves (or rejects) a pending discount request. Approval applies the
// discount to the bill through the SAME code path a direct discount uses; if the
// bill was settled in the meantime the whole decision rolls back.
export async function DecideDiscountRequest(
  restaurantId: string,
  requestId: string,
  approve: boolean,
  decidedBy?: string | null,
): Promise<DiscountRequestRecord> {
  await ensureDiscountRequestsTable();
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const decider = decidedBy
      ? (await resolveEmployeeByUsername(context, decidedBy, client))?.username ?? decidedBy
      : null;
    const rows = await runQuery<Record<string, any>>(
      `update "DiscountRequests"
          set status = $4, decided_by = $5, decided_at = now()
        where id = $1 and res_id = $2 and outlet_id = $3 and status = 'pending'
        returning *`,
      [requestId, context.res_id, context.outlet_id, approve ? "approved" : "rejected", decider],
      client,
    );
    if (!rows[0]) throw new Error("Discount request not found or already decided");
    const request = mapDiscountRequest(rows[0]);

    if (approve) {
      const bill = await runQuery<{ id: string; table_id: string | null; closed_at: Date | null }>(
        `select id, table_id, closed_at from "Bills" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
        [request.bill_id, context.res_id, context.outlet_id],
        client,
      );
      if (!bill[0] || bill[0].closed_at || !bill[0].table_id) {
        throw new Error("The bill has already been settled — discount not applied");
      }
      await applyDiscountToOpenBill(context, bill[0].table_id, request.discount_type, request.discount_value, client);
    }
    return request;
  });
}

// Compute a split of a table's current bill WITHOUT mutating any state (the whole
// table still settles as one bill). 'even' divides the grand total N ways; 'item'
// totals caller-assigned item groups and pro-rates charges so the parts sum to the
// grand total exactly (last part absorbs rounding).
export async function SplitBillForTable(
  restaurantId: string,
  tableName: string,
  mode: "even" | "item",
  options: { parts?: number; groups?: Array<{ label?: string; items?: Array<{ name: string; price: number; quantity: number }> }> },
): Promise<{ mode: "even" | "item"; grand_total: number; parts: Array<{ label: string; subtotal: number; total: number; items?: Array<{ name: string; price: number; quantity: number }> }> }> {
  const bill = await GetBillForTable(restaurantId, tableName);
  if (!bill) throw new Error("No open bill for this table");
  // Pure, unit-tested allocation (see billing_math.computeBillSplit) — parts always
  // sum back to the grand total exactly.
  return computeBillSplit(bill.grand_total, mode, {
    parts: options.parts,
    groups: options.groups,
    subtotalFallback: bill.subtotal,
  });
}

// Merge one table's active orders into another (combine checks). Moves the source
// table's open orders onto the destination, carries covers, recomputes the
// destination bill, closes the source bill and frees the source table.
export async function MergeTableBills(
  restaurantId: string,
  fromTable: string,
  toTable: string,
): Promise<{ success: true; total_amt: number; moved_orders: number }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const fromId = await tableIdByName(context, fromTable, client);
    const toId = await tableIdByName(context, toTable, client);
    if (!fromId) throw new Error("Source table not found");
    if (!toId) throw new Error("Destination table not found");
    if (fromId === toId) throw new Error("Pick a different destination table");
    await assertBillEditable(context, fromId, client);
    await assertBillEditable(context, toId, client);

    const orders = await runQuery<{ id: string; food: unknown }>(
      `select id, food from "Orders"
         where res_id = $1 and outlet_id = $2 and table_id = $3
           and coalesce(status::text, '1') not in ('4','5','7')
       order by created_at asc`,
      [context.res_id, context.outlet_id, fromId],
      client,
    );
    if (orders.length === 0) throw new Error("That table has no active orders to merge");

    const destName = toTable.trim();
    for (const o of orders) {
      const f = (parseJsonObject(o.food) ?? {}) as Record<string, unknown>;
      f.table = destName;
      await runQuery(
        `update "Orders" set table_id = $1, food = $2::json where id = $3 and res_id = $4 and outlet_id = $5`,
        [toId, JSON.stringify(f), o.id, context.res_id, context.outlet_id],
        client,
      );
    }

    // Carry the source covers onto the destination and keep it occupied.
    const coversRows = await runQuery<{ from_c: number | null; to_c: number | null }>(
      `select
         (select coalesce(num_covers,1) from "Tables" where id = $1) as from_c,
         (select coalesce(num_covers,1) from "Tables" where id = $2) as to_c`,
      [fromId, toId],
      client,
    );
    const carried =
      Math.max(1, Number(coversRows[0]?.from_c ?? 1)) + Math.max(1, Number(coversRows[0]?.to_c ?? 1));
    await runQuery(
      `update "Tables" set is_occupied = true, num_covers = $1 where id = $2 and res_id = $3 and outlet_id = $4`,
      [carried, toId, context.res_id, context.outlet_id],
      client,
    );

    // Recompute / create the destination bill.
    const consolidated = await sumOrderTotalsForTable(context, toId, client);
    const toBill = await runQuery<{ id: string }>(
      `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
      [toId, context.res_id, context.outlet_id],
      client,
    );
    if (toBill[0]) {
      await runQuery(`update "Bills" set total_amt = $1 where id = $2 and res_id = $3 and outlet_id = $4`,
        [consolidated, toBill[0].id, context.res_id, context.outlet_id], client);
    } else {
      const billNo = await nextBillNo(context, client);
      await runQuery(
        `insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no)
         values ($1, now(), $2, $3, $4, null, 1, null, $5, '[]'::jsonb, $6)
         on conflict do nothing`,
        [randomUUID(), context.res_id, context.outlet_id, toId, consolidated, billNo],
        client,
      );
    }

    // Close the source table's open bill and free it.
    await runQuery(
      `update "Bills" set closed_at = now(), closed_by_username = 'merge'
         where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null`,
      [fromId, context.res_id, context.outlet_id],
      client,
    );
    await runQuery(
      `update "Tables" set is_occupied = false, num_covers = 1, linked_order_id = null where id = $1 and res_id = $2 and outlet_id = $3`,
      [fromId, context.res_id, context.outlet_id],
      client,
    );
    await unassignTableById(context, fromId, client);

    return { success: true, total_amt: consolidated, moved_orders: orders.length };
  });
}

// Refund a settled bill. Finds it by bill_id or (latest settled) table name and
// records the reversal in the ledger. Any Razorpay gateway call is performed by the
// route, which passes the resulting refundRef back in.
export async function RefundBill(
  restaurantId: string,
  opts: { billId?: string; tableName?: string; amount?: number; reason?: string; refundRef?: string; byUsername?: string },
): Promise<{ success: true; bill_id: string; amount: number; payment_method: string | null; payment_ref: string | null }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);

    type RefundRow = {
      id: string;
      total_amt: number | string | null;
      payment_method: string | null;
      payment_proof_screenshot_url: string | null;
      refunded_at: Date | null;
      refund_ref: string | null;
    };
    let billRow: RefundRow | undefined;
    if (opts.billId) {
      const rows = await runQuery<RefundRow>(
        `select id, total_amt, payment_method, payment_proof_screenshot_url, refunded_at, refund_ref
           from "Bills" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
        [opts.billId, context.res_id, context.outlet_id],
        client,
      );
      billRow = rows[0];
    } else if (opts.tableName) {
      const tableId = await tableIdByName(context, opts.tableName, client);
      if (!tableId) throw new Error("Table not found");
      const rows = await runQuery<RefundRow>(
        `select id, total_amt, payment_method, payment_proof_screenshot_url, refunded_at, refund_ref
           from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3
             and (admin_approved_at is not null or closed_at is not null)
           order by created_at desc limit 1`,
        [tableId, context.res_id, context.outlet_id],
        client,
      );
      billRow = rows[0];
    } else {
      throw new Error("A bill_id or table_name is required");
    }

    if (!billRow) throw new Error("No settled bill found to refund");
    // Two-phase refund: refunded_at records the INTENT. A Razorpay refund is only
    // truly complete once the gateway returns a refund id (refund_ref). So block a
    // repeat only when there's nothing left to do — a non-gateway refund (already
    // settled), or a Razorpay refund the gateway has already confirmed. A Razorpay
    // refund whose gateway call failed (refund_ref still null) stays RETRYABLE; the
    // caller passes a stable Razorpay idempotency key so retrying can't double-refund.
    const isRazorpay = (billRow.payment_method ?? "").toLowerCase() === "razorpay";
    const gatewayConfirmed = !!billRow.refund_ref;
    if (billRow.refunded_at && (!isRazorpay || gatewayConfirmed)) {
      throw new Error("This bill has already been refunded");
    }

    const billTotal = round2(Number(billRow.total_amt ?? 0) || 0);
    const amount =
      opts.amount && Number(opts.amount) > 0 ? round2(Math.min(Number(opts.amount), billTotal)) : billTotal;

    const firstRefund = !billRow.refunded_at;
    await runQuery(
      `update "Bills" set refunded_at = now(), refunded_by_username = $1, refund_amount = $2, refund_reason = $3, refund_ref = $4
         where id = $5 and res_id = $6 and outlet_id = $7`,
      [opts.byUsername ?? null, amount, opts.reason ?? null, opts.refundRef ?? null, billRow.id, context.res_id, context.outlet_id],
      client,
    );

    // Free the coupon back (usage_limit / per-customer) — only on the FIRST refund so
    // a retryable Razorpay refund can't decrement twice. Best-effort.
    if (firstRefund) {
      try { await reverseCouponForBill(context, billRow.id, client); }
      catch (err) { logger.warn({ err }, "coupon_reverse_on_refund_failed"); }
    }

    return {
      success: true,
      bill_id: billRow.id,
      amount,
      payment_method: billRow.payment_method,
      payment_ref: billRow.payment_proof_screenshot_url,
    };
  });
}

// Record the gateway refund id on an already-refunded bill (used after a
// successful Razorpay refund call).
export async function SetBillRefundRef(restaurantId: string, billId: string, refundRef: string): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBillWorkflowColumns();
  await runQuery(
    `update "Bills" set refund_ref = $1 where id = $2 and res_id = $3 and outlet_id = $4`,
    [refundRef, billId, context.res_id, context.outlet_id],
  );
}

export type ReopenedBill = {
  success: true;
  bill: {
    id: string;
    bill_no: string | null;
    table_id: string | null;
    table_name: string | null;
    total_amt: number;
    payment_method: string | null;
    status: number | null;
    closed_at: null;
    admin_approved_at: null;
    waiter_confirmed_at: string | null;
    created_at: string;
  };
  restored_orders: number;
  window_min: number;
};

// Re-open a CLOSED bill within the restaurant's configured window (admin only,
// enforced at the route). The exact inverse of the approve/close finalization:
// clears closed_* and the admin approval stamps (waiter confirmation + payment
// method are kept as the record of what was paid), puts the session's settled
// orders back to "Payment Pending Approval", and re-occupies the table. Refunded
// bills and tables that already started a NEW session are refused.
export async function ReopenBill(
  restaurantId: string,
  billId: string,
  byEmployeeId?: string | null,
): Promise<ReopenedBill> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);

    const rows = await runQuery<{
      id: string;
      bill_no: string | null;
      table_id: string | null;
      total_amt: number | string | null;
      payment_method: string | null;
      created_at: Date;
      closed_at: Date | null;
      refunded_at: Date | null;
      waiter_confirmed_at: Date | null;
      within_window: boolean | null;
      window_min: number | string | null;
    }>(
      `select b.id, b.bill_no, b.table_id, b.total_amt, b.payment_method, b.created_at, b.closed_at,
              b.refunded_at, b.waiter_confirmed_at,
              (b.closed_at >= now() - make_interval(mins => coalesce(r.bill_reopen_window_min, 240))) as within_window,
              coalesce(r.bill_reopen_window_min, 240) as window_min
         from "Bills" b
         join "Restaurant" r on r.id = b.res_id
        where b.id = $1 and b.res_id = $2 and b.outlet_id = $3
        limit 1`,
      [billId, context.res_id, context.outlet_id],
      client,
    );
    const bill = rows[0];
    if (!bill) throw new Error("Bill not found");
    if (!bill.closed_at) throw new Error("This bill is not closed");
    if (bill.refunded_at) throw new Error("A refunded bill cannot be re-opened");
    const windowMin = Math.max(0, Math.round(Number(bill.window_min ?? 240) || 0));
    if (windowMin <= 0) throw new Error("Bill re-opening is disabled for this restaurant");
    if (!bill.within_window) {
      throw new Error(`This bill can no longer be re-opened (allowed within ${windowMin} minutes of closing)`);
    }

    // A NEW session on the same table would collide with the one-open-bill-per-
    // table invariant — refuse with a clear message instead of a unique-index error.
    if (bill.table_id) {
      const open = await runQuery<{ id: string }>(
        `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null limit 1`,
        [bill.table_id, context.res_id, context.outlet_id],
        client,
      );
      if (open[0]) throw new Error("The table already has a new open bill — settle or clear it first");
    }

    const updated = await runQuery<{ id: string; waiter_confirmed_at: Date | null; status: number | null; created_at: Date }>(
      `update "Bills"
          set closed_at = null,
              closed_by_username = null,
              admin_approved_at = null,
              admin_approved_by_username = null,
              status = 1
        where id = $1 and res_id = $2 and outlet_id = $3
        returning id, waiter_confirmed_at, status, created_at`,
      [bill.id, context.res_id, context.outlet_id],
      client,
    );
    if (!updated[0]) throw new Error("Failed to re-open bill");

    // Restore THIS session's settled orders (Paid/Closed between the previous
    // bill's close and this bill's close) so the bill is actionable again. Older
    // sessions' orders stay settled; Cancelled orders stay cancelled.
    let restored = 0;
    let tableName: string | null = null;
    if (bill.table_id) {
      const prev = await runQuery<{ prev_closed: Date | string }>(
        `select coalesce(max(closed_at), 'epoch'::timestamptz) as prev_closed
           from "Bills"
          where table_id = $1 and res_id = $2 and outlet_id = $3 and id <> $4 and closed_at is not null and closed_at <= $5`,
        [bill.table_id, context.res_id, context.outlet_id, bill.id, bill.closed_at],
        client,
      );
      const restoredRows = await runQuery<{ id: string }>(
        `update "Orders"
            set status = 6,
                food = jsonb_set(coalesce(food::jsonb, '{}'::jsonb), '{status}', to_jsonb('Payment Pending Approval'::text), true)
          where res_id = $1 and outlet_id = $2 and table_id = $3
            and coalesce(status::text, '1') in ('4', '7')
            and created_at > $4 and created_at <= $5
          returning id`,
        [context.res_id, context.outlet_id, bill.table_id, prev[0]?.prev_closed ?? new Date(0), bill.closed_at],
        client,
      );
      restored = restoredRows.length;

      // Put the table back in service so the bill shows on the floor again.
      const t = await runQuery<{ table_name: string }>(
        `update "Tables" set is_occupied = true
          where id = $1 and res_id = $2 and outlet_id = $3 and coalesce(is_deleted, false) = false
          returning table_name`,
        [bill.table_id, context.res_id, context.outlet_id],
        client,
      );
      tableName = t[0]?.table_name ?? null;
    }

    return {
      success: true,
      bill: {
        id: bill.id,
        bill_no: bill.bill_no,
        table_id: bill.table_id,
        table_name: tableName,
        total_amt: round2(parseNumeric(bill.total_amt)),
        payment_method: bill.payment_method,
        status: updated[0].status,
        closed_at: null,
        admin_approved_at: null,
        waiter_confirmed_at: bill.waiter_confirmed_at ? new Date(bill.waiter_confirmed_at).toISOString() : null,
        created_at: new Date(bill.created_at).toISOString(),
      },
      restored_orders: restored,
      window_min: windowMin,
    };
  });
}

// --- Accounting & reporting --------------------------------------------------

async function ensureExpensesTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Expenses", async () => {
    await runQuery(
      `create table if not exists "Expenses" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         created_at timestamptz not null default now(),
         spent_on date not null default current_date,
         category text not null default 'General',
         vendor text,
         amount numeric not null default 0,
         note text,
         created_by text
       )`,
    );
    await applyTenantRls("Expenses");
  });
}

export type ExpenseRecord = {
  id: string;
  spent_on: string;
  category: string;
  vendor: string | null;
  amount: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

// Normalize a report range to whole-day UTC boundaries: [from 00:00, to+1day
// 00:00) so the requested 'to' day is inclusive. Defaults to the last 30 days.
function normalizeReportRange(fromInput?: string, toInput?: string): { fromIso: string; toIso: string; fromDate: string; toDate: string } {
  let to = toInput ? new Date(toInput) : new Date();
  if (Number.isNaN(to.getTime())) to = new Date();
  let from = fromInput ? new Date(fromInput) : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime())) from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const fromDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const toDayExcl = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
  return {
    fromIso: fromDay.toISOString(),
    toIso: toDayExcl.toISOString(),
    fromDate: fromDay.toISOString().slice(0, 10),
    toDate: new Date(toDayExcl.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

function dayKeyOf(value: Date | string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// One UTC day as [fromIso, toIso) — built from date parts so "2026-06-15"
// means that calendar day regardless of server timezone. Bad/missing input
// falls back to today.
function dayRangeOf(date?: string): { day: string; fromIso: string; toIso: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  const base = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date();
  const from = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { day: from.toISOString().slice(0, 10), fromIso: from.toISOString(), toIso: to.toISOString() };
}

function parseTaxLines(raw: unknown): BillTaxLine[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      return { name: String(o.name ?? "Tax"), percentage: parseNumeric(o.percentage), amount: round2(parseNumeric(o.amount)) };
    })
    .filter((l) => l.amount > 0 || l.percentage > 0);
}

// Parse a Bills.payment_splits payload ([{method, amount}]) tolerantly.
function parsePaymentSplits(raw: unknown): Array<{ method: string; amount: number }> {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return { method: String(o.method ?? "").trim(), amount: round2(parseNumeric(o.amount)) };
    })
    .filter((s) => s.method && s.amount > 0);
}

type SettledBill = {
  settled_at: Date | string;
  total_amt: number;
  tax_breakdown: unknown;
  payment_method: string | null;
  payment_splits: unknown;
  refund_amount: number;
};

// Settled bills (admin-approved and/or closed) in a range, keyed off the
// settlement timestamp. total_amt is the grand total charged (all settle paths
// snapshot it), so this is the canonical revenue basis.
async function getSettledBills(context: RestaurantContext, fromIso: string, toIso: string, client?: PoolClient): Promise<SettledBill[]> {
  await ensureBillWorkflowColumns(client);
  const og = isAllOutlets() ? "true" : "false";
  const rows = await runQuery<{
    settled_at: Date | string;
    total_amt: number | string | null;
    tax_breakdown: unknown;
    payment_method: string | null;
    payment_splits: unknown;
    refund_amount: number | string | null;
  }>(
    `select coalesce(closed_at, admin_approved_at) as settled_at, total_amt, tax_breakdown, payment_method, payment_splits,
            coalesce(refund_amount, 0) as refund_amount
       from "Bills"
       where res_id = $1 and (${og} or outlet_id = $2)
         and (admin_approved_at is not null or closed_at is not null)
         and coalesce(closed_at, admin_approved_at) >= $3
         and coalesce(closed_at, admin_approved_at) < $4`,
    [context.res_id, context.outlet_id, fromIso, toIso],
    client,
  );
  return rows.map((r) => ({
    settled_at: r.settled_at,
    total_amt: round2(parseNumeric(r.total_amt)),
    tax_breakdown: r.tax_breakdown,
    payment_method: r.payment_method,
    payment_splits: r.payment_splits,
    refund_amount: round2(parseNumeric(r.refund_amount)),
  }));
}

export async function AddExpense(
  restaurantId: string,
  input: { category?: string; vendor?: string; amount: number; note?: string; spent_on?: string; createdBy?: string },
): Promise<ExpenseRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureExpensesTable();
  const amount = round2(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw new Error("Expense amount must be greater than zero");
  const category = (input.category ?? "General").trim() || "General";
  const spentOn = input.spent_on && /^\d{4}-\d{2}-\d{2}$/.test(input.spent_on) ? input.spent_on : null;
  const rows = await runQuery<ExpenseRecord>(
    `insert into "Expenses" (id, res_id, outlet_id, spent_on, category, vendor, amount, note, created_by)
     values ($1, $2, $3, coalesce($4::date, current_date), $5, $6, $7, $8, $9)
     returning id, to_char(spent_on,'YYYY-MM-DD') as spent_on, category, vendor, amount, note, created_by, created_at`,
    [randomUUID(), context.res_id, context.outlet_id, spentOn, category, input.vendor?.trim() || null, amount, input.note?.trim() || null, input.createdBy ?? null],
  );
  if (!rows[0]) throw new Error("Failed to record expense");
  return rows[0];
}

export async function GetExpenses(restaurantId: string, fromIso?: string, toIso?: string): Promise<ExpenseRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const og = isAllOutlets() ? "true" : "false";
  await ensureExpensesTable();
  const range = normalizeReportRange(fromIso, toIso);
  return runQuery<ExpenseRecord>(
    `select id, to_char(spent_on,'YYYY-MM-DD') as spent_on, category, vendor, amount, note, created_by, created_at
       from "Expenses"
       where res_id = $1 and (${og} or outlet_id = $2) and spent_on >= $3::date and spent_on <= $4::date
       order by spent_on desc, created_at desc`,
    [context.res_id, context.outlet_id, range.fromDate, range.toDate],
  );
}

export async function DeleteExpense(restaurantId: string, id: string): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureExpensesTable();
  await runQuery(`delete from "Expenses" where id = $1 and res_id = $2 and outlet_id = $3`, [id, context.res_id, context.outlet_id]);
  return true;
}

// --- Cash register / day-close ----------------------------------------------
// A cash session models a drawer between opening (operator enters the starting
// float) and closing (operator counts the drawer). Expected cash is derived from
// settled CASH bills in the window; variance = counted - expected. One open
// session per outlet at a time.

export type CashSessionRecord = {
  id: string;
  opened_at: string;
  opened_by: string | null;
  opening_float: number;
  closed_at: string | null;
  closed_by: string | null;
  cash_sales: number | null;
  cash_refunds: number | null;
  cash_payouts: number | null;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  notes: string | null;
  status: "open" | "closed";
};

async function ensureCashSessionsTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("CashSessions", async () => {
    await runQuery(
      `create table if not exists "CashSessions" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         opened_at timestamptz not null default now(),
         opened_by text,
         opening_float numeric not null default 0,
         closed_at timestamptz,
         closed_by text,
         cash_sales numeric,
         cash_refunds numeric,
         cash_payouts numeric,
         expected_cash numeric,
         counted_cash numeric,
         variance numeric,
         notes text,
         status text not null default 'open'
       )`,
    );
    await runQuery(
      `create index if not exists cash_sessions_lookup_idx on "CashSessions" (res_id, outlet_id, status, opened_at desc)`,
    );
    await applyTenantRls("CashSessions");
  });
}

function mapCashSession(r: Record<string, any>): CashSessionRecord {
  const iso = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  const num = (v: any) => (v == null ? null : round2(parseNumeric(v)));
  return {
    id: r.id,
    opened_at: iso(r.opened_at) ?? "",
    opened_by: r.opened_by ?? null,
    opening_float: round2(parseNumeric(r.opening_float)),
    closed_at: iso(r.closed_at),
    closed_by: r.closed_by ?? null,
    cash_sales: num(r.cash_sales),
    cash_refunds: num(r.cash_refunds),
    cash_payouts: num(r.cash_payouts),
    expected_cash: num(r.expected_cash),
    counted_cash: num(r.counted_cash),
    variance: num(r.variance),
    notes: r.notes ?? null,
    status: r.status === "closed" ? "closed" : "open",
  };
}

// Sum settled CASH bills (+ their refunds) for the outlet since `sinceIso`
// (optionally bounded to settlements strictly before `untilIso` — used by the
// balance sheet to value an open drawer as of a past date).
async function cashTotalsSince(
  context: RestaurantContext,
  sinceIso: string,
  client?: PoolClient,
  untilIso?: string,
): Promise<{ cash_sales: number; cash_refunds: number; bill_count: number }> {
  await ensureBillWorkflowColumns(client);
  const params: unknown[] = [context.res_id, context.outlet_id, sinceIso];
  let upperBound = "";
  if (untilIso) {
    params.push(untilIso);
    upperBound = ` and coalesce(closed_at, admin_approved_at) < $4`;
  }
  const rows = await runQuery<{ total_amt: number | string | null; refund_amount: number | string | null; payment_method: string | null; payment_splits: unknown }>(
    `select total_amt, coalesce(refund_amount, 0) as refund_amount, payment_method, payment_splits
       from "Bills"
      where res_id = $1 and outlet_id = $2
        and lower(coalesce(payment_method, '')) in ('cash', 'split')
        and (admin_approved_at is not null or closed_at is not null)
        and coalesce(closed_at, admin_approved_at) >= $3${upperBound}`,
    params,
    client,
  );
  let cash_sales = 0;
  let cash_refunds = 0;
  let bill_count = 0;
  for (const r of rows) {
    if ((r.payment_method ?? "").toLowerCase() === "split") {
      // Only the CASH portion of a split-tender bill hits the drawer. Split
      // refunds are reconciled manually (mode attribution is ambiguous).
      const cashPart = parsePaymentSplits(r.payment_splits)
        .filter((s) => s.method.toLowerCase() === "cash")
        .reduce((s, p) => s + p.amount, 0);
      if (cashPart <= 0) continue;
      cash_sales += cashPart;
      bill_count += 1;
      continue;
    }
    cash_sales += parseNumeric(r.total_amt);
    cash_refunds += parseNumeric(r.refund_amount);
    bill_count += 1;
  }
  return { cash_sales: round2(cash_sales), cash_refunds: round2(cash_refunds), bill_count };
}

// The open session (if any) for the caller's outlet, plus a LIVE expected-cash
// computation so the operator can see the drawer position before closing.
export async function GetCurrentCashSession(
  restaurantId: string,
): Promise<(CashSessionRecord & { live_cash_sales: number; live_cash_refunds: number; live_expected: number }) | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCashSessionsTable();
  const rows = await runQuery<Record<string, any>>(
    `select * from "CashSessions" where res_id = $1 and outlet_id = $2 and status = 'open' order by opened_at desc limit 1`,
    [context.res_id, context.outlet_id],
  );
  if (!rows[0]) return null;
  const session = mapCashSession(rows[0]);
  const totals = await cashTotalsSince(context, session.opened_at);
  const live_expected = round2(session.opening_float + totals.cash_sales - totals.cash_refunds);
  return { ...session, live_cash_sales: totals.cash_sales, live_cash_refunds: totals.cash_refunds, live_expected };
}

export async function OpenCashSession(
  restaurantId: string,
  input: { opening_float?: number; openedBy?: string },
): Promise<CashSessionRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCashSessionsTable();
  return withTransaction(async (client) => {
    const open = await runQuery<{ id: string }>(
      `select id from "CashSessions" where res_id = $1 and outlet_id = $2 and status = 'open' limit 1`,
      [context.res_id, context.outlet_id],
      client,
    );
    if (open[0]) throw new Error("A cash session is already open for this outlet. Close it first.");
    const opening = round2(Math.max(0, Number(input.opening_float) || 0));
    const rows = await runQuery<Record<string, any>>(
      `insert into "CashSessions" (id, res_id, outlet_id, opened_by, opening_float, status)
       values ($1, $2, $3, $4, $5, 'open') returning *`,
      [randomUUID(), context.res_id, context.outlet_id, input.openedBy ?? null, opening],
      client,
    );
    if (!rows[0]) throw new Error("Failed to open cash session");
    return mapCashSession(rows[0]);
  });
}

export async function CloseCashSession(
  restaurantId: string,
  input: { counted_cash: number; cash_payouts?: number; notes?: string; closedBy?: string },
): Promise<CashSessionRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCashSessionsTable();
  return withTransaction(async (client) => {
    const rows = await runQuery<Record<string, any>>(
      `select * from "CashSessions" where res_id = $1 and outlet_id = $2 and status = 'open' order by opened_at desc limit 1`,
      [context.res_id, context.outlet_id],
      client,
    );
    const session = rows[0];
    if (!session) throw new Error("No open cash session to close");
    const openedAtIso = session.opened_at instanceof Date ? session.opened_at.toISOString() : String(session.opened_at);
    const totals = await cashTotalsSince(context, openedAtIso, client);
    const openingFloat = round2(parseNumeric(session.opening_float));
    const payouts = round2(Math.max(0, Number(input.cash_payouts) || 0));
    const counted = round2(Math.max(0, Number(input.counted_cash) || 0));
    const expected = round2(openingFloat + totals.cash_sales - totals.cash_refunds - payouts);
    const variance = round2(counted - expected);
    const updated = await runQuery<Record<string, any>>(
      `update "CashSessions"
          set status = 'closed', closed_at = now(), closed_by = $1,
              cash_sales = $2, cash_refunds = $3, cash_payouts = $4,
              expected_cash = $5, counted_cash = $6, variance = $7, notes = $8
        where id = $9 and res_id = $10 and outlet_id = $11
        returning *`,
      [
        input.closedBy ?? null, totals.cash_sales, totals.cash_refunds, payouts,
        expected, counted, variance, input.notes?.trim() || null,
        session.id, context.res_id, context.outlet_id,
      ],
      client,
    );
    if (!updated[0]) throw new Error("Failed to close cash session");
    return mapCashSession(updated[0]);
  });
}

export async function GetCashSessions(restaurantId: string, fromIso?: string, toIso?: string): Promise<CashSessionRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const og = isAllOutlets() ? "true" : "false";
  await ensureCashSessionsTable();
  const range = normalizeReportRange(fromIso, toIso);
  const rows = await runQuery<Record<string, any>>(
    `select * from "CashSessions"
       where res_id = $1 and (${og} or outlet_id = $2) and opened_at >= $3::date and opened_at < ($4::date + interval '1 day')
       order by opened_at desc`,
    [context.res_id, context.outlet_id, range.fromDate, range.toDate],
  );
  return rows.map(mapCashSession);
}

export type SalesReport = {
  from: string;
  to: string;
  total_sales: number;
  total_tax: number;
  total_refund: number;
  net_sales: number;
  bill_count: number;
  by_day: Array<{ date: string; sales: number; tax: number; refund: number; bills: number }>;
  by_method: Array<{ method: string; sales: number; bills: number }>;
};

export async function GetSalesReport(restaurantId: string, fromIso?: string, toIso?: string): Promise<SalesReport> {
  const context = await requireRestaurantContext(restaurantId);
  const range = normalizeReportRange(fromIso, toIso);
  const bills = await getSettledBills(context, range.fromIso, range.toIso);

  let totalSales = 0, totalTax = 0, totalRefund = 0;
  const byDay = new Map<string, { sales: number; tax: number; refund: number; bills: number }>();
  const byMethod = new Map<string, { sales: number; bills: number }>();
  for (const b of bills) {
    const gross = b.total_amt;
    const tax = round2(parseTaxLines(b.tax_breakdown).reduce((s, l) => s + l.amount, 0));
    totalSales = round2(totalSales + gross);
    totalTax = round2(totalTax + tax);
    totalRefund = round2(totalRefund + b.refund_amount);
    const day = dayKeyOf(b.settled_at);
    const dd = byDay.get(day) ?? { sales: 0, tax: 0, refund: 0, bills: 0 };
    dd.sales = round2(dd.sales + gross); dd.tax = round2(dd.tax + tax); dd.refund = round2(dd.refund + b.refund_amount); dd.bills += 1;
    byDay.set(day, dd);
    // Split-tender bills attribute each part's amount to its REAL mode (a bill
    // paid Cash+Card counts once under each mode it touched, so per-mode bill
    // counts can sum above bill_count). Splits that don't reconstruct the total
    // (legacy/bad data) fall back to the 'Split' bucket.
    const splits = (b.payment_method ?? "").toLowerCase() === "split" ? parsePaymentSplits(b.payment_splits) : [];
    if (splits.length > 0) {
      for (const s of splits) {
        const mm = byMethod.get(s.method) ?? { sales: 0, bills: 0 };
        mm.sales = round2(mm.sales + s.amount); mm.bills += 1;
        byMethod.set(s.method, mm);
      }
    } else {
      const m = b.payment_method || "Other";
      const mm = byMethod.get(m) ?? { sales: 0, bills: 0 };
      mm.sales = round2(mm.sales + gross); mm.bills += 1;
      byMethod.set(m, mm);
    }
  }

  return {
    from: range.fromDate,
    to: range.toDate,
    total_sales: totalSales,
    total_tax: totalTax,
    total_refund: totalRefund,
    net_sales: round2(totalSales - totalRefund),
    bill_count: bills.length,
    by_day: [...byDay.entries()].filter(([d]) => d).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v })),
    by_method: [...byMethod.entries()].sort((a, b) => b[1].sales - a[1].sales).map(([method, v]) => ({ method, ...v })),
  };
}

export type GstReport = {
  from: string;
  to: string;
  total_taxable: number;
  total_tax: number;
  by_rate: Array<{ name: string; percentage: number; taxable: number; tax: number }>;
};

export async function GetGstReport(restaurantId: string, fromIso?: string, toIso?: string): Promise<GstReport> {
  const context = await requireRestaurantContext(restaurantId);
  const range = normalizeReportRange(fromIso, toIso);
  const bills = await getSettledBills(context, range.fromIso, range.toIso);

  let totalTax = 0, totalGross = 0;
  const byRate = new Map<string, { name: string; percentage: number; taxable: number; tax: number }>();
  for (const b of bills) {
    totalGross = round2(totalGross + b.total_amt);
    for (const l of parseTaxLines(b.tax_breakdown)) {
      const key = `${l.name}@${l.percentage}`;
      const e = byRate.get(key) ?? { name: l.name, percentage: l.percentage, taxable: 0, tax: 0 };
      e.tax = round2(e.tax + l.amount);
      e.taxable = round2(e.taxable + (l.percentage > 0 ? l.amount / (l.percentage / 100) : 0));
      byRate.set(key, e);
      totalTax = round2(totalTax + l.amount);
    }
  }

  return {
    from: range.fromDate,
    to: range.toDate,
    total_taxable: round2(totalGross - totalTax),
    total_tax: totalTax,
    by_rate: [...byRate.values()].sort((a, b) => b.tax - a.tax),
  };
}

export type ProfitAndLoss = {
  from: string;
  to: string;
  gross_sales: number;
  refunds: number;
  tax_collected: number;
  net_revenue: number;
  total_expenses: number;
  net_profit: number;
  expenses_by_category: Array<{ category: string; amount: number }>;
};

export async function GetProfitAndLoss(restaurantId: string, fromIso?: string, toIso?: string): Promise<ProfitAndLoss> {
  const sales = await GetSalesReport(restaurantId, fromIso, toIso);
  const expenses = await GetExpenses(restaurantId, fromIso, toIso);
  const totalExpenses = round2(expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const byCat = new Map<string, number>();
  for (const e of expenses) byCat.set(e.category, round2((byCat.get(e.category) ?? 0) + (Number(e.amount) || 0)));
  // Tax collected is pass-through (owed to the government), so net revenue and
  // profit are computed ex-tax.
  const netRevenue = round2(sales.total_sales - sales.total_refund - sales.total_tax);
  return {
    from: sales.from,
    to: sales.to,
    gross_sales: sales.total_sales,
    refunds: sales.total_refund,
    tax_collected: sales.total_tax,
    net_revenue: netRevenue,
    total_expenses: totalExpenses,
    net_profit: round2(netRevenue - totalExpenses),
    expenses_by_category: [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount })),
  };
}

// --- Discounts & offers report -------------------------------------------------
// Money given away in a range, over the same settled-bill basis as the sales
// report. IMPORTANT: total_amt is snapshotted NET of discount at every settle
// path, so the sales / GST / P&L figures already reflect these discounts — this
// report is additive context, never a number to subtract from revenue again.
export type DiscountsReport = {
  from: string;
  to: string;
  bill_count: number;
  discounted_bills: number;
  total_discount: number;
  manual_discount: number;
  coupon_discount: number;
  // Bills whose discount was stored as a raw percentage: the money value is
  // reconstructed (see below), so the totals containing them are estimates.
  estimated_bills: number;
  // Same basis as SalesReport.total_sales (net of discount) — shown for context.
  total_sales: number;
  gift_redemption_total: number;
  by_coupon: Array<{ code: string; kind: "promo" | "gift"; uses: number; amount: number }>;
  notes: string[];
};

export async function GetDiscountsReport(restaurantId: string, fromIso?: string, toIso?: string): Promise<DiscountsReport> {
  const context = await requireRestaurantContext(restaurantId);
  const og = isAllOutlets() ? "true" : "false";
  const range = normalizeReportRange(fromIso, toIso);
  await ensureBillWorkflowColumns();

  const bills = await runQuery<{
    total_amt: number | string | null;
    tax_breakdown: unknown;
    discount_type: string | null;
    discount_value: number | string | null;
    coupon_code: string | null;
  }>(
    `select total_amt, tax_breakdown, discount_type, discount_value, coupon_code
       from "Bills"
       where res_id = $1 and (${og} or outlet_id = $2)
         and (admin_approved_at is not null or closed_at is not null)
         and coalesce(closed_at, admin_approved_at) >= $3
         and coalesce(closed_at, admin_approved_at) < $4`,
    [context.res_id, context.outlet_id, range.fromIso, range.toIso],
  );

  const scPct = await getServiceChargePercent(context.res_id);
  let totalSales = 0, totalDiscount = 0, manualDiscount = 0, couponDiscount = 0, discountedBills = 0, estimatedBills = 0;
  for (const b of bills) {
    const total = round2(parseNumeric(b.total_amt));
    totalSales = round2(totalSales + total);
    const value = Math.max(0, parseNumeric(b.discount_value));
    if (value <= 0) continue;
    discountedBills += 1;
    let money = 0;
    if (b.discount_type === "percent") {
      // Percent rows store the RAW percentage; the money it removed was never
      // snapshotted. Reconstruct it from the settled total (see computeBillCharges):
      //   total = discounted_subtotal·(1 + sc/100) + taxes
      //   → discounted_subtotal = (total − tax) / (1 + sc/100)
      //   → discount = discounted_subtotal · p / (100 − p)
      // Uses the CURRENT service-charge %, so bills settled under a different SC
      // setting are slightly off, and a 100%-off bill (total 0) is unknowable.
      estimatedBills += 1;
      const p = Math.min(value, 100);
      if (p < 100) {
        const tax = round2(parseTaxLines(b.tax_breakdown).reduce((s, l) => s + l.amount, 0));
        const discountedSubtotal = Math.max(0, (total - tax) / (1 + scPct / 100));
        money = round2((discountedSubtotal * p) / (100 - p));
      }
    } else {
      // Flat rows store the exact money amount — and every coupon, gift voucher
      // and loyalty redemption is written as flat (ApplyCouponToBill).
      money = round2(value);
    }
    totalDiscount = round2(totalDiscount + money);
    if ((b.coupon_code ?? "").trim()) couponDiscount = round2(couponDiscount + money);
    else manualDiscount = round2(manualDiscount + money);
  }

  // Per-code redemptions restricted to bills settled in the range. A redemption
  // row's table_name holds the BILL id (ApplyCouponToBill), and cleared/refunded
  // redemptions are deleted, so surviving rows are money actually given away.
  // Coupons is a lazily-created table — tolerate its absence (42P01) for tenants
  // that never configured a promo (same stance as GetAdvancedAnalytics).
  let byCoupon: Array<{ code: string; kind: "promo" | "gift"; uses: number; amount: number }> = [];
  try {
    const rows = await runQuery<{ code: string; kind: string | null; uses: number; amount: number | string | null }>(
      `select r.code, coalesce(max(c.kind), 'promo') as kind, count(*)::int as uses, coalesce(sum(r.amount), 0) as amount
         from "CouponRedemptions" r
         join "Bills" b on b.id::text = r.table_name and b.res_id = r.res_id
         left join "Coupons" c on c.id = r.coupon_id and c.res_id = r.res_id
        where r.res_id = $1 and (${og} or r.outlet_id = $2)
          and (b.admin_approved_at is not null or b.closed_at is not null)
          and coalesce(b.closed_at, b.admin_approved_at) >= $3
          and coalesce(b.closed_at, b.admin_approved_at) < $4
        group by r.code
        order by 4 desc, 3 desc`,
      [context.res_id, context.outlet_id, range.fromIso, range.toIso],
    );
    byCoupon = rows.map((r) => ({
      code: r.code,
      kind: r.kind === "gift" ? ("gift" as const) : ("promo" as const),
      uses: Number(r.uses) || 0,
      amount: round2(parseNumeric(r.amount)),
    }));
  } catch (err: any) {
    if (err?.code !== "42P01") throw err;
  }
  const giftTotal = round2(byCoupon.filter((c) => c.kind === "gift").reduce((s, c) => s + c.amount, 0));

  const notes = [
    "Bill totals are stored net of discount, so the sales, GST and P&L figures already reflect these discounts — don't subtract them again.",
    "Discounts come off the items subtotal before service charge and taxes, so a pre-discount gross sales figure isn't derivable from settled totals and is deliberately not shown.",
  ];
  if (estimatedBills > 0) {
    notes.push(`${estimatedBills} bill(s) carried a percentage discount; their money value is reconstructed from the settled total using the current service-charge % and is an estimate.`);
  }

  return {
    from: range.fromDate,
    to: range.toDate,
    bill_count: bills.length,
    discounted_bills: discountedBills,
    total_discount: totalDiscount,
    manual_discount: manualDiscount,
    coupon_discount: couponDiscount,
    estimated_bills: estimatedBills,
    total_sales: totalSales,
    gift_redemption_total: giftTotal,
    by_coupon: byCoupon,
    notes,
  };
}

// --- Balance sheet (pragmatic snapshot from operational data) ------------------
// Not a double-entry ledger: each line is derived from the operational tables
// that exist today, and equity is the balancing figure. Simplifications are
// spelled out in `notes` (and shown in the UI) so the owner knows what's counted.
export type BalanceSheet = {
  as_of: string;
  assets: { cash_in_hand: number; receivables: number; inventory_value: number; total: number };
  liabilities: { payables: number; unpaid_payroll: number; total: number };
  equity: number;
  notes: string[];
};

export async function GetBalanceSheet(restaurantId: string, asOf?: string): Promise<BalanceSheet> {
  const context = await requireRestaurantContext(restaurantId);
  const range = dayRangeOf(asOf);
  const cutoffIso = range.toIso; // end of the as-of day (exclusive)
  const rid = context.res_id, oid = context.outlet_id;

  // Cash in hand: the drawer position at the cutoff — the counted cash of the
  // last session closed before it, or, for a session still open at the cutoff,
  // its opening float plus cash takings up to the cutoff (mirrors live expected).
  await ensureCashSessionsTable();
  let cashInHand = 0;
  const sessRows = await runQuery<Record<string, any>>(
    `select * from "CashSessions" where res_id = $1 and outlet_id = $2 and opened_at < $3 order by opened_at desc limit 1`,
    [rid, oid, cutoffIso],
  );
  if (sessRows[0]) {
    const s = mapCashSession(sessRows[0]);
    if (s.status === "closed" && s.closed_at && s.closed_at < cutoffIso) {
      cashInHand = s.counted_cash ?? 0;
    } else {
      const totals = await cashTotalsSince(context, s.opened_at, undefined, cutoffIso);
      cashInHand = round2(s.opening_float + totals.cash_sales - totals.cash_refunds);
    }
  }

  // Receivables: bills raised on/before the as-of day and not yet settled then.
  await ensureBillWorkflowColumns();
  const rec = await runQuery<{ total: number | string | null }>(
    `select coalesce(sum(total_amt), 0) as total from "Bills"
      where res_id = $1 and outlet_id = $2 and created_at < $3
        and (coalesce(closed_at, admin_approved_at) is null or coalesce(closed_at, admin_approved_at) >= $3)
        and coalesce(total_amt, 0) > 0`,
    [rid, oid, cutoffIso],
  );
  const receivables = round2(parseNumeric(rec[0]?.total));

  // Inventory at latest recorded purchase cost (from the StockMovements ledger,
  // bounded to purchases before the cutoff). Quantities are CURRENT — movement
  // history can't reliably rebuild past stock, so a back-dated sheet still
  // values today's shelf. Items with no costed purchase are excluded.
  await ensureStockMovementsTable();
  const costRows = await runQuery<{ inventory_id: string; unit_cost: number | string }>(
    `select distinct on (inventory_id) inventory_id, unit_cost
       from "StockMovements"
      where res_id = $1 and outlet_id = $2 and kind = 'purchase' and unit_cost is not null and created_at < $3
      order by inventory_id, created_at desc`,
    [rid, oid, cutoffIso],
  );
  const costByItem = new Map(costRows.map((r) => [r.inventory_id, parseNumeric(r.unit_cost)]));
  const invRows = await runQuery<{ barcode: string; qty: number | string | null }>(
    `select barcode, coalesce("Quantity", 0) as qty from "Inventory" where res_id = $1 and outlet_id = $2`,
    [rid, oid],
  );
  let inventoryValue = 0;
  for (const r of invRows) {
    const cost = costByItem.get(r.barcode);
    if (cost != null) inventoryValue = round2(inventoryValue + Math.max(0, parseNumeric(r.qty)) * cost);
  }

  // Payables: purchase orders committed (ordered) before the cutoff and not yet
  // received then. There is no supplier-invoice "paid" flag in the schema, so
  // ordered-not-received is the closest honest proxy for money owed.
  await ensurePurchaseOrdersTable();
  const pay = await runQuery<{ total: number | string | null }>(
    `select coalesce(sum(total_cost), 0) as total from "PurchaseOrders"
      where res_id = $1 and outlet_id = $2 and status <> 'cancelled'
        and ordered_at is not null and ordered_at < $3
        and (received_at is null or received_at >= $3)`,
    [rid, oid, cutoffIso],
  );
  const payables = round2(parseNumeric(pay[0]?.total));

  // Unpaid payroll: the as-of month's computed pay not yet recorded as paid.
  const payroll = await GetPayroll(restaurantId, range.day.slice(0, 7));
  const unpaidPayroll = payroll.total_due;

  const assetsTotal = round2(cashInHand + receivables + inventoryValue);
  const liabilitiesTotal = round2(payables + unpaidPayroll);
  return {
    as_of: range.day,
    assets: { cash_in_hand: round2(cashInHand), receivables, inventory_value: round2(inventoryValue), total: assetsTotal },
    liabilities: { payables, unpaid_payroll: unpaidPayroll, total: liabilitiesTotal },
    equity: round2(assetsTotal - liabilitiesTotal),
    notes: [
      "Cash in hand comes from cash sessions: last close before the date, or opening float + cash takings for a still-open drawer.",
      "Receivables are bills raised but not yet settled as of the date.",
      "Inventory is valued at each item's latest recorded purchase cost; quantities are current and uncosted items are excluded.",
      "Payables are purchase orders placed but not yet received (the schema has no supplier-invoice paid flag).",
      "Unpaid payroll is the as-of month's computed pay not yet recorded as paid. Equity is the balancing figure (assets − liabilities).",
    ],
  };
}

// --- Settlement reconciliation -------------------------------------------------
// Match what the POS says each payment mode took on a day against what actually
// landed (bank credit / aggregator settlement / cash count). Expected totals are
// derived from settled bills with split-tender parts attributed to their REAL
// modes — the same attribution as the sales report, so the two screens agree.
export const RECONCILE_ACTION_ID = "7d3a9f52-4b8c-4e16-a2d7-90c5e8b1f634";

async function ensureSettlementBatchesTable(): Promise<void> {
  await ensureLazyTable("SettlementBatches", async () => {
    await runQuery(
      `create table if not exists "SettlementBatches" (
         id uuid primary key default gen_random_uuid(),
         res_id uuid not null,
         outlet_id uuid,
         date date not null,
         method text not null,
         expected numeric not null default 0,
         actual numeric not null default 0,
         note text,
         status text not null default 'variance',
         created_by text,
         created_at timestamptz not null default now(),
         unique (res_id, outlet_id, date, method)
       )`,
    );
    // Dedicated audit action so reconciliations show up with an honest name.
    await runQuery(
      `insert into "Actions" (id, action_name, action_desc)
       values ($1, 'Reconcile Settlement', 'Record the actual settlement received per payment method vs the POS expected total')
       on conflict (id) do nothing`,
      [RECONCILE_ACTION_ID],
    ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
    await applyTenantRls("SettlementBatches");
  });
}

// Per-payment-method gross takings for a set of settled bills (split parts go
// to their real modes; unreconstructable splits fall back to 'Split').
function methodTotalsOf(bills: SettledBill[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const b of bills) {
    const splits = (b.payment_method ?? "").toLowerCase() === "split" ? parsePaymentSplits(b.payment_splits) : [];
    if (splits.length > 0) {
      for (const s of splits) totals.set(s.method, round2((totals.get(s.method) ?? 0) + s.amount));
    } else {
      const m = b.payment_method || "Other";
      totals.set(m, round2((totals.get(m) ?? 0) + b.total_amt));
    }
  }
  return totals;
}

export type ReconciliationRow = {
  method: string;
  expected: number;
  actual: number | null;
  status: "matched" | "variance" | null;
  note: string | null;
};

export async function GetReconciliation(restaurantId: string, date?: string): Promise<{ date: string; rows: ReconciliationRow[] }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureSettlementBatchesTable();
  const range = dayRangeOf(date);
  const bills = await getSettledBills(context, range.fromIso, range.toIso);
  const expected = methodTotalsOf(bills);
  const saved = await runQuery<{ method: string; actual: number | string; status: string; note: string | null }>(
    `select method, actual::float as actual, status, note from "SettlementBatches"
      where res_id = $1 and outlet_id = $2 and date = $3::date`,
    [context.res_id, context.outlet_id, range.day],
  );
  const savedByMethod = new Map(saved.map((r) => [r.method, r]));
  const methods = new Set<string>([...expected.keys(), ...savedByMethod.keys()]);
  const rows: ReconciliationRow[] = [...methods].map((method): ReconciliationRow => {
    const s = savedByMethod.get(method);
    return {
      method,
      expected: round2(expected.get(method) ?? 0),
      actual: s ? round2(parseNumeric(s.actual)) : null,
      status: s ? (s.status === "matched" ? "matched" : "variance") : null,
      note: s?.note ?? null,
    };
  }).sort((a, b) => b.expected - a.expected || a.method.localeCompare(b.method));
  return { date: range.day, rows };
}

export async function SaveReconciliation(
  restaurantId: string,
  input: { date: string; method: string; actual: number; note?: string; createdBy?: string },
): Promise<ReconciliationRow & { date: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureSettlementBatchesTable();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? "").trim())) throw new Error("date must be YYYY-MM-DD");
  const method = String(input.method ?? "").trim();
  if (!method) throw new Error("method is required");
  const actualNum = Number(input.actual);
  if (!Number.isFinite(actualNum) || actualNum < 0) throw new Error("actual must be a non-negative amount");
  const actual = round2(actualNum);

  const range = dayRangeOf(input.date);
  const bills = await getSettledBills(context, range.fromIso, range.toIso);
  const expected = round2(methodTotalsOf(bills).get(method) ?? 0);
  // Within ₹1 counts as matched (rounding of split parts / bank fees paise).
  const status: "matched" | "variance" = Math.abs(expected - actual) <= 1 ? "matched" : "variance";
  const note = input.note?.trim() || null;
  await runQuery(
    `insert into "SettlementBatches" (id, res_id, outlet_id, date, method, expected, actual, note, status, created_by)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10)
     on conflict (res_id, outlet_id, date, method) do update set
       expected = $6, actual = $7, note = $8, status = $9, created_by = $10, created_at = now()`,
    [randomUUID(), context.res_id, context.outlet_id, range.day, method, expected, actual, note, status, input.createdBy ?? null],
  );
  return { date: range.day, method, expected, actual, status, note };
}

// Remove a saved reconciliation entry (undo a mistaken save).
export async function DeleteReconciliation(restaurantId: string, date: string, method: string): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureSettlementBatchesTable();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "").trim())) throw new Error("date must be YYYY-MM-DD");
  const m = String(method ?? "").trim();
  if (!m) throw new Error("method is required");
  await runQuery(
    `delete from "SettlementBatches" where res_id = $1 and outlet_id = $2 and date = $3::date and method = $4`,
    [context.res_id, context.outlet_id, date.trim(), m],
  );
  return { success: true };
}

// Tally-compatible voucher XML ("Import Data" envelope): one Sales voucher per
// day of settled bills + one Payment voucher per expense. The referenced ledgers
// (Sales Receipts, Sales Account, Output Tax, Cash, and the expense categories)
// must exist in the Tally company or be created on import. Debit entries use
// ISDEEMEDPOSITIVE=Yes with a negative amount; credits use No with a positive
// amount (each voucher nets to zero).
export async function BuildTallyXml(restaurantId: string, fromIso?: string, toIso?: string): Promise<string> {
  const sales = await GetSalesReport(restaurantId, fromIso, toIso);
  const expenses = await GetExpenses(restaurantId, fromIso, toIso);
  let companyName = "Restaurant";
  try {
    const prof = (await GetRestaurantProfile(restaurantId)) as { name?: string } | null;
    if (prof && typeof prof.name === "string" && prof.name.trim()) companyName = prof.name.trim();
  } catch {/* ignore */}

  const esc = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tallyDate = (d: string) => d.replace(/-/g, "");
  const amt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

  const messages: string[] = [];
  let vno = 1;
  for (const d of sales.by_day) {
    if (d.sales <= 0) continue;
    const net = round2(d.sales - d.tax);
    const taxEntry = d.tax > 0
      ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output Tax</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(d.tax)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
      : "";
    messages.push(
      `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">` +
      `<DATE>${tallyDate(d.date)}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${vno++}</VOUCHERNUMBER>` +
      `<NARRATION>Daily sales ${esc(d.date)} (${d.bills} bills)</NARRATION>` +
      `<PARTYLEDGERNAME>Sales Receipts</PARTYLEDGERNAME>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Receipts</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt(d.sales)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(net)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      taxEntry +
      `</VOUCHER></TALLYMESSAGE>`,
    );
  }
  for (const e of expenses) {
    const a = round2(Number(e.amount) || 0);
    if (a <= 0) continue;
    const cat = esc(e.category || "Expenses");
    messages.push(
      `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Payment" ACTION="Create">` +
      `<DATE>${tallyDate(e.spent_on)}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>${vno++}</VOUCHERNUMBER>` +
      `<NARRATION>${esc(`${e.category}${e.note ? " - " + e.note : ""}`)}</NARRATION>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${cat}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt(a)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(a)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      `</VOUCHER></TALLYMESSAGE>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${messages.join("")}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
  );
}

export async function AddBill(
  restaurantId: string,
  bill: {
    id?: string;
    emp_id?: string | null;
    status: number;
    reason?: string | null;
    order_id: string;
    total_amt: number;
    tax_breakdown?: any;
  },
): Promise<{ id: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBillWorkflowColumns();
  const id = isUuid(String(bill.id ?? '')) ? String(bill.id) : randomUUID();

  // Try to resolve table_id from order
  const orderRows = await runQuery<{ table_id: string }>(
    `
      select table_id
      from "Orders"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [bill.order_id, context.res_id, context.outlet_id],
  );
  const tableId = orderRows[0]?.table_id ?? null;

  const activeBillRows = tableId
    ? await runQuery<{ id: string; total_amt: number }>(
      `
        select id, total_amt
        from "Bills"
        where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null
        order by created_at desc
        limit 1
      `,
      [tableId, context.res_id, context.outlet_id],
    )
    : [];

  const activeBill = activeBillRows[0] ?? null;

  let empId: string | null = null;
  if (bill.emp_id) {
    const rawEmployeeId = String(bill.emp_id).trim();
    if (isUuid(rawEmployeeId)) {
      empId = rawEmployeeId;
    } else {
      const resolved = await resolveEmployeeByUsername(context, rawEmployeeId);
      empId = resolved?.id ?? null;
    }
  }
  if (!empId) {
    throw new Error("Unable to resolve employee for bill (emp_id)");
  }

  if (activeBill) {
    // Consolidated total = sum of ALL the table's orders (idempotent — never
    // double-counts when an order is edited or the bill is regenerated).
    const consolidatedTotal = tableId
      ? await sumOrderTotalsForTable(context, tableId)
      : round2(Number(activeBill.total_amt ?? 0) + Number(bill.total_amt ?? 0));
    await runQuery(
      `
        update "Bills"
        set total_amt = $1,
            emp_id = $2,
            status = $3,
            reason = $4,
            tax_breakdown = $5
        where id = $6 and res_id = $7 and outlet_id = $8
      `,
      [
        consolidatedTotal,
        empId,
        bill.status,
        bill.reason ?? null,
        bill.tax_breakdown ? JSON.stringify(bill.tax_breakdown) : null,
        activeBill.id,
        context.res_id,
        context.outlet_id,
      ],
    );

    return { id: activeBill.id };
  }

  const newBillNo = await nextBillNo(context);
  await runQuery(
    `
      insert into "Bills"
        (id, created_at, res_id, outlet_id, table_id, emp_id, status, reason, order_id, total_amt, tax_breakdown, bill_no)
      values
        ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (id, res_id, outlet_id)
      do update set
        emp_id = excluded.emp_id,
        status = excluded.status,
        reason = excluded.reason,
        total_amt = excluded.total_amt,
        tax_breakdown = excluded.tax_breakdown,
        bill_no = "Bills".bill_no -- preserve original bill_no on updates
    `,
    [
      id,
      context.res_id,
      context.outlet_id,
      tableId,
      empId,
      bill.status,
      bill.reason ?? null,
      bill.order_id,
      bill.total_amt,
      bill.tax_breakdown ? JSON.stringify(bill.tax_breakdown) : null,
      newBillNo,
    ],
  );

  return { id };
}

async function ensureBillWorkflowColumns(client?: PoolClient): Promise<void> {
  // Run the 17 ALTERs at most ONCE per process (ACCESS EXCLUSIVE locks on the
  // hot Bills table) and tolerate a non-owner (app_runtime) 42501 post-cutover.
  await ensureLazyTable("Bills.workflow_cols", async () => {
  await runQuery(
    `
      alter table "Bills"
      add column if not exists payment_method text
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists waiter_confirmed_at timestamptz
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists waiter_confirmed_by_username text
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists payment_proof_screenshot_url text
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists admin_approved_at timestamptz
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists admin_approved_by_username text
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists closed_at timestamptz
    `,
    [],
    client,
  );
  await runQuery(
    `
      alter table "Bills"
      add column if not exists closed_by_username text
    `,
    [],
    client,
  );
  // Discount (applied to the items subtotal before service charge + tax).
  await runQuery(`alter table "Bills" add column if not exists discount_type text`, [], client);
  await runQuery(`alter table "Bills" add column if not exists discount_value numeric`, [], client);
  // Coupon code applied to the bill (the discount above is the computed effect).
  await runQuery(`alter table "Bills" add column if not exists coupon_code text`, [], client);
  // Refunds (a settled bill that was reversed; refund_ref = gateway refund id).
  await runQuery(`alter table "Bills" add column if not exists refunded_at timestamptz`, [], client);
  await runQuery(`alter table "Bills" add column if not exists refunded_by_username text`, [], client);
  await runQuery(`alter table "Bills" add column if not exists refund_amount numeric`, [], client);
  await runQuery(`alter table "Bills" add column if not exists refund_reason text`, [], client);
  await runQuery(`alter table "Bills" add column if not exists refund_ref text`, [], client);
  // Split tender: per-mode breakdown ([{method, amount}]) when ONE bill is settled
  // with multiple payment modes; payment_method is then 'Split'.
  await runQuery(`alter table "Bills" add column if not exists payment_splits jsonb`, [], client);
  // Dedicated audit actions for the discount-approval + bill re-open workflows so
  // they show up with honest names in the log (same pattern as Attendance).
  await runQuery(
    `insert into "Actions" (id, action_name, action_desc)
     values ('c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f', 'Approve Discount', 'Review (approve/reject) staff bill-discount requests'),
            ('d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a', 'Reopened bill', 'Re-open a closed bill within the allowed window')
     on conflict (id) do nothing`,
    [],
    client,
  ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
  });
}

// The open bill's discount for a table (null when none / no open bill). Tolerant
// of the columns not existing yet.
async function getOpenBillDiscount(
  context: RestaurantContext,
  tableId: string,
  client?: PoolClient,
): Promise<BillDiscount> {
  try {
    const rows = await runQuery<{ discount_type: string | null; discount_value: number | string | null }>(
      `select discount_type, discount_value from "Bills"
         where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null
         order by created_at desc limit 1`,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    const r = rows[0];
    if (!r || !r.discount_type) return null;
    const v = Math.max(0, Number(r.discount_value ?? 0) || 0);
    if (v <= 0) return null;
    return { type: r.discount_type === "flat" ? "flat" : "percent", value: v };
  } catch {
    return null;
  }
}

// --- Coupons (fully configurable promo codes) -------------------------------
export type CouponRecord = {
  id: string;
  code: string;
  description: string | null;
  type: "percent" | "flat";
  value: number;
  min_order: number;
  max_discount: number | null;
  usage_limit: number | null;
  used_count: number;
  per_customer_limit: number | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  // 'promo' (default) = a configured discount code; 'gift' = a prepaid voucher
  // whose remaining spendable balance decrements on every redemption.
  kind: "promo" | "gift";
  balance: number | null;
};

async function ensureCouponsTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Coupons", async () => {
    await runQuery(
      `create table if not exists "Coupons" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         code text not null,
         description text,
         type text not null default 'percent',
         value numeric not null default 0,
         min_order numeric not null default 0,
         max_discount numeric,
         usage_limit integer,
         used_count integer not null default 0,
         per_customer_limit integer,
         valid_from timestamptz,
         valid_to timestamptz,
         active boolean not null default true,
         created_at timestamptz not null default now()
       )`,
    );
    await runQuery(
      `create table if not exists "CouponRedemptions" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         coupon_id uuid not null,
         code text not null,
         customer_phone text,
         table_name text,
         created_at timestamptz not null default now()
       )`,
    );
    // One code per (restaurant, outlet) — backs the dup-check + makes concurrent
    // creates safe (UpsertCoupon catches the 23505).
    await runQuery(
      `create unique index if not exists coupons_res_outlet_code_uniq
         on "Coupons" (res_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(code))`,
    ).catch(() => {/* ignore if a duplicate already exists pre-index */});
    // Gift vouchers reuse the coupon infra: kind promo|gift; a gift coupon
    // carries a spendable balance. Redemptions snapshot the applied amount so a
    // cleared/refunded gift redemption can restore the exact balance.
    await runQuery(`alter table "Coupons" add column if not exists kind text not null default 'promo'`);
    await runQuery(`alter table "Coupons" add column if not exists balance numeric`);
    await runQuery(`alter table "CouponRedemptions" add column if not exists amount numeric`);
    await applyTenantRls("Coupons");
    await applyTenantRls("CouponRedemptions");
  });
}

function mapCoupon(r: Record<string, any>): CouponRecord {
  return {
    id: r.id,
    code: r.code,
    description: r.description ?? null,
    type: r.type === "flat" ? "flat" : "percent",
    value: Number(r.value ?? 0) || 0,
    min_order: Number(r.min_order ?? 0) || 0,
    max_discount: r.max_discount != null ? Number(r.max_discount) : null,
    usage_limit: r.usage_limit != null ? Number(r.usage_limit) : null,
    used_count: Number(r.used_count ?? 0) || 0,
    per_customer_limit: r.per_customer_limit != null ? Number(r.per_customer_limit) : null,
    valid_from: r.valid_from ? new Date(r.valid_from).toISOString() : null,
    valid_to: r.valid_to ? new Date(r.valid_to).toISOString() : null,
    active: r.active !== false,
    kind: r.kind === "gift" ? "gift" : "promo",
    balance: r.balance != null ? round2(Number(r.balance) || 0) : null,
  };
}

export async function GetCoupons(restaurantId: string): Promise<CouponRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCouponsTable();
  const rows = await runQuery<Record<string, any>>(
    `select * from "Coupons" where res_id = $1 and (outlet_id = $2 or outlet_id is null) order by created_at desc`,
    [context.res_id, context.outlet_id],
  );
  return rows.map(mapCoupon);
}

export type CouponInput = {
  id?: string | null;
  code: string;
  description?: string | null;
  type?: string | null;
  value?: number | null;
  min_order?: number | null;
  max_discount?: number | null;
  usage_limit?: number | null;
  per_customer_limit?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  active?: boolean | null;
};

export async function UpsertCoupon(restaurantId: string, input: CouponInput): Promise<CouponRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCouponsTable();
  const code = String(input.code ?? "").trim().toUpperCase();
  if (!code) throw new Error("Coupon code is required");
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new Error("Code must be 2–32 chars: A–Z, 0–9, - or _");
  const type = input.type === "flat" ? "flat" : "percent";
  const value = Math.max(0, Number(input.value ?? 0) || 0);
  if (value <= 0) throw new Error("Discount value must be greater than 0");
  if (type === "percent" && value > 100) throw new Error("A percentage coupon cannot exceed 100%");
  const num = (v: unknown) => (v == null || v === "" ? null : Math.max(0, Number(v) || 0));
  const intNum = (v: unknown) => (v == null || v === "" ? null : Math.max(0, Math.round(Number(v) || 0)));
  const params = [
    context.res_id,
    context.outlet_id,
    code,
    typeof input.description === "string" ? input.description.trim().slice(0, 200) || null : null,
    type,
    value,
    num(input.min_order) ?? 0,
    num(input.max_discount),
    intNum(input.usage_limit),
    intNum(input.per_customer_limit),
    input.valid_from ? new Date(input.valid_from) : null,
    input.valid_to ? new Date(input.valid_to) : null,
    input.active !== false,
  ];

  if (input.id) {
    // Scope by outlet too: an admin/manager may only edit their own outlet's (or a
    // global) coupon, never another outlet's.
    const rows = await runQuery<Record<string, any>>(
      `update "Coupons" set code=$3, description=$4, type=$5, value=$6, min_order=$7, max_discount=$8,
         usage_limit=$9, per_customer_limit=$10, valid_from=$11, valid_to=$12, active=$13
       where id=$14 and res_id=$1 and (outlet_id=$2 or outlet_id is null) returning *`,
      [...params, input.id],
    );
    if (!rows[0]) throw new Error("Coupon not found");
    return mapCoupon(rows[0]);
  }
  // Reject a duplicate active code for this outlet.
  const dup = await runQuery<{ id: string }>(
    `select id from "Coupons" where res_id=$1 and (outlet_id=$2 or outlet_id is null) and upper(code)=upper($3) limit 1`,
    [context.res_id, context.outlet_id, code],
  );
  if (dup[0]) throw new Error(`Coupon "${code}" already exists`);
  try {
    const rows = await runQuery<Record<string, any>>(
      `insert into "Coupons" (id, res_id, outlet_id, code, description, type, value, min_order, max_discount, usage_limit, per_customer_limit, valid_from, valid_to, active)
       values ($14, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
      [...params, randomUUID()],
    );
    if (!rows[0]) throw new Error("Failed to create coupon");
    return mapCoupon(rows[0]);
  } catch (err: any) {
    // Unique-index race (migration 007): another request created the same code.
    if (err?.code === "23505") throw new Error(`Coupon "${code}" already exists`);
    throw err;
  }
}

export async function DeleteCoupon(restaurantId: string, id: string): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCouponsTable();
  await runQuery(`delete from "Coupons" where id = $1 and res_id = $2 and (outlet_id = $3 or outlet_id is null)`,
    [id, context.res_id, context.outlet_id]);
  return true;
}

// Issue a gift voucher: a kind='gift' coupon whose balance starts at the face
// amount. Staff redeem it at billing by code exactly like any coupon; each
// redemption spends min(balance, bill subtotal) and 0 balance deactivates it.
export async function CreateGiftVoucher(
  restaurantId: string,
  input: { code?: string | null; amount: number },
): Promise<CouponRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureCouponsTable();
  const amount = round2(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw new Error("Voucher amount must be greater than 0");
  const explicit = String(input.code ?? "").trim().toUpperCase();
  if (explicit && !/^[A-Z0-9_-]{2,32}$/.test(explicit)) throw new Error("Code must be 2–32 chars: A–Z, 0–9, - or _");
  // Auto-generated codes retry on the (vanishingly unlikely) unique collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = explicit || `GV-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    try {
      const rows = await runQuery<Record<string, any>>(
        `insert into "Coupons" (id, res_id, outlet_id, code, description, type, value, min_order, active, kind, balance)
         values ($1, $2, $3, $4, 'Gift voucher', 'flat', $5, 0, true, 'gift', $5) returning *`,
        [randomUUID(), context.res_id, context.outlet_id, code, amount],
      );
      if (rows[0]) return mapCoupon(rows[0]);
    } catch (err: any) {
      if (err?.code === "23505") {
        if (explicit) throw new Error(`Coupon "${explicit}" already exists`);
        continue; // generated code collided — roll a new one
      }
      throw err;
    }
  }
  throw new Error("Unable to generate a unique voucher code");
}

// `computeCouponDiscount` is imported from ./billing_math.js (pure, unit-tested).

// Validate a coupon against a subtotal (+ optional customer). Returns the coupon
// row + computed discount, or a human reason why it can't be used.
async function validateCoupon(
  context: RestaurantContext,
  code: string,
  subtotal: number,
  customerPhone: string | undefined,
  client?: PoolClient,
): Promise<{ coupon: CouponRecord; discount: number } | { error: string }> {
  await ensureCouponsTable(client);
  const rows = await runQuery<Record<string, any>>(
    `select * from "Coupons" where res_id=$1 and (outlet_id=$2 or outlet_id is null) and upper(code)=upper($3) limit 1`,
    [context.res_id, context.outlet_id, code.trim()],
    client,
  );
  if (!rows[0]) return { error: "Invalid coupon code" };
  const c = mapCoupon(rows[0]);
  if (!c.active) return { error: "This coupon is not active" };
  const now = Date.now();
  if (c.valid_from && now < new Date(c.valid_from).getTime()) return { error: "This coupon isn't valid yet" };
  if (c.valid_to && now > new Date(c.valid_to).getTime()) return { error: "This coupon has expired" };
  if (c.min_order > 0 && subtotal < c.min_order) return { error: `Minimum order of ${c.min_order} required` };
  if (c.usage_limit != null && c.used_count >= c.usage_limit) return { error: "This coupon has reached its usage limit" };
  if (c.per_customer_limit != null && customerPhone) {
    const used = await runQuery<{ n: string }>(
      `select count(*)::int as n from "CouponRedemptions" where res_id=$1 and coupon_id=$2 and customer_phone=$3`,
      [context.res_id, c.id, customerPhone], client,
    );
    if (Number(used[0]?.n ?? 0) >= c.per_customer_limit) return { error: "You've already used this coupon" };
  }
  // Gift vouchers spend their remaining balance (capped at the bill subtotal);
  // promo coupons compute their configured percent/flat discount.
  const discount = c.kind === "gift"
    ? round2(Math.min(Math.max(0, c.balance ?? 0), Math.max(0, subtotal)))
    : computeCouponDiscount(c, subtotal);
  if (c.kind === "gift" && (c.balance ?? 0) <= 0) return { error: "This gift voucher has no balance left" };
  if (discount <= 0) return { error: "This coupon gives no discount on this order" };
  return { coupon: c, discount };
}

// Read-only check (for the customer page to preview a code before paying).
export async function CheckCoupon(
  restaurantId: string,
  code: string,
  subtotal: number,
  customerPhone?: string,
): Promise<{ valid: boolean; discount: number; description?: string | null; error?: string }> {
  const context = await requireRestaurantContext(restaurantId);
  const r = await validateCoupon(context, code, Number(subtotal) || 0, customerPhone);
  if ("error" in r) return { valid: false, discount: 0, error: r.error };
  return { valid: true, discount: r.discount, description: r.coupon.description };
}

// Clear any coupon currently on the table's open bill (decrement + delete the
// redemption). Used when removing/replacing the bill discount.
async function clearBillCoupon(context: RestaurantContext, tableId: string, client: PoolClient): Promise<void> {
  await ensureCouponsTable(client);
  const rows = await runQuery<{ id: string; coupon_code: string | null }>(
    `select id, coupon_code from "Bills" where table_id=$1 and res_id=$2 and outlet_id=$3 and closed_at is null order by created_at desc limit 1`,
    [tableId, context.res_id, context.outlet_id], client,
  );
  const bill = rows[0];
  if (!bill || !bill.coupon_code) return;
  // Decrement the EXACT coupon that was applied (by id from its redemption row),
  // not by code — a tenant can have an outlet-specific AND a global coupon with
  // the same code, and decrementing by code would corrupt the other's counter.
  const redemption = await runQuery<{ coupon_id: string; amount: number | string | null }>(
    `select coupon_id, amount from "CouponRedemptions" where res_id=$1 and outlet_id=$2 and table_name=$3 order by created_at desc limit 1`,
    [context.res_id, context.outlet_id, bill.id], client,
  );
  const couponId = redemption[0]?.coupon_id ?? null;
  if (couponId) {
    await runQuery(`update "Coupons" set used_count = greatest(0, used_count - 1) where id=$1 and res_id=$2`,
      [couponId, context.res_id], client);
    await restoreGiftBalance(context, couponId, Number(redemption[0]?.amount ?? 0) || 0, client);
  }
  await runQuery(`delete from "CouponRedemptions" where res_id=$1 and table_name=$2`,
    [context.res_id, bill.id], client).catch(() => {});
  await runQuery(`update "Bills" set coupon_code=null where id=$1 and res_id=$2`, [bill.id, context.res_id], client);
}

// Give a redeemed gift voucher its money back (clear/refund paths): restore the
// snapshotted redemption amount to the balance and reactivate the code. No-op
// for promo coupons (the where clause pins kind='gift').
async function restoreGiftBalance(context: RestaurantContext, couponId: string, amount: number, client: PoolClient): Promise<void> {
  if (amount <= 0) return;
  await runQuery(
    `update "Coupons" set balance = round(coalesce(balance, 0)::numeric + $3::numeric, 2), active = true
       where id=$1 and res_id=$2 and kind='gift'`,
    [couponId, context.res_id, amount], client,
  ).catch(() => {/* best-effort: never fail the clearing flow over a balance restore */});
}

// Reverse a SPECIFIC bill's coupon redemption (used on refund/void of a settled
// bill) so a refunded order doesn't permanently consume the coupon's global
// usage_limit / the customer's per-customer limit. Best-effort — never fail the
// refund over a coupon counter.
async function reverseCouponForBill(context: RestaurantContext, billId: string, client: PoolClient): Promise<void> {
  const rows = await runQuery<{ coupon_code: string | null }>(
    `select coupon_code from "Bills" where id=$1 and res_id=$2 limit 1`, [billId, context.res_id], client,
  );
  const code = rows[0]?.coupon_code;
  if (!code) return; // no coupon on this bill → nothing to reverse
  const redemption = await runQuery<{ coupon_id: string; amount: number | string | null }>(
    `select coupon_id, amount from "CouponRedemptions" where res_id=$1 and table_name=$2 order by created_at desc limit 1`,
    [context.res_id, billId], client,
  );
  const couponId = redemption[0]?.coupon_id ?? null;
  if (couponId) {
    await runQuery(`update "Coupons" set used_count = greatest(0, used_count - 1) where id=$1 and res_id=$2`,
      [couponId, context.res_id], client);
    await restoreGiftBalance(context, couponId, Number(redemption[0]?.amount ?? 0) || 0, client);
  }
  await runQuery(`delete from "CouponRedemptions" where res_id=$1 and table_name=$2`, [context.res_id, billId], client);
}

// Apply a coupon code to a table's open bill: validates, sets the bill discount
// to the computed amount, records the code + a redemption, and bumps used_count.
export async function ApplyCouponToBill(
  restaurantId: string,
  tableName: string,
  code: string,
  customerPhone?: string,
): Promise<{ success: true; code: string; discount: number }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const tableId = await tableIdByName(context, tableName, client);
    if (!tableId) throw new Error("Table not found");
    await assertBillEditable(context, tableId, client);

    const subtotal = await sumOrderTotalsForTable(context, tableId, client);
    // Revert any coupon already on this bill FIRST, so re-applying the same code
    // (or switching codes) doesn't count the bill's own prior use against the
    // usage/per-customer limits during validation below.
    await clearBillCoupon(context, tableId, client);
    const v = await validateCoupon(context, code, subtotal, customerPhone, client);
    if ("error" in v) throw new Error(v.error);

    const existing = await runQuery<{ id: string }>(
      `select id from "Bills" where table_id=$1 and res_id=$2 and outlet_id=$3 and closed_at is null order by created_at desc limit 1`,
      [tableId, context.res_id, context.outlet_id], client);
    let billId = existing[0]?.id;
    if (!billId) {
      billId = randomUUID();
      const billNo = await nextBillNo(context, client);
      const ins = await runQuery<{ id: string }>(
        `insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no)
         values ($1, now(), $2, $3, $4, null, 1, null, $5, '[]'::jsonb, $6)
         on conflict do nothing returning id`,
        [billId, context.res_id, context.outlet_id, tableId, subtotal, billNo], client);
      billId = ins[0]?.id ?? (await existingOpenBillId(context, tableId, client)) ?? billId;
    }
    // Store the coupon's effect as a flat discount so all existing bill math + the
    // printed bill honour the cap/min-order computed here.
    await runQuery(
      `update "Bills" set discount_type='flat', discount_value=$1, coupon_code=$2 where id=$3 and res_id=$4 and outlet_id=$5`,
      [v.discount, v.coupon.code, billId, context.res_id, context.outlet_id], client);
    await runQuery(`update "Coupons" set used_count = used_count + 1 where id=$1 and res_id=$2`, [v.coupon.id, context.res_id], client);
    // A gift voucher spends its balance: decrement by the applied amount and
    // deactivate once exhausted (a cleared redemption restores both).
    if (v.coupon.kind === "gift") {
      const bal = await runQuery<{ balance: number | string | null }>(
        `update "Coupons" set balance = greatest(0, round(coalesce(balance, 0)::numeric - $3::numeric, 2))
           where id=$1 and res_id=$2 returning balance`,
        [v.coupon.id, context.res_id, v.discount], client,
      );
      if ((Number(bal[0]?.balance ?? 0) || 0) <= 0) {
        await runQuery(`update "Coupons" set active=false where id=$1 and res_id=$2`, [v.coupon.id, context.res_id], client);
      }
    }
    await runQuery(
      `insert into "CouponRedemptions" (id, res_id, outlet_id, coupon_id, code, customer_phone, table_name, amount)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), context.res_id, context.outlet_id, v.coupon.id, v.coupon.code, customerPhone ?? null, billId, v.discount], client);
    return { success: true, code: v.coupon.code, discount: v.discount };
  });
}

// --- Loyalty points (earn on bill settle, redeem as a bill discount) ---------
// Ledger-only model: balance = sum(points) per (restaurant, customer phone).
// Earn rows are positive, redeem rows negative. The earn rate + point value
// live on the Restaurant row (loyalty_earn_per_100 / loyalty_point_value).

async function ensureLoyaltyTable(): Promise<void> {
  await ensureLazyTable("LoyaltyLedger", async () => {
    await runQuery(
      `create table if not exists "LoyaltyLedger" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         customer_phone text not null,
         points numeric not null,
         kind text not null default 'earn',
         bill_id uuid,
         note text,
         created_at timestamptz not null default now()
       )`,
    );
    await runQuery(
      `create index if not exists loyalty_res_phone_idx on "LoyaltyLedger" (res_id, customer_phone, created_at desc)`,
    );
    // At most ONE earn per bill — makes the settle-hook idempotent across the
    // multiple settle paths / client retries.
    await runQuery(
      `create unique index if not exists loyalty_earn_bill_uniq on "LoyaltyLedger" (res_id, bill_id) where kind = 'earn' and bill_id is not null`,
    ).catch(() => {/* ignore if historical duplicates pre-date the index */});
    await applyTenantRls("LoyaltyLedger");
  });
}

// Dedicated audit action so loyalty redemptions read honestly in the log.
export const LOYALTY_REDEEM_ACTION_ID = "5b3f9d71-2c84-47e6-9a05-8e64d1f0b923";
async function ensureLoyaltyRedeemAction(): Promise<void> {
  await ensureLazyTable("Actions.loyalty_redeem", async () => {
    await runQuery(
      `insert into "Actions" (id, action_name, action_desc)
       values ($1, 'Loyalty Redeem', 'Loyalty points redeemed as a bill discount')
       on conflict (id) do nothing`,
      [LOYALTY_REDEEM_ACTION_ID],
    ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
  });
}

async function getLoyaltyConfig(resId: string, client?: PoolClient): Promise<{ earn_per_100: number; point_value: number }> {
  try {
    const rows = await runQuery<{ loyalty_earn_per_100: number | string | null; loyalty_point_value: number | string | null }>(
      `select loyalty_earn_per_100, loyalty_point_value from "Restaurant" where id = $1 limit 1`,
      [resId], client,
    );
    return {
      earn_per_100: Math.max(0, Number(rows[0]?.loyalty_earn_per_100 ?? 0) || 0),
      point_value: Math.max(0, Number(rows[0]?.loyalty_point_value ?? 1) || 0),
    };
  } catch {
    return { earn_per_100: 0, point_value: 1 }; // column not provisioned yet → loyalty off
  }
}

async function loyaltyBalance(context: RestaurantContext, phone: string, client?: PoolClient): Promise<number> {
  const rows = await runQuery<{ balance: number | string | null }>(
    `select coalesce(sum(points), 0) as balance from "LoyaltyLedger" where res_id = $1 and customer_phone = $2`,
    [context.res_id, phone], client,
  );
  return round2(Number(rows[0]?.balance ?? 0) || 0);
}

// Earn points for a just-settled bill. Called (best-effort, inside try/catch)
// from EVERY settle finalizer — admin approval, close-by-order, Razorpay — so
// it can never fail a settle. Needs a customer phone on the session's orders
// (Orders.food JSON carries customer_phone for QR/takeaway/delivery orders).
async function awardLoyaltyForSettledBill(
  context: RestaurantContext,
  tableId: string,
  client: PoolClient,
): Promise<void> {
  const cfg = await getLoyaltyConfig(context.res_id, client);
  if (cfg.earn_per_100 <= 0) return; // loyalty off
  await ensureLoyaltyTable();
  // The bill this settle just closed (latest closed bill on the table).
  const bills = await runQuery<{ id: string; total_amt: number | string | null }>(
    `select id, total_amt from "Bills"
       where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is not null
       order by closed_at desc limit 1`,
    [tableId, context.res_id, context.outlet_id], client,
  );
  const bill = bills[0];
  if (!bill) return;
  // Most recent order on the table carrying a phone = this session's customer.
  const phones = await runQuery<{ phone: string | null }>(
    `select nullif(trim((food)::jsonb->>'customer_phone'), '') as phone
       from "Orders"
      where res_id = $1 and outlet_id = $2 and table_id = $3
        and nullif(trim((food)::jsonb->>'customer_phone'), '') is not null
      order by created_at desc limit 1`,
    [context.res_id, context.outlet_id, tableId], client,
  );
  const phone = phones[0]?.phone?.trim();
  if (!phone) return;
  const total = round2(Number(bill.total_amt ?? 0) || 0);
  const points = Math.floor(total / 100) * cfg.earn_per_100;
  if (points <= 0) return;
  await runQuery(
    `insert into "LoyaltyLedger" (id, res_id, outlet_id, customer_phone, points, kind, bill_id, note)
     values ($1, $2, $3, $4, $5, 'earn', $6, $7)
     on conflict do nothing`,
    [randomUUID(), context.res_id, context.outlet_id, phone, points, bill.id, `Earned on bill settle (₹${total})`],
    client,
  );
}

export async function GetLoyaltyAccount(
  restaurantId: string,
  phoneRaw: string,
): Promise<{ phone: string; balance: number; point_value: number; earn_per_100: number; history: Array<{ points: number; kind: string; note: string | null; bill_id: string | null; created_at: string }> }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureLoyaltyTable();
  const phone = phoneRaw.trim();
  if (!phone) throw new Error("Phone number is required");
  const cfg = await getLoyaltyConfig(context.res_id);
  const balance = await loyaltyBalance(context, phone);
  const rows = await runQuery<{ points: number | string; kind: string; note: string | null; bill_id: string | null; created_at: Date }>(
    `select points, kind, note, bill_id, created_at from "LoyaltyLedger"
       where res_id = $1 and customer_phone = $2 order by created_at desc limit 50`,
    [context.res_id, phone],
  );
  return {
    phone,
    balance,
    point_value: cfg.point_value,
    earn_per_100: cfg.earn_per_100,
    history: rows.map((r) => ({
      points: round2(Number(r.points) || 0),
      kind: r.kind,
      note: r.note,
      bill_id: r.bill_id,
      created_at: new Date(r.created_at).toISOString(),
    })),
  };
}

// Redeem N points against a table's OPEN bill: converts points × point_value
// into a flat bill discount through the same internal path SetBillDiscount
// uses (admin-level — staff access is gated at the route), and records the
// negative ledger row. Validates the balance and keeps the discount within the
// bill subtotal so points can't be burned for value that doesn't exist.
export async function RedeemLoyaltyPoints(
  restaurantId: string,
  opts: { phone: string; points: number; table_name: string },
): Promise<{ success: true; points: number; discount: number; balance: number }> {
  await ensureLoyaltyTable();
  await ensureLoyaltyRedeemAction();
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const phone = String(opts.phone ?? "").trim();
    if (!phone) throw new Error("Phone number is required");
    const points = Math.floor(Number(opts.points) || 0);
    if (points <= 0) throw new Error("Points to redeem must be greater than 0");
    const cfg = await getLoyaltyConfig(context.res_id, client);
    if (cfg.point_value <= 0) throw new Error("Loyalty redemption is not enabled (point value is 0)");
    const balance = await loyaltyBalance(context, phone, client);
    if (points > balance) throw new Error(`Not enough points — the balance is ${balance}`);

    const tableId = await tableIdByName(context, opts.table_name, client);
    if (!tableId) throw new Error("Table not found");
    await assertBillEditable(context, tableId, client);
    const subtotal = await sumOrderTotalsForTable(context, tableId, client);
    if (subtotal <= 0) throw new Error("This table has no active orders to discount");
    const discount = round2(points * cfg.point_value);
    if (discount > subtotal) {
      throw new Error(`${points} points are worth ₹${discount} — more than the bill subtotal (₹${subtotal}). Redeem fewer points.`);
    }

    // Same internal flat-discount path as SetBillDiscount (replaces any
    // existing manual discount/coupon on the open bill).
    const billId = await applyDiscountToOpenBill(context, tableId, "flat", discount, client);
    await runQuery(
      `insert into "LoyaltyLedger" (id, res_id, outlet_id, customer_phone, points, kind, bill_id, note)
       values ($1, $2, $3, $4, $5, 'redeem', $6, $7)`,
      [randomUUID(), context.res_id, context.outlet_id, phone, -points, billId, `Redeemed for ₹${discount} off (table ${opts.table_name.trim()})`],
      client,
    );
    return { success: true, points, discount, balance: round2(balance - points) };
  });
}

async function updateOrderWorkflowStatus(
  context: RestaurantContext,
  orderId: string,
  status: OrderRecord["status"],
  client?: PoolClient,
): Promise<void> {
  const orderRows = await runQuery<{ table_id: string | null }>(
    `
      select table_id
      from "Orders"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [orderId, context.res_id, context.outlet_id],
    client,
  );

  const tableId = orderRows[0]?.table_id ?? null;
  if (tableId) {
    // Move the WHOLE table's orders together (one consolidated bill spans several
    // orders), but ONLY the current session's still-active orders. Orders already
    // Paid(4)/Cancelled(5)/Closed(7) belong to a previous, settled session and
    // keep the same table_id — without this guard, confirming a new payment would
    // re-open every past payment on the table as "Payment Pending Approval" again.
    await runQuery(
      `
        update "Orders"
        set status = $1,
            food = jsonb_set(coalesce(food::jsonb, '{}'::jsonb), '{status}', to_jsonb($2::text), true)
        where table_id = $3 and res_id = $4 and outlet_id = $5
          and coalesce(status::text, '1') not in ('4','5','7')
      `,
      [toOrderStatusCode(status), status, tableId, context.res_id, context.outlet_id],
      client,
    );
    return;
  }

  await runQuery(
    `
      update "Orders"
      set status = $1,
          food = jsonb_set(coalesce(food::jsonb, '{}'::jsonb), '{status}', to_jsonb($2::text), true)
      where id = $3 and res_id = $4 and outlet_id = $5
    `,
    [toOrderStatusCode(status), status, orderId, context.res_id, context.outlet_id],
    client,
  );
}

// Validate a split-tender payload: 2-6 rows of {method, amount} using REAL
// methods (no nested 'Split'), positive amounts. Sum is checked against the
// bill's grand total later (once it is known).
function normalizePaymentSplits(raw: unknown): Array<{ method: PaymentMethod; amount: number }> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length < 2 || raw.length > 6) throw new Error("A split payment needs between 2 and 6 parts");
  return raw.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const method = normalizePaymentMethod(o.method);
    if (!method || method === "Split" || method === "Razorpay") {
      throw new Error(`Invalid split payment method: ${String(o.method ?? "")}`);
    }
    const amount = round2(Number(o.amount) || 0);
    if (amount <= 0) throw new Error("Every split part needs an amount greater than zero");
    return { method, amount };
  });
}

export async function ConfirmBillPaymentByWaiter(
  restaurantId: string,
  orderId: string,
  waiterEmployeeId: string,
  paymentMethodRaw: string,
  paymentProofScreenshotUrlRaw?: string | null,
  splitsRaw?: unknown,
): Promise<{ success: true; payment_method: PaymentMethod; splits?: Array<{ method: PaymentMethod; amount: number }> }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const splits = normalizePaymentSplits(splitsRaw);
    const paymentMethod = splits.length > 0 ? ("Split" as PaymentMethod) : normalizePaymentMethod(paymentMethodRaw);
    if (!paymentMethod) {
      throw new Error("Invalid payment method");
    }
    if (paymentMethod === "Split" && splits.length === 0) {
      throw new Error("A split payment needs its parts ({method, amount} rows)");
    }

    const requiresProof = paymentRequiresProof(paymentMethod);
    const paymentProofScreenshotUrl =
      typeof paymentProofScreenshotUrlRaw === "string" ? paymentProofScreenshotUrlRaw.trim() : "";
    if (requiresProof && !paymentProofScreenshotUrl) {
      throw new Error("Payment proof screenshot is required for Dineout, Zomato, EasyDiner or District");
    }

    const waiter = await resolveEmployeeByUsername(context, waiterEmployeeId, client);
    if (!waiter) {
      throw new Error("Waiter not found");
    }

    const orderRows = await runQuery<{ table_id: string | null }>(
      `
        select table_id
        from "Orders"
        where id = $1 and res_id = $2 and outlet_id = $3
        limit 1
      `,
      [orderId, context.res_id, context.outlet_id],
      client,
    );
    const tableId = orderRows[0]?.table_id ?? null;
    if (!tableId) {
      throw new Error("Order table not found");
    }

    const billRows = await runQuery<{ id: string }>(
      `
        select id
        from "Bills"
        where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null
        order by created_at desc
        limit 1
      `,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    let billId = billRows[0]?.id;
    if (!billId) {
      // No bill generated yet — create the consolidated bill from the table's
      // orders so payment can be recorded directly (single bill per table).
      const total = await sumOrderTotalsForTable(context, tableId, client);
      billId = randomUUID();
      const billNo = await nextBillNo(context, client);
      const ins = await runQuery<{ id: string }>(
        `insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no)
         values ($1, now(), $2, $3, $4, $5, 1, $6, $7, '[]'::jsonb, $8)
         on conflict do nothing returning id`,
        [billId, context.res_id, context.outlet_id, tableId, waiter.id, orderId, total, billNo],
        client,
      );
      billId = ins[0]?.id ?? (await existingOpenBillId(context, tableId, client)) ?? billId;
    }

    // Snapshot the charged grand total + tax lines so every settled bill is a
    // consistent basis for accounting/reporting (mirrors the customer/online
    // payment paths, which already store the grand total in total_amt).
    const subtotalNow = await sumOrderTotalsForTable(context, tableId, client);
    const taxRows = await runQuery<{ default_tax: any }>(
      `select default_tax from "Outlets" where id = $1 and res_id = $2 limit 1`,
      [context.outlet_id, context.res_id],
      client,
    );
    const scPctNow = await getServiceChargePercent(context.res_id, client);
    const discountNow = await getOpenBillDiscount(context, tableId, client);
    const charges = computeBillCharges(subtotalNow, taxRows[0]?.default_tax ?? null, scPctNow, true, discountNow);
    const taxJsonNow = JSON.stringify(charges.taxes);

    // Split tender: the parts must reconstruct the charged grand total exactly
    // (±1 paisa for rounding) — a split can never lose or invent money.
    if (splits.length > 0) {
      const splitSum = round2(splits.reduce((s, p) => s + p.amount, 0));
      if (Math.abs(splitSum - charges.grand_total) > 0.01) {
        throw new Error(`Split amounts (${splitSum}) must add up to the bill total (${charges.grand_total})`);
      }
    }

    const updated = await runQuery<{ id: string }>(
      `
        update "Bills"
        set payment_method = $1,
            payment_proof_screenshot_url = $2,
            waiter_confirmed_at = now(),
            waiter_confirmed_by_username = $3,
            admin_approved_at = null,
            admin_approved_by_username = null,
            closed_at = null,
            closed_by_username = null,
            total_amt = $7,
            tax_breakdown = $8::jsonb,
            payment_splits = $9::jsonb,
            status = 1
        where
          id = $4
          and res_id = $5
          and outlet_id = $6
          and status <> 3
        returning id
      `,
      [
        paymentMethod,
        paymentProofScreenshotUrl || null,
        waiter.username,
        billId,
        context.res_id,
        context.outlet_id,
        charges.grand_total,
        taxJsonNow,
        splits.length > 0 ? JSON.stringify(splits) : null,
      ],
      client,
    );

    if (!updated[0]) {
      throw new Error("Bill not found or not eligible for payment confirmation");
    }

    await updateOrderWorkflowStatus(context, orderId, "Payment Pending Approval", client);
    return { success: true, payment_method: paymentMethod, ...(splits.length > 0 ? { splits } : {}) };
  });
}

// Customer-initiated payment from the QR ordering page. Records the chosen
// method (+ screenshot for 4-7) on the table's single bill and marks it PENDING
// STAFF APPROVAL — staff then approve + close. No employee identity (the
// customer isn't logged in); a fallback employee is recorded for the bill row.
export async function SubmitCustomerPayment(
  restaurantId: string,
  tableName: string,
  paymentMethodRaw: string,
  screenshotUrlRaw?: string | null,
  requireScreenshotOverride?: boolean,
): Promise<{ success: true; payment_method: PaymentMethod; order_id: string; total_amt: number }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const paymentMethod = normalizePaymentMethod(paymentMethodRaw);
    // 'Split' is staff-only (needs the per-mode breakdown) — never a QR option.
    if (!paymentMethod || paymentMethod === "Split") throw new Error("Invalid payment method");
    const screenshotUrl = typeof screenshotUrlRaw === "string" ? screenshotUrlRaw.trim() : "";
    // Screenshot requirement is config-driven when an override is supplied,
    // otherwise falls back to the built-in proof-method defaults.
    const requiresProof = typeof requireScreenshotOverride === "boolean" ? requireScreenshotOverride : paymentRequiresProof(paymentMethod);
    if (requiresProof && !screenshotUrl) {
      throw new Error("A payment screenshot is required for this method.");
    }

    await ensureTableOccupancyColumns(client);
    const tableRows = await runQuery<{ id: string }>(
      `select id from "Tables" where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3) and coalesce(is_deleted, false) = false limit 1`,
      [context.res_id, context.outlet_id, tableName.trim()],
      client,
    );
    const tableId = tableRows[0]?.id;
    if (!tableId) throw new Error("Table not found");

    const ord = await runQuery<{ id: string; food: unknown }>(
      `select id, food from "Orders" where res_id = $1 and outlet_id = $2 and table_id = $3 order by created_at desc limit 1`,
      [context.res_id, context.outlet_id, tableId],
      client,
    );
    const orderId = ord[0]?.id;
    if (!orderId) throw new Error("No orders to pay for on this table");

    let empId = String((parseJsonObject(ord[0]?.food) ?? {}).taken_by_employee_id ?? "").trim();
    if (!empId || !isUuid(empId)) {
      const anyEmp = await runQuery<{ id: string }>(
        `select id from "Employees" where res_id = $1 and outlet_id = $2 limit 1`,
        [context.res_id, context.outlet_id],
        client,
      );
      empId = anyEmp[0]?.id ?? "";
    }

    const subtotal = await sumOrderTotalsForTable(context, tableId, client);
    // Fold the optional service charge + taxes into the recorded/charged total.
    const taxRows = await runQuery<{ default_tax: any }>(
      `select default_tax from "Outlets" where id = $1 and res_id = $2 limit 1`,
      [context.outlet_id, context.res_id],
      client,
    );
    const scPct = await getServiceChargePercent(context.res_id, client);
    const billDiscount = await getOpenBillDiscount(context, tableId, client);
    const { taxes, grand_total } = computeBillCharges(subtotal, taxRows[0]?.default_tax ?? null, scPct, true, billDiscount);
    const total = grand_total;
    const taxJson = JSON.stringify(taxes);

    const billRows = await runQuery<{ id: string }>(
      `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    let billId = billRows[0]?.id;
    if (!billId) {
      billId = randomUUID();
      const billNo = await nextBillNo(context, client);
      const ins = await runQuery<{ id: string }>(
        `insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no)
         values ($1, now(), $2, $3, $4, $5, 1, $6, $7, $8::jsonb, $9)
         on conflict do nothing returning id`,
        [billId, context.res_id, context.outlet_id, tableId, empId || null, orderId, total, taxJson, billNo],
        client,
      );
      billId = ins[0]?.id ?? (await existingOpenBillId(context, tableId, client)) ?? billId;
    }

    await runQuery(
      `update "Bills" set
         total_amt = $1, tax_breakdown = $2::jsonb, payment_method = $3, payment_proof_screenshot_url = $4,
         waiter_confirmed_at = now(), waiter_confirmed_by_username = 'customer',
         admin_approved_at = null, admin_approved_by_username = null, closed_at = null, status = 1
       where id = $5 and res_id = $6 and outlet_id = $7 and status <> 3`,
      [total, taxJson, paymentMethod, screenshotUrl || null, billId, context.res_id, context.outlet_id],
      client,
    );

    await updateOrderWorkflowStatus(context, orderId, "Payment Pending Approval", client);

    return { success: true, payment_method: paymentMethod, order_id: orderId, total_amt: total };
  });
}

export async function ApproveBillPaymentByAdmin(
  restaurantId: string,
  orderId: string,
  adminEmployeeId: string,
): Promise<{ success: true }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const admin = await resolveEmployeeByUsername(context, adminEmployeeId, client);
    if (!admin) {
      throw new Error("Admin not found");
    }

    const orderRows = await runQuery<{ table_id: string | null }>(
      `
        select table_id
        from "Orders"
        where id = $1 and res_id = $2 and outlet_id = $3
        limit 1
      `,
      [orderId, context.res_id, context.outlet_id],
      client,
    );
    const tableId = orderRows[0]?.table_id ?? null;
    if (!tableId) {
      throw new Error("Order table not found");
    }

    const billRows = await runQuery<{
      payment_method: string | null;
      payment_proof_screenshot_url: string | null;
    }>(
      `
        select payment_method, payment_proof_screenshot_url
        from "Bills"
        where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null
        order by created_at desc
        limit 1
      `,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    const bill = billRows[0];
    if (!bill) {
      // Idempotent: if there's no OPEN bill, the payment was likely already
      // approved/closed (e.g. a double-tap) — treat that as success rather than
      // erroring with "Bill not found".
      const already = await runQuery<{ id: string }>(
        `select id from "Bills"
           where table_id = $1 and res_id = $2 and outlet_id = $3 and admin_approved_at is not null
           order by created_at desc limit 1`,
        [tableId, context.res_id, context.outlet_id],
        client,
      );
      if (already[0]) return { success: true };
      throw new Error("Bill not found");
    }

    const billPaymentMethod = normalizePaymentMethod(bill.payment_method);
    const requiresProof = paymentRequiresProof(billPaymentMethod);
    const hasProof =
      typeof bill.payment_proof_screenshot_url === "string" && bill.payment_proof_screenshot_url.trim().length > 0;
    if (requiresProof && !hasProof) {
      throw new Error("Payment proof screenshot is required before approval for Dineout, Zomato, EasyDiner or District");
    }

    const updated = await runQuery<{ id: string }>(
      `
        update "Bills"
        set admin_approved_at = now(),
            admin_approved_by_username = $1,
            status = 2
        where
          table_id = $2
          and res_id = $3
          and outlet_id = $4
          and waiter_confirmed_at is not null
          and status <> 3
        returning id
      `,
      [admin.username, tableId, context.res_id, context.outlet_id],
      client,
    );

    if (!updated[0]) {
      throw new Error("Bill is not ready for admin approval");
    }

    await updateOrderWorkflowStatus(context, orderId, "Paid", client);

    // Approval FINALIZES the bill (view-once): close it so it can no longer be
    // edited by anyone, free the table, and complete any seated booking.
    await runQuery(
      `update "Bills" set closed_at = now(), closed_by_username = $1
         where table_id = $2 and res_id = $3 and outlet_id = $4 and closed_at is null and admin_approved_at is not null`,
      [admin.username, tableId, context.res_id, context.outlet_id],
      client,
    );
    // Loyalty earn on settle — best-effort, never fails the approval.
    try { await awardLoyaltyForSettledBill(context, tableId, client); } catch (err) { logger.warn({ err }, "loyalty_award_failed"); }
    await completeSeatedBookingsForTable(context, tableId, client);
    await runQuery(
      `update "Tables" set is_occupied = false, num_covers = 1, linked_order_id = null where id = $1 and res_id = $2 and outlet_id = $3`,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    await unassignTableById(context, tableId, client);
    await softDeleteIfVirtual(context, tableId, client);
    return { success: true };
  });
}

// Mark EVERY still-active order on a table as settled, so a freed/re-used table
// never re-sums a previous session's orders (the cause of bills "randomly"
// growing). Active = not already Paid(4)/Cancelled(5)/Closed(7).
async function closeActiveOrdersForTable(
  context: RestaurantContext,
  tableId: string,
  client: PoolClient,
  statusCode = 7, // Closed
): Promise<void> {
  await runQuery(
    `update "Orders" set status = $4
       where res_id = $1 and outlet_id = $2 and table_id = $3
         and coalesce(status::text, '1') not in ('4','5','7')`,
    [context.res_id, context.outlet_id, tableId, statusCode],
    client,
  );
}

// When a table is cleared (paid / closed / released), mark any booking that was
// actively SEATED or ARRIVED at it as Completed so the reservation list reflects
// that the party has left. Future (Confirmed/Requested) bookings are left
// untouched. Best-effort — never blocks the clearing flow.
async function completeSeatedBookingsForTable(
  context: RestaurantContext,
  tableId: string,
  client?: PoolClient,
): Promise<void> {
  try {
    const rows = await runQuery<{ id: string; slot: string; created_at: Date }>(
      `select id, slot, created_at from "Bookings"
         where res_id = $1 and outlet_id = $2 and table_id = $3`,
      [context.res_id, context.outlet_id, tableId],
      client,
    );
    for (const r of rows) {
      const slot = decodeSlot(r.slot, r.created_at);
      const st = String(slot.status ?? "").trim().toLowerCase();
      if (st === "seated" || st === "arrived") {
        slot.status = "Completed";
        await runQuery(
          `update "Bookings" set slot = $4 where id = $1 and res_id = $2 and outlet_id = $3`,
          [r.id, context.res_id, context.outlet_id, encodeSlot(slot)],
          client,
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "complete_bookings_for_table_failed");
  }
}

// Create a fresh hidden table to back a single takeaway/delivery order, so those
// channels flow through the normal per-table bill/settle machinery without using
// a physical floor table. Named "Takeaway XXXX" / "Delivery XXXX".
async function provisionVirtualTable(
  context: RestaurantContext,
  kind: "Takeaway" | "Delivery",
  client?: PoolClient,
  nameOverride?: string, // aggregator orders name their table after the channel + external id
): Promise<{ id: string; table_name: string }> {
  await ensureTableOccupancyColumns(client);
  const id = randomUUID();
  const name = nameOverride?.trim() || `${kind} ${id.slice(0, 4).toUpperCase()}`;
  await runQuery(
    `insert into "Tables" (id, created_at, res_id, outlet_id, table_name, capacity, is_occupied, num_covers, is_virtual)
     values ($1, now(), $2, $3, $4, 1, true, 1, true)`,
    [id, context.res_id, context.outlet_id, name],
    client,
  );
  return { id, table_name: name };
}

// After a virtual (takeaway/delivery) table's bill is settled/closed/released,
// soft-delete it so it never lingers on the floor or in future queries.
async function softDeleteIfVirtual(context: RestaurantContext, tableId: string, client?: PoolClient): Promise<void> {
  try {
    await runQuery(
      `update "Tables" set is_deleted = true, is_occupied = false
         where id = $1 and res_id = $2 and outlet_id = $3 and coalesce(is_virtual, false) = true`,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
  } catch (err) {
    logger.warn({ err }, "soft_delete_virtual_table_failed");
  }
}

// Place a takeaway / delivery order: provisions a hidden virtual table, then
// records the order against it (so it bills and settles like any table).
export async function AddTakeawayOrder(
  restaurantId: string,
  order: Partial<OrderRecord> & { order_type?: string; customer_phone?: string; delivery_address?: string },
): Promise<{ id: string; table: string; order_type: string }> {
  const context = await requireRestaurantContext(restaurantId);
  const kind: "Takeaway" | "Delivery" = String(order.order_type ?? "").toLowerCase() === "delivery" ? "Delivery" : "Takeaway";
  const virt = await provisionVirtualTable(context, kind);
  const created = await AddOrder(restaurantId, {
    ...(order as Record<string, unknown>),
    table: virt.table_name,
    order_type: kind.toLowerCase(),
  } as Partial<OrderRecord>);
  return { id: created.id, table: virt.table_name, order_type: kind.toLowerCase() };
}

// --- Aggregator (Swiggy/Zomato) order intake ---------------------------------
// Public integration point: a middleware/partner webhook posts the aggregator
// order with the restaurant's API key; it lands on a virtual table (like
// takeaway) tagged with its source so it flows through the SAME KDS/bill/settle
// machinery. Dedupe on (source, external_id) makes webhook retries safe.

async function ensureAggregatorOrdersTable(): Promise<void> {
  await ensureLazyTable("AggregatorOrders", async () => {
    await runQuery(
      `create table if not exists "AggregatorOrders" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         source text not null,
         external_id text not null,
         order_id uuid,
         created_at timestamptz not null default now()
       )`,
    );
    await runQuery(
      `create unique index if not exists aggregator_orders_uniq on "AggregatorOrders" (res_id, source, external_id)`,
    );
    await applyTenantRls("AggregatorOrders");
  });
}

// Mint (or rotate) the restaurant's aggregator API key. Returned ONCE to the
// admin; stored plain (per-tenant machine credential, rotation = regenerate).
export async function GenerateAggregatorKey(restaurantId: string): Promise<string> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const key = `agg_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await runQuery(`update "Restaurant" set aggregator_key = $2 where id = $1`, [context.res_id, key]);
  return key;
}

// Resolve the tenant for a presented aggregator key (public endpoint — runs
// before any tenant binding). Null = unknown/invalid key.
export async function GetRestaurantIdByAggregatorKey(key: string): Promise<string | null> {
  const trimmed = key.trim();
  if (trimmed.length < 12) return null;
  await ensureBrandingColumns();
  const rows = await runQuery<{ id: string }>(
    `select id from "Restaurant" where aggregator_key = $1 limit 1`,
    [trimmed],
  );
  return rows[0]?.id ?? null;
}

export async function AddAggregatorOrder(
  restaurantId: string,
  input: {
    source: "swiggy" | "zomato";
    external_id: string;
    items: Array<{ name: unknown; qty?: unknown; quantity?: unknown; price: unknown }>;
    customer_name?: string;
    customer_phone?: string;
  },
): Promise<{ order_id: string; table: string; total: number; deduped: boolean }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureAggregatorOrdersTable();
  const source = input.source;
  const externalId = String(input.external_id ?? "").trim().slice(0, 64);
  if (!externalId) throw new Error("external_id is required");

  // Webhook retries / duplicate posts return the original order (200, deduped).
  const existing = await runQuery<{ order_id: string | null }>(
    `select order_id from "AggregatorOrders" where res_id = $1 and source = $2 and external_id = $3 limit 1`,
    [context.res_id, source, externalId],
  );
  if (existing[0]) {
    return { order_id: existing[0].order_id ?? "", table: "", total: 0, deduped: true };
  }

  const items = (Array.isArray(input.items) ? input.items : []).map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    return {
      id: randomUUID(),
      name: String(it.name ?? "").trim().slice(0, 120) || "Item",
      price: round2(Math.max(0, Number(it.price) || 0)),
      quantity: Math.max(1, Math.round(Number(it.qty ?? it.quantity) || 1)),
    };
  });
  if (items.length === 0) throw new Error("At least one item is required");
  const subtotal = round2(items.reduce((s, it) => s + it.price * it.quantity, 0));

  const label = source.toUpperCase(); // SWIGGY / ZOMATO — the KDS source tag
  const safeExt = externalId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || randomUUID().slice(0, 4).toUpperCase();
  const virt = await provisionVirtualTable(context, "Delivery", undefined, `${label}-${safeExt}`);
  const created = await AddOrder(restaurantId, {
    table: virt.table_name,
    customer: input.customer_name?.trim().slice(0, 80) || `${label} guest`,
    customer_phone: input.customer_phone?.trim().slice(0, 20) || undefined,
    order_type: source, // tags the channel in Orders.food → KDS/expo badges
    note: `${label} order #${externalId}`,
    items,
    subtotal,
    total: subtotal,
    taxes: [],
    applyServiceCharge: false,
    status: "Preparing", // straight to the kitchen queue
  } as unknown as Partial<OrderRecord>);

  // Record the dedupe row. A concurrent duplicate that lost this race is
  // tolerated (rare double webhook within milliseconds) — the winner's row wins.
  await runQuery(
    `insert into "AggregatorOrders" (id, res_id, outlet_id, source, external_id, order_id)
     values ($1, $2, $3, $4, $5, $6) on conflict (res_id, source, external_id) do nothing`,
    [randomUUID(), context.res_id, context.outlet_id, source, externalId, created.id],
  );

  return { order_id: created.id, table: virt.table_name, total: subtotal, deduped: false };
}

export async function CloseBillByOrder(
  restaurantId: string,
  orderId: string,
  adminEmployeeId: string,
): Promise<{ success: true }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const admin = await resolveEmployeeByUsername(context, adminEmployeeId, client);
    if (!admin) {
      throw new Error("Admin not found");
    }

    const orderRows = await runQuery<{ table_id: string | null }>(
      `
        select table_id
        from "Orders"
        where id = $1 and res_id = $2 and outlet_id = $3
        limit 1
      `,
      [orderId, context.res_id, context.outlet_id],
      client,
    );

    const tableId = orderRows[0]?.table_id ?? null;
    if (!tableId) {
      throw new Error("Bill is not ready to be closed");
    }

    // Get the active table bill instead of a single order bill
    const billRows = await runQuery<{ id: string; table_id: string | null }>(
      `
        select id, table_id
        from "Bills"
        where
          table_id = $1
          and res_id = $2
          and outlet_id = $3
          and admin_approved_at is not null
          and status <> 3
          and closed_at is null
        order by created_at desc
        limit 1
      `,
      [tableId, context.res_id, context.outlet_id],
      client,
    );

    if (!billRows[0]) {
      // Approval already finalizes+closes the bill, so a follow-up close call is a
      // no-op: succeed if an approved+closed bill already exists for this table.
      const already = await runQuery<{ id: string }>(
        `select id from "Bills"
           where table_id = $1 and res_id = $2 and outlet_id = $3 and admin_approved_at is not null and closed_at is not null
           order by created_at desc limit 1`,
        [tableId, context.res_id, context.outlet_id],
        client,
      );
      if (already[0]) return { success: true };
      throw new Error("Bill is not ready to be closed");
    }

    const billId = billRows[0].id;
    const billTableId = billRows[0].table_id;

    const updated = await runQuery<{ id: string }>(
      `
        update "Bills"
        set closed_at = now(),
            closed_by_username = $1
        where id = $2
        returning id
      `,
      [admin.username, billId],
      client,
    );

    if (!updated[0]) {
      throw new Error("Failed to close bill");
    }

    // Loyalty earn on settle — best-effort, never fails the close.
    try { await awardLoyaltyForSettledBill(context, tableId, client); } catch (err) { logger.warn({ err }, "loyalty_award_failed"); }

    // Close ALL of the table's active orders (not just this one) so the next
    // session starts from a clean slate.
    await closeActiveOrdersForTable(context, tableId, client, 7);
    // Complete any booking that was seated at this table.
    await completeSeatedBookingsForTable(context, tableId, client);

    // Release the table if it exists
    if (billTableId) {
      const tableRows = await runQuery<{ table_name: string }>(
        `
          select table_name
          from "Tables"
          where id = $1 and res_id = $2 and outlet_id = $3
          limit 1
        `,
        [billTableId, context.res_id, context.outlet_id],
        client,
      );

      if (tableRows[0]) {
        const tableName = tableRows[0].table_name;
        await runQuery(
          `
            update "Tables"
            set is_occupied = false, num_covers = 1
            where id = $1 and res_id = $2 and outlet_id = $3
          `,
          [billTableId, context.res_id, context.outlet_id],
          client,
        );
        await softDeleteIfVirtual(context, billTableId, client);
      }
    }

    return { success: true };
  });
}

// Online payment (Razorpay) is gateway-verified, so it finalizes the table's
// bill directly: consolidates all orders, marks it paid + closed (locked), with
// no manual approval step. Call inside the tenant context (withTenant).
export async function FinalizeOnlinePayment(
  restaurantId: string,
  tableName: string,
  paymentRef: string,
): Promise<{ success: true; total_amt: number }> {
  return withTransaction(async (client) => {
    await ensureBillWorkflowColumns(client);
    await ensureTableOccupancyColumns(client);
    const context = await requireRestaurantContext(restaurantId, client);

    // Idempotency: /razorpay/verify is re-run on every client retry. If a bill
    // already records THIS payment ref it's settled — return it instead of cutting
    // a second (duplicate) closed bill that also burns another bill_no.
    const already = await runQuery<{ total_amt: number | string | null }>(
      `select total_amt from "Bills"
         where res_id = $1 and outlet_id = $2 and payment_proof_screenshot_url = $3
         limit 1`,
      [context.res_id, context.outlet_id, paymentRef],
      client,
    );
    if (already[0]) {
      return { success: true, total_amt: round2(Number(already[0].total_amt ?? 0) || 0) };
    }

    const tableRows = await runQuery<{ id: string }>(
      `select id from "Tables" where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3) and coalesce(is_deleted, false) = false limit 1`,
      [context.res_id, context.outlet_id, tableName.trim()],
      client,
    );
    const tableId = tableRows[0]?.id;
    if (!tableId) throw new Error("Table not found");

    const subtotal = await sumOrderTotalsForTable(context, tableId, client);
    // Fold the optional service charge + taxes into the charged/recorded total.
    const taxRows = await runQuery<{ default_tax: any }>(
      `select default_tax from "Outlets" where id = $1 and res_id = $2 limit 1`,
      [context.outlet_id, context.res_id],
      client,
    );
    const scPct = await getServiceChargePercent(context.res_id, client);
    const billDiscount = await getOpenBillDiscount(context, tableId, client);
    const { taxes, grand_total } = computeBillCharges(subtotal, taxRows[0]?.default_tax ?? null, scPct, true, billDiscount);
    const total = grand_total;
    const taxJson = JSON.stringify(taxes);

    const billRows = await runQuery<{ id: string }>(
      `select id from "Bills" where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null order by created_at desc limit 1`,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    let billId = billRows[0]?.id;
    if (!billId) {
      // No bill yet — create one from the table's orders.
      const ord = await runQuery<{ id: string; food: unknown }>(
        `select id, food from "Orders" where res_id = $1 and outlet_id = $2 and table_id = $3 order by created_at desc limit 1`,
        [context.res_id, context.outlet_id, tableId],
        client,
      );
      const orderId = ord[0]?.id ?? null;
      const empId = String((parseJsonObject(ord[0]?.food) ?? {}).taken_by_employee_id ?? "") || null;
      billId = randomUUID();
      const billNo = await nextBillNo(context, client);
      const ins = await runQuery<{ id: string }>(
        `insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no)
         values ($1, now(), $2, $3, $4, $5, 0, $6, $7, $8::jsonb, $9)
         on conflict do nothing returning id`,
        [billId, context.res_id, context.outlet_id, tableId, empId, orderId, total, taxJson, billNo],
        client,
      );
      billId = ins[0]?.id ?? (await existingOpenBillId(context, tableId, client)) ?? billId;
    }

    await runQuery(
      `update "Bills" set
         total_amt = $1, tax_breakdown = $2::jsonb, payment_method = 'Razorpay', payment_proof_screenshot_url = $3,
         waiter_confirmed_at = now(), waiter_confirmed_by_username = 'razorpay',
         admin_approved_at = now(), admin_approved_by_username = 'razorpay',
         closed_at = now(), closed_by_username = 'razorpay', status = 2
       where id = $4 and res_id = $5 and outlet_id = $6`,
      [total, taxJson, paymentRef, billId, context.res_id, context.outlet_id],
      client,
    );
    // Loyalty earn on settle — best-effort, never fails the payment.
    try { await awardLoyaltyForSettledBill(context, tableId, client); } catch (err) { logger.warn({ err }, "loyalty_award_failed"); }
    // Gateway-verified payment fully settles the table: mark its orders Paid and
    // free the table so the next guest (after re-scanning) starts fresh.
    await closeActiveOrdersForTable(context, tableId, client, 4); // Paid
    await completeSeatedBookingsForTable(context, tableId, client);
    await runQuery(
      `update "Tables" set is_occupied = false, num_covers = 1, linked_order_id = null
         where id = $1 and res_id = $2 and outlet_id = $3`,
      [tableId, context.res_id, context.outlet_id],
      client,
    );
    await unassignTableById(context, tableId, client);
    await softDeleteIfVirtual(context, tableId, client);
    return { success: true, total_amt: total };
  });
}

// A settled order (Paid = 4, Closed = 7) is final — its status must never change
// again (the bill is view-once after settlement). Throws when it's locked.
async function assertOrderStatusEditable(
  context: RestaurantContext,
  orderId: string,
  client?: PoolClient,
): Promise<void> {
  const rows = await runQuery<{ status: number | string | null }>(
    `select status from "Orders" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [orderId, context.res_id, context.outlet_id],
    client,
  );
  if (!rows[0]) return; // not found — leave not-found handling to the caller
  const code = Number(rows[0].status ?? 0);
  if (code === 4 || code === 7) {
    throw new Error("This order's bill is already settled and locked — its status can no longer be changed.");
  }
}

export async function UpdateBillStatusByOrder(
  restaurantId: string,
  orderId: string,
  status: number,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBillWorkflowColumns();
  await assertOrderStatusEditable(context, orderId);
  await runQuery(
    `
      update "Bills"
      set status = $1
      where order_id = $2 and res_id = $3 and outlet_id = $4
    `,
    [status, orderId, context.res_id, context.outlet_id],
  );
  return true;
}

// Advance a single order's kitchen/service stage (Preparing -> Served -> ...).
// Updates the Orders row so it reflects in the orders list and the KDS.
export async function SetOrderStatus(
  restaurantId: string,
  orderId: string,
  status: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  await assertOrderStatusEditable(context, orderId);
  const code = toOrderStatusCode(status);
  // An un-barked order can be accepted (Preparing) or cancelled, but never
  // advanced past the kitchen queue — the bark is the step in between.
  if (code === 2 || code === 3) await assertOrderBarked(context, orderId);
  const rows = await runQuery<{ id: string }>(
    `
      update "Orders"
      set status = $1,
          food = jsonb_set(coalesce(food::jsonb, '{}'::jsonb), '{status}', to_jsonb($2::text), true)
      where id = $3 and res_id = $4 and outlet_id = $5
      returning id
    `,
    [code, status, orderId, context.res_id, context.outlet_id],
  );
  if (rows.length > 0) {
    try { await applyTimingForStatus(context, orderId, status); } catch (err) { logger.warn({ err }, "timing status hook failed"); }
  }
  return rows.length > 0;
}

export async function ReplaceBill(
  restaurantId: string,
  payload: {
    old_order_id: string;
    reason: string | null;
    new_order: {
      table: string;
      customer: string;
      taken_by_employee_id?: string | null;
      taken_by_employee_name?: string | null;
      taken_by_employee_role?: string | null;
      items: OrderItemRecord[];
      subtotal: number;
      serviceChargePercentage?: number | null;
      applyServiceCharge?: boolean;
      taxes?: Array<{ id?: string; name: string; percentage: number }>;
    };
    new_bill: {
      total_amt: number;
      emp_id?: string | null;
      status?: number;
      tax_breakdown?: any;
    };
  },
): Promise<{ newOrderId: string; newBillId: string } | null> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const oldOrderId = String(payload.old_order_id ?? '').trim();
    if (!oldOrderId) throw new Error('Missing old_order_id');

    // locate existing bill (if any)
    // try to locate existing bill and update in-place
    const existing = await runQuery<{ id: string; emp_id: string | null; table_id: string | null }>(
      `select id, emp_id, table_id from "Bills" where order_id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
      [oldOrderId, context.res_id, context.outlet_id],
      client,
    );
    const oldBillRow = existing[0] ?? null;

    // prepare new order payload (we will update the existing order's embedded JSON)
    const newOrderPayload = {
      id: oldOrderId,
      table: String(payload.new_order.table ?? ''),
      customer: String(payload.new_order.customer ?? 'Guest'),
      taken_by_employee_id: String(payload.new_order.taken_by_employee_id ?? '').trim() || null,
      taken_by_employee_name: String(payload.new_order.taken_by_employee_name ?? '').trim() || null,
      taken_by_employee_role: String(payload.new_order.taken_by_employee_role ?? '').trim() || null,
      items: Array.isArray(payload.new_order.items) ? payload.new_order.items : [],
      subtotal: parseNumeric(payload.new_order.subtotal ?? 0),
      serviceChargePercentage: parseNumeric(payload.new_order.serviceChargePercentage ?? 0),
      taxes: Array.isArray(payload.new_order.taxes) ? payload.new_order.taxes : [],
      applyServiceCharge: Boolean(payload.new_order.applyServiceCharge),
      total: parseNumeric(payload.new_bill.total_amt ?? 0),
      status: 'Bill Verification',
    };

    // resolve table id (prefer resolving from new payload, fallback to existing bill table)
    let tableId: string | null = null;
    if (newOrderPayload.table) {
      const tableRows = await runQuery<{ id: string }>(
        `select id from "Tables" where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3) limit 1`,
        [context.res_id, context.outlet_id, newOrderPayload.table],
        client,
      );
      tableId = tableRows[0]?.id ?? null;
    }
    if (!tableId && oldBillRow) tableId = oldBillRow.table_id ?? null;

    // resolve employee id for bill update. prefer provided, fall back to existing bill emp_id
    let empId: string | null = null;
    if (payload.new_bill.emp_id) {
      const rawEmployeeId = String(payload.new_bill.emp_id).trim();
      if (isUuid(rawEmployeeId)) {
        empId = rawEmployeeId;
      } else {
        const resolved = await resolveEmployeeByUsername(context, rawEmployeeId, client);
        empId = resolved?.id ?? null;
      }
    }

    if (oldBillRow && !oldBillRow.id) {
      // unreachable but defensive
    }

    if (oldBillRow) {
      // update existing order row's embedded food JSON and status
      await runQuery(
        `
        update "Orders"
        set food = $1::json,
            table_id = $2,
            status = $3
        where id = $4 and res_id = $5 and outlet_id = $6
      `,
        [JSON.stringify(newOrderPayload), tableId, toOrderStatusCode('Bill Verification'), oldOrderId, context.res_id, context.outlet_id],
        client,
      );

      // if empId not resolved, keep existing emp_id
      if (!empId) empId = oldBillRow.emp_id ?? null;

      // update existing bill row in-place
      await runQuery(
        `update "Bills" set total_amt = $1, tax_breakdown = $2, emp_id = $3, reason = $4, table_id = $5 where id = $6 and res_id = $7 and outlet_id = $8`,
        [
          payload.new_bill.total_amt ?? 0,
          payload.new_bill.tax_breakdown ? JSON.stringify(payload.new_bill.tax_breakdown) : null,
          empId,
          payload.reason ?? null,
          tableId,
          oldBillRow.id,
          context.res_id,
          context.outlet_id,
        ],
        client,
      );

      return { newOrderId: oldOrderId, newBillId: oldBillRow.id };
    }

    // if no existing bill found, fall back to creating a new order+bill (legacy behavior)
    const newOrderId = randomUUID();
    const tableRows = await runQuery<{ id: string }>(
      `select id from "Tables" where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3) limit 1`,
      [context.res_id, context.outlet_id, newOrderPayload.table],
      client,
    );
    const resolvedTableId = tableRows[0]?.id ?? null;

    await runQuery(
      `
      insert into "Orders" (id, created_at, res_id, outlet_id, food, table_id, status, cust_id)
      values ($1, now(), $2, $3, $4::json, $5, $6, null)
    `,
      [newOrderId, context.res_id, context.outlet_id, JSON.stringify({ ...newOrderPayload, id: newOrderId }), resolvedTableId, toOrderStatusCode('Bill Verification')],
      client,
    );

    const newBillId = randomUUID();
    if (!empId) {
      throw new Error("Unable to resolve employee for replacement bill (emp_id)");
    }

    await runQuery(
      `
      insert into "Bills" (id, created_at, res_id, outlet_id, table_id, emp_id, status, reason, order_id, total_amt, tax_breakdown)
      values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
      [
        newBillId,
        context.res_id,
        context.outlet_id,
        resolvedTableId,
        empId,
        payload.new_bill.status ?? 1,
        null,
        newOrderId,
        payload.new_bill.total_amt ?? 0,
        payload.new_bill.tax_breakdown ? JSON.stringify(payload.new_bill.tax_breakdown) : null,
      ],
      client,
    );

    return { newOrderId, newBillId };
  });
}

async function ensureTableAssignmentsTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Table_assignments", async () => {
    await runQuery(
      `create table if not exists "Table_assignments" (
        id uuid primary key,
        created_at timestamptz not null default now(),
        res_id uuid not null,
        outlet_id uuid not null,
        table_id uuid not null,
        employee_id uuid not null
      )`,
    );
    await runQuery(
      `create unique index if not exists idx_table_assignments_unique
       on "Table_assignments" (res_id, outlet_id, table_id)`,
    );
    await runQuery(
      `create index if not exists idx_table_assignments_employee
       on "Table_assignments" (res_id, outlet_id, employee_id)`,
    );
    await applyTenantRls("Table_assignments");
  });
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

// round2 / computeBillTaxes / computeBillCharges are imported and re-exported from
// ./billing_math.js (pure, unit-tested — see jest-tests/billing_math.test.ts).

// The restaurant's configured service-charge percent (0 = off). Tolerant of the
// column not existing yet (returns 0).
async function getServiceChargePercent(resId: string, client?: PoolClient): Promise<number> {
  try {
    const rows = await runQuery<{ service_charge: number | string | null }>(
      `select service_charge from "Restaurant" where id = $1 limit 1`,
      [resId],
      client,
    );
    return Math.max(0, Number(rows[0]?.service_charge ?? 0) || 0);
  } catch {
    return 0;
  }
}

async function resolveTableByName(
  context: RestaurantContext,
  tableName: string,
  client?: PoolClient,
): Promise<{ id: string; table_name: string } | null> {
  await ensureTableOccupancyColumns(client);
  const rows = await runQuery<{ id: string; table_name: string }>(
    `
      select id, table_name
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
        and coalesce(is_deleted, false) = false
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
): Promise<{ id: string; username: string; fname: string | null; lname: string | null; role_primary: string } | null> {
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
        and (
          lower(l.emp_username) = lower($3)
          or e.id::text = $3
        )
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
    fname: row.fname ?? null,
    lname: row.lname ?? null,
    role_primary: row.role_primary ?? "employee",
  };
}

// --- Waitlist / queue --------------------------------------------------------
// Walk-in parties join a queue (public QR) when the floor is full; staff call &
// seat them. A held pre_order (items picked while waiting) is placed as a real
// order on seating. RLS-scoped by res_id like every tenant table.
export type WaitlistItem = { id: string; name: string; price: number; quantity: number; note?: string };
// Additive contact-capture: everyone who scans the shared "join party" QR records
// their own name/phone here. Does NOT change party_size (that's still the head count).
export type WaitlistMember = { name: string; phone: string; joined_at: string };
export type WaitlistEntry = {
  id: string;
  name: string;
  phone: string | null;
  party_size: number;
  status: "waiting" | "called" | "seated" | "cancelled" | "no_show";
  token: string;
  pre_order: WaitlistItem[];
  party_members: WaitlistMember[];
  table_name: string | null;
  qr_token?: string | null;
  created_at: string;
  called_at: string | null;
  seated_at: string | null;
};

async function ensureWaitlistTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Waitlist", async () => {
    await runQuery(
      `create table if not exists "Waitlist" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         token uuid not null,
         name text not null,
         phone text,
         party_size integer not null default 1,
         status text not null default 'waiting',
         pre_order jsonb not null default '[]'::jsonb,
         table_id uuid,
         created_at timestamptz not null default now(),
         called_at timestamptz,
         seated_at timestamptz
       )`,
    );
    await runQuery(`create index if not exists waitlist_lookup_idx on "Waitlist" (res_id, outlet_id, status, created_at)`);
    await runQuery(`create unique index if not exists waitlist_token_idx on "Waitlist" (token)`);
    // Lazy column: party members captured when scanners of the shared join-QR add
    // themselves. Guarded like other lazy columns so pre-existing tables get it too.
    const hasMembers = await runQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'Waitlist' and column_name = 'party_members'`,
    );
    if (!hasMembers[0]) {
      await runQuery(`alter table "Waitlist" add column party_members jsonb not null default '[]'::jsonb`);
    }
    await applyTenantRls("Waitlist");
  });
}

// Normalize the party_members jsonb — trims/caps every field, drops empty rows,
// and enforces the 25-member ceiling. Used both when reading (mapWaitlist) and
// when appending (AddWaitlistMember).
function normalizeWaitlistMembers(raw: unknown): WaitlistMember[] {
  if (!Array.isArray(raw)) return [];
  const out: WaitlistMember[] = [];
  for (const r of raw.slice(0, 25)) {
    const o = (r ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim().slice(0, 80);
    const phone = String(o.phone ?? "").trim().slice(0, 40);
    if (!name && !phone) continue;
    const joined_at = typeof o.joined_at === "string" && o.joined_at ? o.joined_at : new Date().toISOString();
    out.push({ name, phone, joined_at });
  }
  return out;
}

// Digits-only key used to dedupe members (so "+91 99900-01111" and "9990001111"
// count as the same person).
function waitlistMemberPhoneKey(phone: string): string {
  return String(phone ?? "").replace(/\D+/g, "");
}

function normalizeWaitlistItems(raw: unknown): WaitlistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WaitlistItem[] = [];
  for (const r of raw.slice(0, 100)) { // cap line count (anti-DoS)
    const o = (r ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    if (!name) continue;
    const quantity = Math.min(99, Math.max(1, Math.round(parseNumeric(o.quantity ?? 1) || 1)));
    const price = Math.max(0, parseNumeric(o.price ?? 0));
    const note = typeof o.note === "string" ? o.note.trim().slice(0, 280) : "";
    out.push({ id: String(o.id ?? randomUUID()), name, price: round2(price), quantity, ...(note ? { note } : {}) });
  }
  return out;
}

// Replace client-supplied prices with authoritative MENU prices (security: a guest
// must never order real items for free). `floorOnly` keeps a client price only when
// it's >= the menu base (so modifier upcharges on the staff/QR order path survive);
// otherwise the exact menu price is used. Items with no current menu match are
// DROPPED (they can't be billed). Must run inside the tenant context.
export async function repriceFromMenu(restaurantId: string, items: WaitlistItem[], floorOnly = false): Promise<WaitlistItem[]> {
  if (!Array.isArray(items) || items.length === 0) return [];
  const menu = await GetMenuItems(restaurantId).catch(() => [] as MenuItemRecord[]);
  if (menu.length === 0) return [];
  const byId = new Map(menu.map((m) => [String(m.id), m]));
  const byName = new Map(menu.map((m) => [m.name.trim().toLowerCase(), m]));
  const out: WaitlistItem[] = [];
  for (const it of items) {
    const m = byId.get(String(it.id)) ?? byName.get(String(it.name).trim().toLowerCase());
    if (!m) continue;
    const base = round2(parseNumeric(m.price));
    const price = floorOnly ? Math.max(base, round2(parseNumeric(it.price))) : base;
    out.push({ id: String(m.id), name: m.name, price, quantity: it.quantity, ...(it.note ? { note: it.note } : {}) });
  }
  return out;
}

function mapWaitlist(r: Record<string, any>): WaitlistEntry {
  const iso = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  let pre: WaitlistItem[] = [];
  try { pre = normalizeWaitlistItems(typeof r.pre_order === "string" ? JSON.parse(r.pre_order) : r.pre_order); } catch { pre = []; }
  let members: WaitlistMember[] = [];
  try { members = normalizeWaitlistMembers(typeof r.party_members === "string" ? JSON.parse(r.party_members) : r.party_members); } catch { members = []; }
  const status = ["waiting", "called", "seated", "cancelled", "no_show"].includes(r.status) ? r.status : "waiting";
  return {
    id: r.id,
    name: r.name,
    phone: r.phone ?? null,
    party_size: Number(r.party_size ?? 1) || 1,
    status,
    token: r.token,
    pre_order: pre,
    party_members: members,
    table_name: r.table_name ?? null,
    created_at: iso(r.created_at) ?? "",
    called_at: iso(r.called_at),
    seated_at: iso(r.seated_at),
  };
}

// Parties still waiting ahead of this one (created earlier).
async function waitlistPosition(context: RestaurantContext, entry: { created_at: string; status: string }, outletId?: string): Promise<number> {
  if (entry.status !== "waiting") return 0;
  // Count against the ENTRY's own outlet — the public status-poll binds an empty
  // outlet (resolves to the default), so a party who joined a non-default branch
  // must still be ranked within THAT branch's queue, not outlet #1's.
  const outlet = outletId ?? context.outlet_id;
  const rows = await runQuery<{ n: number | string }>(
    `select count(*)::int as n from "Waitlist" where res_id = $1 and outlet_id = $2 and status = 'waiting' and created_at < $3`,
    [context.res_id, outlet, entry.created_at],
  );
  return Number(rows[0]?.n ?? 0) + (entry.status === "waiting" ? 1 : 0);
}

export async function JoinWaitlist(restaurantId: string, input: { name: string; phone?: string; party_size?: number }): Promise<WaitlistEntry & { position: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Name is required to join the queue");
  const party = Math.max(1, Math.min(50, Math.round(Number(input.party_size) || 1)));
  const phone = input.phone?.trim() || null;
  // Dedupe: if this phone already has an active entry, return it instead of stacking
  // duplicate parties (which would inflate everyone else's position).
  if (phone) {
    const dup = await runQuery<Record<string, any>>(
      `select w.*, t.table_name from "Waitlist" w left join "Tables" t on t.id = w.table_id
         where w.res_id = $1 and w.outlet_id = $2 and w.phone = $3 and w.status in ('waiting','called')
         order by w.created_at desc limit 1`,
      [context.res_id, context.outlet_id, phone],
    );
    if (dup[0]) {
      const e = mapWaitlist(dup[0]);
      return { ...e, position: await waitlistPosition(context, e) };
    }
  }
  const rows = await runQuery<Record<string, any>>(
    `insert into "Waitlist" (id, res_id, outlet_id, token, name, phone, party_size, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'waiting') returning *`,
    [randomUUID(), context.res_id, context.outlet_id, randomUUID(), name, phone, party],
  );
  if (!rows[0]) throw new Error("Failed to join the queue");
  const entry = mapWaitlist(rows[0]);
  return { ...entry, position: await waitlistPosition(context, entry) };
}

export async function GetWaitlistEntryByToken(restaurantId: string, token: string): Promise<(WaitlistEntry & { position: number }) | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  const rows = await runQuery<Record<string, any>>(
    `select w.*, t.table_name from "Waitlist" w left join "Tables" t on t.id = w.table_id where w.token = $1 and w.res_id = $2 limit 1`,
    [token, context.res_id],
  );
  if (!rows[0]) return null;
  const entry = mapWaitlist(rows[0]);
  // Once seated, hand the client the table's SIGNED ordering token so the queue
  // page can redirect the party straight to that table's menu. It can't be forged
  // client-side — it's HMAC-signed with the server secret.
  const qr_token = entry.status === "seated" && entry.table_name
    ? encodeTableToken(context.res_id, entry.table_name)
    : null;
  return { ...entry, qr_token, position: await waitlistPosition(context, entry, rows[0].outlet_id) };
}

export async function SetWaitlistPreorder(restaurantId: string, token: string, items: unknown): Promise<{ success: true } | { error: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  // Re-price every line from the authoritative menu (a guest must not set prices);
  // unknown items are dropped — they can't be billed.
  const normalized = await repriceFromMenu(restaurantId, normalizeWaitlistItems(items), false);
  const rows = await runQuery<{ id: string }>(
    `update "Waitlist" set pre_order = $1::jsonb where token = $2 and res_id = $3 and status in ('waiting','called') returning id`,
    [JSON.stringify(normalized), token, context.res_id],
  );
  if (!rows[0]) return { error: "Your queue entry is no longer active" };
  return { success: true };
}

// A person who scanned the shared "join party" QR records their own contact here.
// DEDUPE by normalized phone (same phone updates the name instead of stacking a
// duplicate); cap 25 members. Only allowed while the party is active. Runs under a
// row lock so concurrent scanners can't clobber each other's append.
export async function AddWaitlistMember(
  restaurantId: string,
  token: string,
  input: { name?: unknown; phone?: unknown },
): Promise<{ success: true; party_members: WaitlistMember[] } | { error: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  const name = String(input?.name ?? "").trim().slice(0, 80);
  const phoneRaw = String(input?.phone ?? "").trim().slice(0, 40);
  if (!name) return { error: "Please enter your name" };
  if (waitlistMemberPhoneKey(phoneRaw).length < 7) return { error: "Please enter a valid phone number" };
  const key = waitlistMemberPhoneKey(phoneRaw);

  return withTransaction(async () => {
    const rows = await runQuery<Record<string, any>>(
      `select party_members from "Waitlist" where token = $1 and res_id = $2 and status in ('waiting','called') for update`,
      [token, context.res_id],
    );
    if (!rows[0]) return { error: "This queue entry is no longer active" };
    const members = normalizeWaitlistMembers(
      typeof rows[0].party_members === "string" ? JSON.parse(rows[0].party_members) : rows[0].party_members,
    );
    const existing = members.find((m) => waitlistMemberPhoneKey(m.phone) === key);
    if (existing) {
      existing.name = name; // same phone → update the name only, keep joined_at
      existing.phone = phoneRaw;
    } else {
      if (members.length >= 25) return { error: "This party is full (25 people max)" };
      members.push({ name, phone: phoneRaw, joined_at: new Date().toISOString() });
    }
    await runQuery(
      `update "Waitlist" set party_members = $1::jsonb where token = $2 and res_id = $3 and status in ('waiting','called')`,
      [JSON.stringify(members), token, context.res_id],
    );
    return { success: true, party_members: members };
  });
}

export async function CancelWaitlistByToken(restaurantId: string, token: string): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  await runQuery(`update "Waitlist" set status = 'cancelled' where token = $1 and res_id = $2 and status in ('waiting','called')`, [token, context.res_id]);
  return { success: true };
}

export async function GetWaitlist(restaurantId: string): Promise<Array<WaitlistEntry & { position: number; minutes_waiting: number }>> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  const rows = await runQuery<Record<string, any>>(
    `select w.*, t.table_name from "Waitlist" w left join "Tables" t on t.id = w.table_id
       where w.res_id = $1 and w.outlet_id = $2 and w.status in ('waiting','called')
       order by w.created_at asc`,
    [context.res_id, context.outlet_id],
  );
  let pos = 0;
  return rows.map((r) => {
    const e = mapWaitlist(r);
    const minutes = Math.max(0, Math.round((Date.now() - new Date(e.created_at).getTime()) / 60000));
    const position = e.status === "waiting" ? ++pos : 0;
    return { ...e, position, minutes_waiting: minutes };
  });
}

export async function CallWaitlistEntry(restaurantId: string, id: string): Promise<WaitlistEntry> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  const rows = await runQuery<Record<string, any>>(
    `update "Waitlist" set status = 'called', called_at = now() where id = $1 and res_id = $2 and outlet_id = $3 and status = 'waiting' returning *`,
    [id, context.res_id, context.outlet_id],
  );
  if (!rows[0]) throw new Error("Entry not found or not waiting");
  return mapWaitlist(rows[0]);
}

export async function CancelWaitlistEntry(restaurantId: string, id: string, status: "cancelled" | "no_show"): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  const next = status === "no_show" ? "no_show" : "cancelled";
  await runQuery(`update "Waitlist" set status = $1 where id = $2 and res_id = $3 and outlet_id = $4 and status in ('waiting','called')`, [next, id, context.res_id, context.outlet_id]);
  return { success: true };
}

export async function SeatWaitlistEntry(
  restaurantId: string,
  id: string,
  tableName: string,
  actorEmployeeId?: string | null,
): Promise<{ success: true; placed_order_id: string | null; table_name: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureWaitlistTable();
  await ensureTableOccupancyColumns();
  const table = String(tableName ?? "").trim();
  if (!table) throw new Error("A table is required to seat the party");

  // The whole seat is one transaction: claim the queue entry, claim a FREE table
  // (row-locked), occupy it, and place the held pre-order. If anything fails
  // (e.g. the table just got taken, or AddOrder rejects), the entire thing rolls
  // back — no half-seated party, no double-occupy, no lost pre-order.
  return withTransaction(async (client) => {
    // 1) Atomically claim the entry — only if it is still active. Two staff seating
    //    the same party: the second claims 0 rows and aborts.
    const claimed = await runQuery<{ party_size: number; pre_order: unknown; name: string }>(
      `update "Waitlist" set status = 'seated', seated_at = now()
         where id = $1 and res_id = $2 and outlet_id = $3 and status in ('waiting','called')
         returning party_size, pre_order, name`,
      [id, context.res_id, context.outlet_id],
      client,
    );
    if (!claimed[0]) throw new Error("This party is no longer in the queue");
    const party = Math.max(1, Math.round(Number(claimed[0].party_size ?? 1) || 1));
    const name = String(claimed[0].name ?? "").trim();
    const preRaw = claimed[0].pre_order;
    const preOrder = normalizeWaitlistItems(typeof preRaw === "string" ? JSON.parse(preRaw || "[]") : preRaw);

    // 2) Atomically claim the table — must exist and be free (row lock prevents two
    //    parties racing onto the same table).
    const trows = await runQuery<{ id: string; occ: boolean }>(
      `select id, coalesce(is_occupied, false) as occ from "Tables"
         where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3) and coalesce(is_deleted, false) = false
         limit 1 for update`,
      [context.res_id, context.outlet_id, table],
      client,
    );
    if (!trows[0]) throw new Error("Table not found");
    if (trows[0].occ) throw new Error("That table is already occupied — pick another");
    const tableId = trows[0].id;
    await runQuery(
      `update "Tables" set is_occupied = true, num_covers = $4, linked_order_id = null where id = $1 and res_id = $2 and outlet_id = $3`,
      [tableId, context.res_id, context.outlet_id, party],
      client,
    );
    await runQuery(`update "Waitlist" set table_id = $1 where id = $2 and res_id = $3`, [tableId, id, context.res_id], client);
    if (actorEmployeeId && isUuid(actorEmployeeId)) {
      try {
        await assignTableById(context, tableId, actorEmployeeId, client);
      } catch (err) {
        logger.warn({ err: (err as any)?.message ?? err }, "waitlist seat assign failed");
      }
    }

    // 3) Place the held pre-order, re-priced from the menu. This MUST succeed (it
    //    runs on the same client/txn); if it throws, the whole seat rolls back.
    let placedOrderId: string | null = null;
    if (preOrder.length > 0) {
      const priced = await repriceFromMenu(restaurantId, preOrder, false);
      if (priced.length > 0) {
        const subtotal = round2(priced.reduce((s, it) => s + it.price * it.quantity, 0));
        const settings = await GetRestaurantSettings(restaurantId).catch(() => ({ auto_push_orders: true } as any));
        const order = await AddOrder(restaurantId, {
          table,
          customer: name || "Walk-in",
          items: priced,
          subtotal,
          total: subtotal,
          taxes: [],
          status: settings.auto_push_orders ? "Preparing" : "Pending",
          ...(actorEmployeeId ? { taken_by_employee_id: actorEmployeeId } : {}),
        } as any);
        placedOrderId = order.id;
      }
    }
    return { success: true as const, placed_order_id: placedOrderId, table_name: table };
  });
}

// Auto-assign the seating employee to a table by ids (drives APC + feedback/rating
// attribution). Best-effort — call only with a real Employees.id (UUID). Upserts
// so re-seating replaces the assignment; created_at refreshed so the latest wins.
async function assignTableById(context: RestaurantContext, tableId: string, employeeId: string, client?: PoolClient): Promise<void> {
  await ensureTableAssignmentsTable(client);
  await runQuery(
    `insert into "Table_assignments" (id, created_at, res_id, outlet_id, table_id, employee_id)
     values ($1, now(), $2, $3, $4, $5)
     on conflict (res_id, outlet_id, table_id)
     do update set employee_id = excluded.employee_id, created_at = now()`,
    [randomUUID(), context.res_id, context.outlet_id, tableId, employeeId],
    client,
  );
}

// Remove a table's waiter assignment by table id (when the table is freed/settled).
// Safe no-op when there's no assignment.
async function unassignTableById(context: RestaurantContext, tableId: string, client?: PoolClient): Promise<void> {
  await ensureTableAssignmentsTable(client);
  await runQuery(
    `delete from "Table_assignments" where res_id = $1 and outlet_id = $2 and table_id = $3`,
    [context.res_id, context.outlet_id, tableId],
    client,
  );
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
      employee_name: `${employee.fname ?? ''} ${employee.lname ?? ''}`.trim(),
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

// The waiter currently assigned to a specific table. Returns the Employees.id
// (UUID) — the same identifier /feedback/submit attributes feedback to — so the
// feedback form QR/redirect can credit the right waiter. Null when the table
// has no assignment.
export async function GetTableFeedbackContext(
  restaurantId: string,
  tableName: string,
): Promise<{
  employee_id: string;
  employee_name: string;
  employee_role: string;
  res_id: string;
  outlet_id: string;
} | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableAssignmentsTable();

  const rows = await runQuery<{
    employee_id: string;
    fname: string;
    lname: string;
    role_primary: string | null;
  }>(
    `
      select
        e.id as employee_id,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname,
        e.emp_roles->>'primary' as role_primary
      from "Table_assignments" ta
      join "Tables" t
        on t.id = ta.table_id and t.res_id = ta.res_id and t.outlet_id = ta.outlet_id
      join "Employees" e
        on e.id = ta.employee_id and e.res_id = ta.res_id and e.outlet_id = ta.outlet_id
      where ta.res_id = $1 and ta.outlet_id = $2 and lower(t.table_name) = lower($3)
      order by ta.created_at desc
      limit 1
    `,
    [context.res_id, context.outlet_id, tableName],
  );

  let row = rows[0];

  // Fallback: no explicit table->waiter assignment, so credit the employee who
  // took the table's most recent order (so feedback still attributes correctly).
  if (!row || !row.employee_id) {
    const orderRows = await runQuery<{ food: unknown }>(
      `select o.food
         from "Orders" o
         join "Tables" t on t.id = o.table_id and t.res_id = o.res_id and t.outlet_id = o.outlet_id
        where o.res_id = $1 and o.outlet_id = $2 and lower(t.table_name) = lower($3)
        order by o.created_at desc limit 1`,
      [context.res_id, context.outlet_id, tableName],
    );
    const empId = String((parseJsonObject(orderRows[0]?.food) ?? {}).taken_by_employee_id ?? "").trim();
    if (empId && isUuid(empId)) {
      const empRows = await runQuery<{ fname: string; lname: string; role_primary: string | null }>(
        `select e."emp_Fname" as fname, e."emp_Lname" as lname, e.emp_roles->>'primary' as role_primary
           from "Employees" e where e.id = $1 and e.res_id = $2 limit 1`,
        [empId, context.res_id],
      );
      row = { employee_id: empId, fname: empRows[0]?.fname ?? "", lname: empRows[0]?.lname ?? "", role_primary: empRows[0]?.role_primary ?? null };
    }
  }

  // Always return at least the restaurant + outlet so the customer can be sent to
  // the feedback form even when no waiter could be resolved (employee_id empty).
  return {
    employee_id: row?.employee_id ?? "",
    employee_name: row ? `${row.fname ?? ""} ${row.lname ?? ""}`.trim() : "",
    employee_role: row?.role_primary ?? "waiter",
    res_id: context.res_id,
    outlet_id: context.outlet_id,
  };
}

// The DB clock can differ from the Node process clock (timezone / sandbox), and
// order rows are stamped with DB now(). Base period math on the DB clock so the
// "current month" lines up with the orders' timestamps (otherwise APC reads 0).
async function currentDbTime(): Promise<Date> {
  try {
    const rows = await runQuery<{ now: Date }>(`select now() as now`);
    const v = rows[0]?.now;
    return v ? new Date(v as unknown as string) : new Date();
  } catch {
    return new Date();
  }
}

// Daily revenue + order-count series for the last `days` days (for trend charts).
export async function GetDailyRevenueSeries(
  restaurantId: string,
  days = 14,
): Promise<Array<{ date: string; revenue: number; orders: number }>> {
  const context = await requireRestaurantContext(restaurantId);
  const span = Math.min(90, Math.max(1, Math.round(days)));
  const now = await currentDbTime();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)));

  const rows = await runQuery<{ created_at: Date | string; food: unknown; status: unknown }>(
    `select created_at, food, status from "Orders"
       where res_id = $1 and outlet_id = $2 and created_at >= $3`,
    [context.res_id, context.outlet_id, start.toISOString()],
  );

  const byDay = new Map<string, { revenue: number; orders: number }>();
  for (const r of rows) {
    const st = String(fromOrderStatusCode(r.status) ?? "").toLowerCase();
    if (st === "cancelled") continue;
    const d = new Date(r.created_at as string);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const p = parseJsonObject(r.food) ?? {};
    const total = parseNumeric(p.total) > 0 ? parseNumeric(p.total) : parseNumeric(p.subtotal);
    const cur = byDay.get(key) ?? { revenue: 0, orders: 0 };
    cur.revenue += total;
    cur.orders += 1;
    byDay.set(key, cur);
  }

  const series: Array<{ date: string; revenue: number; orders: number }> = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const v = byDay.get(key) ?? { revenue: 0, orders: 0 };
    series.push({ date: key, revenue: round2(v.revenue), orders: v.orders });
  }
  return series;
}

// Operational analytics from REAL orders (replaces the dashboard's hardcoded mock
// charts): order volume + revenue bucketed by hour-of-day and by weekday over the
// last N days. Hours/weekdays are UTC for determinism.
export async function GetOperationsAnalytics(
  restaurantId: string,
  days = 30,
): Promise<{
  days: number;
  by_hour: Array<{ hour: number; orders: number; revenue: number }>;
  by_weekday: Array<{ weekday: number; label: string; orders: number; revenue: number }>;
}> {
  const context = await requireRestaurantContext(restaurantId);
  const span = Math.min(180, Math.max(1, Math.round(days)));
  const now = await currentDbTime();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)));
  const rows = await runQuery<{ created_at: Date | string; food: unknown; status: unknown }>(
    `select created_at, food, status from "Orders" where res_id = $1 and outlet_id = $2 and created_at >= $3`,
    [context.res_id, context.outlet_id, start.toISOString()],
  );
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));
  const wkLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byWeekday = wkLabels.map((label, weekday) => ({ weekday, label, orders: 0, revenue: 0 }));
  for (const r of rows) {
    const st = String(fromOrderStatusCode(r.status) ?? "").toLowerCase();
    if (st === "cancelled") continue;
    const d = new Date(r.created_at as string);
    if (Number.isNaN(d.getTime())) continue;
    const p = parseJsonObject(r.food) ?? {};
    const total = parseNumeric(p.total) > 0 ? parseNumeric(p.total) : parseNumeric(p.subtotal);
    const hb = byHour[d.getUTCHours()];
    if (hb) {
      hb.orders += 1;
      hb.revenue = round2(hb.revenue + total);
    }
    const wb = byWeekday[d.getUTCDay()];
    if (wb) {
      wb.orders += 1;
      wb.revenue = round2(wb.revenue + total);
    }
  }
  return { days: span, by_hour: byHour, by_weekday: byWeekday };
}

// --- Multi-outlet management -------------------------------------------------

let outletColumnsEnsured = false;
async function ensureOutletColumns(client?: PoolClient): Promise<void> {
  if (outletColumnsEnsured && !client) return;
  await runQuery(`alter table "Outlets" add column if not exists is_active boolean not null default true`, [], client);
  // Per-outlet running invoice counter — each outlet keeps its own sequential
  // bill (invoice) number series, as GST expects per place of business.
  await runQuery(`alter table "Outlets" add column if not exists bill_seq integer not null default 0`, [], client);
  if (!client) outletColumnsEnsured = true;
}

// Atomically allocate the next sequential bill number for the outlet. The
// `update … returning` is atomic on its own (row lock), so concurrent
// settlements never get the same number, with or without a surrounding
// transaction. Pass the client when inside one so it shares the transaction.
async function nextBillNo(context: RestaurantContext, client?: PoolClient): Promise<number> {
  await ensureOutletColumns(client);
  const rows = await runQuery<{ bill_seq: number }>(
    `update "Outlets" set bill_seq = coalesce(bill_seq, 0) + 1
       where id = $1 and res_id = $2
       returning bill_seq`,
    [context.outlet_id, context.res_id],
    client,
  );
  return rows[0]?.bill_seq ?? 1;
}

export type OutletRecord = {
  id: string;
  outlet_name: string;
  outlet_add: string | null;
  outlet_phone: string | null;
  outlet_hours: string | null;
  is_active: boolean;
  is_default: boolean;
};

export async function GetOutlets(restaurantId: string): Promise<OutletRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutletColumns();
  const rows = await runQuery<{
    id: string;
    outlet_name: string | null;
    outlet_add: string | null;
    outlet_phone: string | null;
    outlet_hours: string | null;
    is_active: boolean | null;
  }>(
    `select id, outlet_name, outlet_add, cast(outlet_main_ph as text) as outlet_phone,
            outlet_working_hours as outlet_hours, coalesce(is_active, true) as is_active
       from "Outlets" where res_id = $1 order by created_at asc`,
    [context.res_id],
  );
  return rows.map((r, i) => ({
    id: r.id,
    outlet_name: r.outlet_name ?? "",
    outlet_add: r.outlet_add,
    outlet_phone: r.outlet_phone,
    outlet_hours: r.outlet_hours,
    is_active: r.is_active ?? true,
    is_default: i === 0, // the oldest outlet is the main one (cannot be deleted/disabled)
  }));
}

export async function AddOutlet(
  restaurantId: string,
  input: { name: string; address?: string; phone?: string; hours?: string },
): Promise<OutletRecord> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutletColumns();
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Outlet name is required");
  const id = randomUUID();
  const slugPart = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "outlet";
  const username = `${context.restaurant_slug}-${slugPart}-${id.slice(0, 6)}`;
  const phone = normalizePhone(input.phone ?? "") || null;
  await runQuery(
    `insert into "Outlets" (id, created_at, oultet_username, outlet_name, outlet_add, outlet_main_ph, outlet_working_hours, res_id, is_active)
     values ($1, now(), $2, $3, $4, $5, $6, $7, true)`,
    [id, username, name, input.address?.trim() ?? "", phone, input.hours?.trim() || null, context.res_id],
  );
  return { id, outlet_name: name, outlet_add: input.address?.trim() ?? "", outlet_phone: phone, outlet_hours: input.hours?.trim() || null, is_active: true, is_default: false };
}

export async function UpdateOutlet(
  restaurantId: string,
  outletId: string,
  input: { name?: string; address?: string; phone?: string; hours?: string },
): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutletColumns();
  const sets: string[] = [];
  const params: unknown[] = [outletId, context.res_id];
  let p = 3;
  if (typeof input.name === "string") { sets.push(`outlet_name = $${p++}`); params.push(input.name.trim()); }
  if (typeof input.address === "string") { sets.push(`outlet_add = $${p++}`); params.push(input.address.trim()); }
  if (typeof input.phone === "string") { sets.push(`outlet_main_ph = $${p++}`); params.push(normalizePhone(input.phone) || null); }
  if (typeof input.hours === "string") { sets.push(`outlet_working_hours = $${p++}`); params.push(input.hours.trim() || null); }
  if (sets.length === 0) return { success: true };
  await runQuery(`update "Outlets" set ${sets.join(", ")} where id = $1 and res_id = $2`, params);
  return { success: true };
}

export async function SetOutletActive(restaurantId: string, outletId: string, active: boolean): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutletColumns();
  const outlets = await GetOutlets(restaurantId);
  const target = outlets.find((o) => o.id === outletId);
  if (!target) throw new Error("Outlet not found");
  if (target.is_default && !active) throw new Error("The main outlet cannot be deactivated");
  if (!active && outlets.filter((o) => o.is_active).length <= 1) throw new Error("At least one outlet must stay active");
  await runQuery(`update "Outlets" set is_active = $3 where id = $1 and res_id = $2`, [outletId, context.res_id, active]);
  return { success: true };
}

export async function DeleteOutlet(restaurantId: string, outletId: string): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutletColumns();
  const outlets = await GetOutlets(restaurantId);
  const target = outlets.find((o) => o.id === outletId);
  if (!target) throw new Error("Outlet not found");
  if (target.is_default) throw new Error("The main outlet cannot be deleted");
  // Block hard-delete when the outlet has history (FK + accounting integrity) —
  // deactivate it instead.
  const used = await runQuery<{ n: number }>(
    `select (
        (select count(*) from "Orders" where outlet_id = $1 and res_id = $2) +
        (select count(*) from "Bills"  where outlet_id = $1 and res_id = $2)
      )::int as n`,
    [outletId, context.res_id],
  );
  if ((used[0]?.n ?? 0) > 0) throw new Error("This outlet has orders/bills — deactivate it instead of deleting");
  await runQuery(`delete from "Outlets" where id = $1 and res_id = $2`, [outletId, context.res_id]);
  return { success: true };
}

// Cross-outlet rollup: revenue + order count per outlet over the last N days plus
// combined totals. Queries by res_id only (RLS keys on res_id, so every outlet of
// the restaurant is visible regardless of the request's active outlet).
export async function GetOutletsRollup(
  restaurantId: string,
  days = 30,
): Promise<{
  days: number;
  outlets: Array<{ outlet_id: string; name: string; revenue: number; orders: number }>;
  totals: { revenue: number; orders: number; outlets: number };
}> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutletColumns();
  const span = Math.min(365, Math.max(1, Math.round(days)));
  const now = await currentDbTime();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)));

  const outletRows = await runQuery<{ id: string; outlet_name: string | null }>(
    `select id, outlet_name from "Outlets" where res_id = $1 order by created_at asc`,
    [context.res_id],
  );

  const orderRows = await runQuery<{ outlet_id: string | null; food: unknown; status: unknown }>(
    `select outlet_id, food, status from "Orders" where res_id = $1 and created_at >= $2`,
    [context.res_id, start.toISOString()],
  );
  const agg = new Map<string, { revenue: number; orders: number }>();
  for (const r of orderRows) {
    const st = String(fromOrderStatusCode(r.status) ?? "").toLowerCase();
    if (st === "cancelled") continue;
    const oid = r.outlet_id ?? "";
    const p = parseJsonObject(r.food) ?? {};
    const total = parseNumeric(p.total) > 0 ? parseNumeric(p.total) : parseNumeric(p.subtotal);
    const cur = agg.get(oid) ?? { revenue: 0, orders: 0 };
    cur.revenue = round2(cur.revenue + total);
    cur.orders += 1;
    agg.set(oid, cur);
  }

  const outlets = outletRows.map((o) => {
    const a = agg.get(o.id) ?? { revenue: 0, orders: 0 };
    return { outlet_id: o.id, name: o.outlet_name ?? "Outlet", revenue: a.revenue, orders: a.orders };
  });
  return {
    days: span,
    outlets,
    totals: {
      revenue: round2(outlets.reduce((s, o) => s + o.revenue, 0)),
      orders: outlets.reduce((s, o) => s + o.orders, 0),
      outlets: outletRows.length,
    },
  };
}

// Multi-outlet comparison: per-outlet revenue / bills / orders / avg feedback
// rating over the last N days, in single-pass grouped queries. Unlike the
// normal outlet-scoped analytics these query by res_id ONLY and group by
// outlet_id (RLS keys on res_id, so every outlet of the restaurant is visible
// regardless of which outlet the request is bound to).
export async function GetOutletsComparison(
  restaurantId: string,
  days = 30,
): Promise<{
  days: number;
  outlets: Array<{ outlet_id: string; name: string; revenue: number; bills: number; orders: number; avg_rating: number | null }>;
}> {
  const context = await requireRestaurantContext(restaurantId);
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const since = `now() - ($2 || ' days')::interval`;

  const outletRows = await runQuery<{ id: string; outlet_name: string | null }>(
    `select id, outlet_name from "Outlets" where res_id = $1 order by created_at asc`,
    [context.res_id],
  );
  const billRows = await runQuery<{ outlet_id: string | null; revenue: number; bills: number }>(
    `select outlet_id, coalesce(sum(total_amt),0)::float as revenue, count(*)::int as bills
       from "Bills" where res_id = $1 and status <> 0 and created_at >= ${since}
       group by outlet_id`,
    [context.res_id, String(span)],
  );
  const orderRows = await runQuery<{ outlet_id: string | null; orders: number }>(
    `select outlet_id, count(*)::int as orders
       from "Orders" where res_id = $1 and created_at >= ${since}
       group by outlet_id`,
    [context.res_id, String(span)],
  );
  const fbRows = await runQuery<{ outlet_id: string | null; avg_rating: number | null }>(
    `select outlet_id, avg(overall_rating)::float as avg_rating
       from "Feedback_entries" where res_id = $1 and submitted_at >= ${since}
       group by outlet_id`,
    [context.res_id, String(span)],
  );

  const bills = new Map(billRows.map((r) => [r.outlet_id ?? "", r]));
  const orders = new Map(orderRows.map((r) => [r.outlet_id ?? "", r.orders]));
  const ratings = new Map(fbRows.map((r) => [r.outlet_id ?? "", r.avg_rating]));
  return {
    days: span,
    outlets: outletRows.map((o) => {
      const b = bills.get(o.id);
      const rating = ratings.get(o.id);
      return {
        outlet_id: o.id,
        name: (o.outlet_name ?? "").trim() || "Outlet",
        revenue: round2(b?.revenue ?? 0),
        bills: b?.bills ?? 0,
        orders: orders.get(o.id) ?? 0,
        avg_rating: rating != null ? round2(rating) : null,
      };
    }),
  };
}

// --- Advanced analytics (KPI dashboard) ------------------------------------
// Colour band for a KPI value, matching the operator KPI spec (Blue=excellent,
// Green=on-target, Amber=watch, Red=action, Grey=missing data). `dir` says which
// direction is good; `b` are the three cut points [excellent, on-target, watch].
export type KpiStatus = "blue" | "green" | "amber" | "red" | "grey";
export type KpiCard = { key: string; label: string; value: number | null; unit: string; status: KpiStatus };

function kpiBand(value: number | null, dir: "lower" | "higher", b: [number, number, number]): KpiStatus {
  if (value == null || !Number.isFinite(value)) return "grey";
  if (dir === "lower") return value <= b[0] ? "blue" : value <= b[1] ? "green" : value <= b[2] ? "amber" : "red";
  return value >= b[0] ? "blue" : value >= b[1] ? "green" : value >= b[2] ? "amber" : "red";
}

// One consolidated pass computing the analytics-spec metrics that are derivable
// from existing data. Everything is tenant + outlet scoped and windowed to `days`.
export async function GetAdvancedAnalytics(
  restaurantId: string,
  opts?: { days?: number },
): Promise<Record<string, unknown>> {
  const context = await requireRestaurantContext(restaurantId);
  const days = Math.max(7, Math.min(Math.round(opts?.days ?? 90), 365));
  const rid = context.res_id, oid = context.outlet_id;
  const og = isAllOutlets() ? "true" : "false";
  const since = `now() - ($3 || ' days')::interval`;

  // Discount & offer usage
  const disc = (await runQuery<{ total_bills: number; discount_bills: number; total_discount: number; redemptions: number }>(
    `select count(*)::int total_bills,
            count(*) filter (where discount_value > 0)::int discount_bills,
            coalesce(sum(discount_value),0)::float total_discount,
            count(*) filter (where coupon_code is not null and coupon_code <> '')::int redemptions
       from "Bills" where res_id=$1 and (${og} or outlet_id=$2) and status <> 0 and created_at >= ${since}`,
    [rid, oid, String(days)],
  ))[0] ?? { total_bills: 0, discount_bills: 0, total_discount: 0, redemptions: 0 };
  const utilization_pct = disc.total_bills > 0 ? round2((disc.discount_bills / disc.total_bills) * 100) : 0;

  // Staff / outlet feedback + complaint rate
  const staffRows = await runQuery<{ name: string | null; feedbacks: number; avg_rating: number | null; negatives: number }>(
    `select e."emp_Fname" as name, count(*)::int feedbacks, avg(f.overall_rating)::float avg_rating,
            count(*) filter (where f.overall_rating <= 2)::int negatives
       from "Feedback_entries" f
       left join "Employees" e on e.id=f.emp_id and e.res_id=f.res_id
       where f.res_id=$1 and (${og} or f.outlet_id=$2) and f.submitted_at >= ${since}
       group by e."emp_Fname" order by feedbacks desc`,
    [rid, oid, String(days)],
  );
  const totalFb = staffRows.reduce((s, r) => s + r.feedbacks, 0);
  const totalNeg = staffRows.reduce((s, r) => s + r.negatives, 0);
  const weightedRating = totalFb > 0 ? round2(staffRows.reduce((s, r) => s + (r.avg_rating ?? 0) * r.feedbacks, 0) / totalFb) : null;
  const overall_complaint_pct = totalFb > 0 ? round2((totalNeg / totalFb) * 100) : 0;
  const staff = staffRows.map((r) => ({
    name: (r.name ?? "").trim() || "Unattributed",
    feedbacks: r.feedbacks,
    avg_rating: r.avg_rating != null ? round2(r.avg_rating) : null,
    complaint_pct: r.feedbacks > 0 ? round2((r.negatives / r.feedbacks) * 100) : 0,
  }));

  // Order processing time = bill time − order time, guarded to a sane 0–24h window
  // so a table left open for days doesn't blow up the average.
  const proc = (await runQuery<{ avg_min: number | null; n: number }>(
    `select avg(extract(epoch from (coalesce(b.closed_at,b.admin_approved_at,b.created_at) - o.created_at))/60)::float avg_min, count(*)::int n
       from "Bills" b join "Orders" o on o.id=b.order_id and o.res_id=b.res_id and o.outlet_id=b.outlet_id
       where b.res_id=$1 and (${og} or b.outlet_id=$2) and b.order_id is not null and b.created_at >= ${since}
         and coalesce(b.closed_at,b.admin_approved_at,b.created_at) > o.created_at
         and coalesce(b.closed_at,b.admin_approved_at,b.created_at) - o.created_at <= interval '24 hours'`,
    [rid, oid, String(days)],
  ))[0] ?? { avg_min: null, n: 0 };
  const processing_time_min = proc.avg_min != null ? round2(proc.avg_min) : null;

  // Supplier on-time delivery, quality + spend (from purchase orders). Score is
  // adapted from the spec (no cross-vendor price normalization possible yet):
  // 0.6 × on-time fraction + 0.4 × (avg quality ÷ 5); on-time-only when unrated.
  await ensurePurchaseOrdersTable(); // guarantees the quality_rating column exists
  const supRows = await runQuery<{ vendor: string | null; pos: number; on_time: number; spend: number; quality: number | null }>(
    `select coalesce(vendor_name,'?') vendor, count(*)::int pos,
            count(*) filter (where received_at is not null and expected_date is not null and received_at <= expected_date)::int on_time,
            coalesce(sum(total_cost),0)::float spend,
            avg(quality_rating)::float quality
       from "PurchaseOrders" where res_id=$1 and (${og} or outlet_id=$2) group by vendor_name order by pos desc limit 20`,
    [rid, oid],
  );
  const totalPo = supRows.reduce((s, r) => s + r.pos, 0);
  const totalOnTime = supRows.reduce((s, r) => s + r.on_time, 0);
  const overall_on_time_pct = totalPo > 0 ? round2((totalOnTime / totalPo) * 100) : null;
  const supplierScore = (onTimeFrac: number | null, quality: number | null): number | null => {
    if (onTimeFrac == null && quality == null) return null;
    if (quality == null) return round2(onTimeFrac ?? 0);
    if (onTimeFrac == null) return round2(quality / 5);
    return round2(0.6 * onTimeFrac + 0.4 * (quality / 5));
  };
  const suppliers = supRows.map((r) => {
    const onTimeFrac = r.pos > 0 ? r.on_time / r.pos : null;
    return {
      vendor: (r.vendor ?? "?").trim() || "?",
      pos: r.pos,
      on_time_pct: r.pos > 0 ? round2((r.on_time / r.pos) * 100) : 0,
      spend: round2(r.spend),
      quality: r.quality != null ? round2(r.quality) : null,
      score: supplierScore(onTimeFrac, r.quality),
    };
  });
  const ratedSup = suppliers.filter((s) => s.score != null);
  const overall_supplier_score = ratedSup.length
    ? round2(ratedSup.reduce((s, r) => s + (r.score ?? 0), 0) / ratedSup.length)
    : null;

  // Customer demographics (aggregated, PII-safe: counts only)
  await ensureCustomerDemographicCols();
  const demoRows = (await runQuery<{ total: number; tagged: number }>(
    `select count(*)::int total,
            count(*) filter (where gender is not null or age_group is not null or pincode is not null)::int tagged
       from "Customers" where res_id=$1 and (${og} or outlet_id=$2)`,
    [rid, oid],
  ))[0] ?? { total: 0, tagged: 0 };
  const byGender = await runQuery<{ label: string; n: number }>(
    `select gender label, count(*)::int n from "Customers" where res_id=$1 and (${og} or outlet_id=$2) and gender is not null group by gender order by n desc`,
    [rid, oid],
  );
  const byAge = await runQuery<{ label: string; n: number }>(
    `select age_group label, count(*)::int n from "Customers" where res_id=$1 and (${og} or outlet_id=$2) and age_group is not null group by age_group order by n desc`,
    [rid, oid],
  );
  const byPincode = await runQuery<{ label: string; n: number }>(
    `select pincode label, count(*)::int n from "Customers" where res_id=$1 and (${og} or outlet_id=$2) and pincode is not null group by pincode order by n desc limit 5`,
    [rid, oid],
  );
  const demographics = {
    total_customers: demoRows.total,
    tagged: demoRows.tagged,
    coverage_pct: demoRows.total > 0 ? round2((demoRows.tagged / demoRows.total) * 100) : null,
    by_gender: byGender,
    by_age: byAge,
    top_pincodes: byPincode,
  };

  // Campaign ROI: revenue in the campaign window vs an equal-length window
  // immediately before it. ROI needs a recorded cost; uplift works without one.
  await ensureCampaignsTable();
  const campRows = await runQuery<Record<string, any>>(
    `select * from "Campaigns" where res_id=$1 and (${og} or outlet_id=$2) order by starts_at desc limit 10`,
    [rid, oid],
  );
  const campaigns: Array<{ id: string; name: string; cost: number; starts_at: string; ends_at: string; sales_during: number; sales_before: number; uplift_pct: number | null; roi_pct: number | null }> = [];
  for (const raw of campRows) {
    const c = mapCampaign(raw);
    const sums = (await runQuery<{ during: number; before: number }>(
      `select
         coalesce(sum(total_amt) filter (where created_at >= $3::date and created_at < ($4::date + interval '1 day')), 0)::float during,
         coalesce(sum(total_amt) filter (where created_at >= ($3::date - (($4::date - $3::date) + 1)) and created_at < $3::date), 0)::float before
       from "Bills" where res_id=$1 and (${og} or outlet_id=$2) and status <> 0`,
      [rid, oid, c.starts_at, c.ends_at],
    ))[0] ?? { during: 0, before: 0 };
    const uplift = sums.before > 0 ? round2(((sums.during - sums.before) / sums.before) * 100) : null;
    const roi = c.cost > 0 ? round2((((sums.during - sums.before) - c.cost) / c.cost) * 100) : null;
    campaigns.push({ id: c.id, name: c.name, cost: c.cost, starts_at: c.starts_at, ends_at: c.ends_at, sales_during: round2(sums.during), sales_before: round2(sums.before), uplift_pct: uplift, roi_pct: roi });
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const finishedRoi = campaigns.filter((c) => c.roi_pct != null && c.ends_at <= todayIso);
  const overall_campaign_roi_pct = finishedRoi.length
    ? round2(finishedRoi.reduce((s, c) => s + (c.roi_pct ?? 0), 0) / finishedRoi.length)
    : null;

  // --- Ops KPIs: RevPASH, labour cost %, reservation fill/no-show --------------
  // RevPASH = revenue ÷ (seats × operating hours). Operating hours default to
  // 12h/day — a house assumption until an opening-hours setting exists.
  const OPERATING_HOURS_PER_DAY = 12;
  const windowRev = (await runQuery<{ rev: number }>(
    `select coalesce(sum(total_amt),0)::float rev from "Bills" where res_id=$1 and (${og} or outlet_id=$2) and status <> 0 and created_at >= ${since}`,
    [rid, oid, String(days)],
  ))[0]?.rev ?? 0;
  const seats = (await runQuery<{ seats: number }>(
    `select coalesce(sum(greatest(capacity, 1)), 0)::int seats from "Tables"
       where res_id=$1 and (${og} or outlet_id=$2) and coalesce(is_deleted,false)=false and coalesce(is_virtual,false)=false`,
    [rid, oid],
  ))[0]?.seats ?? 0;
  const revpash = seats > 0 && windowRev > 0 ? round2(windowRev / (seats * OPERATING_HOURS_PER_DAY * days)) : null;

  // Labour cost: recorded payroll payments in the window vs revenue; plus
  // sales-per-approved-labour-hour as the productivity read.
  await ensurePayrollTables();
  const labourPaid = (await runQuery<{ paid: number }>(
    `select coalesce(sum(amount),0)::float paid from "PayrollPayments" where res_id=$1 and (${og} or outlet_id=$2) and paid_at >= ${since}`,
    [rid, oid, String(days)],
  ))[0]?.paid ?? 0;
  const labour_cost_pct = labourPaid > 0 && windowRev > 0 ? round2((labourPaid / windowRev) * 100) : null;
  const labourHours = (await runQuery<{ hours: number }>(
    `select coalesce(sum(least(extract(epoch from (clock_out - clock_in))/3600, 16)), 0)::float hours
       from "Attendance" where res_id=$1 and (${og} or outlet_id=$2) and clock_out is not null and clock_out > clock_in
         and ${ATTENDANCE_COUNTED} and clock_in >= ${since}`,
    [rid, oid, String(days)],
  ))[0]?.hours ?? 0;
  // Require ≥1h of approved labour — a single seconds-long shift would otherwise
  // divide into an absurd productivity number.
  const sales_per_labour_hour = labourHours >= 1 && windowRev > 0 ? round2(windowRev / labourHours) : null;

  // Reservation conversion: bookings whose slot status reached completed/seated
  // vs no-shows; cancellations drop out of the denominator.
  const bookingRows = await runQuery<{ slot: string }>(
    `select slot from "Bookings" where res_id=$1 and (${og} or outlet_id=$2) and created_at >= ${since}`,
    [rid, oid, String(days)],
  );
  let bkTotal = 0, bkDone = 0, bkNoShow = 0;
  for (const b of bookingRows) {
    let st = "";
    try { st = String((typeof b.slot === "string" ? JSON.parse(b.slot) : b.slot)?.status ?? "").toLowerCase(); } catch { /* unparseable slot */ }
    if (st.includes("cancel")) continue;
    bkTotal += 1;
    if (st.includes("complete") || st.includes("seated")) bkDone += 1;
    else if (st.replace(/[\s_-]/g, "").includes("noshow")) bkNoShow += 1;
  }
  const booking_fill_pct = bkTotal > 0 ? round2((bkDone / bkTotal) * 100) : null;
  const booking_no_show_pct = bkTotal > 0 ? round2((bkNoShow / bkTotal) * 100) : null;
  const ops = {
    revpash, seats, operating_hours_per_day: OPERATING_HOURS_PER_DAY,
    labour_paid: round2(labourPaid), labour_cost_pct, labour_hours: round2(labourHours), sales_per_labour_hour,
    bookings_total: bkTotal, booking_fill_pct, booking_no_show_pct,
  };

  // --- Profit margin: (revenue − expenses) ÷ revenue --------------------------
  // Costs mirror the accounting P&L (GetProfitAndLoss): recorded "Expenses" rows
  // only — payroll already lands there via the auto-booked "Payroll" expense on
  // each payment (so PayrollPayments is NOT added again), and purchase orders are
  // excluded just like /reports/pnl. Revenue reuses windowRev (billed total_amt),
  // the same basis every other KPI in this payload uses. With zero recorded
  // expenses the margin would be a meaningless 100%, so it stays null/grey.
  await ensureExpensesTable();
  const windowExpenses = (await runQuery<{ total: number }>(
    `select coalesce(sum(amount),0)::float total from "Expenses"
       where res_id=$1 and (${og} or outlet_id=$2) and spent_on >= (now() - ($3 || ' days')::interval)::date`,
    [rid, oid, String(days)],
  ))[0]?.total ?? 0;
  const profit_margin_pct = windowRev > 0 && windowExpenses > 0
    ? Math.round(((windowRev - windowExpenses) / windowRev) * 1000) / 10
    : null;
  const profit = { revenue: round2(windowRev), expenses: round2(windowExpenses), margin_pct: profit_margin_pct };

  // Low-stock alerts + expiring-soon (≤7 days) entries. The low-stock KPI keeps
  // counting ONLY low-quantity items; expiring rows ride along flagged.
  await ensureInventoryExpiryColumn();
  const stockRows = await runQuery<{ name: string; qty: number; low: boolean; expiring: boolean; expiry_date: unknown }>(
    `select name, "Quantity"::float qty,
            ("Quantity"::numeric <= 5) as low,
            (expiry_date is not null and expiry_date <= current_date + 7) as expiring,
            expiry_date
       from "Inventory"
       where res_id=$1 and (${og} or outlet_id=$2)
         and ("Quantity"::numeric <= 5 or (expiry_date is not null and expiry_date <= current_date + 7))
       order by "Quantity"::numeric asc limit 40`,
    [rid, oid],
  );
  const stock_alerts = stockRows.map((r) => ({
    name: r.name,
    qty: r.qty,
    ...(r.expiring ? { expiring: true as const, expiry_date: formatDateOnly(r.expiry_date) } : {}),
  }));
  const lowStockCount = stockRows.filter((r) => r.low).length;

  // --- Food cost: actual issuance vs revenue, and vs theoretical recipe cost ---
  // Actual = Σ |issued qty| × snapshotted unit cost in the window (kind='issue').
  await ensureStockMovementsTable();
  const issueAgg = (await runQuery<{ cost: number; events: number; uncosted: number }>(
    `select coalesce(sum(abs(delta) * unit_cost) filter (where unit_cost is not null), 0)::float cost,
            count(*)::int events,
            count(*) filter (where unit_cost is null)::int uncosted
       from "StockMovements"
       where res_id=$1 and (${og} or outlet_id=$2) and kind='issue' and created_at >= ${since}`,
    [rid, oid, String(days)],
  ))[0] ?? { cost: 0, events: 0, uncosted: 0 };
  const food_cost_pct = windowRev > 0 && issueAgg.cost > 0 ? round2((issueAgg.cost / windowRev) * 100) : null;

  // Theoretical = Σ over items SOLD in the window of qty × recipe cost (latest
  // purchase unit costs). Sold items without a recipe can't be costed — count
  // them so the variance KPI honestly greys out instead of implying precision.
  const soldRows = await runQuery<{ name: string; qty: number }>(
    `with it as (
       select item->>'name' as name, coalesce((item->>'quantity')::numeric, 1) as qty
         from "Orders" o, jsonb_array_elements((o.food)::jsonb->'items') item
        where o.res_id=$1 and (${og} or o.outlet_id=$2) and o.created_at >= ${since}
     )
     select name, sum(qty)::float qty from it where coalesce(name,'') <> '' group by name limit 500`,
    [rid, oid, String(days)],
  );
  let theoreticalCost = 0;
  let recipesMissing = 0; // distinct sold menu items with no usable recipe cost
  try {
    const menuForCost = await GetMenuItems(restaurantId);
    const unitCosts = await getLatestUnitCosts(context);
    const menuByName = new Map(menuForCost.map((m) => [m.name.toLowerCase(), m]));
    for (const sold of soldRows) {
      const m = menuByName.get(sold.name.toLowerCase());
      const recipe = m?.recipe;
      if (!m || !Array.isArray(recipe) || recipe.length === 0) { recipesMissing += 1; continue; }
      let dishCost = 0;
      let costed = 0;
      for (const ing of recipe) {
        const uc = unitCosts.get(ing.inventory_id);
        if (uc != null) { dishCost += ing.qty * uc; costed += 1; }
      }
      if (costed === 0) { recipesMissing += 1; continue; }
      theoreticalCost += dishCost * sold.qty;
    }
  } catch { /* costing is best-effort — never fail the analytics payload */ }
  const variance_pct = theoreticalCost > 0 && issueAgg.cost > 0
    ? round2(((issueAgg.cost - theoreticalCost) / theoreticalCost) * 100)
    : null;
  const food_cost = {
    actual_cost: round2(issueAgg.cost),
    food_cost_pct,
    theoretical_cost: round2(theoreticalCost),
    variance_pct,
    issue_events: issueAgg.events,
    uncosted_issues: issueAgg.uncosted,
    recipes_missing: recipesMissing,
    note: recipesMissing > 0
      ? `${recipesMissing} sold item(s) have no costed recipe — theoretical cost and variance are partial`
      : null,
  };

  // Seasonal demand index (monthly revenue ÷ mean monthly revenue), last 12 months
  const seaRows = await runQuery<{ ym: string; revenue: number; bills: number }>(
    `select to_char(date_trunc('month', created_at),'YYYY-MM') as ym, coalesce(sum(total_amt),0)::float revenue, count(*)::int bills
       from "Bills" where res_id=$1 and (${og} or outlet_id=$2) and status <> 0 and created_at >= now() - interval '12 months'
       group by 1 order by 1`,
    [rid, oid],
  );
  const meanRev = seaRows.length ? seaRows.reduce((s, r) => s + r.revenue, 0) / seaRows.length : 0;
  const seasonal = seaRows.map((r) => ({ month: r.ym, revenue: round2(r.revenue), bills: r.bills, index: meanRev > 0 ? round2(r.revenue / meanRev) : 0 }));

  // --- Menu optimization engine (STAR/GREAT/MID/BAD) -------------------------
  // Popularity = qty share; without stored COGS we use price (revenue per unit)
  // as the profitability proxy. Quadrants split at the medians.
  const itemRows = await runQuery<{ name: string; qty: number; revenue: number }>(
    `with it as (
       select item->>'name' as name,
              coalesce((item->>'quantity')::numeric, 1) as qty,
              coalesce((item->>'price')::numeric, 0) * coalesce((item->>'quantity')::numeric, 1) as rev
         from "Orders" o, jsonb_array_elements((o.food)::jsonb->'items') item
        where o.res_id=$1 and (${og} or o.outlet_id=$2) and o.created_at >= ${since}
     )
     select name, sum(qty)::float qty, sum(rev)::float revenue
       from it where coalesce(name,'') <> '' group by name order by 2 desc limit 60`,
    [rid, oid, String(days)],
  );
  const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const qtyMed = median(itemRows.map((r) => r.qty));
  const unitMed = median(itemRows.map((r) => (r.qty > 0 ? r.revenue / r.qty : 0)));
  const totalQty = itemRows.reduce((s, r) => s + r.qty, 0);
  const totalItemRev = itemRows.reduce((s, r) => s + r.revenue, 0);
  const menu_classes = itemRows.map((r) => {
    const hiPop = r.qty >= qtyMed && qtyMed > 0;
    const hiProfit = (r.qty > 0 ? r.revenue / r.qty : 0) >= unitMed && unitMed > 0;
    const cls = hiPop && hiProfit ? "STAR" : hiPop ? "GREAT" : hiProfit ? "MID" : "BAD";
    return { name: r.name, qty: round2(r.qty), revenue: round2(r.revenue), popularity_pct: totalQty > 0 ? round2((r.qty / totalQty) * 100) : 0, class: cls };
  });
  const badRevenue = menu_classes.filter((m) => m.class === "BAD").reduce((s, m) => s + m.revenue, 0);
  const bad_share_pct = totalItemRev > 0 ? round2((badRevenue / totalItemRev) * 100) : null;

  // --- Customer churn (RFM cohort) -------------------------------------------
  // Identity = phone when captured, else the non-"Guest" name from the order.
  // Cohort churn: identities seen in the FIRST half of the window but not the
  // second = lost. At-risk list = biggest spenders gone quiet 30+ days.
  const custRows = await runQuery<{ ident: string; last_order: Date; orders: number; spend: number }>(
    `with idents as (
       select coalesce(nullif((o.food)::jsonb->>'customer_phone',''), nullif((o.food)::jsonb->>'customer','')) as ident,
              o.created_at, coalesce(((o.food)::jsonb->>'total')::numeric, 0) as total
         from "Orders" o
        where o.res_id=$1 and (${og} or o.outlet_id=$2) and o.created_at >= ${since}
     )
     select ident, max(created_at) last_order, count(*)::int orders, coalesce(sum(total),0)::float spend
       from idents where ident is not null and lower(ident) <> 'guest'
       group by ident order by spend desc limit 200`,
    [rid, oid, String(days)],
  );
  const halfMs = (days / 2) * 86_400_000;
  const nowMs = Date.now();
  const firstHalf = custRows.filter((c) => nowMs - new Date(c.last_order).getTime() > halfMs);
  const startingCohort = custRows.length;
  const churn_rate_pct = startingCohort > 0 ? round2((firstHalf.length / startingCohort) * 100) : null;
  const at_risk = custRows
    .filter((c) => nowMs - new Date(c.last_order).getTime() > 30 * 86_400_000)
    .slice(0, 10)
    .map((c) => ({ customer: c.ident, orders: c.orders, spend: round2(c.spend), days_since_visit: Math.floor((nowMs - new Date(c.last_order).getTime()) / 86_400_000) }));

  // --- Customer wait time (queue-seated parties) ------------------------------
  const wait = (await runQuery<{ avg_min: number | null; n: number }>(
    `select avg(extract(epoch from (seated_at - created_at))/60)::float avg_min, count(*)::int n
       from "Waitlist" where res_id=$1 and (${og} or outlet_id=$2) and seated_at is not null and created_at >= ${since}`,
    [rid, oid, String(days)],
  ))[0] ?? { avg_min: null, n: 0 };
  const wait_time_min = wait.n > 0 && wait.avg_min != null ? round2(wait.avg_min) : null;

  // --- Table turnaround time (seated → left) -----------------------------------
  // From TableSessions (trigger-recorded). Sessions over 6h are treated as
  // stale/abandoned occupies, virtual (takeaway) tables are excluded.
  await ensureTableSessionsTable();
  const tatAgg = (await runQuery<{ avg_min: number | null; median_min: number | null; n: number }>(
    `select avg(extract(epoch from (s.left_at - s.seated_at))/60)::float avg_min,
            percentile_cont(0.5) within group (order by extract(epoch from (s.left_at - s.seated_at))/60)::float median_min,
            count(*)::int n
       from "TableSessions" s
       left join "Tables" t on t.id = s.table_id and t.res_id = s.res_id
       where s.res_id=$1 and (${og} or s.outlet_id=$2) and s.left_at is not null and s.seated_at >= ${since}
         and s.left_at > s.seated_at and s.left_at - s.seated_at <= interval '6 hours'
         and coalesce(t.is_virtual, false) = false`,
    [rid, oid, String(days)],
  ))[0] ?? { avg_min: null, median_min: null, n: 0 };
  const tatByTable = await runQuery<{ table_name: string; visits: number; avg_min: number }>(
    `select coalesce(s.table_name, '?') table_name, count(*)::int visits,
            avg(extract(epoch from (s.left_at - s.seated_at))/60)::float avg_min
       from "TableSessions" s
       left join "Tables" t on t.id = s.table_id and t.res_id = s.res_id
       where s.res_id=$1 and (${og} or s.outlet_id=$2) and s.left_at is not null and s.seated_at >= ${since}
         and s.left_at > s.seated_at and s.left_at - s.seated_at <= interval '6 hours'
         and coalesce(t.is_virtual, false) = false
       group by 1 order by visits desc limit 10`,
    [rid, oid, String(days)],
  );
  const tat = {
    avg_min: tatAgg.n > 0 && tatAgg.avg_min != null ? round2(tatAgg.avg_min) : null,
    median_min: tatAgg.n > 0 && tatAgg.median_min != null ? round2(tatAgg.median_min) : null,
    sessions: tatAgg.n,
    by_table: tatByTable.map((r) => ({ table_name: r.table_name, visits: r.visits, avg_min: round2(r.avg_min) })),
  };

  // --- Happiness vs efficiency: CORR(daily avg service time, daily avg rating) —
  // needs enough day-pairs to mean anything; below 5 pairs we report grey.
  const svcDays = await runQuery<{ d: string; svc: number }>(
    `select date_trunc('day', b.created_at)::date::text d,
            avg(extract(epoch from (coalesce(b.closed_at,b.admin_approved_at,b.created_at) - o.created_at))/60)::float svc
       from "Bills" b join "Orders" o on o.id=b.order_id and o.res_id=b.res_id and o.outlet_id=b.outlet_id
       where b.res_id=$1 and (${og} or b.outlet_id=$2) and b.order_id is not null and b.created_at >= ${since}
         and coalesce(b.closed_at,b.admin_approved_at,b.created_at) - o.created_at between interval '0' and interval '24 hours'
       group by 1`,
    [rid, oid, String(days)],
  );
  const fbDays = await runQuery<{ d: string; r: number }>(
    `select date_trunc('day', submitted_at)::date::text d, avg(overall_rating)::float r
       from "Feedback_entries" where res_id=$1 and (${og} or outlet_id=$2) and submitted_at >= ${since} group by 1`,
    [rid, oid, String(days)],
  );
  const fbByDay = new Map(fbDays.map((f) => [f.d, f.r]));
  const pairs = svcDays.filter((s) => fbByDay.has(s.d)).map((s) => ({ x: s.svc, y: fbByDay.get(s.d)! }));
  let happiness_corr: number | null = null;
  if (pairs.length >= 5) {
    const mx = pairs.reduce((s, p) => s + p.x, 0) / pairs.length;
    const my = pairs.reduce((s, p) => s + p.y, 0) / pairs.length;
    const cov = pairs.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    const sx = Math.sqrt(pairs.reduce((s, p) => s + (p.x - mx) ** 2, 0));
    const sy = Math.sqrt(pairs.reduce((s, p) => s + (p.y - my) ** 2, 0));
    happiness_corr = sx > 0 && sy > 0 ? round2(cov / (sx * sy)) : null;
  }

  // --- Demand forecast (per-item, next week) ----------------------------------
  // Heuristic: weighted 4-week moving average (40/30/20/10, newest first) over the
  // last 12 weeks. Accuracy (MAPE) is computed retrospectively — forecast week N
  // from weeks N-4..N-1 and compare to the actual — and reported only when there
  // is enough history to be meaningful.
  const weekRows = await runQuery<{ name: string; wk: string; qty: number }>(
    `with it as (
       select date_trunc('week', o.created_at)::date::text wk, item->>'name' as name,
              coalesce((item->>'quantity')::numeric, 1) as qty
         from "Orders" o, jsonb_array_elements((o.food)::jsonb->'items') item
        where o.res_id=$1 and (${og} or o.outlet_id=$2) and o.created_at >= now() - interval '12 weeks'
     )
     select name, wk, sum(qty)::float qty from it where coalesce(name,'') <> '' group by name, wk`,
    [rid, oid],
  );
  // Build the full 12-week bucket list so missing weeks count as zero sales.
  const weekKeys: string[] = [];
  {
    const d = new Date();
    const dow = (d.getUTCDay() + 6) % 7; // Monday-start weeks, matching date_trunc
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    for (let i = 11; i >= 0; i -= 1) {
      const w = new Date(monday.getTime() - i * 7 * 86_400_000);
      weekKeys.push(w.toISOString().slice(0, 10));
    }
  }
  const byItem = new Map<string, Map<string, number>>();
  for (const r of weekRows) {
    if (!byItem.has(r.name)) byItem.set(r.name, new Map());
    byItem.get(r.name)!.set(r.wk, r.qty);
  }
  const W = [0.4, 0.3, 0.2, 0.1];
  const wavg = (series: number[], endIdx: number) => {
    let s = 0;
    for (let k = 0; k < 4; k += 1) s += W[k]! * (series[endIdx - k] ?? 0);
    return s;
  };
  const mapeErrs: number[] = [];
  const demand_forecast = Array.from(byItem.entries())
    .map(([name, weeks]) => {
      const series = weekKeys.map((k) => weeks.get(k) ?? 0);
      const total = series.reduce((s, v) => s + v, 0);
      const forecast = round2(wavg(series, series.length - 1));
      const recent = series[series.length - 1] ?? 0;
      const prior3 = (series.slice(-4, -1).reduce((s, v) => s + v, 0)) / 3;
      const trend = recent > prior3 * 1.15 ? "up" : recent < prior3 * 0.85 ? "down" : "flat";
      // retro-MAPE contributions from weeks that had actual sales
      for (let i = 4; i < series.length; i += 1) {
        const actual = series[i]!;
        if (actual > 0) mapeErrs.push(Math.abs(wavg(series, i - 1) - actual) / actual);
      }
      return { name, total_qty: round2(total), forecast_next_week: forecast, trend };
    })
    .filter((f) => f.total_qty > 0)
    .sort((a, b) => b.total_qty - a.total_qty)
    .slice(0, 10);
  const forecast_mape_pct = mapeErrs.length >= 8 ? round2((mapeErrs.reduce((s, e) => s + e, 0) / mapeErrs.length) * 100) : null;

  // --- Offer redemption (coupon usage) ----------------------------------------
  // Coupons is a lazily-created table — tolerate its absence (42P01) for tenants
  // that never configured a promo.
  let offers: Array<{ code: string; used: number; limit: number | null; redemption_pct: number | null }> = [];
  try {
    const cRows = await runQuery<{ code: string; used_count: number; usage_limit: number | null }>(
      `select code, used_count, usage_limit from "Coupons" where res_id=$1 and ((${og} or outlet_id=$2) or outlet_id is null) order by used_count desc limit 20`,
      [rid, oid],
    );
    offers = cRows.map((c) => ({ code: c.code, used: c.used_count, limit: c.usage_limit, redemption_pct: c.usage_limit && c.usage_limit > 0 ? round2((c.used_count / c.usage_limit) * 100) : null }));
  } catch (err: any) {
    if (err?.code !== "42P01") throw err;
  }
  const offersWithLimit = offers.filter((o) => o.redemption_pct != null);
  const overall_redemption_pct = offersWithLimit.length
    ? round2(offersWithLimit.reduce((s, o) => s + (o.redemption_pct ?? 0), 0) / offersWithLimit.length)
    : null;

  // --- NPS (from the optional 0–10 recommend question on the feedback form) ----
  // Standard formula: % promoters (9–10) − % detractors (0–6); passives ignored.
  await ensureFeedbackColumns();
  const npsAgg = (await runQuery<{ promoters: number; detractors: number; responses: number }>(
    `select count(*) filter (where nps >= 9)::int promoters,
            count(*) filter (where nps <= 6)::int detractors,
            count(*) filter (where nps is not null)::int responses
       from "Feedback_entries" where res_id=$1 and (${og} or outlet_id=$2) and submitted_at >= ${since}`,
    [rid, oid, String(days)],
  ))[0] ?? { promoters: 0, detractors: 0, responses: 0 };
  const nps = npsAgg.responses > 0 ? round2(((npsAgg.promoters - npsAgg.detractors) / npsAgg.responses) * 100) : null;

  // --- Valet retrieval time (request → car at entrance) ------------------------
  // requested_at/delivered_at are stamped by UpdateValetVehicleState on states
  // 3 and 5; older records predate the columns, so the KPI stays grey until the
  // telemetry accrues. Durations over 2h are treated as stale/abandoned tickets.
  await ensureValetRetrievalColumns();
  const valetAgg = (await runQuery<{ avg_min: number | null; retrievals: number; cars: number }>(
    `select avg(extract(epoch from (delivered_at - requested_at))/60)
              filter (where requested_at is not null and delivered_at > requested_at
                        and delivered_at - requested_at <= interval '2 hours')::float avg_min,
            count(*) filter (where requested_at is not null and delivered_at > requested_at
                               and delivered_at - requested_at <= interval '2 hours')::int retrievals,
            count(*)::int cars
       from "Valet_vehicle_state" where res_id=$1 and (${og} or outlet_id=$2) and entry_time >= ${since}`,
    [rid, oid, String(days)],
  ))[0] ?? { avg_min: null, retrievals: 0, cars: 0 };
  const valet = {
    avg_retrieval_min: valetAgg.retrievals > 0 && valetAgg.avg_min != null ? round2(valetAgg.avg_min) : null,
    retrievals: valetAgg.retrievals,
    cars: valetAgg.cars,
  };

  const kpis: KpiCard[] = [
    { key: "discount_utilization", label: "Discount Utilization", value: disc.total_bills > 0 ? utilization_pct : null, unit: "%", status: disc.total_bills > 0 ? kpiBand(utilization_pct, "lower", [10, 15, 25]) : "grey" },
    { key: "wait_time", label: "Customer Wait Time", value: wait_time_min, unit: "min", status: kpiBand(wait_time_min, "lower", [7, 10, 15]) },
    // TAT bands are house defaults (the KPI spec sheet doesn't define them):
    // ≤45 excellent, ≤60 on-target, 60–90 watch, >90 action (casual dining).
    { key: "table_turnaround", label: "Table Turnaround (TAT)", value: tat.avg_min, unit: "min", status: kpiBand(tat.avg_min, "lower", [45, 60, 90]) },
    { key: "processing_time", label: "Order Processing Time", value: processing_time_min, unit: "min", status: kpiBand(processing_time_min, "lower", [15, 20, 25]) },
    { key: "avg_rating", label: "Avg Feedback Rating", value: weightedRating, unit: "/5", status: kpiBand(weightedRating, "higher", [4.6, 4.3, 3.9]) },
    // Industry-standard NPS bands: ≥70 world-class, ≥30 great, ≥0 needs work.
    { key: "nps", label: "NPS", value: nps, unit: "", status: kpiBand(nps, "higher", [70, 30, 0]) },
    { key: "complaint_rate", label: "Complaint Rate", value: totalFb > 0 ? overall_complaint_pct : null, unit: "%", status: totalFb > 0 ? kpiBand(overall_complaint_pct, "lower", [5, 8, 12]) : "grey" },
    { key: "churn_rate", label: "Customer Churn Rate", value: churn_rate_pct, unit: "%", status: kpiBand(churn_rate_pct, "lower", [20, 30, 35]) },
    { key: "menu_bad_share", label: "Menu: BAD Share", value: bad_share_pct, unit: "%", status: kpiBand(bad_share_pct, "lower", [8, 10, 15]) },
    { key: "happiness_efficiency", label: "Happiness ↔ Speed", value: happiness_corr, unit: "", status: kpiBand(happiness_corr, "lower", [-0.4, -0.3, -0.1]) },
    { key: "offer_redemption", label: "Offer Redemption", value: overall_redemption_pct, unit: "%", status: kpiBand(overall_redemption_pct, "higher", [70, 50, 30]) },
    { key: "forecast_mape", label: "Forecast Accuracy (MAPE)", value: forecast_mape_pct, unit: "%", status: kpiBand(forecast_mape_pct, "lower", [10, 15, 20]) },
    { key: "supplier_on_time", label: "Supplier On-time", value: overall_on_time_pct, unit: "%", status: kpiBand(overall_on_time_pct, "higher", [90, 80, 60]) },
    { key: "supplier_score", label: "Supplier Score", value: overall_supplier_score, unit: "", status: kpiBand(overall_supplier_score, "higher", [0.8, 0.7, 0.6]) },
    // House-default bands (₹/seat-hour and % of sales) — tune per venue later.
    { key: "revpash", label: "RevPASH", value: revpash, unit: "/seat·h", status: kpiBand(revpash, "higher", [300, 150, 75]) },
    { key: "labour_cost", label: "Labour Cost", value: labour_cost_pct, unit: "%", status: kpiBand(labour_cost_pct, "lower", [25, 30, 35]) },
    { key: "booking_fill", label: "Reservation Fill", value: booking_fill_pct, unit: "%", status: kpiBand(booking_fill_pct, "higher", [90, 75, 50]) },
    { key: "booking_no_show", label: "No-show Rate", value: booking_no_show_pct, unit: "%", status: kpiBand(booking_no_show_pct, "lower", [5, 10, 20]) },
    { key: "campaign_roi", label: "Campaign ROI", value: overall_campaign_roi_pct, unit: "%", status: kpiBand(overall_campaign_roi_pct, "higher", [40, 20, 0]) },
    // House-default retrieval bands: ≤5 excellent, ≤8 on-target, 8–12 watch.
    { key: "valet_retrieval", label: "Valet Retrieval", value: valet.avg_retrieval_min, unit: "min", status: kpiBand(valet.avg_retrieval_min, "lower", [5, 8, 12]) },
    { key: "low_stock", label: "Low-stock Items", value: lowStockCount, unit: "", status: lowStockCount === 0 ? "green" : lowStockCount <= 3 ? "amber" : "red" },
    // Industry food-cost bands: ≤28% excellent, ≤32% on-target, 32–38% watch.
    { key: "food_cost_pct", label: "Food Cost %", value: food_cost_pct, unit: "%", status: kpiBand(food_cost_pct, "lower", [28, 32, 38]) },
    // Variance = actual issuance cost vs theoretical recipe cost of items sold.
    // Signed value (negative = under-issue), banded on the absolute deviation;
    // grey while any sold item lacks a costed recipe (partial theoretical).
    { key: "food_cost_variance", label: "Food Cost Variance", value: variance_pct, unit: "%", status: recipesMissing > 0 || variance_pct == null ? "grey" : kpiBand(Math.abs(variance_pct), "lower", [5, 10, 20]) },
    // Margin over RECORDED expenses only (see the profit block above) — grey
    // until expenses exist so an empty ledger never reads as a healthy 100%.
    { key: "profit_margin", label: "Profit Margin", value: profit_margin_pct, unit: "%", status: kpiBand(profit_margin_pct, "higher", [25, 15, 5]) },
  ];

  return {
    window_days: days,
    discounts: { total_bills: disc.total_bills, discount_bills: disc.discount_bills, utilization_pct, total_discount: round2(disc.total_discount), redemptions: disc.redemptions },
    staff, overall_avg_rating: weightedRating, overall_complaint_pct, total_feedbacks: totalFb,
    processing_time_min, processing_time_n: proc.n,
    suppliers, overall_on_time_pct, overall_supplier_score,
    demographics,
    campaigns, overall_campaign_roi_pct,
    stock_alerts,
    seasonal,
    menu_classes, bad_share_pct,
    churn: { rate_pct: churn_rate_pct, cohort: startingCohort, at_risk },
    wait_time_min, wait_time_n: wait.n,
    tat,
    happiness_corr, happiness_pairs: pairs.length,
    offers, overall_redemption_pct,
    demand_forecast, forecast_mape_pct,
    ops,
    nps, nps_responses: npsAgg.responses,
    valet,
    food_cost,
    profit,
    kpis,
  };
}

export type ApcTrendPoint = {
  month: string;         // "YYYY-MM"
  period_start: string;  // ISO
  total_revenue: number;
  total_covers: number;
  monthly_apc: number;
  bills: number;         // consolidated table-bills that month
};

// Historical month-by-month trend (revenue / covers / APC), reusing the exact
// same per-month aggregation as the single-month cards so the numbers always
// agree. Walks back `months` calendar months from the current DB month.
export async function GetApcTrends(
  restaurantId: string,
  opts?: { months?: number },
): Promise<{ series: ApcTrendPoint[] }> {
  const months = Math.max(1, Math.min(Math.round(opts?.months ?? 12), 24));
  const now = await currentDbTime();
  const series: ApcTrendPoint[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1, 0, 0, 0, 0));
    const insight = await GetMonthlyApcInsights(restaurantId, { period: "month", periodStart: start });
    series.push({
      month: insight.month,
      period_start: insight.period_start,
      total_revenue: insight.total_revenue,
      total_covers: insight.total_covers,
      monthly_apc: insight.monthly_apc,
      bills: insight.orders.length,
    });
  }
  return { series };
}

// --- Monthly history (long-range summary) -------------------------------------
// One row per calendar month, up to 36 months back — built from single-pass
// grouped queries (NOT the per-month APC engine, which would be far too slow at
// this range). Months with no activity are zero-filled so the timeline is gapless.
export type MonthlyHistoryRow = {
  month: string; // "YYYY-MM"
  revenue: number;
  bills: number;
  orders: number;
  avg_bill: number | null;
  discounts: number;
  feedback_count: number;
  avg_rating: number | null;
  new_customers: number;
  avg_tat_min: number | null;
};

export async function GetMonthlyHistory(
  restaurantId: string,
  opts?: { months?: number },
): Promise<{ months: number; series: MonthlyHistoryRow[] }> {
  const context = await requireRestaurantContext(restaurantId);
  const months = Math.max(3, Math.min(Math.round(opts?.months ?? 36), 36));
  const rid = context.res_id, oid = context.outlet_id;
  const og = isAllOutlets() ? "true" : "false";
  await ensureTableSessionsTable();
  const since = `date_trunc('month', now()) - ($3 || ' months')::interval`;

  const billRows = await runQuery<{ ym: string; revenue: number; bills: number; discounts: number }>(
    `select to_char(date_trunc('month', created_at),'YYYY-MM') as ym,
            coalesce(sum(total_amt),0)::float revenue, count(*)::int bills,
            coalesce(sum(discount_value),0)::float discounts
       from "Bills" where res_id=$1 and (${og} or outlet_id=$2) and status <> 0 and created_at >= ${since}
       group by 1`,
    [rid, oid, String(months)],
  );
  const orderRows = await runQuery<{ ym: string; orders: number }>(
    `select to_char(date_trunc('month', created_at),'YYYY-MM') as ym, count(*)::int orders
       from "Orders" where res_id=$1 and (${og} or outlet_id=$2) and created_at >= ${since} group by 1`,
    [rid, oid, String(months)],
  );
  const fbRows = await runQuery<{ ym: string; n: number; avg_rating: number | null }>(
    `select to_char(date_trunc('month', submitted_at),'YYYY-MM') as ym, count(*)::int n, avg(overall_rating)::float avg_rating
       from "Feedback_entries" where res_id=$1 and (${og} or outlet_id=$2) and submitted_at >= ${since} group by 1`,
    [rid, oid, String(months)],
  );
  const custRows = await runQuery<{ ym: string; n: number }>(
    `select to_char(date_trunc('month', created_at),'YYYY-MM') as ym, count(*)::int n
       from "Customers" where res_id=$1 and (${og} or outlet_id=$2) and created_at >= ${since} group by 1`,
    [rid, oid, String(months)],
  );
  const tatRows = await runQuery<{ ym: string; avg_min: number | null }>(
    `select to_char(date_trunc('month', s.seated_at),'YYYY-MM') as ym,
            avg(extract(epoch from (s.left_at - s.seated_at))/60)::float avg_min
       from "TableSessions" s
       left join "Tables" t on t.id = s.table_id and t.res_id = s.res_id
       where s.res_id=$1 and (${og} or s.outlet_id=$2) and s.left_at is not null and s.seated_at >= ${since}
         and s.left_at > s.seated_at and s.left_at - s.seated_at <= interval '6 hours'
         and coalesce(t.is_virtual, false) = false
       group by 1`,
    [rid, oid, String(months)],
  );

  const toMap = <T extends { ym: string }>(rows: T[]) => new Map(rows.map((r) => [r.ym, r]));
  const bills = toMap(billRows), orders = toMap(orderRows), fb = toMap(fbRows), cust = toMap(custRows), tat = toMap(tatRows);

  const now = await currentDbTime();
  const series: MonthlyHistoryRow[] = [];
  for (let i = 0; i < months; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const b = bills.get(ym);
    const revenue = round2(b?.revenue ?? 0);
    const nBills = b?.bills ?? 0;
    series.push({
      month: ym,
      revenue,
      bills: nBills,
      orders: orders.get(ym)?.orders ?? 0,
      avg_bill: nBills > 0 ? round2(revenue / nBills) : null,
      discounts: round2(b?.discounts ?? 0),
      feedback_count: fb.get(ym)?.n ?? 0,
      avg_rating: fb.get(ym)?.avg_rating != null ? round2(fb.get(ym)!.avg_rating!) : null,
      new_customers: cust.get(ym)?.n ?? 0,
      avg_tat_min: tat.get(ym)?.avg_min != null ? round2(tat.get(ym)!.avg_min!) : null,
    });
  }
  return { months, series }; // newest first
}

export async function GetMonthlyApcInsights(
  restaurantId: string,
  monthStartInput?: Date | ApcInsightOptions,
): Promise<MonthlyApcInsight> {
  const context = await requireRestaurantContext(restaurantId);
  const now = await currentDbTime();
  const options: ApcInsightOptions =
    monthStartInput instanceof Date
      ? { period: "month", periodStart: monthStartInput }
      : (monthStartInput ?? {});
  const period = options.period ?? "month";
  const base =
    options.periodStart && !Number.isNaN(options.periodStart.getTime())
      ? options.periodStart
      : now;

  let monthStart: Date;
  let monthEnd: Date;
  let monthLabel: string;

  if (period === "day") {
    monthStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0, 0));
    monthEnd = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1, 0, 0, 0, 0));
    monthLabel = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}-${String(monthStart.getUTCDate()).padStart(2, "0")}`;
  } else if (period === "week") {
    const day = base.getUTCDay();
    const offsetToMonday = day === 0 ? -6 : 1 - day;
    monthStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offsetToMonday, 0, 0, 0, 0));
    monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), monthStart.getUTCDate() + 7, 0, 0, 0, 0));

    const firstJan = new Date(Date.UTC(monthStart.getUTCFullYear(), 0, 1));
    const dayOffset = Math.floor((monthStart.getTime() - firstJan.getTime()) / (24 * 60 * 60 * 1000));
    const firstJanWeekday = (firstJan.getUTCDay() + 6) % 7;
    const weekNumber = Math.floor((dayOffset + firstJanWeekday) / 7) + 1;
    monthLabel = `${monthStart.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
  } else {
    monthStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1, 0, 0, 0, 0));
    monthEnd = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    monthLabel = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  const employeeFilter = options.employeeId?.trim().toLowerCase() || null;
  const yellowBandPercent = 0.1;

  const orderRows = await runQuery<{
    id: string;
    created_at: Date | string;
    table_id: string;
    table_name: string | null;
    num_covers: number;
    food: unknown;
    status: unknown;
    bill_status: number | null;
    admin_approved_at: Date | null;
    waiter_confirmed_by_username: string | null;
  }>(
    `
      select
        o.id,
        o.created_at,
        o.table_id,
        t.table_name,
        coalesce(t.num_covers, 1) as num_covers,
        o.food,
        o.status,
        b.status as bill_status,
        b.admin_approved_at,
        b.waiter_confirmed_by_username
      from "Orders" o
      left join "Tables" t
        on t.id = o.table_id and t.res_id = o.res_id and t.outlet_id = o.outlet_id
      left join "Bills" b
        on (b.order_id = o.id or (b.table_id = o.table_id and b.closed_at is null))
        and b.res_id = o.res_id and b.outlet_id = o.outlet_id
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

  const precomputedOrders = orderRows.map((row) => {
    const payload = parseJsonObject(row.food) ?? {};
    const createdAt = new Date(row.created_at);
    const subtotal = parseNumeric(payload.subtotal);
    const total = parseNumeric(payload.total) > 0 ? parseNumeric(payload.total) : subtotal;

    const payloadPeopleRaw = parseNumeric(
      (payload.people_count as unknown) ?? (payload.number_of_people as unknown),
    );

    // Prioritize num_covers from table, then payload, then booking lookup
    let people = Math.max(1, row.num_covers);

    if (payloadPeopleRaw > 0) {
      people = Math.max(1, Math.round(payloadPeopleRaw));
    } else if (!(payloadPeopleRaw > 0)) {
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

      // Accept nearest same-table booking if within 6 hours; otherwise use table num_covers
      people = bestScore <= 6 * 60 * 60 * 1000 ? Math.max(1, bestPeople) : Math.max(1, row.num_covers);
    }

    const payloadStatusRaw = String(payload.status ?? "").trim();
    const payloadStatus = payloadStatusRaw.length > 0 ? (payloadStatusRaw as OrderRecord["status"]) : undefined;
    const finalStatus = fromOrderStatusCode(row.status) || payloadStatus || "Preparing";

    const waiterIdFromPayload = String(payload.taken_by_employee_id ?? "").trim();
    const waiterNameFromPayload = String(payload.taken_by_employee_name ?? "").trim();
    const waiterRoleFromPayload = String(payload.taken_by_employee_role ?? "").trim();
    const waiterFromBill = String(row.waiter_confirmed_by_username ?? "").trim();

    const isPaid =
      Number(row.bill_status ?? 0) === 2
      || Boolean(row.admin_approved_at)
      || finalStatus === "Paid"
      || finalStatus === "Closed";

    return {
      order_id: row.id,
      table_name: row.table_name ?? String(payload.table ?? ""),
      created_at: createdAt.toISOString(),
      total: round2(total),
      people_count: people,
      assigned_employee_id: waiterIdFromPayload || waiterFromBill || null,
      assigned_employee_name: waiterNameFromPayload || waiterFromBill || null,
      assigned_employee_role: waiterRoleFromPayload || "waiter",
      status: finalStatus,
      is_paid: isPaid,
    };
  });

  const scopedOrders = employeeFilter
    ? precomputedOrders.filter((order) =>
      order.assigned_employee_id
        ? order.assigned_employee_id.toLowerCase() === employeeFilter
        : false,
    )
    : precomputedOrders;

  // APC is computed for all non-cancelled orders (Preparing, Served, Paid, Closed, etc.).
  // This allows APC visibility at every order status stage rather than only after payment.
  const effectiveOrders = scopedOrders.filter(
    (o) => String(o.status).toLowerCase() !== "cancelled",
  );

  // Aggregate by TABLE: one occupied table = one bill, and its covers are
  // counted ONCE. (Counting a table's covers once per order inflates the cover
  // count and crushes APC when a table places several orders.) APC for a table
  // = its bill (sum of orders) / the number of people on it.
  type TableAgg = {
    table_name: string;
    total: number;
    covers: number;
    created_at: string;
    employee_id: string | null;
    employee_name: string | null;
    employee_role: string;
  };
  const byTable = new Map<string, TableAgg>();
  for (const o of effectiveOrders) {
    const key = o.table_name || o.order_id;
    const agg = byTable.get(key) ?? {
      table_name: o.table_name,
      total: 0,
      covers: 0,
      created_at: o.created_at,
      employee_id: o.assigned_employee_id,
      employee_name: o.assigned_employee_name,
      employee_role: o.assigned_employee_role,
    };
    agg.total = round2(agg.total + o.total);
    agg.covers = Math.max(agg.covers, o.people_count); // covers counted once per table
    if (o.created_at > agg.created_at) agg.created_at = o.created_at;
    agg.employee_id ??= o.assigned_employee_id;
    agg.employee_name ??= o.assigned_employee_name;
    byTable.set(key, agg);
  }
  const tableBills = Array.from(byTable.values());

  const totalRevenue = round2(tableBills.reduce((sum, t) => sum + t.total, 0));
  const totalCovers = tableBills.reduce((sum, t) => sum + t.covers, 0);
  const monthlyApc = totalCovers > 0 ? round2(totalRevenue / totalCovers) : 0;

  // One insight per table bill: APC = bill / covers.
  const orders: OrderApcInsight[] = tableBills.map((t) => {
    const target = round2(monthlyApc * t.covers);
    return {
      order_id: t.table_name, // a table's consolidated bill is keyed by the table
      table_name: t.table_name,
      created_at: t.created_at,
      total: t.total,
      people_count: t.covers,
      target_total: target,
      zone: toApcZone(t.total, target, yellowBandPercent),
      assigned_employee_id: t.employee_id,
      assigned_employee_name: t.employee_name,
    };
  });

  // Employee performance: covers counted once per table the employee served.
  const employeeAccumulator = new Map<string, {
    employee_name: string;
    employee_role: string;
    tableCovers: Map<string, number>;
    orders_count: number;
    revenue: number;
  }>();

  for (const order of effectiveOrders) {
    if (!order.assigned_employee_id) continue;
    const existing = employeeAccumulator.get(order.assigned_employee_id) ?? {
      employee_name: order.assigned_employee_name || order.assigned_employee_id,
      employee_role: order.assigned_employee_role || "waiter",
      tableCovers: new Map<string, number>(),
      orders_count: 0,
      revenue: 0,
    };
    existing.tableCovers.set(
      order.table_name,
      Math.max(existing.tableCovers.get(order.table_name) ?? 0, order.people_count),
    );
    existing.orders_count += 1;
    existing.revenue = round2(existing.revenue + order.total);
    employeeAccumulator.set(order.assigned_employee_id, existing);
  }

  const employee_incentives: EmployeeApcIncentive[] = Array.from(employeeAccumulator.entries())
    .map(([employeeId, data]) => {
      const coversCount = Array.from(data.tableCovers.values()).reduce((s, c) => s + c, 0);
      const meanApc = coversCount > 0 ? round2(data.revenue / coversCount) : 0;
      return {
        employee_id: employeeId,
        employee_name: data.employee_name,
        employee_role: data.employee_role,
        assigned_tables: Array.from(data.tableCovers.keys()).sort((a, b) => a.localeCompare(b)),
        orders_count: data.orders_count,
        covers_count: coversCount,
        mean_apc: meanApc,
        zone: toApcZone(meanApc, monthlyApc, yellowBandPercent),
      };
    })
    .sort((a, b) => b.mean_apc - a.mean_apc);

  return {
    month: monthLabel,
    period,
    period_start: monthStart.toISOString(),
    period_end: monthEnd.toISOString(),
    monthly_apc: monthlyApc,
    total_revenue: totalRevenue,
    total_covers: totalCovers,
    yellow_band_percent: yellowBandPercent,
    orders,
    employee_incentives,
  };
}

export type DishStat = { name: string; category: string; quantity: number; revenue: number; orders: number; current_price: number | null };
export type PriceSuggestion = {
  name: string;
  category: string;
  current_price: number;
  suggested_price: number;
  direction: "increase" | "decrease";
  reason: string;
};
export type WaiterStat = { employee_id: string; employee_name: string; orders: number; revenue: number };

// Actionable menu/staff analytics over the last `days` days: best/worst selling
// dishes, simple data-driven price suggestions, and revenue by waiter. Built
// from the per-order line items in Orders.food.
export async function GetMenuPerformanceInsights(
  restaurantId: string,
  days = 30,
): Promise<{
  period_days: number;
  total_revenue: number;
  total_items_sold: number;
  top_dishes: DishStat[];
  slow_movers: DishStat[];
  price_suggestions: PriceSuggestion[];
  top_waiters: WaiterStat[];
}> {
  const context = await requireRestaurantContext(restaurantId);
  const now = await currentDbTime();
  const periodDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const start = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const orderRows = await runQuery<{ food: unknown }>(
    `
      select o.food
      from "Orders" o
      where o.res_id = $1 and o.outlet_id = $2
        and o.created_at >= $3
        and coalesce(o.status::text, '1') <> '5'
    `,
    [context.res_id, context.outlet_id, start.toISOString()],
  );

  const menu = await GetMenuItems(restaurantId).catch(() => [] as MenuItemRecord[]);
  const menuByName = new Map<string, MenuItemRecord>();
  for (const mi of menu) menuByName.set(mi.name.toLowerCase(), mi);

  // Aggregate sold line items by dish name.
  const dishMap = new Map<string, { name: string; quantity: number; revenue: number; orders: number }>();
  const waiterMap = new Map<string, { revenue: number; orders: number }>();
  let totalRevenue = 0;
  let totalItems = 0;

  for (const o of orderRows) {
    const f = parseJsonObject(o.food) ?? {};
    const list = Array.isArray((f as Record<string, unknown>).items) ? (f as { items: unknown[] }).items : [];
    let orderRevenue = 0;
    for (const raw of list) {
      const it = (raw ?? {}) as Record<string, unknown>;
      // Use the base dish name (strip any " (modifiers)" suffix) for aggregation.
      const fullName = String(it.name ?? "Item");
      const name = fullName.replace(/\s*\(.*\)\s*$/, "").trim() || fullName;
      const price = parseNumeric(it.price);
      const quantity = Math.max(1, Math.round(parseNumeric(it.quantity) || 1));
      const lineRevenue = round2(price * quantity);
      orderRevenue += lineRevenue;
      totalItems += quantity;
      const key = name.toLowerCase();
      const ex = dishMap.get(key);
      if (ex) { ex.quantity += quantity; ex.revenue = round2(ex.revenue + lineRevenue); ex.orders += 1; }
      else dishMap.set(key, { name, quantity, revenue: lineRevenue, orders: 1 });
    }
    totalRevenue = round2(totalRevenue + orderRevenue);
    const empId = String((f as Record<string, unknown>).taken_by_employee_id ?? "").trim();
    if (empId) {
      const w = waiterMap.get(empId) ?? { revenue: 0, orders: 0 };
      w.revenue = round2(w.revenue + orderRevenue);
      w.orders += 1;
      waiterMap.set(empId, w);
    }
  }

  const dishes: DishStat[] = Array.from(dishMap.values()).map((d) => {
    const mi = menuByName.get(d.name.toLowerCase());
    return {
      name: d.name,
      category: mi?.category ?? "",
      quantity: d.quantity,
      revenue: d.revenue,
      orders: d.orders,
      current_price: mi ? mi.price : null,
    };
  });

  const top_dishes = [...dishes].sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity).slice(0, 10);

  // Slow movers: items still on the (available) menu that sold little or nothing.
  const soldByName = new Map(dishes.map((d) => [d.name.toLowerCase(), d]));
  const slow_movers: DishStat[] = menu
    .filter((mi) => mi.available !== false)
    .map((mi) => {
      const sold = soldByName.get(mi.name.toLowerCase());
      return {
        name: mi.name,
        category: mi.category ?? "",
        quantity: sold?.quantity ?? 0,
        revenue: sold?.revenue ?? 0,
        orders: sold?.orders ?? 0,
        current_price: mi.price,
      };
    })
    .sort((a, b) => a.quantity - b.quantity || a.revenue - b.revenue)
    .slice(0, 8);

  // Price suggestions: raise prices on top-quartile sellers (demand is strong),
  // and trim prices on available-but-stagnant items to drive volume.
  const sortedByQty = [...dishes].filter((d) => d.current_price && d.current_price > 0).sort((a, b) => b.quantity - a.quantity);
  const topCount = Math.max(1, Math.ceil(sortedByQty.length * 0.25));
  const hotSellers = new Set(sortedByQty.slice(0, topCount).map((d) => d.name.toLowerCase()));
  const price_suggestions: PriceSuggestion[] = [];
  for (const d of sortedByQty) {
    const price = d.current_price as number;
    if (hotSellers.has(d.name.toLowerCase()) && d.quantity >= 5) {
      price_suggestions.push({
        name: d.name,
        category: d.category,
        current_price: price,
        suggested_price: round2(price * 1.08),
        direction: "increase",
        reason: `Strong demand — ${d.quantity} sold in ${periodDays} days. A ~8% rise likely won't dent volume.`,
      });
    }
  }
  // Underperformers: available menu items with very low sales over the window.
  for (const mv of slow_movers) {
    if (mv.current_price && mv.current_price > 0 && mv.quantity <= 2) {
      price_suggestions.push({
        name: mv.name,
        category: mv.category,
        current_price: mv.current_price,
        suggested_price: round2(mv.current_price * 0.9),
        direction: "decrease",
        reason: mv.quantity === 0
          ? `No sales in ${periodDays} days — consider a lower price or a promotion.`
          : `Only ${mv.quantity} sold in ${periodDays} days — a ~10% cut may lift volume.`,
      });
    }
  }
  const price_suggestions_capped = price_suggestions.slice(0, 12);

  // Resolve waiter names + revenue ranking.
  const waiterIds = Array.from(waiterMap.keys()).filter((id) => isUuid(id));
  const nameRows = waiterIds.length > 0
    ? await runQuery<{ id: string; fname: string | null; lname: string | null }>(
        `select id, "emp_Fname" as fname, "emp_Lname" as lname from "Employees" where id = any($1::uuid[]) and res_id = $2`,
        [waiterIds, context.res_id],
      )
    : [];
  const nameById = new Map(nameRows.map((r) => [r.id, `${r.fname ?? ""} ${r.lname ?? ""}`.trim()]));
  const top_waiters: WaiterStat[] = Array.from(waiterMap.entries())
    .map(([employee_id, v]) => ({
      employee_id,
      employee_name: nameById.get(employee_id) || "Staff",
      revenue: v.revenue,
      orders: v.orders,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    period_days: periodDays,
    total_revenue: totalRevenue,
    total_items_sold: totalItems,
    top_dishes,
    slow_movers,
    price_suggestions: price_suggestions_capped,
    top_waiters,
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
          -- employeeId from the session is the Employees UUID; older callers may
          -- pass a username, so match either.
          and (e.id::text = $3 or lower(l.emp_username) = lower($3))
        limit 1
      `,
      [context.res_id, context.outlet_id, employeeId.trim()],
    );
    // A provided employeeId that matches no one → skip the contact mirror rather
    // than risk writing it onto a different (fallback) employee.
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
    restaurant_name: context.restaurant_name,
    outlet_add: outlet?.outlet_add ?? "",
    outlet_phone: outlet?.outlet_phone ?? "",
    email: employee?.email ?? "",
    outlet_hours: outlet?.outlet_hours ?? "",

    res_id: context.res_id,
    restaurant_username: context.restaurant_slug,
    restaurant_main_office_add: context.restaurant_main_office_add,
    restaurant_logo_url: context.restaurant_logo_url,

    outlet_id: context.outlet_id,
    outlet_name: outlet?.outlet_name ?? "",
  };
}

// --- Customer-facing branding (logo + theme color) -------------------------
let brandingColsEnsured = false;
async function ensureBrandingColumns(): Promise<void> {
  if (brandingColsEnsured) return;
  await runQuery(`alter table "Restaurant" add column if not exists theme_color text`);
  await runQuery(`alter table "Restaurant" add column if not exists auto_push_orders boolean default true`);
  await runQuery(`alter table "Restaurant" add column if not exists currency text`);
  await runQuery(`alter table "Restaurant" add column if not exists payment_config jsonb`);
  // The restaurant's own Razorpay credentials, so online payments settle to their
  // account directly (we never middle-man). Secret is never exposed to clients.
  await runQuery(`alter table "Restaurant" add column if not exists razorpay_key_id text`);
  await runQuery(`alter table "Restaurant" add column if not exists razorpay_key_secret text`);
  // Optional service charge (percent of subtotal), added before tax. 0 = off.
  await runQuery(`alter table "Restaurant" add column if not exists service_charge numeric default 0`);
  // Customer feedback form configuration (title, valet gate, categories, etc.).
  await runQuery(`alter table "Restaurant" add column if not exists feedback_config jsonb`);
  // Bill logo as raw SVG markup (distinct from the PNG logo_url used elsewhere) —
  // printed at the top of the thermal/printed bill so it stays crisp at any size.
  await runQuery(`alter table "Restaurant" add column if not exists bill_logo_svg text`);
  // Thermal paper width: '58mm' (32 cols) or '80mm' (48 cols, default). Drives the
  // printed-bill column layout + logo raster width.
  await runQuery(`alter table "Restaurant" add column if not exists bill_paper_width text`);
  // Whether the walk-in queue page shows the menu / pre-order. Some restaurants
  // want a pure "queue position only" experience — default true (show it).
  await runQuery(`alter table "Restaurant" add column if not exists queue_show_menu boolean default true`);
  // Manager approval threshold for staff-applied bill discounts: when a NON-admin
  // applies a discount whose computed amount exceeds this, it becomes a pending
  // DiscountRequests row instead of applying. 0 = approvals off (apply directly).
  await runQuery(`alter table "Restaurant" add column if not exists discount_approval_threshold numeric default 0`);
  // Window (minutes) after closed_at during which an admin may re-open a closed
  // bill. 0 disables re-opening; default 4 hours.
  await runQuery(`alter table "Restaurant" add column if not exists bill_reopen_window_min integer default 240`);
  // Exception-alert thresholds (see RunExceptionChecks): ping the bell when the
  // 24h discount total exceeds this % of 24h revenue (0 = off), or when this
  // many orders were voided in 24h (0 = off).
  await runQuery(`alter table "Restaurant" add column if not exists alert_discount_pct numeric default 10`);
  await runQuery(`alter table "Restaurant" add column if not exists alert_void_count integer default 5`);
  // Loyalty programme: points earned per ₹100 of a settled bill (0 = loyalty
  // off) and the ₹ value of one point when redeemed as a bill discount.
  await runQuery(`alter table "Restaurant" add column if not exists loyalty_earn_per_100 numeric default 0`);
  await runQuery(`alter table "Restaurant" add column if not exists loyalty_point_value numeric default 1`);
  // Aggregator (Swiggy/Zomato) order-intake API key. Stored PLAIN by design:
  // it's a per-tenant, revocable machine credential (regenerate to rotate) and
  // staff need it visible nowhere — it's returned once on generation only.
  await runQuery(`alter table "Restaurant" add column if not exists aggregator_key text`);
  // Reservation deposits (collected via the restaurant's own Razorpay at public
  // booking time): flat deposit amount (0 = off), minimum party size the rule
  // applies from (0 = every booking once amount > 0), and the cancellation
  // window in hours — cancelling EARLIER than this before the slot start makes
  // the deposit refund_due; cancelling inside it forfeits the deposit.
  await runQuery(`alter table "Restaurant" add column if not exists booking_deposit_amount numeric default 0`);
  await runQuery(`alter table "Restaurant" add column if not exists booking_deposit_min_party integer default 0`);
  await runQuery(`alter table "Restaurant" add column if not exists booking_cancel_window_hours integer default 24`);
  // Informational minimum spend (₹) stamped onto new bookings (0 = off). Shown
  // to guests + staff; deliberately NOT enforced at billing.
  await runQuery(`alter table "Restaurant" add column if not exists booking_min_spend numeric default 0`);
  // Guest messaging (SMS/WhatsApp), provider-agnostic so no provider decision
  // blocks shipping: 'none' (log-only), 'twilio' or 'meta' (WhatsApp Cloud API).
  // msg_sender = Twilio number / Meta phone-number-id; msg_key_id = Twilio
  // Account SID (unused for meta); msg_key_secret = Twilio auth token / Meta
  // permanent token (write-only, never returned to clients); msg_webhook_secret
  // doubles as the Meta hub.verify_token AND the app secret for
  // X-Hub-Signature-256 verification (auto-generated on first messaging save).
  await runQuery(`alter table "Restaurant" add column if not exists msg_provider text default 'none'`);
  await runQuery(`alter table "Restaurant" add column if not exists msg_sender text`);
  await runQuery(`alter table "Restaurant" add column if not exists msg_key_id text`);
  await runQuery(`alter table "Restaurant" add column if not exists msg_key_secret text`);
  await runQuery(`alter table "Restaurant" add column if not exists msg_reminder_hours integer default 2`);
  await runQuery(`alter table "Restaurant" add column if not exists msg_webhook_secret text`);
  // Managed kitchen sections (ordered string array, e.g. ["Tandoor","Curry","Bar"]).
  // Menu items point at a section via Menu.description.station; the KDS offers
  // one display per section. Free-form stations on items remain allowed.
  await runQuery(`alter table "Restaurant" add column if not exists kitchen_sections jsonb`);
  // Managed inventory categories (string array, e.g. ["Vegetable","Meat","Dairy"]).
  // Inventory items point at a category via Inventory.description.category; a null
  // column means "use the built-in defaults" (see sanitizeInventoryCategories).
  await runQuery(`alter table "Restaurant" add column if not exists inventory_categories jsonb`);
  // IANA timezone the restaurant operates in (e.g. "Asia/Kolkata"). Reservation
  // wall-clock times are interpreted in this zone so a UTC prod server stores the
  // correct instant; the public reserve/queue pages read it via branding.
  await runQuery(`alter table "Restaurant" add column if not exists timezone text default 'Asia/Kolkata'`);
  brandingColsEnsured = true;
}

// The restaurant's own Razorpay keys (server-side only — used to create/verify
// orders against their account). Returns null when not configured.
export async function GetRestaurantRazorpayKeys(
  restaurantId: string,
): Promise<{ key_id: string; key_secret: string } | null> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const rows = await runQuery<{ razorpay_key_id: string | null; razorpay_key_secret: string | null }>(
    `select razorpay_key_id, razorpay_key_secret from "Restaurant" where id = $1 limit 1`,
    [context.res_id],
  );
  const id = (rows[0]?.razorpay_key_id ?? "").trim();
  const secret = (rows[0]?.razorpay_key_secret ?? "").trim();
  if (!id || !secret) return null;
  return { key_id: id, key_secret: secret };
}

// --- Guest messaging (SMS / WhatsApp, provider-agnostic) ---------------------
// The provider adapters (Twilio / Meta Cloud API HTTP calls) live in index.ts
// (sendMessage) next to fetchWithTimeout; this section owns the per-tenant
// config + the OutboundMessages audit trail + the reminder bookkeeping.

// Server-side messaging credentials (never sent to clients — the settings
// endpoint only exposes a configured flag for the secret).
export type MessagingConfig = {
  provider: "none" | "twilio" | "meta";
  sender: string;
  key_id: string;
  key_secret: string;
  reminder_hours: number;
  webhook_secret: string;
};

export async function GetMessagingConfig(restaurantId: string): Promise<MessagingConfig> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const rows = await runQuery<{ msg_provider: string | null; msg_sender: string | null; msg_key_id: string | null; msg_key_secret: string | null; msg_reminder_hours: number | string | null; msg_webhook_secret: string | null }>(
    `select msg_provider, msg_sender, msg_key_id, msg_key_secret, msg_reminder_hours, msg_webhook_secret from "Restaurant" where id = $1 limit 1`,
    [context.res_id],
  );
  return {
    provider: normalizeMsgProvider(rows[0]?.msg_provider),
    sender: (rows[0]?.msg_sender ?? "").trim(),
    key_id: (rows[0]?.msg_key_id ?? "").trim(),
    key_secret: (rows[0]?.msg_key_secret ?? "").trim(),
    reminder_hours: Math.max(0, Math.round(Number(rows[0]?.msg_reminder_hours ?? 2) || 0)),
    webhook_secret: (rows[0]?.msg_webhook_secret ?? "").trim(),
  };
}

// Every outbound guest message (or the reason one wasn't sent) is logged here,
// so the feature is observable even before a provider is configured
// (status 'skipped_no_provider') and delivery failures are visible to staff.
async function ensureOutboundMessagesTable(): Promise<void> {
  await ensureLazyTable("OutboundMessages", async () => {
    await runQuery(`
      create table if not exists "OutboundMessages" (
        id uuid primary key default gen_random_uuid(),
        res_id uuid not null,
        outlet_id uuid,
        channel text not null default 'sms',
        to_phone text,
        body text,
        kind text,
        ref_id text,
        status text not null default 'skipped_no_provider',
        error text,
        provider text,
        created_at timestamptz not null default now()
      )
    `);
    await runQuery(`create index if not exists outbound_messages_res_idx on "OutboundMessages" (res_id, created_at desc)`);
    await applyTenantRls("OutboundMessages");
  });
}

export type OutboundMessageEntry = {
  channel: "sms" | "whatsapp";
  to_phone: string | null;
  body: string;
  kind: "booking_confirm" | "booking_reminder" | "wa_reply";
  ref_id?: string | null;
  status: "sent" | "failed" | "skipped_no_provider";
  error?: string | null;
  provider?: string | null;
};

export async function RecordOutboundMessage(
  restaurantId: string,
  entry: OutboundMessageEntry,
): Promise<string> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutboundMessagesTable();
  const id = randomUUID();
  await runQuery(
    `insert into "OutboundMessages" (id, res_id, outlet_id, channel, to_phone, body, kind, ref_id, status, error, provider)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      context.res_id,
      context.outlet_id || null,
      entry.channel,
      entry.to_phone ?? null,
      (entry.body ?? "").slice(0, 2000),
      entry.kind,
      entry.ref_id ?? null,
      entry.status,
      entry.error ? String(entry.error).slice(0, 800) : null,
      entry.provider ?? null,
    ],
  );
  return id;
}

// Recent outbound messages for the delivery-visibility card (newest first).
export async function GetOutboundMessages(
  restaurantId: string,
  limit = 50,
): Promise<Array<{ id: string; channel: string; to_phone: string | null; body: string | null; kind: string | null; ref_id: string | null; status: string; error: string | null; provider: string | null; created_at: Date }>> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureOutboundMessagesTable();
  return runQuery(
    `select id, channel, to_phone, body, kind, ref_id, status, error, provider, created_at
       from "OutboundMessages"
      where res_id = $1
      order by created_at desc
      limit $2`,
    [context.res_id, Math.max(1, Math.min(200, Math.round(limit)))],
  );
}

export type DueBookingReminder = {
  booking_id: string;
  customer_name: string;
  phone: string;
  start: Date;
  party: number;
  table_name: string | null;
};

// Bookings starting within the next `withinHours` that still need a reminder:
// active-ish status, a guest phone on file and no reminder_sent stamp yet.
// Same decode-in-JS pattern as GetBookingsAfterTime (slot start lives in JSON).
export async function GetDueBookingReminders(
  restaurantId: string,
  withinHours: number,
): Promise<DueBookingReminder[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    booking_id: string;
    slot: string;
    created_at: Date;
    num_adults: unknown;
    table_name: string | null;
    cust_fname: string;
    cust_lname: string;
    phone: string | null;
  }>(
    `
      select
        b.id as booking_id,
        b.slot,
        b.created_at,
        b.num_adults,
        t.table_name as table_name,
        c."cust_Fname" as cust_fname,
        c."cust_Lname" as cust_lname,
        cast(c.cust_ph as text) as phone
      from "Bookings" b
      join "Customers" c
        on c.id = b.cust_id and c.res_id = b.res_id and c.outlet_id = b.outlet_id
      left join "Tables" t
        on t.id = b.table_id and t.res_id = b.res_id and t.outlet_id = b.outlet_id
      where b.res_id = $1 and b.outlet_id = $2
    `,
    [context.res_id, context.outlet_id],
  );

  const now = Date.now();
  const horizon = now + Math.max(0, withinHours) * 60 * MINUTE_IN_MS;
  const REMINDABLE = new Set(["requested", "confirmed", "pending"]);
  const due: DueBookingReminder[] = [];
  for (const row of rows) {
    const slot = decodeSlot(row.slot, row.created_at);
    if (slot.reminder_sent === true) continue;
    if (!REMINDABLE.has(String(slot.status ?? "Confirmed").trim().toLowerCase())) continue;
    const start = new Date(slot.start).getTime();
    if (!Number.isFinite(start) || start <= now || start > horizon) continue;
    const phone = (row.phone ?? "").trim();
    if (!phone) continue;
    due.push({
      booking_id: row.booking_id,
      customer_name: `${row.cust_fname} ${row.cust_lname}`.trim(),
      phone,
      start: new Date(start),
      party: Math.max(1, Math.round(parseNumeric(row.num_adults))),
      table_name: row.table_name,
    });
  }
  due.sort((a, b) => a.start.getTime() - b.start.getTime());
  return due;
}

// Stamp slot.reminder_sent = true. Returns false when the booking is missing
// or already stamped — the caller sends the reminder only on a true return,
// so the 30-min sweep can never double-remind the same booking.
export async function MarkBookingReminderSent(
  restaurantId: string,
  booking_id: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ slot: string; created_at: Date }>(
    `select slot, created_at from "Bookings" where id = $1 and res_id = $2 and outlet_id = $3 limit 1`,
    [booking_id, context.res_id, context.outlet_id],
  );
  const row = rows[0];
  if (!row) return false;
  const slot = decodeSlot(row.slot, row.created_at);
  if (slot.reminder_sent === true) return false;
  slot.reminder_sent = true;
  await runQuery(
    `update "Bookings" set slot = $4 where id = $1 and res_id = $2 and outlet_id = $3`,
    [booking_id, context.res_id, context.outlet_id, encodeSlot(slot)],
  );
  return true;
}

export type PaymentMethodConfig = { id: string; label: string; enabled: boolean; requires_screenshot: boolean; online?: boolean };

// Default payment methods. Razorpay (online) on by default; alternate methods
// 4–7 require a screenshot by default. Restaurants override via settings.
export const DEFAULT_PAYMENT_METHODS: PaymentMethodConfig[] = [
  { id: "Razorpay", label: "Pay online (Razorpay)", enabled: true, requires_screenshot: false, online: true },
  { id: "Upi", label: "UPI", enabled: true, requires_screenshot: false },
  { id: "Cash", label: "Cash", enabled: true, requires_screenshot: false },
  { id: "Card", label: "Card", enabled: true, requires_screenshot: false },
  { id: "Dineout", label: "Dineout", enabled: true, requires_screenshot: true },
  { id: "Zomato", label: "Zomato", enabled: true, requires_screenshot: true },
  { id: "Eazydiner", label: "EasyDiner", enabled: true, requires_screenshot: true },
  { id: "District", label: "District", enabled: true, requires_screenshot: true },
];

function mergePaymentConfig(stored: unknown): PaymentMethodConfig[] {
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(stored)) for (const m of stored) { const id = String((m as any)?.id ?? ""); if (id) byId.set(id, m as any); }
  return DEFAULT_PAYMENT_METHODS.map((def) => {
    const ov = byId.get(def.id);
    return {
      ...def,
      enabled: ov && typeof ov.enabled === "boolean" ? ov.enabled : def.enabled,
      requires_screenshot: ov && typeof ov.requires_screenshot === "boolean" ? ov.requires_screenshot : def.requires_screenshot,
    };
  });
}

// --- Customer feedback form configuration -----------------------------------
export type FeedbackCategoryConfig = { key: string; label: string };
export type FeedbackConfig = {
  title: string;
  subtitle: string;
  valet_enabled: boolean;
  require_image: boolean;
  review_url: string; // external review link (Google/TripAdvisor) for the high-rating CTA
  categories: FeedbackCategoryConfig[];
};

const DEFAULT_FEEDBACK_CATEGORIES: FeedbackCategoryConfig[] = [
  { key: "initial_greeting", label: "Initial Greeting" },
  { key: "waiter_serving", label: "Waiter Service" },
  { key: "food", label: "Food Quality" },
  { key: "ambience", label: "Ambience" },
  { key: "restroom", label: "Restroom" },
  { key: "valet_parking", label: "Valet Parking" },
];

// Valet gate + forced image upload default OFF (the old form always showed the
// valet gate and refused to submit without a photo — both fixed here).
export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  title: "Restaurant Feedback",
  subtitle: "We'd love to hear about your visit.",
  valet_enabled: false,
  require_image: false,
  review_url: "",
  categories: DEFAULT_FEEDBACK_CATEGORIES,
};

function mergeFeedbackConfig(stored: unknown): FeedbackConfig {
  const s = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const cats = Array.isArray(s.categories)
    ? (s.categories
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          const label = String(o.label ?? "").trim();
          if (!label) return null;
          const key = String(o.key ?? "").trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
          return { key: (key || "category").slice(0, 40), label: label.slice(0, 40) };
        })
        .filter(Boolean) as FeedbackCategoryConfig[])
    : [];
  return {
    title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 80) : DEFAULT_FEEDBACK_CONFIG.title,
    subtitle: typeof s.subtitle === "string" ? s.subtitle.trim().slice(0, 200) : DEFAULT_FEEDBACK_CONFIG.subtitle,
    valet_enabled: typeof s.valet_enabled === "boolean" ? s.valet_enabled : DEFAULT_FEEDBACK_CONFIG.valet_enabled,
    require_image: typeof s.require_image === "boolean" ? s.require_image : DEFAULT_FEEDBACK_CONFIG.require_image,
    review_url: typeof s.review_url === "string" ? s.review_url.trim().slice(0, 500) : DEFAULT_FEEDBACK_CONFIG.review_url,
    categories: cats.length > 0 ? cats.slice(0, 12) : DEFAULT_FEEDBACK_CONFIG.categories,
  };
}

// Normalize an arbitrary tax payload (array of {name,percentage} or a
// name->percentage record) into an ordered, validated array.
function normalizeTaxes(raw: unknown): Array<{ name: string; percentage: number }> {
  const out: Array<{ name: string; percentage: number }> = [];
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const o = (t ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      const pct = Number(o.percentage);
      if (name && Number.isFinite(pct) && pct >= 0) out.push({ name: name.slice(0, 24), percentage: round2(pct) });
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, pct] of Object.entries(raw as Record<string, unknown>)) {
      const p = Number(pct);
      if (name.trim() && Number.isFinite(p) && p >= 0) out.push({ name: name.trim().slice(0, 24), percentage: round2(p) });
    }
  }
  return out;
}

// Managed kitchen-section list: trimmed, case-insensitively deduped, capped at
// 20 sections of 32 chars each. Order is preserved (it drives KDS chip order).
export function sanitizeKitchenSections(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    const name = typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 32) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

// The built-in inventory categories, used when the tenant has never customized
// the managed list (inventory_categories column is null). Mirrors the set the
// web/Flutter UIs historically hardcoded.
export const DEFAULT_INVENTORY_CATEGORIES: string[] = ["Vegetable", "Meat", "Dairy", "Dry Goods", "Oil", "Other"];

// Like sanitizeKitchenSections but for inventory categories: trim, collapse
// spaces, cap each name at 40 chars, case-insensitive dedupe, cap the list at 40.
// A non-array value (i.e. the column was never written) falls back to the
// built-in defaults so GET /restaurant/settings always returns a usable list.
export function sanitizeInventoryCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_INVENTORY_CATEGORIES];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    const name = typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 40) break;
  }
  return out;
}

export type RestaurantSettings = {
  auto_push_orders: boolean;
  currency: string;
  payment_methods: PaymentMethodConfig[];
  taxes: Array<{ name: string; percentage: number }>;
  service_charge: number;
  discount_approval_threshold: number;
  bill_reopen_window_min: number;
  alert_discount_pct: number;
  alert_void_count: number;
  // Loyalty: points earned per ₹100 of settled bill (0 = off) + ₹ per point.
  loyalty_earn_per_100: number;
  loyalty_point_value: number;
  // Reservation deposits + informational minimum spend (see ensureBrandingColumns).
  booking_deposit_amount: number;
  booking_deposit_min_party: number;
  booking_cancel_window_hours: number;
  booking_min_spend: number;
  razorpay_key_id: string;
  razorpay_configured: boolean;
  // Guest messaging (confirmations/reminders + WhatsApp booking). The provider
  // secret is write-only: only a configured flag is ever returned.
  msg_provider: "none" | "twilio" | "meta";
  msg_sender: string;
  msg_key_id: string;
  msg_secret_configured: boolean;
  msg_reminder_hours: number;
  msg_webhook_secret: string;
  feedback_config: FeedbackConfig;
  bill_logo_svg: string;
  bill_paper_width: "58mm" | "80mm";
  queue_show_menu?: boolean;
  // Managed kitchen sections (ordered) — see sanitizeKitchenSections.
  kitchen_sections: string[];
  // Managed inventory categories — see sanitizeInventoryCategories.
  inventory_categories: string[];
  // IANA timezone reservation wall-clock times are interpreted in.
  timezone: string;
};

// Basic sanitization for an uploaded SVG logo: cap the size and strip the
// script/event-handler vectors so a stored logo can't run code where it's
// rendered. Returns "" for anything that isn't a plausible <svg> document.
export function sanitizeBillLogoSvg(input: unknown): string {
  if (typeof input !== "string") return "";
  let svg = input.trim();
  if (!svg) return "";
  if (svg.length > 100_000) svg = svg.slice(0, 100_000);
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>/i.test(svg)) return "";
  // Drop <script> blocks, on*= handlers, and javascript: URLs.
  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
  return svg;
}

// Coerce a stored msg_provider value into the supported set.
function normalizeMsgProvider(raw: unknown): "none" | "twilio" | "meta" {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "twilio" || v === "meta" ? v : "none";
}

export async function GetRestaurantSettings(
  restaurantId: string,
): Promise<RestaurantSettings> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const rows = await runQuery<{ auto_push_orders: boolean | null; currency: string | null; payment_config: unknown; razorpay_key_id: string | null; razorpay_key_secret: string | null; service_charge: number | string | null; discount_approval_threshold: number | string | null; bill_reopen_window_min: number | string | null; alert_discount_pct: number | string | null; alert_void_count: number | string | null; loyalty_earn_per_100: number | string | null; loyalty_point_value: number | string | null; booking_deposit_amount: number | string | null; booking_deposit_min_party: number | string | null; booking_cancel_window_hours: number | string | null; booking_min_spend: number | string | null; msg_provider: string | null; msg_sender: string | null; msg_key_id: string | null; msg_key_secret: string | null; msg_reminder_hours: number | string | null; msg_webhook_secret: string | null; feedback_config: unknown; bill_logo_svg: string | null; bill_paper_width: string | null; queue_show_menu: boolean | null; kitchen_sections: unknown; inventory_categories: unknown; timezone: string | null }>(
    `select auto_push_orders, currency, payment_config, razorpay_key_id, razorpay_key_secret, service_charge, discount_approval_threshold, bill_reopen_window_min, alert_discount_pct, alert_void_count, loyalty_earn_per_100, loyalty_point_value, booking_deposit_amount, booking_deposit_min_party, booking_cancel_window_hours, booking_min_spend, msg_provider, msg_sender, msg_key_id, msg_key_secret, msg_reminder_hours, msg_webhook_secret, feedback_config, bill_logo_svg, bill_paper_width, queue_show_menu, kitchen_sections, inventory_categories, timezone from "Restaurant" where id = $1 limit 1`,
    [context.res_id],
  );
  const taxRows = await runQuery<{ default_tax: unknown }>(
    `select default_tax from "Outlets" where id = $1 and res_id = $2 limit 1`,
    [context.outlet_id, context.res_id],
  );
  const keyId = (rows[0]?.razorpay_key_id ?? "").trim();
  const keySecret = (rows[0]?.razorpay_key_secret ?? "").trim();
  return {
    auto_push_orders: rows[0]?.auto_push_orders ?? true,
    currency: (rows[0]?.currency && String(rows[0].currency).trim()) || "₹",
    payment_methods: mergePaymentConfig(rows[0]?.payment_config),
    taxes: normalizeTaxes(taxRows[0]?.default_tax),
    service_charge: Math.max(0, Number(rows[0]?.service_charge ?? 0) || 0),
    discount_approval_threshold: Math.max(0, Number(rows[0]?.discount_approval_threshold ?? 0) || 0),
    bill_reopen_window_min: Math.max(0, Math.round(Number(rows[0]?.bill_reopen_window_min ?? 240) || 0)),
    alert_discount_pct: Math.max(0, Number(rows[0]?.alert_discount_pct ?? 10) || 0),
    alert_void_count: Math.max(0, Math.round(Number(rows[0]?.alert_void_count ?? 5) || 0)),
    loyalty_earn_per_100: Math.max(0, Number(rows[0]?.loyalty_earn_per_100 ?? 0) || 0),
    loyalty_point_value: Math.max(0, Number(rows[0]?.loyalty_point_value ?? 1) || 0),
    booking_deposit_amount: Math.max(0, Number(rows[0]?.booking_deposit_amount ?? 0) || 0),
    booking_deposit_min_party: Math.max(0, Math.round(Number(rows[0]?.booking_deposit_min_party ?? 0) || 0)),
    booking_cancel_window_hours: Math.max(0, Math.round(Number(rows[0]?.booking_cancel_window_hours ?? 24) || 0)),
    booking_min_spend: Math.max(0, Number(rows[0]?.booking_min_spend ?? 0) || 0),
    // key_id is the publishable identifier (sent to the browser at checkout), so
    // it's safe to return. The secret is NEVER returned — only a configured flag.
    razorpay_key_id: keyId,
    razorpay_configured: keyId.length > 0 && keySecret.length > 0,
    // Messaging: provider secret is write-only (configured flag only); the
    // webhook secret IS returned — the owner needs it as the Meta verify token.
    msg_provider: normalizeMsgProvider(rows[0]?.msg_provider),
    msg_sender: (rows[0]?.msg_sender ?? "").trim(),
    msg_key_id: (rows[0]?.msg_key_id ?? "").trim(),
    msg_secret_configured: (rows[0]?.msg_key_secret ?? "").trim().length > 0,
    msg_reminder_hours: Math.max(0, Math.round(Number(rows[0]?.msg_reminder_hours ?? 2) || 0)),
    msg_webhook_secret: (rows[0]?.msg_webhook_secret ?? "").trim(),
    feedback_config: mergeFeedbackConfig(rows[0]?.feedback_config),
    bill_paper_width: rows[0]?.bill_paper_width === "58mm" ? "58mm" : "80mm",
    bill_logo_svg: rows[0]?.bill_logo_svg ?? "",
    queue_show_menu: rows[0]?.queue_show_menu ?? true,
    kitchen_sections: sanitizeKitchenSections(rows[0]?.kitchen_sections),
    inventory_categories: sanitizeInventoryCategories(rows[0]?.inventory_categories),
    timezone: sanitizeTimezone(rows[0]?.timezone),
  };
}

export async function SetRestaurantSettings(
  restaurantId: string,
  opts: { auto_push_orders?: boolean; currency?: string; payment_methods?: unknown; taxes?: unknown; razorpay_key_id?: string; razorpay_key_secret?: string; service_charge?: number; discount_approval_threshold?: number; bill_reopen_window_min?: number; alert_discount_pct?: number; alert_void_count?: number; loyalty_earn_per_100?: number; loyalty_point_value?: number; booking_deposit_amount?: number; booking_deposit_min_party?: number; booking_cancel_window_hours?: number; booking_min_spend?: number; msg_provider?: string; msg_sender?: string; msg_key_id?: string; msg_key_secret?: string; msg_reminder_hours?: number; feedback_config?: unknown; bill_logo_svg?: unknown; bill_paper_width?: unknown; kitchen_sections?: unknown; inventory_categories?: unknown; timezone?: string },
): Promise<RestaurantSettings> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const feedbackConfig = opts.feedback_config !== undefined ? JSON.stringify(mergeFeedbackConfig(opts.feedback_config)) : null;
  // bill_logo_svg: only written when the field is present. Empty string clears it.
  const billLogoSvg = opts.bill_logo_svg !== undefined ? sanitizeBillLogoSvg(opts.bill_logo_svg) : null;
  // bill_paper_width: only '58mm' or '80mm' accepted; null leaves it unchanged.
  const billPaperWidth = opts.bill_paper_width === "58mm" || opts.bill_paper_width === "80mm" ? opts.bill_paper_width : null;
  const currency = typeof opts.currency === "string" && opts.currency.trim() ? opts.currency.trim().slice(0, 8) : null;
  const paymentConfig = Array.isArray(opts.payment_methods) ? JSON.stringify(mergePaymentConfig(opts.payment_methods)) : null;
  // key_id: set when a string is provided (empty string clears it).
  const razorpayKeyId = typeof opts.razorpay_key_id === "string" ? opts.razorpay_key_id.trim().slice(0, 80) : null;
  // key_secret: only overwrite when a non-empty value is sent (blank = keep current).
  const razorpayKeySecret = typeof opts.razorpay_key_secret === "string" && opts.razorpay_key_secret.trim()
    ? opts.razorpay_key_secret.trim().slice(0, 120)
    : null;
  const serviceCharge = typeof opts.service_charge === "number" && Number.isFinite(opts.service_charge)
    ? Math.max(0, Math.min(100, round2(opts.service_charge)))
    : null;
  // Discount approval threshold is an AMOUNT (not a %), so it is only bounded below.
  const discountApprovalThreshold = typeof opts.discount_approval_threshold === "number" && Number.isFinite(opts.discount_approval_threshold)
    ? Math.max(0, round2(opts.discount_approval_threshold))
    : null;
  // Re-open window in minutes (0 = disabled); capped at 30 days.
  const billReopenWindowMin = typeof opts.bill_reopen_window_min === "number" && Number.isFinite(opts.bill_reopen_window_min)
    ? Math.max(0, Math.min(43200, Math.round(opts.bill_reopen_window_min)))
    : null;
  // Exception-alert thresholds: discount % of 24h revenue (0 = off, ≤100) and
  // voided-orders count in 24h (0 = off).
  const alertDiscountPct = typeof opts.alert_discount_pct === "number" && Number.isFinite(opts.alert_discount_pct)
    ? Math.max(0, Math.min(100, round2(opts.alert_discount_pct)))
    : null;
  const alertVoidCount = typeof opts.alert_void_count === "number" && Number.isFinite(opts.alert_void_count)
    ? Math.max(0, Math.min(1000, Math.round(opts.alert_void_count)))
    : null;
  // Loyalty earn rate (points per ₹100 settled; 0 = off) and point value (₹/point).
  const loyaltyEarnPer100 = typeof opts.loyalty_earn_per_100 === "number" && Number.isFinite(opts.loyalty_earn_per_100)
    ? Math.max(0, Math.min(1000, round2(opts.loyalty_earn_per_100)))
    : null;
  const loyaltyPointValue = typeof opts.loyalty_point_value === "number" && Number.isFinite(opts.loyalty_point_value)
    ? Math.max(0, Math.min(10000, round2(opts.loyalty_point_value)))
    : null;
  // Reservation deposit rule: flat ₹ amount (0 = off), min party the rule
  // applies from (0 = always), cancel window in hours (refund_due vs forfeited),
  // and the informational minimum spend stamped onto new bookings (0 = off).
  const bookingDepositAmount = typeof opts.booking_deposit_amount === "number" && Number.isFinite(opts.booking_deposit_amount)
    ? Math.max(0, Math.min(1_000_000, round2(opts.booking_deposit_amount)))
    : null;
  const bookingDepositMinParty = typeof opts.booking_deposit_min_party === "number" && Number.isFinite(opts.booking_deposit_min_party)
    ? Math.max(0, Math.min(500, Math.round(opts.booking_deposit_min_party)))
    : null;
  const bookingCancelWindowHours = typeof opts.booking_cancel_window_hours === "number" && Number.isFinite(opts.booking_cancel_window_hours)
    ? Math.max(0, Math.min(720, Math.round(opts.booking_cancel_window_hours)))
    : null;
  const bookingMinSpend = typeof opts.booking_min_spend === "number" && Number.isFinite(opts.booking_min_spend)
    ? Math.max(0, Math.min(10_000_000, round2(opts.booking_min_spend)))
    : null;
  // Guest messaging: provider must be one of the supported values; sender/key_id
  // are clearable (empty string clears); the secret is write-only (blank = keep
  // current, mirroring razorpay_key_secret); reminder hours 0 = reminders off.
  const msgProvider = typeof opts.msg_provider === "string" && ["none", "twilio", "meta"].includes(opts.msg_provider.trim().toLowerCase())
    ? opts.msg_provider.trim().toLowerCase()
    : null;
  const msgSender = typeof opts.msg_sender === "string" ? opts.msg_sender.trim().slice(0, 120) : null;
  const msgKeyId = typeof opts.msg_key_id === "string" ? opts.msg_key_id.trim().slice(0, 120) : null;
  const msgKeySecret = typeof opts.msg_key_secret === "string" && opts.msg_key_secret.trim()
    ? opts.msg_key_secret.trim().slice(0, 300)
    : null;
  const msgReminderHours = typeof opts.msg_reminder_hours === "number" && Number.isFinite(opts.msg_reminder_hours)
    ? Math.max(0, Math.min(168, Math.round(opts.msg_reminder_hours)))
    : null;
  const msgFieldTouched = msgProvider !== null || msgSender !== null || msgKeyId !== null || msgKeySecret !== null || msgReminderHours !== null;
  // Managed kitchen sections: only written when an array is sent ([] clears).
  const kitchenSections = Array.isArray(opts.kitchen_sections) ? JSON.stringify(sanitizeKitchenSections(opts.kitchen_sections)) : null;
  // Managed inventory categories: only written when an array is sent ([] clears;
  // an unset/null column reads back as the built-in defaults, not this write).
  const inventoryCategories = Array.isArray(opts.inventory_categories) ? JSON.stringify(sanitizeInventoryCategories(opts.inventory_categories)) : null;
  // Timezone: only written when a non-empty string is sent; an invalid IANA id
  // falls back to Asia/Kolkata (sanitizeTimezone). null leaves it unchanged.
  const timezone = typeof opts.timezone === "string" && opts.timezone.trim() ? sanitizeTimezone(opts.timezone) : null;
  const rows = await runQuery<{ auto_push_orders: boolean | null; currency: string | null; payment_config: unknown; razorpay_key_id: string | null; razorpay_key_secret: string | null; service_charge: number | string | null; discount_approval_threshold: number | string | null; bill_reopen_window_min: number | string | null; alert_discount_pct: number | string | null; alert_void_count: number | string | null; loyalty_earn_per_100: number | string | null; loyalty_point_value: number | string | null; booking_deposit_amount: number | string | null; booking_deposit_min_party: number | string | null; booking_cancel_window_hours: number | string | null; booking_min_spend: number | string | null; msg_provider: string | null; msg_sender: string | null; msg_key_id: string | null; msg_key_secret: string | null; msg_reminder_hours: number | string | null; msg_webhook_secret: string | null; feedback_config: unknown; bill_logo_svg: string | null; bill_paper_width: string | null; kitchen_sections: unknown; inventory_categories: unknown; timezone: string | null }>(
    `update "Restaurant" set
       auto_push_orders = coalesce($2, auto_push_orders),
       currency = coalesce($3, currency),
       payment_config = coalesce($4::jsonb, payment_config),
       razorpay_key_id = case when $5::text is null then razorpay_key_id else nullif($5, '') end,
       razorpay_key_secret = coalesce($6, razorpay_key_secret),
       service_charge = coalesce($7, service_charge),
       feedback_config = coalesce($8::jsonb, feedback_config),
       bill_logo_svg = case when $9::text is null then bill_logo_svg else nullif($9, '') end,
       bill_paper_width = coalesce($10, bill_paper_width),
       discount_approval_threshold = coalesce($11, discount_approval_threshold),
       bill_reopen_window_min = coalesce($12, bill_reopen_window_min),
       alert_discount_pct = coalesce($13, alert_discount_pct),
       alert_void_count = coalesce($14, alert_void_count),
       loyalty_earn_per_100 = coalesce($15, loyalty_earn_per_100),
       loyalty_point_value = coalesce($16, loyalty_point_value),
       booking_deposit_amount = coalesce($17, booking_deposit_amount),
       booking_deposit_min_party = coalesce($18, booking_deposit_min_party),
       booking_cancel_window_hours = coalesce($19, booking_cancel_window_hours),
       booking_min_spend = coalesce($20, booking_min_spend),
       msg_provider = coalesce($21, msg_provider),
       msg_sender = case when $22::text is null then msg_sender else nullif($22, '') end,
       msg_key_id = case when $23::text is null then msg_key_id else nullif($23, '') end,
       msg_key_secret = coalesce($24, msg_key_secret),
       msg_reminder_hours = coalesce($25, msg_reminder_hours),
       kitchen_sections = coalesce($26::jsonb, kitchen_sections),
       timezone = coalesce($27, timezone),
       inventory_categories = coalesce($28::jsonb, inventory_categories)
     where id = $1
     returning auto_push_orders, currency, payment_config, razorpay_key_id, razorpay_key_secret, service_charge, discount_approval_threshold, bill_reopen_window_min, alert_discount_pct, alert_void_count, loyalty_earn_per_100, loyalty_point_value, booking_deposit_amount, booking_deposit_min_party, booking_cancel_window_hours, booking_min_spend, msg_provider, msg_sender, msg_key_id, msg_key_secret, msg_reminder_hours, msg_webhook_secret, feedback_config, bill_logo_svg, bill_paper_width, kitchen_sections, inventory_categories, timezone`,
    [
      context.res_id,
      typeof opts.auto_push_orders === "boolean" ? opts.auto_push_orders : null,
      currency,
      paymentConfig,
      razorpayKeyId,
      razorpayKeySecret,
      serviceCharge,
      feedbackConfig,
      billLogoSvg,
      billPaperWidth,
      discountApprovalThreshold,
      billReopenWindowMin,
      alertDiscountPct,
      alertVoidCount,
      loyaltyEarnPer100,
      loyaltyPointValue,
      bookingDepositAmount,
      bookingDepositMinParty,
      bookingCancelWindowHours,
      bookingMinSpend,
      msgProvider,
      msgSender,
      msgKeyId,
      msgKeySecret,
      msgReminderHours,
      kitchenSections,
      timezone,
      inventoryCategories,
    ],
  );
  // First messaging save: mint the webhook secret (Meta hub.verify_token +
  // X-Hub-Signature-256 app secret) so the owner has something to paste into
  // the Meta console without a separate "generate" step.
  let msgWebhookSecret = (rows[0]?.msg_webhook_secret ?? "").trim();
  if (msgFieldTouched && !msgWebhookSecret) {
    msgWebhookSecret = randomUUID().replace(/-/g, "");
    await runQuery(
      `update "Restaurant" set msg_webhook_secret = $2 where id = $1 and (msg_webhook_secret is null or msg_webhook_secret = '')`,
      [context.res_id, msgWebhookSecret],
    );
  }
  // Taxes live on the outlet (default_tax) — write the normalized array when provided.
  if (opts.taxes !== undefined) {
    await runQuery(
      `update "Outlets" set default_tax = $2::jsonb where id = $1 and res_id = $3`,
      [context.outlet_id, JSON.stringify(normalizeTaxes(opts.taxes)), context.res_id],
    );
  }
  const taxRows = await runQuery<{ default_tax: unknown }>(
    `select default_tax from "Outlets" where id = $1 and res_id = $2 limit 1`,
    [context.outlet_id, context.res_id],
  );
  const keyId = (rows[0]?.razorpay_key_id ?? "").trim();
  const keySecret = (rows[0]?.razorpay_key_secret ?? "").trim();
  return {
    auto_push_orders: rows[0]?.auto_push_orders ?? true,
    currency: (rows[0]?.currency && String(rows[0].currency).trim()) || "₹",
    payment_methods: mergePaymentConfig(rows[0]?.payment_config),
    taxes: normalizeTaxes(taxRows[0]?.default_tax),
    service_charge: Math.max(0, Number(rows[0]?.service_charge ?? 0) || 0),
    discount_approval_threshold: Math.max(0, Number(rows[0]?.discount_approval_threshold ?? 0) || 0),
    bill_reopen_window_min: Math.max(0, Math.round(Number(rows[0]?.bill_reopen_window_min ?? 240) || 0)),
    alert_discount_pct: Math.max(0, Number(rows[0]?.alert_discount_pct ?? 10) || 0),
    alert_void_count: Math.max(0, Math.round(Number(rows[0]?.alert_void_count ?? 5) || 0)),
    loyalty_earn_per_100: Math.max(0, Number(rows[0]?.loyalty_earn_per_100 ?? 0) || 0),
    loyalty_point_value: Math.max(0, Number(rows[0]?.loyalty_point_value ?? 1) || 0),
    booking_deposit_amount: Math.max(0, Number(rows[0]?.booking_deposit_amount ?? 0) || 0),
    booking_deposit_min_party: Math.max(0, Math.round(Number(rows[0]?.booking_deposit_min_party ?? 0) || 0)),
    booking_cancel_window_hours: Math.max(0, Math.round(Number(rows[0]?.booking_cancel_window_hours ?? 24) || 0)),
    booking_min_spend: Math.max(0, Number(rows[0]?.booking_min_spend ?? 0) || 0),
    razorpay_key_id: keyId,
    razorpay_configured: keyId.length > 0 && keySecret.length > 0,
    msg_provider: normalizeMsgProvider(rows[0]?.msg_provider),
    msg_sender: (rows[0]?.msg_sender ?? "").trim(),
    msg_key_id: (rows[0]?.msg_key_id ?? "").trim(),
    msg_secret_configured: (rows[0]?.msg_key_secret ?? "").trim().length > 0,
    msg_reminder_hours: Math.max(0, Math.round(Number(rows[0]?.msg_reminder_hours ?? 2) || 0)),
    msg_webhook_secret: msgWebhookSecret,
    feedback_config: mergeFeedbackConfig(rows[0]?.feedback_config),
    bill_paper_width: rows[0]?.bill_paper_width === "58mm" ? "58mm" : "80mm",
    bill_logo_svg: rows[0]?.bill_logo_svg ?? "",
    kitchen_sections: sanitizeKitchenSections(rows[0]?.kitchen_sections),
    inventory_categories: sanitizeInventoryCategories(rows[0]?.inventory_categories),
    timezone: sanitizeTimezone(rows[0]?.timezone),
  };
}

// --- SSRF guard for server-side fetches of tenant-supplied URLs -------------
// A tenant admin can set an arbitrary logo URL that the server fetches while an
// ANONYMOUS visitor loads /qr/:slug/menu — so block private/loopback/link-local/
// cloud-metadata targets (169.254.169.254 et al.) to prevent internal probing /
// credential theft from inside the VPC.
function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    const a = o[0] ?? 0, b = o[1] ?? 0;
    if (a === 127 || a === 10 || a === 0) return true;      // loopback / 10-8 / this-host
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
    if (a === 192 && b === 168) return true;                 // 192.168/16
    if (a === 169 && b === 254) return true;                 // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 100.64/10
    if (a >= 224) return true;                               // multicast / reserved
    return false;
  }
  const l = ip.toLowerCase();
  if (l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
  if (l.startsWith("::ffff:")) return isBlockedIp(l.slice(7));        // IPv4-mapped
  return false;
}
// Returns the URL only if it's a PUBLIC http(s) target (DNS-resolved, no private IP).
async function assertPublicHttpUrl(urlStr: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || /(^|\.)(localhost|internal|local)$/i.test(host)) return null;
  if (net.isIP(host)) return isBlockedIp(host) ? null : u;
  try {
    const addrs = await dnsLookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) return null;
    return u;
  } catch { return null; }
}

// --- Logo-derived theming (server-side, via sharp) --------------------------
// Decode the stored logo to raw bytes (storage path/URL, http URL, or data URL).
async function logoToBuffer(logoRef: string): Promise<Buffer | null> {
  if (logoRef.startsWith("data:")) {
    const b64 = logoRef.split(",")[1] ?? "";
    return b64 ? Buffer.from(b64, "base64") : null;
  }
  try {
    const blob = await downloadFile(logoRef);
    if (blob) return Buffer.from(await blob.arrayBuffer());
  } catch {/* fall through to direct fetch */}
  if (/^https?:\/\//.test(logoRef)) {
    const safe = await assertPublicHttpUrl(logoRef);
    if (!safe) return null; // SSRF guard: refuse internal/metadata targets
    try {
      // redirect:"manual" so a 3xx can't bounce us to an internal host post-check.
      const r = await fetch(safe, { redirect: "manual" });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        return buf.length <= 5_000_000 ? buf : null; // cap size
      }
    } catch {/* ignore */}
  }
  return null;
}

const logoPaletteCache = new Map<string, { primary: string; secondary: string } | null>();

// Extract a brand palette (primary = vivid dominant colour, secondary = a
// distinct accent) from the logo. Done server-side so there's no canvas/CORS
// taint that previously left the customer pages stuck on the default theme.
export async function ExtractLogoPalette(logoRef: string | null): Promise<{ primary: string; secondary: string } | null> {
  if (!logoRef) return null;
  if (logoPaletteCache.has(logoRef)) return logoPaletteCache.get(logoRef) ?? null;
  let result: { primary: string; secondary: string } | null = null;
  try {
    const buf = await logoToBuffer(logoRef);
    if (buf) {
      const { data, info } = await sharp(buf).resize(48, 48, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
      for (let i = 0; i + ch - 1 < data.length; i += ch) {
        const a = ch >= 4 ? (data[i + 3] ?? 255) : 255;
        if (a < 200) continue;
        const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
        if (r > 238 && g > 238 && b > 238) continue; // skip near-white
        if (r < 18 && g < 18 && b < 18) continue;     // skip near-black
        const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
        const ex = buckets.get(key);
        if (ex) { ex.count++; ex.r += r; ex.g += g; ex.b += b; }
        else buckets.set(key, { count: 1, r, g, b });
      }
      if (buckets.size > 0) {
        const toHex = (c: { r: number; g: number; b: number }) =>
          "#" + [c.r, c.g, c.b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");
        const scored = [...buckets.values()].map((bk) => {
          const avg = { r: bk.r / bk.count, g: bk.g / bk.count, b: bk.b / bk.count };
          const max = Math.max(avg.r, avg.g, avg.b), min = Math.min(avg.r, avg.g, avg.b);
          const sat = max === 0 ? 0 : (max - min) / max;
          return { avg, score: bk.count * (0.35 + sat) };
        }).sort((a, b) => b.score - a.score);
        const primary = scored[0]!.avg;
        const dist = (a: typeof primary, b: typeof primary) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        const sec = scored.slice(1).find((s) => dist(s.avg, primary) > 90);
        const secondary = sec ? sec.avg : { r: primary.r - 46, g: primary.g - 46, b: primary.b - 46 };
        result = { primary: toHex(primary), secondary: toHex(secondary) };
      }
    }
  } catch {/* ignore — caller falls back to theme_color */}
  logoPaletteCache.set(logoRef, result);
  return result;
}

export async function GetPublicBranding(
  restaurantId: string,
): Promise<{ logo_url: string | null; theme_color: string | null; theme_primary: string | null; theme_secondary: string | null; currency: string; payment_methods: PaymentMethodConfig[]; restaurant_name: string; feedback_config: FeedbackConfig; bill_logo_svg: string; queue_show_menu: boolean; timezone: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const rows = await runQuery<{ logo: string | null; theme_color: string | null; currency: string | null; payment_config: unknown; feedback_config: unknown; res_name: string | null; bill_logo_svg: string | null; queue_show_menu: boolean | null; timezone: string | null }>(
    `select logo, theme_color, currency, payment_config, feedback_config, res_name, bill_logo_svg, queue_show_menu, timezone from "Restaurant" where id = $1 limit 1`,
    [context.res_id],
  );
  const palette = await ExtractLogoPalette(rows[0]?.logo ?? null);
  return {
    logo_url: rows[0]?.logo ?? null,
    theme_color: rows[0]?.theme_color ?? null,
    theme_primary: palette?.primary ?? null,
    theme_secondary: palette?.secondary ?? null,
    currency: (rows[0]?.currency && String(rows[0].currency).trim()) || "₹",
    // Only enabled methods are exposed to customers; include the screenshot flag.
    payment_methods: mergePaymentConfig(rows[0]?.payment_config).filter((m) => m.enabled),
    restaurant_name: rows[0]?.res_name ?? context.restaurant_name ?? "",
    feedback_config: mergeFeedbackConfig(rows[0]?.feedback_config),
    // SVG bill logo for the customer-facing digital bill (crisp at any size).
    bill_logo_svg: rows[0]?.bill_logo_svg ?? "",
    queue_show_menu: rows[0]?.queue_show_menu ?? true,
    // Restaurant timezone so the public reserve/queue pages can render + submit
    // wall-clock times in the correct zone.
    timezone: sanitizeTimezone(rows[0]?.timezone),
  };
}

export async function SetBranding(
  restaurantId: string,
  opts: { logo_url?: string | null; theme_color?: string | null; queue_show_menu?: boolean },
): Promise<{ logo_url: string | null; theme_color: string | null; queue_show_menu: boolean }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  const rows = await runQuery<{ logo: string | null; theme_color: string | null; queue_show_menu: boolean | null }>(
    `
      update "Restaurant" set
        logo = coalesce($2, logo),
        theme_color = coalesce($3, theme_color),
        queue_show_menu = coalesce($4, queue_show_menu)
      where id = $1
      returning logo, theme_color, queue_show_menu
    `,
    [context.res_id, opts.logo_url ?? null, opts.theme_color ?? null, typeof opts.queue_show_menu === "boolean" ? opts.queue_show_menu : null],
  );
  return { logo_url: rows[0]?.logo ?? null, theme_color: rows[0]?.theme_color ?? null, queue_show_menu: rows[0]?.queue_show_menu ?? true };
}

// --- Staff notifications (bell) --------------------------------------------
async function ensureNotificationsTable(): Promise<void> {
  await ensureLazyTable("Notifications", async () => {
    await runQuery(`
      create table if not exists "Notifications" (
        id uuid primary key default gen_random_uuid(),
        res_id uuid not null,
        outlet_id uuid,
        type text default 'info',
        title text not null,
        body text,
        meta jsonb default '{}'::jsonb,
        read_at timestamptz,
        created_at timestamptz not null default now()
      )
    `);
    await runQuery(`create index if not exists notifications_res_idx on "Notifications" (res_id, created_at desc)`);
    await applyTenantRls("Notifications");
  });
}

export async function AddNotification(
  restaurantId: string,
  n: { type?: string; title: string; body?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureNotificationsTable();
  await runQuery(
    `insert into "Notifications" (res_id, outlet_id, type, title, body, meta) values ($1, $2, $3, $4, $5, $6)`,
    [context.res_id, context.outlet_id, n.type ?? "info", n.title, n.body ?? null, JSON.stringify(n.meta ?? {})],
  );
}

export async function GetNotifications(
  restaurantId: string,
  limit = 50,
): Promise<{ notifications: Array<Record<string, unknown>>; unread: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureNotificationsTable();
  const rows = await runQuery<Record<string, unknown>>(
    `select id, type, title, body, meta, read_at, created_at
       from "Notifications" where res_id = $1 order by created_at desc limit $2`,
    [context.res_id, limit],
  );
  const countRows = await runQuery<{ n: number }>(
    `select count(*)::int as n from "Notifications" where res_id = $1 and read_at is null`,
    [context.res_id],
  );
  return { notifications: rows, unread: countRows[0]?.n ?? 0 };
}

export async function MarkNotificationRead(restaurantId: string, id: string): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureNotificationsTable();
  await runQuery(`update "Notifications" set read_at = now() where id = $1 and res_id = $2 and read_at is null`, [id, context.res_id]);
}

export async function MarkAllNotificationsRead(restaurantId: string): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureNotificationsTable();
  await runQuery(`update "Notifications" set read_at = now() where res_id = $1 and read_at is null`, [context.res_id]);
}

export async function DeleteNotification(restaurantId: string, id: string): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureNotificationsTable();
  await runQuery(`delete from "Notifications" where id = $1 and res_id = $2`, [id, context.res_id]);
}

export async function ClearNotifications(restaurantId: string): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureNotificationsTable();
  await runQuery(`delete from "Notifications" where res_id = $1`, [context.res_id]);
}

// --- Exception alerts (discount spikes / void streaks / negative feedback) ---
// Dedupe guard: an alert with the same alert_key (stored in Notifications.meta)
// created in the last 24h that is still on the bell (i.e. not deleted/dismissed)
// suppresses a re-ping. Dismissing the notification re-arms the alert.
async function hasRecentAlert(resId: string, alertKey: string): Promise<boolean> {
  const rows = await runQuery<{ n: number }>(
    `select count(*)::int as n from "Notifications"
      where res_id = $1 and meta->>'alert_key' = $2 and created_at >= now() - interval '24 hours'`,
    [resId, alertKey],
  );
  return (rows[0]?.n ?? 0) > 0;
}

// Scan the last 24h for operational exceptions and ping the notification bell
// (type 'warning'). Restaurant-wide (res_id only, all outlets) because the
// thresholds live on the Restaurant row. Checks:
//   (a) discounts  — 24h discount total > alert_discount_pct % of 24h revenue (0 = off)
//   (b) voids      — ≥ alert_void_count orders voided (status 5) in 24h (0 = off)
//   (c) feedback   — ≥ 3 feedbacks rated ≤ 2/5 in 24h (fixed threshold)
// Best-effort by design: callers wrap it in try/catch — it must never fail the
// analytics request or the boot sweep.
export async function RunExceptionChecks(restaurantId: string): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBrandingColumns();
  await ensureNotificationsTable();
  const rid = context.res_id;

  const cfg = (await runQuery<{ alert_discount_pct: number | string | null; alert_void_count: number | string | null }>(
    `select alert_discount_pct, alert_void_count from "Restaurant" where id = $1 limit 1`,
    [rid],
  ))[0];
  const discountPct = Math.max(0, Number(cfg?.alert_discount_pct ?? 10) || 0);
  const voidThreshold = Math.max(0, Math.round(Number(cfg?.alert_void_count ?? 5) || 0));

  // (a) Discount spike: 24h discount value vs 24h revenue.
  if (discountPct > 0) {
    const agg = (await runQuery<{ discounts: number; revenue: number }>(
      `select coalesce(sum(discount_value),0)::float as discounts, coalesce(sum(total_amt),0)::float as revenue
         from "Bills" where res_id = $1 and status <> 0 and created_at >= now() - interval '24 hours'`,
      [rid],
    ))[0] ?? { discounts: 0, revenue: 0 };
    if (agg.revenue > 0 && agg.discounts > 0) {
      const pct = (agg.discounts / agg.revenue) * 100;
      if (pct > discountPct && !(await hasRecentAlert(rid, "discount_spike"))) {
        await AddNotification(restaurantId, {
          type: "warning",
          title: `⚠ Discount spike: ${round2(pct)}% of 24h revenue`,
          body: `${round2(agg.discounts)} discounted against ${round2(agg.revenue)} revenue in the last 24h (alert threshold ${discountPct}%).`,
          meta: { alert_key: "discount_spike", discount_total: round2(agg.discounts), revenue: round2(agg.revenue), pct: round2(pct), threshold_pct: discountPct },
        });
      }
    }
  }

  // (b) Void streak. Orders have no voided_at timestamp, so "voided in 24h"
  // means orders CREATED in the window that are now status 5 (covers both admin
  // voids and release-without-payment voids).
  if (voidThreshold > 0) {
    const voided = (await runQuery<{ n: number }>(
      `select count(*)::int as n from "Orders"
        where res_id = $1 and status::text = '5' and created_at >= now() - interval '24 hours'`,
      [rid],
    ))[0]?.n ?? 0;
    if (voided >= voidThreshold && !(await hasRecentAlert(rid, "void_streak"))) {
      await AddNotification(restaurantId, {
        type: "warning",
        title: `⚠ Void streak: ${voided} orders voided in 24h`,
        body: `At or above the alert threshold of ${voidThreshold} — review recent voids in the audit log.`,
        meta: { alert_key: "void_streak", voided, threshold: voidThreshold },
      });
    }
  }

  // (c) Negative-feedback streak (fixed: 3+ ratings of ≤2/5 in 24h).
  const negatives = (await runQuery<{ n: number }>(
    `select count(*)::int as n from "Feedback_entries"
      where res_id = $1 and overall_rating <= 2 and submitted_at >= now() - interval '24 hours'`,
    [rid],
  ))[0]?.n ?? 0;
  if (negatives >= 3 && !(await hasRecentAlert(rid, "negative_feedback_streak"))) {
    await AddNotification(restaurantId, {
      type: "warning",
      title: `⚠ Negative feedback streak: ${negatives} low ratings in 24h`,
      body: `${negatives} feedbacks rated 2/5 or below in the last 24 hours — check the Feedback page for recovery follow-ups.`,
      meta: { alert_key: "negative_feedback_streak", negatives },
    });
  }
}

// All tenant ids, for boot-time sweeps. "Restaurant" is deliberately readable
// without a tenant context (RLS fail-open metadata table for the slug lookup),
// so this works on the plain pool outside any request.
export async function ListRestaurantIds(): Promise<string[]> {
  const rows = await runQuery<{ id: string }>(`select id from "Restaurant"`);
  return rows.map((r) => r.id);
}

//Important: Need to fix this function according to the new RestaurantProfileRecord class
export async function UpdateRestaurantProfile(
  restaurantId: string,
  // Only the editable fields are needed. Accept a partial so callers that pass
  // either the short {name…}->normalized shape or a full RestaurantProfileRecord
  // both work, and a missing field never crashes the .trim() calls below.
  profile: Partial<Pick<RestaurantProfileRecord, "restaurant_name" | "outlet_add" | "outlet_phone" | "outlet_hours" | "email">>,
  employeeId?: string,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);

  const name = String(profile.restaurant_name ?? "").trim();
  const address = String(profile.outlet_add ?? "").trim();
  const phone = String(profile.outlet_phone ?? "").trim();
  const hours = String(profile.outlet_hours ?? "").trim();
  const email = String(profile.email ?? "").trim();

  await withTransaction(async (client) => {
    await runQuery(
      `
        update "Restaurant"
        set
          res_name = $2,
          main_office_add = $3
        where id = $1
      `,
      [context.res_id, name, address || null],
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
        name,
        address,
        normalizePhone(phone) || null,
        hours || null,
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
          email || null,
          normalizePhone(phone) || null,
          address || null,
        ],
        client,
      );
    }
  });
}

export async function GetOutletDefaultTax(restaurantId: string): Promise<Record<string, number> | null> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    default_tax: any;
  }>(
    `
      select default_tax
      from "Outlets"
      where id = $1 and res_id = $2
      limit 1
    `,
    [context.outlet_id, context.res_id],
  );

  const row = rows[0];
  if (!row) return null;
  return row.default_tax ?? null;
}

export async function GetRestaurantLogo(restaurantId: string): Promise<string | null> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    logo_url: string | null;
  }>(
    `
      select r.logo as logo_url
      from "Restaurant" r
      where r.id = $1
      limit 1
    `,
    [context.res_id],
  );
  const row = rows[0];
  if (!row || !row.logo_url) return null;
  const logo_base64 = await downloadFile(row.logo_url)
    .then(async (blob) => {
      if (!blob) return null;
      const arrayBuffer = await blob.arrayBuffer();
      return Buffer.from(arrayBuffer).toString("base64");
    })
    .catch(() => null);
  return logo_base64;
}

export async function GetBillByOrder(restaurantId: string, orderId: string) {
  const context = await requireRestaurantContext(restaurantId);
  await ensureBillWorkflowColumns();
  const orderRows = await runQuery<{ table_id: string | null }>(
    `
      select table_id
      from "Orders"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [orderId, context.res_id, context.outlet_id],
  );
  const tableId = orderRows[0]?.table_id ?? null;
  const rows = await runQuery<{
    id: string;
    status: number;
    total_amt: number;
    emp_id: string | null;
    tax_breakdown: any;
    payment_method: string | null;
    payment_proof_screenshot_url: string | null;
    waiter_confirmed_at: Date | null;
    waiter_confirmed_by_username: string | null;
    admin_approved_at: Date | null;
    admin_approved_by_username: string | null;
    closed_at: Date | null;
    closed_by_username: string | null;
    bill_no: number;
  }>(
    `
      select
        id,
        status,
        total_amt,
        emp_id,
        tax_breakdown,
        payment_method,
        payment_proof_screenshot_url,
        waiter_confirmed_at,
        waiter_confirmed_by_username,
        admin_approved_at,
        admin_approved_by_username,
        closed_at,
        closed_by_username,
        bill_no
      from "Bills"
      where (
        order_id = $1
        or table_id = $4
      ) and res_id = $2 and outlet_id = $3 and closed_at is null
      order by created_at desc
      limit 1
    `,
    [orderId, context.res_id, context.outlet_id, tableId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    ...row,
    payment_method: normalizePaymentMethod(row.payment_method),
    payment_proof_screenshot_url:
      typeof row.payment_proof_screenshot_url === "string" ? row.payment_proof_screenshot_url : null,
    waiter_confirmed_at: row.waiter_confirmed_at ? new Date(row.waiter_confirmed_at).toISOString() : null,
    admin_approved_at: row.admin_approved_at ? new Date(row.admin_approved_at).toISOString() : null,
    closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    bill_no: row.bill_no,
  };
}

export async function GetRestaurantLogoRaw(restaurantId: string): Promise<Buffer | null> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    logo: Buffer | null;
  }>(
    `
      select r.logo
      from "Restaurant" r
      where r.id = $1
      limit 1
    `,
    [context.res_id],
  );
  const row = rows[0];
  if (!row || !row.logo) return null;
  return row.logo as Buffer;
}

export async function UpdateOutletDefaultTax(restaurantId: string, defaultTax: Record<string, number> | null): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await runQuery(
    `
      update "Outlets"
      set default_tax = $2
      where id = $1 and res_id = $3
    `,
    [context.outlet_id, JSON.stringify(defaultTax), context.res_id],
  );
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

export type ActionRecord = {
  id: string;
  action_name: string;
  action_desc?: string | null;
  group?: string | null;
};

export class ValidationError extends Error {
  public invalidActionIds: string[];
  constructor(message: string, invalidActionIds: string[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.invalidActionIds = invalidActionIds;
  }
}

export async function GetActions(): Promise<ActionRecord[]> {
  // Actions are global (not scoped per restaurant). Return id, name, desc and group.
  const rows = await runQuery<{
    id: string;
    action_name: string;
    action_desc: string | null;
    group: string | null;
  }>(
    `
      select id, action_name, action_desc, "group"
      from "Actions"
      order by coalesce("group", 'Test'), action_name
    `,
    [],
  );

  return rows.map((r) => ({ id: r.id, action_name: r.action_name, action_desc: r.action_desc ?? null, group: r.group ?? null }));
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
    new Set(actions_performable.map((entry) => String(entry).trim()).filter(Boolean)),
  );
  // Validate that provided action IDs exist in the Actions table.
  if (normalizedActions.length > 0) {
    const found = await runQuery<{ id: string }>(
      `
        select id
        from "Actions"
        where id::text = any($1::text[])
      `,
      [normalizedActions],
    );
    const foundIds = new Set(found.map((r) => r.id));
    const invalid = normalizedActions.filter((id) => !foundIds.has(id));
    if (invalid.length > 0) {
      throw new ValidationError(`Invalid action ids: ${invalid.join(",")}`, invalid);
    }
  }

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
        and l.emp_id = $3
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
  const raw = String(roleName ?? "").trim();
  if (!raw) {
    throw new Error("Role is required");
  }

  await withTransaction(async (client) => {
    // If the incoming value is a UUID, treat it as a custom role id.
    let entryToAdd: string;
    if (isUuid(raw)) {
      const roleRows = await runQuery<{ id: string; role_name: string }>(
        `select id, role_name from "Roles" where id = $1 and res_id = $2 limit 1`,
        [raw, context.res_id],
        client,
      );
      if (!roleRows[0]) throw new Error("Role does not exist");
      entryToAdd = roleRows[0].id; // store id for custom role
    } else {
      const normalizedRole = raw.toLowerCase();
      if (["admin", "employee", "valet", "waiter", "cashier", "captain", "manager"].includes(normalizedRole)) {
        entryToAdd = normalizedRole; // core role name
      } else {
        // lookup custom role by name and store its id
        const roleRows = await runQuery<{ id: string }>(
          `select id from "Roles" where res_id = $1 and lower(role_name) = lower($2) limit 1`,
          [context.res_id, normalizedRole],
          client,
        );
        if (!roleRows[0]) {
          throw new Error("Role does not exist");
        }
        entryToAdd = roleRows[0].id;
      }
    }

    const employee = await getEmployeeRoleRow(context, employeeId, client);
    if (!employee) {
      throw new Error("Employee not found");
    }

    const roles = parseEmployeeRoles(employee.emp_roles);
    const nextAll = Array.from(new Set([...roles.all, entryToAdd]));
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
  const raw = String(roleName ?? "").trim();
  if (!raw) throw new Error("Role is required");

  await withTransaction(async (client) => {
    const employee = await getEmployeeRoleRow(context, employeeId, client);
    if (!employee) {
      throw new Error("Employee not found");
    }

    const roles = parseEmployeeRoles(employee.emp_roles);
    let nextAll: string[];
    if (isUuid(raw)) {
      // remove by id
      nextAll = roles.all.filter((entry) => entry !== raw);
    } else {
      const normalizedRole = raw.toLowerCase();
      if (["admin", "employee", "valet", "waiter"].includes(normalizedRole)) {
        nextAll = roles.all.filter((entry) => entry !== normalizedRole);
      } else {
        // custom role name: try to resolve to id and remove id; also remove legacy name if present
        const roleRows = await runQuery<{ id: string }>(
          `select id from "Roles" where res_id = $1 and lower(role_name) = lower($2) limit 1`,
          [context.res_id, normalizedRole],
          client,
        );
        const roleId = roleRows[0]?.id ?? null;
        nextAll = roles.all.filter((entry) => entry !== normalizedRole && entry !== roleId);
      }
    }

    const nextPrimary = roles.primary === raw || roles.primary === raw.toLowerCase()
      ? (nextAll.find((r) => ["admin", "employee", "valet", "waiter"].includes(r)) ?? "employee")
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
      // Employee entries might contain role ids (custom roles) or role names (core roles or legacy). Remove both where applicable.
      if (!parsed.all.includes(role.id) && !parsed.all.includes(role.role_name)) {
        continue;
      }

      const all = parsed.all.filter((entry) => entry !== role.role_name && entry !== role.id);
      const primary = parsed.primary === role.role_name || parsed.primary === role.id
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
  const normalizedEmployeeId = employeeId.trim();
  if (!normalizedEmployeeId) return null;

  // Accept either employee username (case-insensitive) or employee UUID (emp_id)
  const normalizedEmployeeLower = normalizedEmployeeId.toLowerCase();

  const rows = await runQuery<{ role_primary: string | null }>(
    `
      select e.emp_roles->>'primary' as role_primary
      from "Login" l
      join "Employees" e
        on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      where
        l.res_id = $1
        and l.outlet_id = $2
        and (
          lower(l.emp_username) = $3
          or l.emp_id = $4
        )
      limit 1
    `,
    [context.res_id, context.outlet_id, normalizedEmployeeLower, normalizedEmployeeId],
  );

  const row = rows[0];
  return row ? toRole(row.role_primary) : null;
}

let feedbackColsEnsured = false;
async function ensureFeedbackColumns(client?: PoolClient): Promise<void> {
  if (feedbackColsEnsured && !client) return;
  // Service-recovery: low-rating feedback becomes an internal ticket staff resolve.
  await runQuery(`alter table "Feedback_entries" add column if not exists recovery_status text`, [], client);
  await runQuery(`alter table "Feedback_entries" add column if not exists recovery_resolved_at timestamptz`, [], client);
  await runQuery(`alter table "Feedback_entries" add column if not exists recovery_resolved_by text`, [], client);
  await runQuery(`alter table "Feedback_entries" add column if not exists recovery_note text`, [], client);
  // NPS: optional 0–10 recommend score asked on the feedback form.
  await runQuery(`alter table "Feedback_entries" add column if not exists nps integer`, [], client);
  if (!client) feedbackColsEnsured = true;
}

export async function AddFeedbackEntry(
  restaurantId: string,
  employeeId: string,
  entry: FeedbackSubmissionInput,
): Promise<{ id: string; submitted_at: Date; recovery: boolean; overall_rating: number; waiter_name: string | null }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureFeedbackColumns();
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

  // Low-rating feedback opens a service-recovery ticket for staff to follow up.
  const needsRecovery = overallRating <= 3 || ratings.some((r) => r.rating <= 2);

  // Attribute to the waiter when one was resolved from the link; otherwise store
  // NULL (unattributed feedback still saves — see migration 013).
  const empUuid = employeeId && isUuid(employeeId) ? employeeId : null;

  const id = randomUUID();
  const visitDate =
    entry.visit_date instanceof Date && !Number.isNaN(entry.visit_date.getTime())
      ? entry.visit_date
      : submittedAt;

  // Optional 0–10 NPS answer; anything non-numeric stores NULL (question skipped).
  const nps =
    typeof entry.nps === "number" && Number.isFinite(entry.nps)
      ? Math.max(0, Math.min(10, Math.round(entry.nps)))
      : null;

  await runQuery(
    `
      insert into "Feedback_entries"
        (id, submitted_at, res_id, outlet_id, emp_id, cust_name, comments, overall_rating, cattegory_ratings, visit_date, source, recovery_status, nps)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10, $11, $12, $13)
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
      needsRecovery ? "open" : null,
      nps,
    ],
  );

  // Resolve the waiter's display name (best-effort) so callers can attribute
  // low-score alerts without another round trip.
  let waiterName: string | null = null;
  if (empUuid) {
    try {
      const empRows = await runQuery<{ name: string | null }>(
        `select trim(concat("emp_Fname", ' ', coalesce("emp_Lname", ''))) as name
           from "Employees" where id = $1 and res_id = $2 limit 1`,
        [empUuid, context.res_id],
      );
      waiterName = empRows[0]?.name?.trim() || null;
    } catch {
      waiterName = null;
    }
  }

  return { id, submitted_at: submittedAt, recovery: needsRecovery, overall_rating: overallRating, waiter_name: waiterName };
}

export async function GetFeedbackEntries(
  restaurantId: string,
  limit = 100,
): Promise<any[]> {
  const context = await requireRestaurantContext(restaurantId);
  const safeLimit = Math.max(1, Math.min(limit, 5000));

  const rows = await runQuery<{
    id: string;
    res_id: string;
    emp_id: string;
    cust_name: string | null;
    comments: string | null;
    overall_rating: number;
    category_ratings: unknown;
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
        cattegory_ratings as category_ratings,
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
    category_ratings: Array.isArray(row.category_ratings)
      ? (row.category_ratings as FeedbackCategoryRatingInput[])
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

export type RecoveryTicket = {
  id: string;
  customer_name: string | null;
  overall_rating: number;
  comments: string | null;
  category_ratings: Array<{ key: string; label: string; rating: number; follow_up_answer: string | null }>;
  submitted_at: string;
  recovery_status: string;
  recovery_resolved_at: string | null;
  recovery_resolved_by: string | null;
  recovery_note: string | null;
};

// Service-recovery tickets: low-rating feedback that needs staff follow-up. By
// default returns OPEN tickets only.
export async function GetRecoveryTickets(restaurantId: string, includeResolved = false): Promise<RecoveryTicket[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureFeedbackColumns();
  const rows = await runQuery<{
    id: string;
    cust_name: string | null;
    comments: string | null;
    overall_rating: number | string | null;
    category_ratings: unknown;
    submitted_at: Date;
    recovery_status: string | null;
    recovery_resolved_at: Date | null;
    recovery_resolved_by: string | null;
    recovery_note: string | null;
  }>(
    `select id, cust_name, comments, overall_rating, cattegory_ratings as category_ratings, submitted_at,
            recovery_status, recovery_resolved_at, recovery_resolved_by, recovery_note
       from "Feedback_entries"
       where res_id = $1 and outlet_id = $2
         and recovery_status is not null
         ${includeResolved ? "" : "and recovery_status = 'open'"}
       order by submitted_at desc
       limit 300`,
    [context.res_id, context.outlet_id],
  );
  return rows.map((r) => {
    const cats = Array.isArray(r.category_ratings) ? (r.category_ratings as any[]) : [];
    return {
      id: r.id,
      customer_name: r.cust_name,
      overall_rating: parseNumeric(r.overall_rating),
      comments: r.comments,
      // Surface the low-rated categories + the reason the guest gave.
      category_ratings: cats
        .map((c) => ({
          key: String(c?.key ?? ""),
          label: String(c?.label ?? ""),
          rating: parseNumeric(c?.rating),
          follow_up_answer: typeof c?.follow_up_answer === "string" ? c.follow_up_answer : null,
        }))
        .filter((c) => c.rating > 0 && c.rating <= 3),
      submitted_at: new Date(r.submitted_at).toISOString(),
      recovery_status: r.recovery_status ?? "open",
      recovery_resolved_at: r.recovery_resolved_at ? new Date(r.recovery_resolved_at).toISOString() : null,
      recovery_resolved_by: r.recovery_resolved_by,
      recovery_note: r.recovery_note,
    };
  });
}

export async function ResolveRecoveryTicket(
  restaurantId: string,
  id: string,
  note?: string,
  byUsername?: string,
): Promise<{ success: true }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureFeedbackColumns();
  await runQuery(
    `update "Feedback_entries"
       set recovery_status = 'resolved', recovery_resolved_at = now(), recovery_resolved_by = $4, recovery_note = $5
       where id = $1 and res_id = $2 and outlet_id = $3 and recovery_status is not null`,
    [id, context.res_id, context.outlet_id, byUsername ?? null, note?.trim() || null],
  );
  return { success: true };
}

// --- Attendance / working hours ---------------------------------------------
async function ensureAttendanceTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("Attendance", async () => {
    await runQuery(
      `create table if not exists "Attendance" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         emp_id uuid not null,
         clock_in timestamptz not null default now(),
         clock_out timestamptz,
         created_at timestamptz not null default now()
       )`,
    );
    // Approval workflow: new clock-ins are 'pending' until an admin approves.
    // status NULL = legacy rows from before the workflow — treated as approved.
    // clock_in is ALWAYS the moment the employee clocked in; approval only
    // stamps approved_at/approved_by and never rewrites the shift times.
    await runQuery(`alter table "Attendance" add column if not exists status text`);
    await runQuery(`alter table "Attendance" add column if not exists approved_by text`);
    await runQuery(`alter table "Attendance" add column if not exists approved_at timestamptz`);
    // Dedicated audit action so approvals show up with an honest name in the log.
    await runQuery(
      `insert into "Actions" (id, action_name, action_desc)
       values ('e7a41c3b-5a20-4f6e-9d38-6c2b9a51f0aa', 'Approve Attendance', 'Review (approve/reject) employee clock-ins'),
              ('b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21', 'Attendance Clock Event', 'Employee clocked in or out')
       on conflict (id) do nothing`,
    ).catch(() => {/* seeded by migrations under least-privilege runtimes */});
    await applyTenantRls("Attendance");
  });
}

// status filter for anything that COUNTS attendance time: legacy NULL or approved.
const ATTENDANCE_COUNTED = `(status is null or status = 'approved')`;

async function findOpenShift(context: RestaurantContext, employeeId: string): Promise<{ id: string; clock_in: Date } | null> {
  const rows = await runQuery<{ id: string; clock_in: Date }>(
    `select id, clock_in from "Attendance"
       where res_id = $1 and outlet_id = $2 and emp_id = $3 and clock_out is null
       order by clock_in desc limit 1`,
    [context.res_id, context.outlet_id, employeeId],
  );
  return rows[0] ?? null;
}

export async function ClockIn(restaurantId: string, employeeId: string): Promise<{ clocked_in: true; since: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureAttendanceTable();
  if (!isUuid(employeeId)) throw new Error("Invalid employee");
  const open = await findOpenShift(context, employeeId);
  if (open) return { clocked_in: true, since: new Date(open.clock_in).toISOString() };
  // clock_in defaults to now() — the REAL clock-in moment; approval never moves it.
  const rows = await runQuery<{ clock_in: Date }>(
    `insert into "Attendance" (id, res_id, outlet_id, emp_id, status) values ($1, $2, $3, $4, 'pending') returning clock_in`,
    [randomUUID(), context.res_id, context.outlet_id, employeeId],
  );
  return { clocked_in: true, since: new Date(rows[0]?.clock_in ?? new Date()).toISOString() };
}

// Admin approves (or rejects) a pending clock-in. Approval stamps who/when but
// leaves clock_in exactly as recorded at the moment the employee clocked in.
export async function SetAttendanceApproval(
  restaurantId: string,
  attendanceId: string,
  approve: boolean,
  approvedBy?: string,
): Promise<{ id: string; emp_id: string; status: string; clock_in: string }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureAttendanceTable();
  const rows = await runQuery<{ id: string; emp_id: string; status: string; clock_in: Date }>(
    `update "Attendance"
        set status = $4, approved_by = $5, approved_at = now()
      where id = $1 and res_id = $2 and outlet_id = $3 and status = 'pending'
      returning id, emp_id, status, clock_in`,
    [attendanceId, context.res_id, context.outlet_id, approve ? "approved" : "rejected", approvedBy || null],
  );
  if (!rows[0]) throw new Error("Clock-in not found or already reviewed");
  return { ...rows[0], clock_in: new Date(rows[0].clock_in).toISOString() };
}

export async function ClockOut(restaurantId: string, employeeId: string): Promise<{ clocked_in: false; minutes: number }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureAttendanceTable();
  const open = await findOpenShift(context, employeeId);
  if (!open) throw new Error("You are not clocked in");
  const rows = await runQuery<{ clock_in: Date; clock_out: Date }>(
    `update "Attendance" set clock_out = now() where id = $1 and res_id = $2 and outlet_id = $3 returning clock_in, clock_out`,
    [open.id, context.res_id, context.outlet_id],
  );
  const r = rows[0];
  const minutes = r ? Math.max(0, Math.round((new Date(r.clock_out).getTime() - new Date(r.clock_in).getTime()) / 60000)) : 0;
  return { clocked_in: false, minutes };
}

export async function GetMyAttendance(restaurantId: string, employeeId: string): Promise<{ clocked_in: boolean; since: string | null; today_minutes: number; pending_approval: boolean }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureAttendanceTable();
  if (!isUuid(employeeId)) return { clocked_in: false, since: null, today_minutes: 0, pending_approval: false };
  const open = await findOpenShift(context, employeeId);
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const rows = await runQuery<{ clock_in: Date; clock_out: Date | null; status: string | null }>(
    `select clock_in, clock_out, status from "Attendance"
       where res_id = $1 and outlet_id = $2 and emp_id = $3 and clock_in >= $4`,
    [context.res_id, context.outlet_id, employeeId, startOfDay],
  );
  let today = 0;
  let pendingApproval = false;
  for (const r of rows) {
    if (r.status === "rejected") continue; // rejected shifts never count
    if (r.status === "pending") pendingApproval = true;
    const end = r.clock_out ? new Date(r.clock_out).getTime() : Date.now();
    today += Math.max(0, (end - new Date(r.clock_in).getTime()) / 60000);
  }
  return { clocked_in: !!open, since: open ? new Date(open.clock_in).toISOString() : null, today_minutes: Math.round(today), pending_approval: pendingApproval };
}

export type AttendanceSummaryRow = { emp_id: string; name: string; minutes: number; shifts: number; open: boolean };
export type PendingClockIn = { id: string; emp_id: string; name: string; clock_in: string; clock_out: string | null };
export async function GetAttendanceSummary(
  restaurantId: string,
  fromIso?: string,
  toIso?: string,
): Promise<{ from: string; to: string; rows: AttendanceSummaryRow[]; pending: PendingClockIn[] }> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureAttendanceTable();
  const range = normalizeReportRange(fromIso, toIso);
  const rows = await runQuery<{ id: string; emp_id: string; clock_in: Date; clock_out: Date | null; status: string | null; fname: string | null; lname: string | null }>(
    `select a.id, a.emp_id, a.clock_in, a.clock_out, a.status, e."emp_Fname" as fname, e."emp_Lname" as lname
       from "Attendance" a
       left join "Employees" e on e.id = a.emp_id and e.res_id = a.res_id
       where a.res_id = $1 and a.outlet_id = $2 and a.clock_in >= $3 and a.clock_in < $4
       order by a.clock_in desc`,
    [context.res_id, context.outlet_id, range.fromIso, range.toIso],
  );
  const byEmp = new Map<string, AttendanceSummaryRow>();
  const pending: PendingClockIn[] = [];
  for (const r of rows) {
    const name = [r.fname, r.lname].filter(Boolean).join(" ").trim() || "Employee";
    if (r.status === "pending") {
      pending.push({ id: r.id, emp_id: r.emp_id, name, clock_in: new Date(r.clock_in).toISOString(), clock_out: r.clock_out ? new Date(r.clock_out).toISOString() : null });
    }
    // Rejected shifts never count; pending shifts count only once approved.
    if (r.status === "pending" || r.status === "rejected") continue;
    const end = r.clock_out ? new Date(r.clock_out).getTime() : Date.now();
    const mins = Math.max(0, Math.round((end - new Date(r.clock_in).getTime()) / 60000));
    const e = byEmp.get(r.emp_id) ?? { emp_id: r.emp_id, name, minutes: 0, shifts: 0, open: false };
    e.minutes += mins;
    e.shifts += 1;
    if (!r.clock_out) e.open = true;
    e.name = name;
    byEmp.set(r.emp_id, e);
  }
  return { from: range.fromDate, to: range.toDate, rows: [...byEmp.values()].sort((a, b) => b.minutes - a.minutes), pending };
}

// Restaurant-wide employee count (ALL outlets) for plan-limit enforcement.
// GetRestaurantUsers is intentionally outlet-scoped for the management UI, so do
// not reuse it for the limit check.
export async function GetRestaurantEmployeeCount(restaurantId: string): Promise<number> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ n: number | string }>(
    `select count(*)::int as n from "Employees" where res_id = $1`,
    [context.res_id],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function GetRestaurantUsers(
  restaurantId: string,
): Promise<RestaurantUser[]> {
  const context = await requireRestaurantContext(restaurantId);
  const og = isAllOutlets() ? "true" : "false";

  const rows = await runQuery<{
    employee_id: string;
    row_outlet_id: string | null;
    emp_username: string;
    fname: string;
    lname: string;
    role_primary: string | null;
    emp_roles: unknown;
  }>(
    `
      select
        e.id as employee_id,
        l.outlet_id as row_outlet_id,
        l.emp_username,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname,
        e.emp_roles->>'primary' as role_primary,
        e.emp_roles as emp_roles
      from "Login" l
      join "Employees" e
        on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      where l.res_id = $1 and (${og} or l.outlet_id = $2)
      order by l.created_at asc
    `,
    [context.res_id, context.outlet_id],
  );

  const mapped = rows.map((row) => ({
    // include the Employees.id (UUID) as `id` and `employee_id` so callers can match by UUID
    id: row.employee_id,
    res_id: context.res_id,
    // In all-outlets mode rows span every outlet, so report each login's REAL
    // outlet (falling back to the bound outlet) instead of the default.
    outlet_id: row.row_outlet_id ?? context.outlet_id,
    employee_id: row.employee_id,
    employee_Username: row.emp_username,
    emp_Fname: String(row.fname ?? row.emp_username ?? "").trim(),
    emp_Lname: row.lname ?? null,
    password: "", // never expose the stored password hash to clients
    role: toRole(row.role_primary),
    role_all: parseEmployeeRoles(row.emp_roles).all,
    is_superadmin: false,
  }));

  // The superadmin is the restaurant owner: the earliest-created admin login
  // (rows are already ordered by created_at asc). Falls back to the very first
  // user if, for some reason, no one currently holds the admin role.
  const owner = mapped.find((u) => u.role === "admin" || (u.role_all ?? []).includes("admin")) ?? mapped[0];
  if (owner) owner.is_superadmin = true;

  return mapped;
}

// The owner employee id (superadmin) for a restaurant — the earliest-created
// admin. Used to protect the owner from removal / password reset by others.
export async function GetSuperadminEmployeeId(restaurantId: string): Promise<string | null> {
  const users = await GetRestaurantUsers(restaurantId);
  return users.find((u) => u.is_superadmin)?.employee_id ?? null;
}

// Admin sets/resets a user's login password directly (rehashes + stores it).
// Also resolves any pending forgot-password requests for that user.
export async function SetUserPassword(
  restaurantId: string,
  employeeId: string,
  newPassword: string,
): Promise<boolean> {
  const pass = String(newPassword ?? "").trim();
  if (pass.length < 4) throw new Error("Password must be at least 4 characters");
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const hash = await hashPassword(pass);
    const rows = await runQuery<{ emp_id: string }>(
      `update "Login" set emp_pass = $4
         where res_id = $1 and outlet_id = $2 and emp_id = $3
         returning emp_id`,
      [context.res_id, context.outlet_id, employeeId, hash],
      client,
    );
    if (!rows[0]) throw new Error("User not found");
    await ensurePasswordResetTable(client);
    await runQuery(
      `update "PasswordResetRequests" set status = 'resolved', resolved_at = now()
         where res_id = $1 and outlet_id = $2 and emp_id = $3 and status = 'pending'`,
      [context.res_id, context.outlet_id, employeeId],
      client,
    );
    return true;
  });
}

// --- Forgot-password requests -----------------------------------------------
async function ensurePasswordResetTable(_client?: PoolClient): Promise<void> {
  await ensureLazyTable("PasswordResetRequests", async () => {
    await runQuery(
      `create table if not exists "PasswordResetRequests" (
         id uuid primary key,
         res_id uuid not null,
         outlet_id uuid,
         emp_id uuid not null,
         username text not null,
         status text not null default 'pending',
         created_at timestamptz not null default now(),
         resolved_at timestamptz
       )`,
    );
    await applyTenantRls("PasswordResetRequests");
  });
}

// A staff member who can't log in requests a reset (identified by username). The
// restaurant slug resolves the tenant. Always succeeds quietly when the username
// isn't found, so this can't be used to enumerate accounts.
export async function AddPasswordResetRequest(
  restaurantSlug: string,
  username: string,
): Promise<{ success: true }> {
  const uname = String(username ?? "").trim();
  if (!uname) throw new Error("Username is required");
  const context = await requireRestaurantContext(restaurantSlug);
  return withTenant(
    { res_id: context.res_id, outlet_id: context.outlet_id, employeeId: "", role: "" },
    async () => {
      await ensurePasswordResetTable();
      const rows = await runQuery<{ emp_id: string }>(
        `select emp_id from "Login" where res_id = $1 and lower(emp_username) = lower($2) limit 1`,
        [context.res_id, uname],
      );
      const empId = rows[0]?.emp_id;
      if (empId) {
        // Collapse duplicate pending requests for the same user.
        const existing = await runQuery<{ id: string }>(
          `select id from "PasswordResetRequests" where res_id = $1 and emp_id = $2 and status = 'pending' limit 1`,
          [context.res_id, empId],
        );
        if (!existing[0]) {
          await runQuery(
            `insert into "PasswordResetRequests" (id, res_id, outlet_id, emp_id, username)
               values ($1, $2, $3, $4, $5)`,
            [randomUUID(), context.res_id, context.outlet_id, empId, uname],
          );
        }
      }
      return { success: true };
    },
  );
}

export async function GetPasswordResetRequests(
  restaurantId: string,
): Promise<Array<{ id: string; employee_id: string; username: string; name: string; created_at: string }>> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePasswordResetTable();
  const rows = await runQuery<{ id: string; emp_id: string; username: string; fname: string | null; lname: string | null; created_at: Date }>(
    `select r.id, r.emp_id, r.username, e."emp_Fname" as fname, e."emp_Lname" as lname, r.created_at
       from "PasswordResetRequests" r
       left join "Employees" e on e.id = r.emp_id and e.res_id = r.res_id
      where r.res_id = $1 and r.status = 'pending'
      order by r.created_at asc`,
    [context.res_id],
  );
  return rows.map((r) => ({
    id: r.id,
    employee_id: r.emp_id,
    username: r.username,
    name: `${String(r.fname ?? "").trim()} ${String(r.lname ?? "").trim()}`.trim() || r.username,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export async function ResolvePasswordResetRequest(restaurantId: string, requestId: string): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  await ensurePasswordResetTable();
  await runQuery(
    `update "PasswordResetRequests" set status = 'dismissed', resolved_at = now()
       where id = $1 and res_id = $2 and status = 'pending'`,
    [requestId, context.res_id],
  );
  return true;
}

export async function DeleteRestaurantUser(
  restaurantId: string,
  employeeId: string,
  outletId: string
): Promise<boolean> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client, outletId);

    // The superadmin (owner = earliest-created admin) cannot be removed by anyone.
    const ownerRows = await runQuery<{ emp_id: string }>(
      `select l.emp_id from "Login" l
         join "Employees" e on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
        where l.res_id = $1 and l.outlet_id = $2
          and (e.emp_roles->>'primary' = 'admin' or e.emp_roles::text ilike '%"admin"%')
        order by l.created_at asc limit 1`,
      [context.res_id, context.outlet_id],
      client,
    );
    if (ownerRows[0]?.emp_id === employeeId) {
      throw new Error("The restaurant owner (superadmin) cannot be removed.");
    }

    // Every employee created via AddRestaurantUser also gets a "Login" row whose
    // emp_id FK references Employees(id). Leaving it behind both blocks the delete
    // (FK violation -> the "cannot remove employees" bug) and would let a removed
    // user keep signing in, so remove credentials first.
    await runQuery(
      `delete from "Login" where res_id = $1 and outlet_id = $2 and emp_id = $3`,
      [context.res_id, context.outlet_id, employeeId],
      client,
    );

    // Bills are financial records — keep them but drop the waiter link so the FK
    // doesn't block removal of an employee who has worked tables.
    await runQuery(
      `update "Bills" set emp_id = null where res_id = $1 and outlet_id = $2 and emp_id = $3`,
      [context.res_id, context.outlet_id, employeeId],
      client,
    );

    // Attendance rows belong to the employee; clear them out.
    await ensureAttendanceTable(client);
    await runQuery(
      `delete from "Attendance" where res_id = $1 and outlet_id = $2 and emp_id = $3`,
      [context.res_id, context.outlet_id, employeeId],
      client,
    );

    // Finally remove the employee record.
    await runQuery(
      `delete from "Employees" where res_id = $1 and outlet_id = $2 and id = $3`,
      [context.res_id, context.outlet_id, employeeId],
      client,
    );

    return true;
  });
}

export type EmployeeLoginResult = {
  employeeId: string; // uuid of Employees.id
  employeeUsername: string; // login username
  role: "admin" | "employee" | "valet" | "waiter" | "cashier" | "captain" | "manager";
  role_all: string[];
  restaurantUsername: string;
  restaurantName: string;
  res_id: string;
  outlet_id: string;
  emp_Fname: string;
  emp_Lname: string | null;
  actions_set: Set<string>;
  action_names: string[];
};

// Effective lifecycle status of a restaurant ('active' | 'suspended' |
// 'expired'), via the platform SECURITY DEFINER function. Returns 'active' when
// the platform control plane isn't deployed (function/schema missing), so this
// check is purely additive.
export async function GetRestaurantAccountStatus(resId: string): Promise<string> {
  try {
    const rows = await runQuery<{ status: string | null }>(
      `select platform.restaurant_status($1::uuid) as status`,
      [resId],
    );
    return rows[0]?.status ?? "active";
  } catch (err: any) {
    if (err?.code === "42883" || err?.code === "3F000") {
      return "active"; // undefined_function / invalid_schema_name => control plane not deployed
    }
    logger.error({ err }, "get_restaurant_account_status_failed");
    return "active";
  }
}

export type RestaurantPlan = {
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
};

// Effective plan features + limits for a restaurant, via the platform SECURITY
// DEFINER function. Returns empty objects when the control plane isn't deployed
// or the restaurant has no plan, so feature-gating is purely additive.
export async function GetRestaurantPlan(resId: string): Promise<RestaurantPlan> {
  try {
    const rows = await runQuery<{ features: Record<string, unknown>; limits: Record<string, unknown> }>(
      `select features, limits from platform.restaurant_plan($1::uuid)`,
      [resId],
    );
    return { features: rows[0]?.features ?? {}, limits: rows[0]?.limits ?? {} };
  } catch (err: any) {
    if (err?.code === "42883" || err?.code === "3F000") {
      return { features: {}, limits: {} };
    }
    logger.error({ err }, "get_restaurant_plan_failed");
    return { features: {}, limits: {} };
  }
}

export async function AuthenticateRestaurantEmployee(
  restaurantId: string,
  employeeUsername: string,
  password: string,
): Promise<EmployeeLoginResult | null> {
  const context = await requireRestaurantContext(restaurantId);
  const normalizedEmployeeUsername = employeeUsername.trim();
  if (!normalizedEmployeeUsername) return null;

  // Login touches tenant tables (Login/Employees/Roles), so run the lookups
  // inside the restaurant's tenant context (RLS-safe) now that res_id is known
  // from the RLS-exempt slug resolution above.
  return withTenant(
    { res_id: context.res_id, outlet_id: context.outlet_id, employeeId: "", role: "" },
    async () => {
      const rows = await runQuery<{
        emp_id: string;
        emp_username: string;
        emp_pass: string;
        emp_fname: string | null;
        emp_lname: string | null;
        role_primary: string | null;
        emp_roles: Record<string, string[]>;
        res_id: string;
        outlet_id: string;
      }>(
        `
          select
            e.id as emp_id,
            l.emp_username,
            l.emp_pass,
            e."emp_Fname" as emp_fname,
            e."emp_Lname" as emp_lname,
            e.emp_roles->>'primary' as role_primary,
            e.emp_roles as emp_roles,
            e.res_id,
            e.outlet_id
          from "Login" l
          join "Employees" e
            on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
          where
            l.res_id = $1
            and l.outlet_id = $2
            and lower(l.emp_username) = lower($3)
          limit 1
        `,
        [context.res_id, context.outlet_id, normalizedEmployeeUsername],
      );

      const row = rows[0];
      if (!row) return null;

      // Verify against the stored secret (argon2 hash, or legacy plaintext).
      const passwordOk = await verifyPassword(row.emp_pass, password);
      if (!passwordOk) return null;

      // Transparently upgrade a legacy plaintext credential to an argon2 hash.
      if (!isHashedPassword(row.emp_pass)) {
        const upgraded = await hashPassword(password);
        await runQuery(
          `update "Login" set emp_pass = $1 where res_id = $2 and outlet_id = $3 and lower(emp_username) = lower($4)`,
          [upgraded, context.res_id, context.outlet_id, normalizedEmployeeUsername],
        );
      }

      const coreRoleName = Object.keys(CORE_ROLES);
      let actionSet = new Set<string>();
      const promises = (row.emp_roles['all'] ?? []).map(async role => {
        if (coreRoleName.includes(role)) {
          CORE_ROLES[role as CoreRoleKey].forEach(action => actionSet.add(action));
        } else {
          const actionRows = await runQuery<{ actions_performable: string[] }>(
            `select actions_performable from "Roles" where id = $1 and res_id = $2 limit 1`,
            [role, context.res_id],
          );
          if (actionRows[0]) {
            actionRows[0].actions_performable.forEach(action => actionSet.add(action));
          }
        }
      });

      await Promise.all(promises);

      if (actionSet.size === 0) {
        // Default to employee permissions if no roles or actions found
        CORE_ROLES.employee.forEach(action => actionSet.add(action));
      }

      const actionIds = Array.from(actionSet).filter((id) => isUuid(id));
      const actionNameRows = actionIds.length > 0
        ? await runQuery<{ action_name: string }>(
          `
            select action_name
            from "Actions"
            where id = any($1::uuid[])
          `,
          [actionIds],
        )
        : [];
      const action_names = actionNameRows
        .map((nameRow) => String(nameRow.action_name ?? "").trim())
        .filter((name) => name.length > 0);

      return {
        employeeId: row.emp_id,
        employeeUsername: row.emp_username,
        role: toRole(row.role_primary),
        role_all: parseEmployeeRoles(row.emp_roles).all,
        restaurantUsername: context.restaurant_slug,
        restaurantName: context.restaurant_name,
        res_id: row.res_id,
        outlet_id: row.outlet_id,
        emp_Fname: String(row.emp_fname ?? row.emp_username ?? "").trim(),
        emp_Lname: row.emp_lname ?? null,
        actions_set: actionSet,
        action_names,
      };
    },
  );
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

    // Bind the tenant context for the remainder of the seed so the operational
    // tables' fail-closed RLS accepts these inserts during registration.
    // Transaction-local, so it clears at COMMIT. "Restaurant"/"Outlets" are
    // metadata tables and accept the rows above even before this is set.
    await client.query("select set_config('app.res_id', $1, true)", [resId]);

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
        [adminEmpId, resId, outletId, adminUsername, await hashPassword(seed.admin.password)],
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
        [resId, outletId, adminUsername, await hashPassword(seed.admin.password)],
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
