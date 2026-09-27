/**
 * WHAT THE KITCHEN SEES WHEN AN ORDER IS MOVED TO ANOTHER TABLE.
 *
 * THE PROBLEM THIS FILE EXISTS FOR
 * --------------------------------
 * Moving an order between tables is a database write and, on the screens, it is
 * instant and complete: the KDS card re-renders with the new table, the bill
 * follows, the floor plan repaints. Paper does not re-render. If the docket has
 * already printed, the pass is holding a ticket that says T4 for food that is
 * going to T7, and NOTHING on the pass will ever say otherwise.
 *
 * That is a worse outcome than the mistake being corrected. The original error
 * was one ticket on the wrong table, which a waiter notices when they carry the
 * plates out. A silent move produces a ticket on the wrong table that the SYSTEM
 * now believes is right - so the screens and the paper disagree, and whichever
 * one the kitchen trusts, the other is wrong. The expo calls "26, table four",
 * the runner takes it to table four, and the guests at table four did not order
 * it.
 *
 * SO: A CORRECTION DOCKET, AND ONLY WHEN THERE IS PAPER TO CORRECT
 * ---------------------------------------------------------------
 * There are exactly two states and they get different answers:
 *
 *   * THE ORDER HAS ALREADY BEEN TICKETED TODAY. The kitchen physically holds
 *     that docket. A correction prints: the SAME KOT NUMBER, the NEW table in
 *     the big type the renderer already gives the table line, a context line at
 *     the very top saying which table it used to be - and NO DISH LIST. The
 *     pass can then find the ticket it names and re-address it.
 *
 *   * IT HAS NEVER BEEN TICKETED. There is no paper, so there is nothing to
 *     correct, and printing now would put a docket on the pass for an order the
 *     kitchen has deliberately not been told about yet (an order still awaiting
 *     approval is the ordinary case - see autoPrintOrderKot's approval gate).
 *     Nothing prints. The normal trigger prints it later, at the right table,
 *     with the right number.
 *
 * WHY IT REUSES THE ORIGINAL NUMBER, AND WHY THAT NEEDED A LOOKUP THAT DOES NOT
 * ALLOCATE. The number is how a chef pairs two pieces of paper. "KOT-26: now
 * table 7" can be acted on; a fresh KOT-31 for the same food is just a second
 * order as far as the pass can tell, and the kitchen cooks it twice. Reading the
 * number therefore has to be a pure read - asking AllocateKotNumber would MINT a
 * number for the never-ticketed case above, burning it on a docket that is not
 * going to print and leaving a hole in the day's sequence. Hence
 * LookupKotNumber.
 *
 * WHY THE OLD TABLE'S ID IS WHAT THE KEY IS BUILT FROM. A KOT's identity is
 * (outlet, business day, TABLE, item set) - so the ticket the kitchen holds is
 * keyed to the table the order was on when it printed. By the time this runs the
 * order has already moved, so the caller passes the FORMER table id explicitly.
 * Building the key from the order's current table would look up a ticket that
 * has never existed and conclude, wrongly, that the kitchen has no paper.
 *
 * WHY IT CARRIES NO DISH LIST - CLIENT ITEM 6
 * -------------------------------------------
 * It used to. The correction was the ORDINARY docket with a context line on top,
 * which is the shape the cancellation slip deliberately keeps (a cancellation is
 * matched to its paper by the dishes on it). The client's sheet says what that
 * costs: "after we move a table, the entire order of the table gets reprinted,
 * which the kitchen will consider a new order during busy times." They are
 * right, and the reason is that a numbered dish list under a KOT header IS an
 * order to a pass reading forty of them an hour - the one line of context above
 * it loses to seven lines of food below it.
 *
 * A move correction does not need the list. Its whole job is to re-address paper
 * the kitchen is already holding, and the handle for that is the NUMBER, which
 * this file has always been careful to reuse for exactly that reason. So the
 * docket now says, in the biggest type the printer has, that the table moved;
 * then which ticket(s), where from, where to; and nothing else. See
 * ReceiptOptions.moved in escpos.ts for the layout.
 *
 * WHY THE ITEMS ARE STILL PASSED TO dispatchKot. They decide the STATION SPLIT
 * (withStations -> groupKotItemsByStation -> one docket per station, each aimed
 * by print_routing.ts). A ticket that printed at the tandoor and at the bar is
 * two pieces of paper on two rails, so it takes two corrections; a restaurant
 * that routes nothing gets the single "General" docket it gets for everything
 * else. Deriving that from the items rather than from a station list of our own
 * is what keeps the correction's fan-out identical to the original ticket's.
 *
 * NOTHING HERE MAY THROW AT THE CALLER. The move is committed by the time this
 * runs. A printer that is unreachable, a menu that will not load, an unapplied
 * migration - none of them can be allowed to turn a completed correction into a
 * failed request, because the alternative is staff being told the move failed
 * while the order sits on the new table. The outcome is returned and reported;
 * see POST /tables/move-order.
 */

import { buildKotTicketKey, dispatchKot, resolveCancelledKotNumber, type KotLine } from "./kot_print.js";
import { logger } from "./observability.js";
import {
  GetOrderKotContext,
  GetOrderKotNumbers,
  GetRestaurantProfile,
  GetRestaurantSettings,
  GetTableFeedbackContext,
  LookupKotNumber,
} from "./database_supabase.js";

export interface KotMoveOutcome {
  /** True when a correction docket was built and queued. */
  printed: boolean;
  /** The number on the paper being corrected, when there was any. */
  kot_no: number | null;
  /** How many station dockets the correction became. */
  tickets: number;
  /** Why nothing printed. Absent when something did. */
  reason?: string;
  /**
   * EVERY number the correction re-addressed, when the move carried more than
   * one ticket (a whole party). Absent on a single-ticket move, whose one
   * number is `kot_no` — so every existing reader of this shape is untouched.
   */
  kot_nos?: number[];
}

/**
 * THE FIRST LINE A CHEF READS ON A CORRECTION, and it has to answer both halves
 * of "what happened" — which table this paper used to be for, and which it is
 * for now.
 *
 * IT NAMES BOTH ENDS, where it used to name only the source ("*** TABLE CHANGED
 * - WAS 12 ***"). The destination IS on the docket, in the biggest type on it,
 * but the line that is read first should not need the eye to travel to complete
 * the sentence — and a docket with no dish list under it has room to say so.
 *
 * UPPER-CASED AND STARRED because it is read at a glance off a rail, next to a
 * dozen ordinary dockets, which is the same reason the cancellation slip's
 * reason line is.
 */
export const movedContextLine = (fromTable: string, toTable: string): string =>
  `*** WAS ${fromTable.trim().toUpperCase()} - NOW ${toTable.trim().toUpperCase()} ***`;

/**
 * Put a correction docket on the pass for an order that has just been moved to
 * another table.
 *
 * `previousTableId` and `previousTableName` are the table the order was on
 * BEFORE the move - the caller has them from MoveOrderToTable's result. The
 * order itself is re-read here so the items, covers, section and channel are the
 * ones that are true now.
 */
export async function printKotTableChange(opts: {
  restaurantId: string;
  orderId: string;
  previousTableId: string;
  previousTableName: string;
}): Promise<KotMoveOutcome> {
  const { restaurantId, orderId } = opts;
  try {
    const settings = await GetRestaurantSettings(restaurantId);
    // The same switch that governs every automatic docket (migration 040). A
    // restaurant that calls its orders verbally and prints on demand does not
    // want an automatic correction either; its pass has no paper to correct.
    if (settings.kot_auto_print === false) {return { printed: false, kot_no: null, tickets: 0, reason: "disabled" };}

    const order = await GetOrderKotContext(restaurantId, orderId);
    if (!order) {return { printed: false, kot_no: null, tickets: 0, reason: "order_not_found" };}
    if (!order.outlet_id) {return { printed: false, kot_no: null, tickets: 0, reason: "no_outlet" };}
    if (order.items.length === 0) {return { printed: false, kot_no: null, tickets: 0, reason: "no_items" };}

    const tz = settings.timezone || "Asia/Kolkata";
    const firedAt = new Date();
    // The ticket as the KITCHEN knows it: keyed to the table it printed from.
    const priorKey = buildKotTicketKey({
      outletId: order.outlet_id,
      tableId: opts.previousTableId,
      items: order.items,
      firedAt,
      tz,
      scope: null,
    });
    const prior = await LookupKotNumber(restaurantId, priorKey, firedAt).catch((err: unknown) => {
      // Numbering unreadable (migration 029 unapplied, or its grants missing).
      // "Cannot tell" is treated as "no paper": a correction with no number on
      // it names nothing the pass can find, so it would be one more anonymous
      // docket rather than a correction.
      logger.warn({ err, orderId }, "kot_move_number_lookup_failed");
      return null;
    });
    if (!prior) {
      return { printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" };
    }

    const [profile, waiterCtx] = await Promise.all([
      GetRestaurantProfile(restaurantId).catch(() => null),
      order.table_name ? GetTableFeedbackContext(restaurantId, order.table_name).catch(() => null) : Promise.resolve(null),
    ]);
    const waiterName = (waiterCtx?.employee_name ?? "").trim();
    const waiterRole = (waiterCtx?.employee_role ?? "").trim().toLowerCase();

    const items: KotLine[] = order.items;
    const dispatched = await dispatchKot({
      restaurantId,
      outletId: order.outlet_id,
      // The NEW table, printed in the biggest type on the docket - it is the one
      // thing the kitchen has to end up believing.
      tableName: order.table_name,
      tableId: order.table_id,
      section: order.section,
      covers: order.covers,
      isVirtual: order.is_virtual,
      orderType: order.order_type,
      // NOT PRINTED - see the header. They are here because they are what the
      // station split is computed from, so the correction reaches exactly the
      // rails the original ticket did.
      items,
      assignedTo: waiterName || null,
      captain: waiterName && (waiterRole === "captain" || waiterRole === "manager") ? waiterName : null,
      // NO ORDER NOTE, for the reason the cancellation slip gives for dropping
      // it: this docket does not ask for food to be cooked, so an instruction
      // about how to cook it is at best noise. The allergy is still on the
      // ticket the kitchen is holding - this one only re-addresses it.
      orderNote: null,
      billId: `order-${order.order_id}`,
      restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
      currency: settings.currency ?? "₹",
      cols: settings.bill_paper_width === "58mm" ? 32 : 48,
      tz,
      firedAt,
      // The number already on the pass, and the line that tells a chef what this
      // piece of paper is for.
      pinnedKotNo: prior.kot_no,
      contextLine: movedContextLine(opts.previousTableName, order.table_name),
      // The banner and the missing dish list - client item 6.
      moved: true,
      // Never suppressed. A correction is exactly the docket whose content
      // "has already been ticketed today" - that is the reason it is printing.
      skipIfTicketed: false,
    });
    logger.info(
      { res_id: restaurantId, outlet_id: order.outlet_id, order_id: orderId, kot_no: prior.kot_no, tickets: dispatched.tickets, from: opts.previousTableName, to: order.table_name },
      "kot_table_change_printed",
    );
    return { printed: dispatched.tickets > 0, kot_no: prior.kot_no, tickets: dispatched.tickets };
  } catch (err) {
    logger.error({ err, orderId, restaurantId }, "kot_table_change_print_failed");
    return { printed: false, kot_no: null, tickets: 0, reason: "print_failed" };
  }
}

// ---------------------------------------------------------------------------
// A WHOLE PARTY MOVED TO ANOTHER TABLE (POST /tables/move) — client item 6.
// ---------------------------------------------------------------------------
//
// THE HALF THAT WAS MISSING ENTIRELY. POST /tables/move-order has told the
// kitchen since item 22. POST /tables/move — the one the floor actually presses,
// "Move table", the whole party and everything they own — told it NOTHING. The
// party arrives at 20 and every docket on the rail still says 12, with no paper
// anywhere that says otherwise and a system that now believes 12 is wrong.
//
// It is the same act as a one-ticket move, N tickets wide, so it prints the same
// correction — with one deliberate difference: ONE DOCKET FOR THE WHOLE MOVE,
// naming every KOT number that travelled, rather than one slip per ticket. The
// party moved once, to one table, at one moment; three near-identical slips for
// three rounds is three things to collate at the pass, which is the volume
// problem item 6 is about. "KOT - 5, 7, 9: was 12, now 20" is one thing to read
// and three tickets to re-address.
//
// PER STATION, THOUGH — and that fan-out is not ours to choose. The union of
// every moved ticket's lines is handed to dispatchKot, which splits it exactly
// as it split the originals, so the bar gets a correction if and only if the bar
// is holding paper.
//
// NEVER-TICKETED ORDERS ARE NOT IN IT. A party mid-service normally has both:
// three rounds on the rail and a fourth still awaiting approval. The fourth has
// no paper to correct and no business on this docket — it prints, later, at the
// right table, in the ordinary way. A party with NOTHING on the rail prints
// nothing at all.

/**
 * Put ONE correction docket on the pass for a party that has just been moved,
 * naming every ticket that moved with them.
 *
 * `orderIds` are MoveTableParty's `moved_order_ids` and `previousTableId` /
 * `previousTableName` the table they were on BEFORE it — the key a ticket was
 * minted under is built from the table it printed from, so the current one
 * would look up paper that has never existed. Same contract as
 * printKotTableChange: never throws, because the party has already moved.
 */
export async function printKotPartyMove(opts: {
  restaurantId: string;
  orderIds: readonly string[];
  previousTableId: string;
  previousTableName: string;
}): Promise<KotMoveOutcome> {
  const { restaurantId } = opts;
  try {
    if (opts.orderIds.length === 0) {return { printed: false, kot_no: null, tickets: 0, reason: "no_orders" };}
    const settings = await GetRestaurantSettings(restaurantId);
    // The same switch that governs every automatic docket (migration 040).
    if (settings.kot_auto_print === false) {return { printed: false, kot_no: null, tickets: 0, reason: "disabled" };}

    const tz = settings.timezone || "Asia/Kolkata";
    const firedAt = new Date();

    // WHICH OF THE PARTY'S TICKETS THE KITCHEN IS ACTUALLY HOLDING. A pure read
    // per order, for the reason LookupKotNumber exists: asking must never MINT,
    // or a party with four unticketed rounds would burn four numbers on paper
    // that never prints.
    const held: { order: NonNullable<Awaited<ReturnType<typeof GetOrderKotContext>>>; kotNo: number }[] = [];
    for (const orderId of opts.orderIds) {
      const order = await GetOrderKotContext(restaurantId, orderId).catch(() => null);
      if (!order || !order.outlet_id || order.items.length === 0) {continue;}
      // Awaiting approval = deliberately never told to the kitchen.
      if (order.awaiting_approval) {continue;}
      const priorKey = buildKotTicketKey({
        outletId: order.outlet_id,
        tableId: opts.previousTableId,
        items: order.items,
        firedAt,
        tz,
        scope: null,
      });
      const prior = await LookupKotNumber(restaurantId, priorKey, firedAt).catch((err: unknown) => {
        // "Cannot tell" is treated as "no paper" — see printKotTableChange.
        logger.warn({ err, orderId }, "kot_move_number_lookup_failed");
        return null;
      });
      if (prior) {held.push({ order, kotNo: prior.kot_no });}
    }
    if (held.length === 0) {
      return { printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" };
    }

    const first = held[0]!.order;
    // In allocation order, deduplicated: two rounds of the identical item set
    // share one ticket key and therefore one number, and "KOT - 5, 5" would have
    // the pass hunting for a second piece of paper that was never fired.
    const kotNos = [...new Set(held.map((h) => h.kotNo))].sort((a, b) => a - b);
    // Not printed — the station split, and nothing else. See the file header.
    const items: KotLine[] = held.flatMap((h) => h.order.items);

    const [profile, waiterCtx] = await Promise.all([
      GetRestaurantProfile(restaurantId).catch(() => null),
      first.table_name ? GetTableFeedbackContext(restaurantId, first.table_name).catch(() => null) : Promise.resolve(null),
    ]);
    const waiterName = (waiterCtx?.employee_name ?? "").trim();
    const waiterRole = (waiterCtx?.employee_role ?? "").trim().toLowerCase();

    const dispatched = await dispatchKot({
      restaurantId,
      outletId: first.outlet_id,
      // The destination, in the biggest type on the docket. Every moved order is
      // on it by now — the move committed before this ran — so any of them says
      // the same thing.
      tableName: first.table_name,
      tableId: first.table_id,
      section: first.section,
      covers: first.covers,
      isVirtual: first.is_virtual,
      orderType: first.order_type,
      items,
      assignedTo: waiterName || null,
      captain: waiterName && (waiterRole === "captain" || waiterRole === "manager") ? waiterName : null,
      // No order note, for the reason printKotTableChange gives.
      orderNote: null,
      // Filed under the first moved order, so the slip sits with the dockets it
      // corrects in "PrintJobs" and migration 043 reads back the number it
      // already knew for that order rather than a new one.
      billId: `order-${first.order_id}`,
      restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
      currency: settings.currency ?? "₹",
      cols: settings.bill_paper_width === "58mm" ? 32 : 48,
      tz,
      firedAt,
      pinnedKotNo: kotNos[0]!,
      movedKots: kotNos,
      moved: true,
      contextLine: movedContextLine(opts.previousTableName, first.table_name),
      skipIfTicketed: false,
    });
    logger.info(
      { res_id: restaurantId, outlet_id: first.outlet_id, order_ids: opts.orderIds, kot_nos: kotNos, tickets: dispatched.tickets, from: opts.previousTableName, to: first.table_name },
      "kot_party_move_printed",
    );
    return { printed: dispatched.tickets > 0, kot_no: kotNos[0]!, kot_nos: kotNos, tickets: dispatched.tickets };
  } catch (err) {
    logger.error({ err, restaurantId, tables: `${opts.previousTableName} ->` }, "kot_party_move_print_failed");
    return { printed: false, kot_no: null, tickets: 0, reason: "print_failed" };
  }
}

// ---------------------------------------------------------------------------
// ONE DISH MOVED TO ANOTHER TABLE (POST /bills/move-item) — client item 4.
// ---------------------------------------------------------------------------
//
// THE SAME PROBLEM AS A WHOLE-ORDER MOVE, ONE DISH WIDE. The pass holds a
// docket that says 31A for a dish now going to 31. The move used to print
// nothing and attach no number, so the dish sat on the destination in the "No
// KOT number" group and showed on the kitchen board as a fresh, unnumbered
// ticket — to the kitchen, a second order for food it was already cooking.
//
// So, exactly as above: the number the kitchen knows the dish by is RESOLVED
// (never minted) BEFORE the move, because the source ticket's key is a
// fingerprint of its item set and stops matching the moment a line leaves; and
// after the move a docket prints for the moved dish alone, under that number,
// on the new table, headed "*** MOVED FROM 31A ***". It is grouped under the
// NEW order's `order-<id>`, so migration 043 attributes the number to it and
// the dish lands in a numbered block on both clients. Never ticketed = no paper
// to correct = nothing prints.

/** One source order a dish move will take lines from, as read before the move. */
export interface MoveItemSource {
  order_id: string;
  /** The matched lines, whole, as they stand on the source order. */
  lines: Record<string, unknown>[];
}

const lineText = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A stored line as the add-item docket keyed it (see DELETE /orders/:id/items/:itemId). */
function kotLineOf(raw: Readonly<Record<string, unknown>>): KotLine {
  const note = lineText(raw.note);
  const variation = lineText(raw.variation_name);
  const menuId = lineText(raw.menu_id);
  return {
    name: typeof raw.name === "string" ? raw.name : "Item",
    quantity: Number(raw.quantity ?? 1),
    price: Number(raw.price ?? 0),
    ...(note ? { note } : {}),
    ...(variation ? { variation } : {}),
    ...(menuId ? { menu_id: menuId } : {}),
  };
}

/**
 * The KOT number the kitchen knows each source ticket by — a PURE READ, made
 * before the move. Per source order:
 *
 *   1. the ticket key (resolveCancelledKotNumber: the added-line docket for a
 *      single moved line, then the whole-order docket), which names the exact
 *      paper the dish is on;
 *   2. failing that, the first number PrintJobs attributes to the order
 *      (migration 043) — edit-proof, and the placement docket, which is where
 *      a dish that was not added later sits.
 *
 * An order with neither maps to []: it was never ticketed. Never throws.
 */
export async function resolveMoveSourceKots(
  restaurantId: string,
  sources: readonly MoveItemSource[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (sources.length === 0) {return out;}
  let printed = new Map<string, number[]>();
  try {
    printed = await GetOrderKotNumbers(restaurantId, sources.map((s) => s.order_id));
  } catch (err) {
    logger.warn({ err, restaurantId }, "kot_move_item_printed_numbers_failed");
  }
  let tz = "Asia/Kolkata";
  try {
    tz = (await GetRestaurantSettings(restaurantId)).timezone || tz;
  } catch {/* the tenant zone only moves the business day of the key */}
  for (const source of sources) {
    let kotNo: number | null = null;
    let pending = false;
    try {
      const order = await GetOrderKotContext(restaurantId, source.order_id);
      pending = order?.awaiting_approval === true;
      if (order && !pending) {
        const single = source.lines.length === 1 ? lineText(source.lines[0]?.id) : "";
        kotNo = await resolveCancelledKotNumber(restaurantId, order, {
          cancelledLines: source.lines.map(kotLineOf),
          itemId: single || null,
          firedAt: new Date(),
          tz,
        });
      }
    } catch (err) {
      logger.warn({ err, orderId: source.order_id }, "kot_move_item_number_lookup_failed");
    }
    const fromPrintJobs = pending ? [] : (printed.get(source.order_id) ?? []);
    out.set(source.order_id, kotNo !== null ? [kotNo] : fromPrintJobs.slice(0, 1));
  }
  return out;
}

/**
 * Print the moved dish's docket on its new table, under the number the kitchen
 * already has for it. `orderId` is the order the move CREATED on the
 * destination — its lines are exactly the dishes that moved.
 */
export async function printKotItemMove(opts: {
  restaurantId: string;
  orderId: string;
  previousTableName: string;
  kotNo: number | null;
}): Promise<KotMoveOutcome> {
  const { restaurantId, orderId } = opts;
  const kotNo = typeof opts.kotNo === "number" && opts.kotNo > 0 ? opts.kotNo : null;
  try {
    if (kotNo === null) {
      return { printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" };
    }
    const settings = await GetRestaurantSettings(restaurantId);
    // The same switch that governs every automatic docket (migration 040).
    if (settings.kot_auto_print === false) {return { printed: false, kot_no: kotNo, tickets: 0, reason: "disabled" };}
    const order = await GetOrderKotContext(restaurantId, orderId);
    if (!order) {return { printed: false, kot_no: kotNo, tickets: 0, reason: "order_not_found" };}
    if (!order.outlet_id) {return { printed: false, kot_no: kotNo, tickets: 0, reason: "no_outlet" };}
    if (order.items.length === 0) {return { printed: false, kot_no: kotNo, tickets: 0, reason: "no_items" };}
    // A Pending source was never ticketed; resolveMoveSourceKots already says
    // so, and this is the belt to that brace.
    if (order.awaiting_approval) {return { printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" };}

    const tz = settings.timezone || "Asia/Kolkata";
    const [profile, waiterCtx] = await Promise.all([
      GetRestaurantProfile(restaurantId).catch(() => null),
      order.table_name ? GetTableFeedbackContext(restaurantId, order.table_name).catch(() => null) : Promise.resolve(null),
    ]);
    const waiterName = (waiterCtx?.employee_name ?? "").trim();
    const waiterRole = (waiterCtx?.employee_role ?? "").trim().toLowerCase();
    const dispatched = await dispatchKot({
      restaurantId,
      outletId: order.outlet_id,
      // The NEW table, in the docket's biggest type.
      tableName: order.table_name,
      tableId: order.table_id,
      section: order.section,
      covers: order.covers,
      isVirtual: order.is_virtual,
      orderType: order.order_type,
      // Only the dishes that moved: the destination order holds nothing else.
      items: order.items,
      assignedTo: waiterName || null,
      captain: waiterName && (waiterRole === "captain" || waiterRole === "manager") ? waiterName : null,
      orderNote: order.order_note,
      billId: `order-${order.order_id}`,
      restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
      currency: settings.currency ?? "₹",
      cols: settings.bill_paper_width === "58mm" ? 32 : 48,
      tz,
      firedAt: new Date(),
      pinnedKotNo: kotNo,
      contextLine: `*** MOVED FROM ${opts.previousTableName.toUpperCase()} ***`,
      skipIfTicketed: false,
    });
    logger.info(
      { res_id: restaurantId, order_id: orderId, kot_no: kotNo, tickets: dispatched.tickets, from: opts.previousTableName, to: order.table_name },
      "kot_item_move_printed",
    );
    return { printed: dispatched.tickets > 0, kot_no: kotNo, tickets: dispatched.tickets };
  } catch (err) {
    logger.error({ err, orderId, restaurantId }, "kot_item_move_print_failed");
    return { printed: false, kot_no: kotNo, tickets: 0, reason: "print_failed" };
  }
}
