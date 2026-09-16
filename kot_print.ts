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
 *   2. an order REACHES THE KITCHEN — placed (POST /orders, POST
 *      /orders/takeaway, the guest QR page), approved out of Pending, or barked.
 *      All four go through autoPrintOrderKot below;
 *   3. a LINE IS ADDED to an order already on the pass (POST /orders/:id/items),
 *      which prints the added line and nothing else;
 *   4. someone asks for a docket again because the printer jammed
 *      (POST /print/kot/order/:id).
 *   5. food STOPS being cooked — an order or a line is cancelled, voided or
 *      deleted. dispatchCancellationKot at the foot of this file, and it is the
 *      one docket here that never mints a number: it names the ticket already on
 *      the rail. See its own header for why that distinction is the whole design.
 *
 * WHY 2 IS FOUR EVENTS AND NOT ONE. "Print when the order is placed" is what the
 * restaurant asked for and what happens for essentially every order — but an
 * order placed while auto-push is OFF is created Pending (status 8), which is
 * the approval gate, and paper on the pass IS the kitchen being told. So the
 * placement path declines to print a Pending order and the approval transition
 * prints it instead. See autoPrintOrderKot.
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

import { buildKotBase64, type ReceiptOptions } from "./escpos.js";
import { allocateKotNumber, kotOrderContext, kotStamp, kotTicketKey, serviceModeLabel } from "./kot_numbers.js";
import { logger } from "./observability.js";
import { dispatchPrintJob } from "./print_routing.js";
import {
  GetMenuItems,
  GetOrderKotContext,
  GetRestaurantProfile,
  GetRestaurantSettings,
  GetTableFeedbackContext,
  LookupKotNumber,
  dayKeyOf,
} from "./database_supabase.js";

/**
 * The renderer's options, plus the one field the CANCELLATION slip needs.
 *
 * WHY AN INTERSECTION RATHER THAN JUST PASSING THE FIELD. `cancelled` belongs in
 * ReceiptOptions and escpos.ts is adding it there — it is the renderer's job to
 * decide how big the word "CANCELLED" is and where on the paper it sits, and
 * this file must not grow a second opinion about layout. But escpos.ts is
 * another lane's file, so until that lands a bare `cancelled: true` in the
 * literal below would be an excess property and this file would not compile.
 *
 * The intersection makes the two lanes independent in BOTH directions: it
 * compiles today against a ReceiptOptions that has no such field, and the day
 * the field appears the intersection is simply redundant and everything keeps
 * working — no coordinated merge, no window in which either lane is broken.
 * Delete the `& { … }` once the field is in ReceiptOptions.
 *
 * WHAT HAPPENS IF THE RENDERER SIDE NEVER LANDS: the flag is ignored and the
 * slip prints as an ordinary-looking docket carrying the "*** CANCELLED ***"
 * context line built below. That is the reason the word is ALSO on the context
 * line and not only in the banner — see cancellationBanner.
 */
type KotRenderOptions = ReceiptOptions & { cancelled?: boolean };

/** One line as the kitchen needs it. Prices are accepted and never printed. */
export interface KotLine {
  name: string;
  quantity: number;
  price?: number;
  note?: string;
  variation?: string;
  /**
   * The menu row this line was sold from, stamped server-side on every order
   * write by applyMenuPriceFloor. ADVISORY ONLY: it is never part of any merge
   * key (adding it would split a bill line the guest is handed today), and a
   * pre-039 line simply does not carry it and falls back to name matching, as
   * every line did before. It exists so a dish RENAMED since it was ordered
   * still reaches the right station.
   */
  menu_id?: string | null;
  /**
   * How many of this line's `quantity` are on COURSE HOLD (course_hold set and
   * not yet fired). Absent or 0 on every line of every restaurant that does not
   * hold courses.
   *
   * A COUNT RATHER THAN A FLAG, because the reads that feed this merge order
   * lines by (name, price, non-chargeable, variation) — deliberately, so the
   * printed bill groups the way the guest expects — and held-ness is NOT part of
   * that key. Adding it would have split a guest's bill line in two the moment a
   * waiter held one of the two Paneer Tikkas, and re-merged it when the course
   * was fired: the same table's bill printing differently at 20:00 and 20:30, on
   * a tax document, for a reason the guest cannot see. So the merge stays as it
   * is and the docket does the splitting, here, where only the kitchen looks.
   */
  held_qty?: number;
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
   * The ORDER-LEVEL note ("Orders".food.note) — the whole-order instruction the
   * waiter or the guest typed, as opposed to the per-dish `KotLine.note`.
   *
   * Optional so that every existing caller compiles and prints exactly the
   * docket it printed before; absent and empty both mean "no banner". See
   * ReceiptOptions.orderNote in escpos.ts for why it is on the KOT only, and
   * why it goes on every station's ticket rather than one.
   *
   * DELIBERATELY NOT PART OF THE TICKET KEY (buildKotTicketKey). The key maps
   * one FOOD CONTENT to one KOT number forever, which is what makes a reprint
   * reuse its number instead of minting a second ticket for a dish the kitchen
   * is already cooking. Folding the note into it would mean an edited note
   * re-tickets an unchanged order — a new number, on paper, for food that has
   * not changed. The note rides on the docket; the identity stays the food.
   */
  orderNote?: string | null;
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
  /**
   * Extra ticket-key identity for a docket that is not the order's whole item
   * set — the added line's id, and nothing else, today. See kotTicketKey.
   */
  scope?: string | null;
  /**
   * "Only print this if the content has never been ticketed today."
   *
   * THE INTERLOCK THAT MAKES PRINT-ON-PLACEMENT SAFE, and the reason placing an
   * order and then barking it yields ONE docket rather than two. Every AUTOMATIC
   * trigger sets it; every trigger a human pressed leaves it false, because a
   * reprint that refused to reprint would be a dead button.
   *
   * The test is AllocateKotNumber's own `reused` flag — the migration-029 memo
   * that maps one content fingerprint to one number for ever. Nothing new is
   * stored and nothing new can drift: the fact that answers "has this already
   * been ticketed?" is the same fact that answers "what number is on the paper?".
   *
   * WHAT IT COSTS. A placement whose allocation succeeded but whose enqueue then
   * threw leaves a memo row and no paper, and the bark that follows will be
   * suppressed too. That is what POST /print/kot/order/:id is for, and it is a
   * true reprint — same key, same number, same bytes.
   */
  skipIfTicketed?: boolean;
  /**
   * Print this number instead of allocating one. Nothing is minted and nothing
   * is memoised.
   *
   * THE ONE CALLER, and why the option is narrow on purpose: a docket that
   * CORRECTS a ticket the kitchen already holds (an order moved to another
   * table - see kot_move.ts). It has to carry the SAME number as the paper on
   * the pass, because the number is how a chef pairs the correction with the
   * ticket it corrects: "KOT-26 is now table 7" is actionable, "KOT-31 is table
   * 7, and by the way bin 26" is a puzzle. Allocating would also be wrong twice
   * over - it would burn a number for a re-print of food already ordered, and
   * the content fingerprint would memoise the corrected table as if it were a
   * new ticket.
   *
   * Null or absent = allocate normally, which is every other caller.
   */
  pinnedKotNo?: number | null;
  /**
   * Refuse to MINT a number. With no `pinnedKotNo` the docket prints unnumbered.
   *
   * THE ONE CALLER is the cancellation slip (dispatchCancellationKot), and the
   * reason it needs a flag of its own rather than relying on pinnedKotNo is that
   * its number may legitimately be UNRESOLVABLE. `pinnedKotNo: null` alone falls
   * through to allocateKotNumber below, which would burn a fresh gapless number
   * on a piece of paper whose entire job is to cancel a DIFFERENT one — leaving
   * a hole in the sequence the kitchen counts by and printing a number that
   * names no ticket on the rail.
   *
   * Absent on every other caller, so every other docket allocates exactly as it
   * always has.
   */
  neverAllocate?: boolean;
  /**
   * This docket CANCELS food rather than ordering it.
   *
   * Passed straight to the renderer, which prints "CANCELLED" in the biggest
   * type it has at the top of the ticket. Nothing else about the dispatch
   * changes: same station split, same "kot" kind, same router — the slip has to
   * reach the kitchen that is cooking the food, not the bill printer.
   *
   * Absent (the default) on every ordinary docket, so their bytes are untouched.
   */
  cancelled?: boolean;
  /**
   * Overrides the line at the very top of the docket (normally "Running Table"
   * or the delivery channel - see kotOrderContext). Used to say, in the first
   * thing a chef reads, that this piece of paper replaces another one.
   */
  contextLine?: string | null;
  /**
   * Which docket this restaurant prints — "Restaurant".kot_print_style, passed
   * straight through to the renderer (see ReceiptOptions.kotPrintStyle).
   *
   * Absent or NULL prints the REFERENCE docket, which is what every caller that
   * has not been taught about the setting gets, and what an unset column means.
   * The only other value is 'classic', which keeps the ESC/POS text docket for
   * a kitchen whose printer cannot take a GS v 0 raster.
   */
  kotPrintStyle?: string | null;
}

export interface KotDispatchResult {
  billId: string;
  /** How many station dockets this ticket became. Zero only when skipIfTicketed
   *  suppressed an already-ticketed docket — see `skipped`. */
  tickets: number;
  stations: string[];
  kotNo: number | null;
  businessDay: string | null;
  /** True when the number came back from the memo — i.e. this is a reprint. */
  reprint: boolean;
  /** One per station docket; null where migration 027 is unapplied. */
  jobIds: (string | null)[];
  /**
   * One per station docket, PARALLEL TO jobIds: the device the router aimed that
   * docket at, or null where it went to the whole outlet as it always has.
   *
   * It exists so logKotDispatched can answer "why did the bar docket print at the
   * pass?" from the log line instead of from a database trace. A null here is the
   * ordinary answer for every outlet that has not configured routing, and for a
   * routed one it is the signal that the ladder fell back — the destination was
   * offline, the tables were unreadable, or no rule matched this station.
   */
  devices: (string | null)[];
  /** True when skipIfTicketed suppressed this dispatch. Nothing was built,
   *  nothing was enqueued, and kotNo is the number already on paper. */
  skipped: boolean;
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
  /** See kotTicketKey — empty for a whole-order docket, which is almost all of
   *  them, and the added line's id for a partial one. */
  scope?: string | null;
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
    scope: input.scope ?? null,
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
/**
 * ONE CANONICAL SPELLING PER STATION, for the length of one ticket.
 *
 * THE BUG THIS CLOSES. `groupKotItemsByStation` buckets on the trimmed station
 * string with no case folding, so a menu carrying "Bar" on one dish and "bar"
 * on another mints TWO dockets. The printer agent, meanwhile, upper-cases when
 * it builds its rule key (`PrintRole.kotStation`), so both dockets resolve to
 * the SAME printer — and the bar gets two half-tickets for one order, the
 * second easy to miss under the first.
 *
 * That was cosmetic while every station had its own printer. It stops being
 * cosmetic the moment sections are GROUPED onto one, because grouping is
 * precisely the configuration that lands two spellings on one roll.
 *
 * A CLOSURE RATHER THAN A PURE FUNCTION, because collapsing case is not a
 * property of one string — it is a property of the SET. Two unmanaged spellings
 * have to agree on one of themselves, and the only way to do that without a
 * vocabulary is to remember which was seen first.
 *
 * WHICH SPELLING WINS:
 *   1. The restaurant's own. `Restaurant.kitchen_sections` is the vocabulary the
 *      owner typed and the list the printer screen offers rules for, so a
 *      station that appears there wins — a docket headed "Bar" rather than
 *      whatever casing the first matching dish happened to carry.
 *   2. Failing that, first seen on this ticket. Unmanaged stations are free
 *      text; they still collapse to one bucket, just not to a spelling anybody
 *      chose.
 *
 * FOLDED HERE, NOT IN escpos.ts, deliberately. The renderer stays a pure
 * function of what it is handed, jest-tests/escpos.test.ts keeps describing the
 * renderer rather than the menu, and because every KOT path in the system
 * funnels through dispatchKot, one upstream fix covers all of them.
 *
 * The one deliberate byte change: a docket whose menu says "bar", in a
 * restaurant whose vocabulary says "Bar", now prints the header "Bar". Pinned
 * by a test, so it is a decision rather than a surprise.
 */
export function stationCanonicalizer(kitchenSections: string[]): (raw: string | null | undefined) => string | null {
  const managed = new Map<string, string>();
  for (const s of kitchenSections) {
    const t = String(s ?? "").trim();
    if (t) { managed.set(t.toLowerCase(), t); }
  }
  const seen = new Map<string, string>();
  return (raw) => {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {return null;}
    const folded = trimmed.toLowerCase();
    const fromVocabulary = managed.get(folded);
    if (fromVocabulary) {return fromVocabulary;}
    const first = seen.get(folded);
    if (first) {return first;}
    seen.set(folded, trimmed);
    return trimmed;
  };
}

async function withStations(restaurantId: string, items: KotLine[]): Promise<(KotLine & { price: number; station: string | null; held?: boolean })[]> {
  const stationByName = new Map<string, string>();
  // THE ID MAP, AND WHY IT IS FIRST. A dish is matched to its station by NAME
  // below, which silently fails for a line whose dish has since been renamed —
  // it falls into "General", and under a grouped routing scheme "General" is
  // almost certainly the hot kitchen. So a renamed cocktail prints at the pass
  // and the bar never learns it was ordered. `menu_id` is stamped server-side on
  // every order line by applyMenuPriceFloor (migration 039: "all STAMPED BY THE
  // SERVER, never accepted from the client"), so where it survives to here it is
  // authoritative and the name is only the fallback. GetOrders already resolves
  // stations this way; this brings the PRINT path level with the KDS path.
  const stationById = new Map<string, string>();
  let kitchenSections: string[] = [];
  try {
    const menu = await GetMenuItems(restaurantId);
    for (const m of menu) {
      if (m.station) {
        stationByName.set(m.name.trim().toLowerCase(), m.station);
        if (m.id) { stationById.set(String(m.id), m.station); }
      }
    }
  } catch {
    /* menu unavailable — everything falls under a single General ticket */
  }
  try {
    const settings = await GetRestaurantSettings(restaurantId);
    kitchenSections = Array.isArray(settings.kitchen_sections) ? settings.kitchen_sections : [];
  } catch {
    /* no vocabulary — free-text stations keep their own spelling, still folded */
  }
  const canonical = stationCanonicalizer(kitchenSections);
  return items.flatMap((it) => {
    const rawStation =
      stationById.get(String(it.menu_id ?? "")) ??
      stationByName.get(String(it.name).trim().toLowerCase()) ??
      null;
    const base = {
      ...it,
      // ReceiptItem requires a price and a KOT never prints one, so an absent
      // price becomes 0 rather than making every caller invent a number for a
      // column the renderer does not lay out.
      price: it.price ?? 0,
      station: canonical(rawStation),
    };
    // THE ONE PLACE A MERGED LINE BECOMES TWO DOCKET LINES. "Paneer Tikka x3, of
    // which 1 is held" is one line on the bill and two on the docket: two to
    // cook now, one marked "[Hold]" under itself (escpos.ts). A line that is
    // wholly held produces exactly one, held, line; a line with no hold produces
    // exactly one line and does not even carry the `held` key, so a restaurant
    // that never holds a course gets the object it always got.
    const quantity = Math.max(1, Math.round(Number(it.quantity) || 1));
    const heldQty = Math.max(0, Math.min(quantity, Math.round(Number(it.held_qty) || 0)));
    if (heldQty <= 0) {return [base];}
    if (heldQty >= quantity) {return [{ ...base, quantity, held: true }];}
    return [
      { ...base, quantity: quantity - heldQty },
      { ...base, quantity: heldQty, held: true },
    ];
  });
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
 * failures. autoPrintOrderKot below catches those and reports them, so an order
 * is never rolled back or refused because a printer had a bad day.
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
  // A PINNED number short-circuits allocation entirely: the caller already knows
  // what is on the paper it is correcting, so there is nothing to mint and
  // nothing to memoise. `reused: true` is the truth about it - this number has
  // been printed before.
  const pinned = typeof input.pinnedKotNo === "number" && Number.isFinite(input.pinnedKotNo) && input.pinnedKotNo > 0
    ? { kot_no: Math.round(input.pinnedKotNo), business_day: businessDay, reused: true }
    : null;
  // NEVER-ALLOCATE short-circuits the same way a pin does, and for the inverse
  // reason: the caller knows there is nothing it is entitled to mint. Ordered
  // after `pinned` so a caller that supplies both still prints the number it
  // resolved — "do not mint" and "here is the number" are not in conflict.
  const kot = pinned ?? (input.tableId && !input.neverAllocate
    ? await allocateKotNumber(
      input.restaurantId,
      buildKotTicketKey({ outletId: input.outletId, tableId: input.tableId, items: input.items, firedAt, tz, scope: input.scope ?? null }),
      firedAt,
    )
    : null);

  // ALREADY ON PAPER. An automatic trigger asked for this docket and the memo
  // says this exact content was ticketed earlier today, so the kitchen has it —
  // nothing is built and nothing is enqueued. Placing an order and then barking
  // it lands here on the bark, which is what makes it one docket and not two.
  if (input.skipIfTicketed && kot?.reused) {
    return {
      billId: input.billId,
      tickets: 0,
      stations: [],
      kotNo: kot.kot_no,
      businessDay: kot.business_day,
      reprint: true,
      jobIds: [],
      devices: [],
      skipped: true,
    };
  }

  // Named and annotated rather than passed inline ONLY so `cancelled` can ride
  // along before ReceiptOptions declares it — see KotRenderOptions. Every field
  // below is the one that was passed before, in the same order, so an ordinary
  // docket renders the same bytes it always did.
  const renderOptions: KotRenderOptions = {
    restaurantName: input.restaurantName || "Receipt",
    table: input.tableName,
    covers: input.covers,
    items: kotItems,
    total: input.total ?? 0,
    currency: input.currency,
    kind: "kot",
    kotNo: kot?.kot_no ?? null,
    printedAt: kotStamp(firedAt, tz),
    orderContext: input.contextLine?.trim() ? input.contextLine.trim() : kotOrderContext(input.isVirtual, serviceMode),
    serviceMode,
    section: input.section,
    assignedTo: input.assignedTo,
    captain: input.captain,
    orderNote: input.orderNote ?? null,
    // THE DOCKET'S OWN FACE. Threaded, never decided here: which document a
    // kitchen gets is a restaurant setting, and this file's job is to put the
    // right food on it.
    kotPrintStyle: input.kotPrintStyle ?? null,
    // Set ONLY on a cancellation slip. Spread-conditional rather than
    // `cancelled: false` so an ordinary docket's options object is byte-for-byte
    // the object it was before this field existed.
    ...(input.cancelled ? { cancelled: true } : {}),
  };
  const tickets = buildKotBase64(renderOptions, input.cols);

  // PERSIST-THEN-EMIT, VIA THE ROUTER. dispatchPrintJob does exactly what the
  // enqueue+emit pair here used to do — same order, same payload — and adds one
  // thing: when this outlet has a rule for this station, the docket is emitted to
  // the bound machine's own room instead of to every printer in the outlet. An
  // outlet with zero "PrintRoutes" rows resolves to `mode:'broadcast'` and lands
  // on the same emitOutlet with the same bytes, so the kitchen of every
  // unconfigured restaurant sees no change at all.
  //
  // PRESENCE IS RESOLVED ONCE PER PRINT ACTION, NOT ONCE PER DOCKET, and that is
  // why this loop can call the router N times without paying N cross-replica
  // round trips: resolvePrintTarget reads the route table through a 10s cache and
  // presence through a 2s one (PRINT_PRESENCE_CACHE_MS), both keyed by outlet, so
  // a five-station order does ONE fetchSockets and four cache hits. The sharing
  // lives in those caches rather than in a handle threaded through this function
  // deliberately — see the PRESENCE_TTL_MS note in print_routing.ts — so every
  // future producer gets it without having to know about it.
  const jobIds: (string | null)[] = [];
  const devices: (string | null)[] = [];
  for (const t of tickets) {
    const dispatched = await dispatchPrintJob(input.restaurantId, {
      outlet_id: input.outletId, bill_id: input.billId, kind: "kot", station: t.station, esc_base64: t.escBase64,
      // THE ONE LINE THAT MAKES MIGRATION 043 DO ANYTHING. Without it the column
      // exists, every read returns empty, and no KOT number reaches a kitchen
      // card, an order row or a bill's Token No. line — the whole point of the
      // link, silently absent.
      //
      // DIAGNOSTIC, NEVER A SOURCE. `kot` is the number this ticket was ALREADY
      // allocated a few lines above; this copies it onto the print job so a
      // docket can be found again by the number the kitchen calls it by. It is
      // never read back to decide what to print, and EnqueuePrintJob normalises
      // it at the door, so a null here is simply an unnumbered job — which is
      // exactly what a docket printed while migration 029 is unapplied is.
      kot_no: kot?.kot_no ?? null,
    });
    jobIds.push(dispatched.jobId);
    devices.push(dispatched.assignedDeviceId);
  }

  return {
    billId: input.billId,
    tickets: tickets.length,
    stations: tickets.map((t) => t.station),
    kotNo: kot?.kot_no ?? null,
    businessDay: kot?.business_day ?? businessDay,
    reprint: kot?.reused ?? false,
    jobIds,
    devices,
    skipped: false,
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
  // `devices` is added ONLY when the router actually aimed a docket at a machine.
  // Every outlet in the fleet is unrouted on the day this ships, and adding
  // `devices: [null, null]` to each of their kot_dispatched lines would be pure
  // volume in the one log a busy service produces most of — while its presence on
  // a routed tenant's line is the whole point: it is what says WHICH docket went
  // to WHICH till, and therefore which one fell back to the outlet broadcast.
  const aimed = result.devices.some((d) => d !== null);
  logger.info(
    {
      ...ctx, where, tickets: result.tickets, stations: result.stations, kot_no: result.kotNo, reprint: result.reprint,
      ...(aimed ? { devices: result.devices } : {}),
    },
    "kot_dispatched",
  );
}

// --- the automatic trigger ---------------------------------------------------

export interface AutoKotOutcome {
  /** True when dockets were built and queued by THIS call. */
  printed: boolean;
  /** The number on the paper — present even when this call printed nothing,
   *  because "already ticketed as KOT-26" is the useful answer. */
  kot_no: number | null;
  tickets: number;
  /** Why nothing was printed. Absent when something was. */
  reason?: string;
}

/**
 * Put ONE order's docket on the pass, automatically.
 *
 * WHEN THIS RUNS. Every moment an order reaches the kitchen:
 *
 *   * it is PLACED and goes straight to the kitchen — POST /orders, POST
 *     /orders/takeaway, the guest QR page. This is the ordinary case and it is
 *     what "the KOT prints when the order is placed" means;
 *   * it is APPROVED out of Pending (PATCH /orders/:id/status -> Preparing),
 *     which is when an order placed under auto-push-off reaches the kitchen;
 *   * it is BARKED, which now only ever prints an order the two paths above did
 *     not already ticket.
 *
 * WHY IT DOES NOT PRINT A PENDING ORDER, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------
 * With auto-push off, an order is created Pending (status 8) and a staffer must
 * accept it. That gate exists so the kitchen is not committed to food nobody
 * approved — and A DOCKET ON THE PASS IS THE COMMITMENT. Printing on placement
 * regardless would hand the kitchen every unapproved order and leave the accept
 * button decorating a decision the printer had already made. So the gate is read
 * here, from the order row itself, and the approval transition is a print
 * trigger in its own right. Under auto-push ON — the default, and how nearly
 * every fielded outlet runs — no order is ever Pending and placement always
 * prints, which is exactly what was asked for.
 *
 * WHY A PARTIAL DOCKET NEEDS `only` + `scope`
 * -------------------------------------------
 * Adding a line to an order already on the pass must print THE ADDED LINE. The
 * caller passes it in `only` (the order's other lines are already cooked or
 * cooking) and the line's id in `scope`, which is what keeps two separate "add a
 * Gulab Jamun" presses from hashing to one ticket and losing the second sweet.
 *
 * WHY A FAILURE HERE MUST NOT FAIL THE CALLER
 * -------------------------------------------
 * By the time this runs the order EXISTS — it is committed, it is on the KDS,
 * the guest has been told it was accepted. A printer problem, an unreadable menu
 * or an unapplied migration cannot be allowed to roll that back or turn a
 * successful order into a 400, because the alternative is a guest told their
 * order failed while the row sits in the database. So this returns an outcome
 * the response reports and never throws.
 */
export async function autoPrintOrderKot(opts: {
  restaurantId: string;
  orderId: string;
  /** Names the trigger in the log line: "order_placed", "order_approved", … */
  where: string;
  /** Print only these lines. Absent = the order's whole item set. */
  only?: KotLine[];
  /** Ticket-key discriminator for a partial docket. See kotTicketKey. */
  scope?: string | null;
  /**
   * Default TRUE, because every caller of this function is an automatic
   * trigger. A partial docket passes false: its scope already makes it unique,
   * and suppressing it would drop a line the kitchen has never seen.
   */
  skipIfTicketed?: boolean;
}): Promise<AutoKotOutcome> {
  const { restaurantId, orderId } = opts;
  try {
    const settings = await GetRestaurantSettings(restaurantId);
    // DEFAULT ON. kot_auto_print is NULL for every tenant that predates
    // migration 040 and GetRestaurantSettings reads NULL as true, so the
    // feature is live without anyone opting in — which is the point.
    if (settings.kot_auto_print === false) {return { printed: false, kot_no: null, tickets: 0, reason: "disabled" };}

    const order = await GetOrderKotContext(restaurantId, orderId);
    if (!order) {return { printed: false, kot_no: null, tickets: 0, reason: "order_not_found" };}
    if (!order.outlet_id) {return { printed: false, kot_no: null, tickets: 0, reason: "no_outlet" };}
    // THE APPROVAL GATE. Not yet accepted to the kitchen, so the kitchen is not
    // told. The accept transition calls back in here.
    if (order.awaiting_approval) {return { printed: false, kot_no: null, tickets: 0, reason: "awaiting_approval" };}

    const items = opts.only ?? order.items;
    // An order with no lines has nothing for the kitchen to cook. Printing an
    // empty docket would burn a KOT number on a blank piece of paper.
    if (items.length === 0) {return { printed: false, kot_no: null, tickets: 0, reason: "no_items" };}

    const [profile, waiterCtx] = await Promise.all([
      GetRestaurantProfile(restaurantId).catch(() => null),
      order.table_name ? GetTableFeedbackContext(restaurantId, order.table_name).catch(() => null) : Promise.resolve(null),
    ]);
    const waiterName = (waiterCtx?.employee_name ?? "").trim();
    const waiterRole = (waiterCtx?.employee_role ?? "").trim().toLowerCase();

    const dispatched = await dispatchKot({
      restaurantId,
      outletId: order.outlet_id,
      tableName: order.table_name,
      tableId: order.table_id,
      section: order.section,
      covers: order.covers,
      isVirtual: order.is_virtual,
      orderType: order.order_type,
      items,
      assignedTo: waiterName || null,
      captain: waiterName && (waiterRole === "captain" || waiterRole === "manager") ? waiterName : null,
      // The whole-order instruction, straight from the order this docket is
      // for. A partial docket (opts.only) carries it too: the note qualifies
      // the order, and a fired course is still part of that order.
      orderNote: order.order_note,
      // The same shape POST /print/kot/order/:id uses, so a docket and its
      // later reprint group together in "PrintJobs".
      billId: `order-${order.order_id}`,
      restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
      currency: settings.currency ?? "\u20b9",
      cols: settings.bill_paper_width === "58mm" ? 32 : 48,
      tz: settings.timezone || "Asia/Kolkata",
      scope: opts.scope ?? null,
      skipIfTicketed: opts.skipIfTicketed ?? true,
    });
    logKotDispatched(opts.where, dispatched, { resId: restaurantId, outletId: order.outlet_id, orderId });
    if (dispatched.skipped) {
      return { printed: false, kot_no: dispatched.kotNo, tickets: 0, reason: "already_printed" };
    }
    return { printed: true, kot_no: dispatched.kotNo, tickets: dispatched.tickets };
  } catch (err) {
    // Loud, because a kitchen that stops getting dockets has to be findable
    // in the logs — but never fatal to the order that already exists.
    logger.error({ err, orderId, restaurantId, where: opts.where }, "order_auto_print_failed");
    return { printed: false, kot_no: null, tickets: 0, reason: "print_failed" };
  }
}

// --- the cancellation slip ---------------------------------------------------

/**
 * WHAT THE KITCHEN SEES WHEN FOOD STOPS BEING COOKED.
 *
 * THE FAILURE MODE THIS CLOSES
 * ----------------------------
 * Cancelling is instant and complete on every screen: the KDS card goes, the
 * table clears, the bill drops the money. PAPER DOES NOT RE-RENDER. The docket
 * the kitchen is cooking from is still on the rail and nothing that happens in
 * the database will ever take it off, so the dish is cooked, plated and called —
 * for a table that is not expecting it, or has already left. The restaurant eats
 * the cost, and the waiter who cancelled believes they stopped it.
 *
 * It is the same screens-and-paper disagreement kot_move.ts exists for, with a
 * worse ending: a move sends food to the wrong table, where somebody at least
 * notices; a cancel sends food nowhere at all.
 *
 * IT MUST NOT ALLOCATE A KOT NUMBER, AND THAT IS THE DESIGN CONSTRAINT
 * -------------------------------------------------------------------
 * allocateKotNumber is GAPLESS per outlet-day and the kitchen counts tickets by
 * it. Minting a number for a slip that cancels a ticket would do two wrong
 * things at once: put an entry in the day's sequence for a docket nobody ordered
 * (214, 215, 216-is-a-cancellation, 217 — and the pass now believes 216 is
 * food), and print a number that names no ticket on the rail, which is exactly
 * the number a chef would go looking for. So the number is RESOLVED, by a pure
 * read of migration 029's memo (LookupKotNumber), and pinned; where it cannot be
 * resolved the slip prints with NO number, which is honest, rather than with the
 * next one, which is a lie about an existing ticket. `pinnedKotNo` alone is not
 * enough to guarantee that — a null pin falls through to allocation — hence
 * `neverAllocate`.
 *
 * WHY A PENDING ORDER PRINTS NOTHING
 * ----------------------------------
 * autoPrintOrderKot refuses to print an order still awaiting approval, because
 * paper on the pass IS the kitchen being told and the approval gate exists so
 * the kitchen is not committed to food nobody approved. An order cancelled while
 * still Pending was therefore NEVER on the rail, and a slip cancelling a docket
 * that does not exist is not a correction — it is a piece of paper about an
 * order the kitchen has never heard of, which is the one thing more confusing
 * than no paper at all. Every OTHER state prints, numbered when the number is
 * resolvable and unnumbered when it is not.
 *
 * WHY IT CARRIES NO ORDER NOTE
 * ----------------------------
 * An ordinary docket carries "Orders".food.note because it tells the kitchen how
 * to cook the food. This one tells them not to. Reprinting the allergy under a
 * CANCELLED banner is at best noise and at worst read as an instruction.
 *
 * NOTHING HERE MAY THROW AT THE CALLER
 * ------------------------------------
 * By the time this runs the cancellation is COMMITTED — the money is off the
 * bill, the row says Cancelled, the floor has been told. A printer that is
 * unreachable, a menu that will not load or an unapplied migration must not turn
 * a completed void into a failed request, because the alternative is a waiter
 * told the cancel failed while the order is already gone, who then cancels it
 * again. Same contract as autoPrintOrderKot: the outcome is returned and
 * reported, never raised.
 */

/** The order facts a slip needs, exactly as GetOrderKotContext hands them over. */
export type OrderKotContext = NonNullable<Awaited<ReturnType<typeof GetOrderKotContext>>>;

export interface CancellationKotOutcome {
  /** True when a slip was built and queued by this call. */
  printed: boolean;
  /** The number of the ticket being cancelled, when it could be resolved. */
  kot_no: number | null;
  /** How many station slips the cancellation became. */
  tickets: number;
  /** Why nothing printed. Absent when something did. */
  reason?: string;
}

/**
 * The line at the very top of the slip.
 *
 * THE WORD IS NO LONGER PRINTED TWICE, and the reason it briefly was is worth
 * keeping. This line used to read "*** CANCELLED - <REASON> ***" because
 * ReceiptOptions.cancelled did not exist yet: the two halves were built in
 * different lanes, and a slip that failed to say CANCELLED is a docket the
 * kitchen cooks from, so saying it twice was the cheap side of that trade while
 * the banner was in doubt. The banner has landed, in the biggest type the
 * printer has, above everything else on the ticket — so this line carries the
 * REASON alone. Two shouts compete; one shout and one explanation do not.
 *
 * If the banner is ever removed, restore the word here in the same commit.
 *
 * TRUNCATED TO THE PAPER, because the renderer prints the context line verbatim
 * and a thermal printer hard-wraps an over-wide line mid-word — turning the one
 * line that has to be unmissable into two ragged halves. The full reason is on
 * the "OrderVoids" row and in the audit log; the slip only has to tell the pass
 * enough to stop cooking.
 */
function cancellationBanner(reason: string | null | undefined, cols: number): string {
  const detail = (reason ?? "").trim().replace(/[_\s]+/g, " ").toUpperCase();
  // No reason given: the banner above has already said everything there is to
  // say, so this line is omitted rather than printed empty or restated.
  if (!detail) {return "";}
  const room = cols - "*** REASON:  ***".length;
  if (room < 4) {return "";}
  return `*** REASON: ${detail.length > room ? `${detail.slice(0, room - 1)}…` : detail} ***`;
}

/**
 * The number already on the paper this slip cancels, or null.
 *
 * A PURE READ, ALWAYS. Every candidate goes through LookupKotNumber, which does
 * not mint — see its header, and see the constraint at the top of this section.
 *
 * TWO CANDIDATE KEYS, TRIED IN ORDER OF PRECISION:
 *
 *   1. THE ADDED-LINE TICKET. POST /orders/:id/items dispatches a docket for the
 *      one line it added, keyed with that line's id as `scope`. So a line
 *      cancelled by DELETE /orders/:id/items/:itemId is looked up under exactly
 *      that key first — it is the ticket the kitchen is actually holding for it.
 *
 *   2. THE WHOLE-ORDER TICKET, keyed over the order's full item set with no
 *      scope: the docket autoPrintOrderKot printed at placement or approval.
 *
 * WHY EITHER CAN MISS, AND WHY A MISS IS NOT AN ERROR. The ticket key is a
 * fingerprint of the item SET, so an order that has been edited since it printed
 * (a line added, a quantity changed) no longer hashes to the key its docket was
 * minted under. There is no column joining a KOT number back to an order, so
 * there is nothing else to ask. The slip then prints unnumbered — which still
 * names the table and the dishes, and is what the requirement asks for.
 *
 * WHEN "PrintJobs".kot_no LANDS, this is where it goes: the jobs for this order
 * are already grouped under bill_id `order-<id>`, so the distinct kot_no across
 * them is a direct, edit-proof answer and becomes candidate 0. Nothing else in
 * this function needs to change.
 */
async function resolveCancelledKotNumber(
  restaurantId: string,
  order: OrderKotContext,
  opts: { cancelledLines: KotLine[]; itemId?: string | null; firedAt: Date; tz: string },
): Promise<number | null> {
  if (!order.table_id) {return null;}
  const itemId = (opts.itemId ?? "").trim();
  const candidates: { items: KotLine[]; scope: string | null }[] = [];
  if (itemId) {candidates.push({ items: opts.cancelledLines, scope: itemId });}
  candidates.push({ items: order.items, scope: null });

  for (const candidate of candidates) {
    if (candidate.items.length === 0) {continue;}
    const key = buildKotTicketKey({
      outletId: order.outlet_id,
      tableId: order.table_id,
      items: candidate.items,
      firedAt: opts.firedAt,
      tz: opts.tz,
      scope: candidate.scope,
    });
    // Numbering unreadable (migration 029 unapplied, or its grants missing) is
    // "cannot tell", not "no ticket" — and it degrades to the same unnumbered
    // slip a miss does, so one warn covers both without failing the print.
    const hit = await LookupKotNumber(restaurantId, key, opts.firedAt).catch((err: unknown) => {
      logger.warn({ err, orderId: order.order_id }, "cancellation_kot_number_lookup_failed");
      return null;
    });
    if (hit) {return hit.kot_no;}
  }
  return null;
}

/**
 * Put a CANCELLED slip on the pass for an order, or for one of its lines.
 *
 * `order` may be supplied by the caller, and for DELETE /orders/:id it MUST be:
 * that route destroys the row, so the only moment its items, table and covers
 * can be read is before the delete. Every other caller can leave it out and the
 * order is re-read here.
 *
 * `only` + `itemId` narrow the slip to a single cancelled line. Omit both and
 * the slip covers the whole order.
 */
export async function dispatchCancellationKot(opts: {
  restaurantId: string;
  orderId: string;
  /** Names the trigger in the log line: "order_cancelled", "order_voided", … */
  where: string;
  /** Pre-read order facts, for a caller whose write destroys or edits them. */
  order?: OrderKotContext | null;
  /** Cancel only these lines. Absent = the order's whole item set. */
  only?: KotLine[];
  /** The cancelled line's id, for an item-scoped slip. See resolveCancelledKotNumber. */
  itemId?: string | null;
  /** Why, when the path that cancelled recorded one. Printed on the banner. */
  reason?: string | null;
  /**
   * The order's status BEFORE the cancel, where the caller knows it. "Pending"
   * suppresses the slip — see the approval-gate note above. A caller that passes
   * a pre-read `order` does not need it: its awaiting_approval says the same
   * thing.
   */
  previousStatus?: string | null;
}): Promise<CancellationKotOutcome> {
  const { restaurantId, orderId } = opts;
  try {
    const settings = await GetRestaurantSettings(restaurantId);
    // The same switch that governs every automatic docket (migration 040). A
    // restaurant that calls its orders verbally and prints on demand has no
    // paper on the pass to cancel.
    if (settings.kot_auto_print === false) {return { printed: false, kot_no: null, tickets: 0, reason: "disabled" };}

    const order = opts.order ?? await GetOrderKotContext(restaurantId, orderId);
    if (!order) {return { printed: false, kot_no: null, tickets: 0, reason: "order_not_found" };}
    if (!order.outlet_id) {return { printed: false, kot_no: null, tickets: 0, reason: "no_outlet" };}
    // THE APPROVAL GATE, READ BACKWARDS. Never ticketed means nothing to cancel.
    // Both readings are needed: a pre-read context still carries status 8, while
    // a route that has already flipped the row to Cancelled can only report what
    // the status USED to be.
    const wasPending = order.awaiting_approval
      || (opts.previousStatus ?? "").trim().toLowerCase() === "pending";
    if (wasPending) {return { printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" };}

    const cancelledLines = opts.only ?? order.items;
    // Nothing came off the pass, so there is nothing to say. An empty CANCELLED
    // slip is a docket the kitchen cannot act on.
    if (cancelledLines.length === 0) {return { printed: false, kot_no: null, tickets: 0, reason: "no_items" };}

    const tz = settings.timezone || "Asia/Kolkata";
    const cols = settings.bill_paper_width === "58mm" ? 32 : 48;
    const firedAt = new Date();
    const kotNo = await resolveCancelledKotNumber(restaurantId, order, {
      cancelledLines, itemId: opts.itemId ?? null, firedAt, tz,
    });

    const [profile, waiterCtx] = await Promise.all([
      GetRestaurantProfile(restaurantId).catch(() => null),
      order.table_name ? GetTableFeedbackContext(restaurantId, order.table_name).catch(() => null) : Promise.resolve(null),
    ]);
    const waiterName = (waiterCtx?.employee_name ?? "").trim();
    const waiterRole = (waiterCtx?.employee_role ?? "").trim().toLowerCase();

    const dispatched = await dispatchKot({
      restaurantId,
      outletId: order.outlet_id,
      tableName: order.table_name,
      tableId: order.table_id,
      section: order.section,
      covers: order.covers,
      isVirtual: order.is_virtual,
      orderType: order.order_type,
      // The cancelled lines, and their stations. Routing by station is what
      // sends the slip to the kitchen that is cooking the food rather than to
      // the bill printer — cancelling a cocktail has to reach the bar.
      items: cancelledLines,
      assignedTo: waiterName || null,
      captain: waiterName && (waiterRole === "captain" || waiterRole === "manager") ? waiterName : null,
      // Deliberately not carried. See "WHY IT CARRIES NO ORDER NOTE" above.
      orderNote: null,
      // Grouped with the order's other print jobs, so the slip and the docket it
      // cancels sit together in "PrintJobs".
      billId: `order-${order.order_id}`,
      restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
      currency: settings.currency ?? "₹",
      cols,
      tz,
      firedAt,
      // Resolved, never minted — and null is a legitimate answer that must NOT
      // fall through to allocation. Both halves of that are load-bearing.
      pinnedKotNo: kotNo,
      neverAllocate: true,
      cancelled: true,
      contextLine: cancellationBanner(opts.reason, cols),
      // Never suppressed. This is by definition a docket whose content "has
      // already been ticketed today" — that is the reason it is printing.
      skipIfTicketed: false,
    });
    logKotDispatched(opts.where, dispatched, { resId: restaurantId, outletId: order.outlet_id, orderId, cancelled: true });
    return { printed: dispatched.tickets > 0, kot_no: kotNo, tickets: dispatched.tickets };
  } catch (err) {
    // Loud, because a kitchen that keeps cooking cancelled food has to be
    // findable in the logs — but never fatal to a void that already committed.
    logger.error({ err, orderId, restaurantId, where: opts.where }, "cancellation_print_failed");
    return { printed: false, kot_no: null, tickets: 0, reason: "print_failed" };
  }
}
