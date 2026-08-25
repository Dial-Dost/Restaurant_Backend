/**
 * Kitchen Order Ticket numbering + header context — the policy layer over
 * migration 029's "KotCounters" / "KotTickets".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A KOT printed today needs a short number the pass can shout ("where's 26?"),
 * and that number has to start again at 1 every morning. Three things had to be
 * decided somewhere, and none of them belong in the SQL or in the renderer:
 *
 *   1. WHAT COUNTS AS "THE SAME KOT" — the ticket key. This is what makes a
 *      reprint reuse its number instead of burning a new one.
 *   2. WHAT HAPPENS WHEN MIGRATION 029 IS NOT APPLIED YET. Same degradation rule
 *      print_jobs.ts states for 027: the restaurant must keep printing.
 *   3. HOW THE HEADER READS — the printing stamp in the restaurant's own zone,
 *      and the human wording of a service channel.
 *
 * WHERE THE STATEMENTS LIVE. Every "KotCounters"/"KotTickets" statement is in
 * database_supabase.ts behind AllocateKotNumber (runQuery is module-private
 * there, deliberately). This file never touches SQL.
 *
 * THE DEGRADATION RULE, restated because it is easy to get backwards
 * ------------------------------------------------------------------
 * The rollout order is migration, then backend. In the window between them every
 * statement against these two tables raises 42P01 (or 42501 if the grants half
 * did not run). Letting that propagate would 500 POST /print/bill and stop the
 * kitchen receiving dockets at all — far worse than a docket with no number on
 * it. So that ONE error class, and no other, degrades to an unnumbered ticket
 * with a loud (rate-limited) log. Anything else still throws, because anything
 * else means something is wrong that hiding would not fix.
 */

import { AllocateKotNumber, type KotNumberAllocation } from "./database_supabase.js";
import { logger } from "./observability.js";
import { createHash } from "node:crypto";

/** The item shape the ticket key is built from — a subset of ReceiptItem. */
export interface KotKeyItem {
  name: string;
  quantity: number;
  note?: string | null;
}

/**
 * A stable fingerprint of WHAT IS BEING SENT TO THE KITCHEN.
 *
 * The identity of a KOT is deliberately its CONTENT, not the print request and
 * not "PrintJobs".bill_id:
 *
 *   * bill_id cannot be it. For a table whose bill row has not been generated
 *     yet — the normal case when a KOT is fired, since the bill is created at
 *     settle — routes/bills.ts falls back to `<table>-<epoch>`, which is a
 *     different value on every single press of Print. Keying on that would give
 *     the kitchen two numbers for one docket.
 *
 *   * The request cannot be it either. A waiter pressing Print twice, and an
 *     agent that lost its socket and had the job replayed, must both land on the
 *     number already on paper.
 *
 * So the key is (outlet, business day, table, normalised item set). Reprint the
 * same table with the same items and you get the same number; add a dish and it
 * is a genuinely new ticket that takes the next one. Notes are inside the
 * fingerprint because "Paneer Tikka, no chilli" is a different instruction to
 * the kitchen than "Paneer Tikka".
 *
 * ITEMS ARE SORTED BEFORE HASHING, so two prints that merely enumerate the same
 * dishes in a different order (GetBillForTable aggregates from a Map, whose
 * iteration order follows insertion) are recognised as the same ticket.
 *
 * ONE KEY COVERS ALL N STATION DOCKETS. buildKotBase64 splits a ticket into one
 * docket per kitchen station; those are one logical order and share a number, so
 * the key is computed over the WHOLE item set, before the split.
 */
export function kotTicketKey(input: {
  outletId: string;
  businessDay: string;
  tableId: string;
  items: KotKeyItem[];
}): string {
  const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  // Non-printing separators between every field, spelled as escapes rather than
  // pasted in literally so they survive an editor and are visible in review.
  // Without them the key is ambiguous: {"ab", qty 1} and {"a", qty 0} + {"b1"}
  // would concatenate to the same string and share a number.
  const FIELD = "\u0001";
  const ITEM = "\u0002";
  const GROUP = "\u0003";
  const signature = input.items
    .map((it) => {
      // The renderer's own floor: a KOT line is never for less than one.
      const qty = Math.max(1, Math.round(it.quantity) || 1);
      return `${norm(it.name)}${FIELD}${String(qty)}${FIELD}${norm(it.note)}`;
    })
    .sort()
    .join(ITEM);
  const material = [norm(input.outletId), norm(input.businessDay), norm(input.tableId), signature].join(GROUP);
  // Hashed rather than stored raw: the item set of a large table is unbounded in
  // length, and the column is only ever compared for equality.
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 40);
}

// --- migration-not-applied tolerance ----------------------------------------

const MIN = 60_000;

/** 42P01 undefined_table, 42501 insufficient_privilege — i.e. migration 029 has
 *  not run, or ran without the app_runtime grants. Nothing else qualifies. */
function isSchemaMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42501";
}

let schemaWarnedAt = 0;
/** Loud, but not once per docket: an unmigrated deployment prints all service. */
function warnSchemaMissing(err: unknown): void {
  const now = Date.now();
  if (now - schemaWarnedAt < 10 * MIN) {return;}
  schemaWarnedAt = now;
  logger.error(
    { err },
    'KOT numbering is OFF — "KotCounters"/"KotTickets" are unreadable (apply migration 029). ' +
      "Kitchen tickets still print, without a KOT number.",
  );
}

/**
 * Allocate the KOT number for a ticket, or null if numbering is unavailable.
 *
 * A null is the honest signal that this docket goes out unnumbered; the caller
 * still prints, because a docket the kitchen can cook from beats no docket.
 */
export async function allocateKotNumber(
  restaurantId: string,
  ticketKey: string,
  at: Date = new Date(),
): Promise<KotNumberAllocation | null> {
  try {
    return await AllocateKotNumber(restaurantId, ticketKey, at);
  } catch (err) {
    if (isSchemaMissing(err)) {
      warnSchemaMissing(err);
      return null;
    }
    throw err;
  }
}

// --- header presentation -----------------------------------------------------

/**
 * The printing stamp, in the RESTAURANT's zone: `DD/MM/YY HH:mm`.
 *
 * Formatted here and handed to the renderer as a finished string, on the same
 * principle the money rules state for totals: the renderer prints what it is
 * given and does no arithmetic of its own. The renderer has no idea what zone
 * the restaurant is in, and the escpos module has no business acquiring one.
 *
 * The zone matters, and the previous KOT proves why: it printed
 * `new Date().toLocaleString()`, which is the SERVER's zone and locale. On the
 * UTC production host that stamped an IST kitchen's 01:00 docket as the previous
 * day at 19:30.
 */
export function kotStamp(at: Date, tz: string): string {
  const zone = tz.trim() || "Asia/Kolkata";
  const format = (z: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: z,
      day: "2-digit", month: "2-digit", year: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(zone);
  } catch {
    // An unknown IANA id would throw here. Falling back keeps the stamp honest
    // for the overwhelmingly common tenant rather than printing nothing.
    parts = format("Asia/Kolkata");
  }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/**
 * Human wording for an order channel, as the kitchen should read it.
 *
 * The stored tokens are AddOrder's (`dine_in` by default, plus `takeaway`,
 * `delivery`, and the aggregator names the expo view already treats as channels).
 * Anything unrecognised is title-cased rather than dropped, so a channel added
 * later still prints something truthful instead of silently reading "Dine In".
 */
export function serviceModeLabel(orderType: string | null | undefined): string {
  const t = (orderType ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!t || t === "dine_in" || t === "dinein") {return "Dine In";}
  if (t === "takeaway" || t === "take_away" || t === "pickup" || t === "parcel") {return "Takeaway";}
  if (t === "delivery") {return "Delivery";}
  if (t === "swiggy") {return "Delivery (Swiggy)";}
  if (t === "zomato") {return "Delivery (Zomato)";}
  return t.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The context line at the very top of the ticket — the reference receipt's
 * "Running Table".
 *
 * Derived from real state rather than invented: a KOT on a physical table always
 * covers that table's currently-running order set (GetBillForTable aggregates
 * every ACTIVE order on the table), so "Running Table" is literally what it is.
 * A virtual table is not a table at all — it is the hidden row provisioned to
 * back one takeaway or delivery order — so it announces its channel instead.
 */
export function kotOrderContext(isVirtual: boolean, serviceMode: string): string {
  return isVirtual ? serviceMode : "Running Table";
}
