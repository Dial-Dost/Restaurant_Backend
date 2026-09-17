/**
 * SETTLE AS NC — the HTTP surface over migration 052.
 *
 * Client item 5: "NC has to come up as an option for payment mode when settling
 * a bill, this has to be coded in as analytics for NC is required."
 *
 * One route, and one act: close a table's bill as NON-CHARGEABLE. Every rule
 * about what that does to the money is in nc_settle.ts (pure) and
 * SettleBillAsNonChargeable (the transaction); this file is authorisation, the
 * shape of a request, the audit line, the floor refresh and the paper.
 *
 * ============================================================================
 * WHY TWO PERMISSIONS
 * ============================================================================
 * It is a comp — every dish on the table goes into the NC ledger with a reason
 * and a second name — so it answers to "Mark Items Non-Chargeable"
 * (PERM_NON_CHARGEABLE) in registration position, the gate every other comp
 * route has. It also SETTLES the bill — stamps it confirmed, approved and
 * closed, frees the table — so it answers to C2's settle gate too
 * (enforceSettleAuthority, "Close Bill"), the one function every settle path
 * calls. The core manager holds both; a cashier or captain holds only Close
 * Bill and is refused, and a waiter holds neither. That matches the write-off
 * rule already in force: taking a whole bill off the drawer needs the settle
 * permission as well as the reducing one.
 *
 * ============================================================================
 * THE ORDER IS THE CONTROL — every refusal before any write
 * ============================================================================
 *   403  no comp permission (the guard) / no Close Bill (enforceSettleAuthority)
 *   400  a partial NC (an amount, tenders or splits in the body) — whole bills
 *        only; the sentence says how to give part of a bill away
 *   400  the body's shape (kind, reason, authoriser)
 *   400  an unknown till
 *   400/403  the authoriser missing, unknown, or not permitted (resolveActors)
 *   409  money already on the bill, a discount, held food — ncSettleRefusal,
 *        decided inside the transaction with the rows locked
 *   400  the quote moved (expected_value is not the bill's chargeable subtotal)
 *   503  migration 052 is neither applied nor creatable by this role
 *   200  `already: true` — the table's newest bill is already a closed NC bill
 *
 * ============================================================================
 * NOT idempotent(), NOT QUEUED OFFLINE
 * ============================================================================
 * It mints a bill number when the table has none, and idempotency.ts puts
 * anything that mints a bill or KOT number out of scope; `/bills` is refused
 * offline by the app's outbox with the billing sentence. The double tap is
 * closed in the database instead: the orders are locked first, a second settle
 * finds none still owing, and answers 200 `already` with the first one's bill.
 *
 * ============================================================================
 * A PRINT DOOR THAT IS NOT UNDER /print/
 * ============================================================================
 * The NC bill is printed here, after the commit, because this is the one moment
 * the paper is an ORIGINAL (the accounting reprint prints the same bill with
 * the REPRINT banner). It dispatches through dispatchPrintJob, so on the parked
 * serverless topology the route is served by the always-on task: see the
 * realtimeAlb behaviour in deploy/template.yaml, deploy/README.md 2.1 and
 * jest-tests/bill_print_doors_always_on.test.ts. A print that fails after the
 * commit is answered 200 with `printed: false` and `print_error` — never a 5xx,
 * which would hide a closed bill from the person who has to tell the guest.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
	Audit_log_category,
	BillNonChargeableRefusedError,
	BillNonChargeableSchemaMissingError,
	GetClosedBill,
	GetRestaurantProfile,
	GetRestaurantSettings,
	SetBillCounter,
	SettleBillAsNonChargeable,
} from "../database_supabase.js";
import { buildReceiptBase64 } from "../escpos.js";
import { NON_CHARGEABLE_KINDS } from "../mis_capture.js";
import { NC_WHOLE_BILL_ONLY, ncKindLabel } from "../nc_settle.js";
import { logger } from "../observability.js";
import { dispatchPrintJob } from "../print_routing.js";
import { emitRestaurant } from "../realtime.js";
import { settledBillReceiptOptions } from "./bills.js";
import { resolveActors } from "./mis_capture.js";
import {
	PERM_NON_CHARGEABLE,
	buildLogoEscPos,
	counterIdFrom,
	enforceSettleAuthority,
	extractEmployeeId,
	extractOutletId,
	extractRestaurantId,
	log_audit,
	requireCounter,
	validateAction,
} from "./_shared.js";

/**
 * The body. Same vocabulary, reason length and authoriser length as the item
 * comp route (routes/mis_capture.ts), from the same exported const, so the two
 * comp doors cannot drift. The REASON IS REQUIRED here even while the service-
 * charge waiver's becomes optional: giving a whole table away is not the same
 * act as dropping a service charge, and its reason is the NC Summary's row.
 */
const sSettleNc = z.object({
	nc_kind: z.enum(NON_CHARGEABLE_KINDS),
	reason: z.string().trim().min(1).max(400),
	authorised_by: z.string().trim().min(1).max(120),
	// The chargeable pre-tax subtotal the till was showing, checked to the paisa.
	expected_value: z.number().finite().nonnegative().optional(),
	counter_id: z.string().optional(),
	// Default on: the NC bill prints (decision 5). A client may turn it off.
	print: z.boolean().optional(),
}).passthrough();

/**
 * Migration 052's boot step, handed to index.ts beside the registration so the
 * route and the DDL it depends on are wired from one import — and so index.ts
 * does not have to reach into the data layer's long import line for it.
 */
export { InitBillNonChargeableSchema } from "../database_supabase.js";

/** Keys that mean the caller wanted to NC PART of a bill. Refused by name. */
const PARTIAL_KEYS = ["amount", "tenders", "splits"] as const;

export function registerNcSettleRoutes(app: Express): void {

/*
	POST /bills/order/:orderId/settle-nc
	  body { nc_kind, reason, authorised_by, expected_value?, counter_id?, print? }
	  -> 200 { success, bill_id, bill_no, payment_method: "NC", total_amt: 0,
	           nc_value, nc_lines, would_have_charged, non_chargeables,
	           printed, print_error?, already? }
*/
app.post("/bills/order/:orderId/settle-nc", validateAction(PERM_NON_CHARGEABLE), async (req: Request, res: Response) => {
	// C2 — the settle gate, the second of the two (see the file header).
	if (!(await enforceSettleAuthority(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: "Missing restaurant/outlet" }); return; }
	const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
	if (!orderId) { res.status(400).json({ error: "orderId is required" }); return; }

	const raw = (req.body ?? {}) as Record<string, unknown>;
	if (PARTIAL_KEYS.some((k) => raw[k] !== undefined && raw[k] !== null)) {
		res.status(400).json({ error: NC_WHOLE_BILL_ONLY, whole_bill_only: true });
		return;
	}
	const parsed = sSettleNc.safeParse(raw);
	if (!parsed.success) {
		res.status(400).json({
			error: "Invalid request body.",
			details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
		});
		return;
	}
	const body = parsed.data;
	const counterId = counterIdFrom(req);

	// The till, before anything moves — the same check the ordinary settle makes.
	if (counterId) {
		try { await requireCounter(restaurantId, counterId); } catch (err) {
			res.status(400).json({ error: String((err as { message?: unknown })?.message ?? "Unknown billing counter") });
			return;
		}
	}

	// The acting user from the session; the authoriser resolved against the
	// comp permission. A body field can set neither the actor nor a name that
	// does not hold the permission.
	const who = await resolveActors(req, res, restaurantId, PERM_NON_CHARGEABLE, "a non-chargeable bill");
	if (!who) {return;}

	let result: Awaited<ReturnType<typeof SettleBillAsNonChargeable>>;
	try {
		result = await SettleBillAsNonChargeable(restaurantId, {
			order_id: orderId,
			nc_kind: body.nc_kind,
			reason: body.reason,
			expected_value: body.expected_value ?? null,
			actor: {
				employee_id: who.employee_id,
				username: who.username,
				authorised_by_employee_id: who.authorised_by_employee_id,
				authorised_by_username: who.authorised_by_username,
			},
		});
	} catch (err) {
		if (err instanceof BillNonChargeableSchemaMissingError) {
			logger.error({ err }, "settle_nc_schema_missing");
			res.status(503).json({ error: err.message, retryable: false });
			return;
		}
		if (err instanceof BillNonChargeableRefusedError) {
			res.status(err.status).json({ error: err.message, code: err.code });
			return;
		}
		if ((err as { code?: unknown })?.code === "23505") {
			// A live comp already sits on one of these lines — another device got
			// there first. Nothing was written by this request.
			logger.warn({ err }, "settle_nc_conflict");
			res.status(409).json({ error: "Another device changed this bill at the same moment. Refresh it and try again." });
			return;
		}
		logger.error({ err }, "settle_nc_failed");
		res.status(400).json({ error: String((err as { message?: unknown })?.message ?? "Unable to settle this bill as non-chargeable") });
		return;
	}

	// A replay changed nothing and is not a second act: no second audit line, no
	// second paper, no second emit.
	if (result.already) {
		res.json({ ...result, printed: false });
		return;
	}

	if (counterId) {
		// After the commit, best-effort — the same posture as the ordinary settle.
		try { await SetBillCounter(restaurantId, result.bill_id, counterId); } catch (err) { logger.warn({ err }, "settle_nc_counter_attribution_failed"); }
	}

	try {
		emitRestaurant(restaurantId, "bill:closed", { order_id: orderId, admin: extractEmployeeId(req) });
		if (result.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: result.table_name });}
		emitRestaurant(restaurantId, "order:updated", { order_id: orderId });
	} catch {/* realtime failures never fail a committed settle */}

	// THE CONTROL LINE. Filed under the comp permission's own id with
	// `scope: 'bill'`, which is what the Bill Edit report classifies on
	// ("Bill settled as non-chargeable"). `would_have_charged` lives HERE and on
	// the paper, and in no report.
	try {
		await log_audit(
			req,
			PERM_NON_CHARGEABLE,
			`Settled bill ${result.bill_no ?? result.bill_id}${result.table_name ? ` (table ${result.table_name})` : ""} as non-chargeable (${result.nc_lines} line(s), ₹${result.nc_value.toFixed(2)} given away before tax) — authorised by ${who.authorised_by_username}`,
			Audit_log_category.Bill,
			{
				scope: "bill", bill_id: result.bill_id, bill_no: result.bill_no, order_id: orderId,
				table: result.table_name, settle_group: result.settle_group,
				nc_kind: body.nc_kind, reason: body.reason, authorised_by: who.authorised_by_username,
				nc_value: result.nc_value, nc_lines: result.nc_lines,
				would_have_charged: result.would_have_charged,
				...(counterId ? { counter_id: counterId } : {}),
			},
		);
	} catch (err) { logger.warn({ err }, "log_audit settle_nc failed"); }

	// THE PAPER — the original, read back from the settled bill so it is the
	// same document the accounting reprint will produce, less the banner.
	let printed = false;
	let printError: string | null = null;
	if (body.print !== false) {
		try {
			const [bill, settings, profile] = await Promise.all([
				GetClosedBill(restaurantId, result.bill_id),
				GetRestaurantSettings(restaurantId).catch(() => ({ currency: "₹" } as any)),
				GetRestaurantProfile(restaurantId).catch(() => null),
			]);
			if (!bill) {throw new Error("The settled bill could not be read back to print.");}
			const is58 = settings.bill_paper_width === "58mm";
			const logo = await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null);
			const escBase64 = buildReceiptBase64(settledBillReceiptOptions(bill, {
				settings, profile, logo, reprint: false,
				settlement: {
					kind: ncKindLabel(body.nc_kind),
					authorisedBy: who.authorised_by_username,
					wouldHaveCharged: result.would_have_charged,
				},
			}), is58 ? 32 : 48);
			await dispatchPrintJob(restaurantId, {
				outlet_id: outletId, bill_id: result.bill_id, kind: "bill", station: null, esc_base64: escBase64,
			});
			printed = true;
		} catch (err) {
			logger.error({ err }, "settle_nc_print_failed");
			printError = String((err as { message?: unknown })?.message ?? "Unable to print");
		}
	}

	res.json({ ...result, printed, ...(printError !== null ? { print_error: printError } : {}) });
});
}
