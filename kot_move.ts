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
 *     that docket. A correction prints: same items, same KOT number, the NEW
 *     table in the big type the renderer already gives the table line, and a
 *     context line at the very top saying which table it used to be. The pass
 *     can then find the ticket it names and amend or bin it.
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
 * NOTHING HERE MAY THROW AT THE CALLER. The move is committed by the time this
 * runs. A printer that is unreachable, a menu that will not load, an unapplied
 * migration - none of them can be allowed to turn a completed correction into a
 * failed request, because the alternative is staff being told the move failed
 * while the order sits on the new table. The outcome is returned and reported;
 * see POST /tables/move-order.
 */

import { buildKotTicketKey, dispatchKot, type KotLine } from "./kot_print.js";
import { logger } from "./observability.js";
import {
  GetOrderKotContext,
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
}

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
      items,
      assignedTo: waiterName || null,
      captain: waiterName && (waiterRole === "captain" || waiterRole === "manager") ? waiterName : null,
      billId: `order-${order.order_id}`,
      restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
      currency: settings.currency ?? "₹",
      cols: settings.bill_paper_width === "58mm" ? 32 : 48,
      tz,
      firedAt,
      // The number already on the pass, and the line that tells a chef what this
      // piece of paper is for. Upper-cased and starred because it is read at a
      // glance from a rail, next to a dozen ordinary dockets.
      pinnedKotNo: prior.kot_no,
      contextLine: `*** TABLE CHANGED - WAS ${opts.previousTableName.toUpperCase()} ***`,
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
