/**
 * Building and dispatching a kitchen docket — the ONE implementation, shared by
 * every caller that puts a KOT on paper.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * There is now more than one reason to print a KOT:
 *
 *   1. a waiter presses Print for a TABLE (POST /print/bill {kind:"kot"}) — the
 *      whole running order set, which is the right document for "give me this
 *      table's ticket again";
 *   2. an order is BARKED (POST /orders/:id/bark) — one order announced to the
 *      kitchen, which is the moment the docket should exist;
 *   3. someone asks for that same bark docket again because the printer jammed
 *      (POST /print/kot/order/:id).
 *
 * All three have to agree on four things that are easy to get subtly different
 * if each writes its own copy: which kitchen station each dish belongs to, what
 * number the ticket carries, how the ticket is split across stations, and how
 * the resulting jobs reach a printer durably. When #2 was added, the second copy
 * of that logic is exactly where the KOT number would have drifted — one caller
 * hashing the item set before the station split and another after it would mint
 * two numbers for one docket. So the logic lives here and the callers supply
 * only the facts they actually know.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * The ticket KEY. buildKotTicketKey is exported so a caller can compute the key
 * and look at it (a test does exactly that), but the number itself is minted by
 * kot_numbers.ts:allocateKotNumber against migration 029's memo table, which is
 * the only place it can be made gapless per outlet-day and stable across a
 * reprint. Nothing in this file invents a number.
 */

import { buildKotBase64 } from "./escpos.js";
import { allocateKotNumber, kotOrderContext, kotStamp, kotTicketKey, serviceModeLabel } from "./kot_numbers.js";
import { logger } from "./observability.js";
import { enqueuePrintJob, printJobPayload } from "./print_jobs.js";
import { emitOutlet } from "./realtime.js";
import { GetMenuItems, dayKeyOf } from "./database_supabase.js";

/** One line as the kitchen needs it. Prices are accepted and never printed. */
export interface KotLine {
  name: string;
  quantity: number;
  price?: number;
  note?: string;
  variation?: string;
}

export interface KotDispatchInput {
  restaurantId: string;
  outletId: string;
  /** Printed as "Table No:" and used for nothing else. */
  tableName: string;
  /**
   * "Tables".id — the ticket key's table component, NOT the printed name.
   *
   * An id rather than a name because the key has to survive a table being
   * renamed mid-service: "12" becoming "12A" must not turn a reprint into a
   * brand new ticket with a brand new number.
   */
  tableId: string;
  section: string | null;
  covers: number;
  isVirtual: boolean;
  /** The stored channel token ("dine_in", "swiggy", …), not the label. */
  orderType: string | null;
  items: KotLine[];
  assignedTo: string | null;
  captain: string | null;
  /**
   * The "PrintJobs".bill_id every station docket of this ticket is grouped
   * under. It is NOT the job identity — see the note in print_jobs.ts — it is
   * only the handle that says "these N dockets came from one press".
   */
  billId: string;
  restaurantName: string;
  currency: string;
  /** Paper width in columns: 32 for 58mm, 48 for 80mm. */
  cols: number;
  /** The tenant's IANA zone. Everything dated on the ticket derives from it. */
  tz: string;
  firedAt?: Date;
  /**
   * The order subtotal, which a KOT NEVER PRINTS — buildReceiptBase64 returns at
   * the cut as soon as the items are laid out, well before the totals block that
   * reads this. It is carried only so the table-scoped caller can keep passing
   * the exact value it always passed, which is what makes this refactor
   * byte-identical rather than merely equivalent-looking.
   */
  total?: number;
}

export interface KotDispatchResult {
  billId: string;
  /** How many station dockets this ticket became. Never zero. */
  tickets: number;
  stations: string[];
  kotNo: number | null;
  businessDay: string | null;
  /** True when the number came back from the memo — i.e. this is a reprint. */
  reprint: boolean;
  /** One per station docket; null where migration 027 is unapplied. */
  jobIds: (string | null)[];
}

/**
 * The ticket key for a docket, computed over the WHOLE item set.
 *
 * Exported because the identity of a KOT is a property worth asserting directly
 * in a test, and because the bark path needs to be able to reason about it
 * without dispatching a print.
 */
export function buildKotTicketKey(input: {
  outletId: string;
  tableId: string;
  items: KotLine[];
  firedAt: Date;
  tz: string;
}): string {
  return kotTicketKey({
    outletId: input.outletId,
    businessDay: dayKeyOf(input.firedAt, input.tz),
    tableId: input.tableId,
    items: input.items.map((it) => ({
      name: it.name,
      quantity: it.quantity,
      note: it.note ?? null,
      variation: it.variation ?? null,
    })),
  });
}

/**
 * Tag each line with the kitchen station that cooks it, from the menu, by dish
 * name.
 *
 * A menu that cannot be read costs the SPLIT, not the docket: every line falls
 * under the shared "General" bucket and the kitchen gets one ticket with
 * everything on it, which is what a single-station restaurant gets anyway.
 */
async function withStations(restaurantId: string, items: KotLine[]): Promise<(KotLine & { price: number; station: string | null })[]> {
  const stationByName = new Map<string, string>();
  try {
    const menu = await GetMenuItems(restaurantId);
    for (const m of menu) {
      if (m.station) { stationByName.set(m.name.trim().toLowerCase(), m.station); }
    }
  } catch {
    /* menu unavailable — everything falls under a single General ticket */
  }
  return items.map((it) => ({
    ...it,
    // ReceiptItem requires a price and a KOT never prints one, so an absent
    // price becomes 0 rather than making every caller invent a number for a
    // column the renderer does not lay out.
    price: it.price ?? 0,
    station: stationByName.get(String(it.name).trim().toLowerCase()) ?? null,
  }));
}

/**
 * Build the docket(s) for one ticket and put them on the durable print queue.
 *
 * ORDER OF OPERATIONS, and every step of it is load-bearing:
 *
 *   1. enrich with stations,
 *   2. allocate ONE number for the whole ticket — BEFORE the split, so all N
 *      station dockets carry the same "KOT - n" and the expo can pair them,
 *   3. split into one cut-terminated docket per station,
 *   4. persist each docket as its own "PrintJobs" row and THEN emit it. The row
 *      is the fact and the emit is the optimisation: an emit into an empty room
 *      is a successful no-op, so a till whose socket is down loses nothing.
 *
 * A THROW HERE MUST NEVER BE THE CALLER'S PROBLEM ALONE. Numbering degrades to
 * an unnumbered ticket (allocateKotNumber returns null when migration 029 is
 * unapplied) and durability degrades to fire-and-forget (enqueuePrintJob returns
 * null when 027 is unapplied), so the only things left to throw are real
 * failures. The bark path catches them and still barks; see routes/orders.ts.
 */
export async function dispatchKot(input: KotDispatchInput): Promise<KotDispatchResult> {
  const firedAt = input.firedAt ?? new Date();
  const tz = input.tz.trim() || "Asia/Kolkata";
  const serviceMode = serviceModeLabel(input.orderType);
  const kotItems = await withStations(input.restaurantId, input.items);

  // ONE NUMBER FOR THE WHOLE KOT. A ticket with no table id cannot be keyed
  // (see GetOrderKotContext) — it prints unnumbered rather than sharing the
  // empty-string key with every other unkeyable ticket in the outlet, which
  // would hand them all the same number.
  const businessDay = dayKeyOf(firedAt, tz);
  const kot = input.tableId
    ? await allocateKotNumber(
      input.restaurantId,
      buildKotTicketKey({ outletId: input.outletId, tableId: input.tableId, items: input.items, firedAt, tz }),
      firedAt,
    )
    : null;

  const tickets = buildKotBase64({
    restaurantName: input.restaurantName || "Receipt",
    table: input.tableName,
    covers: input.covers,
    items: kotItems,
    total: input.total ?? 0,
    currency: input.currency,
    kind: "kot",
    kotNo: kot?.kot_no ?? null,
    printedAt: kotStamp(firedAt, tz),
    orderContext: kotOrderContext(input.isVirtual, serviceMode),
    serviceMode,
    section: input.section,
    assignedTo: input.assignedTo,
    captain: input.captain,
  }, input.cols);

  const jobIds: (string | null)[] = [];
  for (const t of tickets) {
    const jobId = await enqueuePrintJob(input.restaurantId, {
      outlet_id: input.outletId, bill_id: input.billId, kind: "kot", station: t.station, esc_base64: t.escBase64,
    });
    jobIds.push(jobId);
    emitOutlet(input.restaurantId, input.outletId, "bill:print", printJobPayload({
      billId: input.billId, escBase64: t.escBase64, kind: "kot", station: t.station, jobId,
      publishedAt: new Date().toISOString(),
    }));
  }

  return {
    billId: input.billId,
    tickets: tickets.length,
    stations: tickets.map((t) => t.station),
    kotNo: kot?.kot_no ?? null,
    businessDay: kot?.business_day ?? businessDay,
    reprint: kot?.reused ?? false,
    jobIds,
  };
}

/**
 * WHAT HAPPENS TO A DOCKET NOBODY CAN PRINT.
 *
 * An outlet with no till running the agent still gets rows in "PrintJobs" — and
 * that is the correct outcome, not a leak. The rows expire on their own after
 * PRINT_JOB_KOT_TTL_MIN (30 minutes by default, enforced at READ time inside
 * ClaimPrintJobsForAgent so it does not depend on the reaper having run), and
 * the reaper then flips them to 'expired' and logs
 * `print_jobs_expired_undelivered` at warn — which is precisely the signal an
 * owner needs: "the kitchen missed N dockets today". The alternative — not
 * enqueueing when no agent is connected — would mean a till that reconnects ten
 * seconds later never learns the order existed, which is the silent drop this
 * whole subsystem was built to remove.
 *
 * This function exists to give that reasoning one line of code to hang on, and
 * to make the log line say which path produced the undeliverable job.
 */
export function logKotDispatched(where: string, result: KotDispatchResult, ctx: Record<string, unknown>): void {
  logger.info(
    { ...ctx, where, tickets: result.tickets, stations: result.stations, kot_no: result.kotNo, reprint: result.reprint },
    "kot_dispatched",
  );
}
