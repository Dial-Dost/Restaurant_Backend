/**
 * Billing: bill creation and lookup, payment capture and approval, settlement,
 * printing, and the bill-edit operations (remove/move item, discount, coupon,
 * split, merge, refund, reopen).
 */
import type { Express, Request, Response } from "express";
import type { BillSectionAxis, BillTenderState } from "../database_supabase.js";
import { z } from "zod";
import { AddBill, AddNotification, ApplyCouponToBill, ApproveBillPaymentByAdmin, Audit_log_category, BILL_SECTION_AXES, CloseBillByOrder, ConfirmBillPaymentByWaiter, GetBillByOrder, GetBillForTable, GetBillPaymentLedger, GetBillTenderState, GetClosedBill, GetTipLedger, GetEmployeeDetailsFromEmpID, GetKotTableContext, GetOrderKotContext, GetOutlets, GetRestaurantProfile, GetRestaurantRazorpayKeys, GetRestaurantSettings, GetTableFeedbackContext, ListBillingCounters, ListClosedBills, ListOpenBills, MergeTableBills, MoveBillItem, RecordBillTenders, RecordClientRenderedBillPrint, RefundBill, RemoveBillItem, ReopenBill, ReplaceBill, SetBillCounter, SetBillDiscountWithApproval, SetBillCustomerName, SetBillItemNote, SetBillRefundRef, SetClosedBillCustomerDetails, SplitBillForTable, SplitBillForTableBySection, UpdateBillStatusByOrder, UpdateOrderItemsSplit, UpsertBillingCounter, VoidBillTender, computeBillCharges, GetBillChargeConfigForTable } from "../database_supabase.js";
import { buildReceiptBase64, buildSplitReceiptsBase64, type SplitReceiptPart } from "../escpos.js";
import { computeSectionSplit, round2 } from "../billing_math.js";
import { CUSTOMER_GSTIN_ERROR, CustomerGstinInvalidError, CustomerGstinSchemaPendingError, normalizeCustomerGstin } from "../customer_gstin.js";
import { dispatchKot, logKotDispatched } from "../kot_print.js";
import { kotStamp } from "../kot_numbers.js";
import { logger } from "../observability.js";
import { hidesPrices, redactOpenBillPage } from "../price_scope.js";
import { ackPrintJob, isSchemaMissing, warnSchemaMissing } from "../print_jobs.js";
import { dispatchPrintJob } from "../print_routing.js";
import { emitRestaurant } from "../realtime.js";
import { ROLES_OUTRANKING_WAITER, isWaiterOnly } from "../role_scope.js";
import { uploadScreenshot } from "../storage_bucket_supabase.js";
import { isDiscountAuthorityError } from "../discount_authority.js";
import { ACCOUNTING_PERM, PERM_CLOSE_BILL, PERM_SETTINGS, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, buildLogoEscPos, callerIsAdmin, clampLimit, counterIdFrom, endOfDayBound, enforceAdmin, enforcePermission, enforceRoles, enforceSettleAuthority, extractEmployeeId, extractEmployeeUsername, extractOutletId, extractRestaurantId, feedbackUrlForTable, fetchWithTimeout, log_audit, requireCounter, validate, validateAction, validateBody } from "./_shared.js";


// Body schemas for the money/bill-mutation routes. `.passthrough()` keeps every
// field the handlers read (they still coerce numbers themselves) — these only assert
// the required identifiers are present + the right type, returning a structured 400
// instead of a vague downstream error. Authz is enforced separately (validateAction
// / enforceRoles / enforceAdmin in the handlers).
const sBillRemoveItem = z.object({ table_name: z.string(), item_name: z.string() }).passthrough();
const sBillMoveItem = z.object({ from_table: z.string(), to_table: z.string(), item_name: z.string() }).passthrough();
const sBillDiscount = z.object({ table_name: z.string() }).passthrough();
const sBillApplyCoupon = z.object({ table_name: z.string(), code: z.string() }).passthrough();
const sBillItemNote = z.object({ table_name: z.string(), item_name: z.string() }).passthrough();
const sBillSplit = z.object({ table_name: z.string() }).passthrough();
const sBillMerge = z.object({ from_table: z.string(), to_table: z.string() }).passthrough();
const sBillRefund = z.object({ bill_id: z.string().optional(), table_name: z.string().optional() }).passthrough()
	.refine((b) => (typeof b.bill_id === "string" && b.bill_id.trim().length > 0) || (typeof b.table_name === "string" && b.table_name.trim().length > 0),
		{ message: "bill_id or table_name is required" });
// TENDERS (migration 037) and BILLING COUNTERS (migration 038).
//
// `tenders` is the array of rows a settle or a part-payment is made of; the
// identity of the bill is the usual bill_id / table_name / order_id triple and at
// least one has to be present, which the refine below is what enforces.
const sBillTenders = z.object({
	bill_id: z.string().optional(),
	table_name: z.string().optional(),
	order_id: z.string().optional(),
	tenders: z.array(z.unknown()),
}).passthrough().refine(
	(b) => [b.bill_id, b.table_name, b.order_id].some((v) => typeof v === "string" && v.trim().length > 0),
	{ message: "bill_id, table_name or order_id is required" },
);
const sTenderVoid = z.object({ reason: z.string() }).passthrough();
const sBillCounter = z.object({
	bill_id: z.string().optional(),
	table_name: z.string().optional(),
	order_id: z.string().optional(),
}).passthrough().refine(
	(b) => [b.bill_id, b.table_name, b.order_id].some((v) => typeof v === "string" && v.trim().length > 0),
	{ message: "bill_id, table_name or order_id is required" },
);
const sCounterUpsert = z.object({ code: z.string() }).passthrough();

/**
 * HOW MANY WAYS ONE BILL MAY BE SPLIT, and why the number is six.
 *
 * "BillTenders" itself allows 50 (migration 037), but the bill's own
 * `payment_splits` column is the COMPATIBILITY SURFACE every existing settlement
 * reader still uses, and normalizePaymentSplits — the data layer's validator for
 * that column — accepts 2..6 parts. A seventh tender would therefore be
 * perfectly recordable and then impossible to mirror, which means impossible to
 * settle: a fully-paid bill stranded open with the guest already gone. Six is
 * the number the whole chain agrees on, so it is enforced at the door, before
 * anything is written.
 */
const MAX_BILL_TENDERS = 6;

/**
 * METHODS THAT CANNOT BE ONE OF SEVERAL PAYMENTS ON A BILL.
 *
 * normalizePaymentSplits — the data layer's validator for `payment_splits` —
 * refuses a part whose method is 'Split' (that is the mirror's own word for "this
 * bill has N tenders", not a way anybody pays) or 'Razorpay' (the online gateway
 * settles a whole bill; there is no such thing as part of a Razorpay
 * authorisation here, and the refund path keys off the gateway reference on the
 * bill). "BillTenders" itself accepts both, because its `method` column is bound
 * only by normalizePaymentMethod.
 *
 * That gap is a trap with real money in it: a Razorpay tender alongside a cash
 * one would RECORD perfectly, mirror down as a split part, and then be REFUSED by
 * normalizePaymentSplits the moment the bill is settled — leaving a fully paid
 * bill open, the guest gone, and the only way out a manual void. So the same rule
 * is enforced here, before anything is written.
 *
 * A LONE Razorpay tender is still fine, and deliberately so: with one tender the
 * mirror is `payment_method = 'Razorpay'` with no parts, normalizePaymentSplits
 * is never called, and the bill settles exactly as an online payment always has.
 */
const UNSPLITTABLE_TENDER_METHODS: ReadonlySet<string> = new Set(["razorpay", "split"]);

/**
 * Everything that must be true of a proposed set of tenders BEFORE a row is
 * written, checked against what the bill already carries. Returns the sentence to
 * show the person at the till, or null when the set is recordable.
 *
 * Both rules exist for the same reason and neither belongs in readTenderList:
 * they are not about the shape of a request, they are about whether the result
 * could still be SETTLED afterwards. A tender that can be recorded and then not
 * settled is worse than one that is refused.
 */
function tenderSetRefusal(
	ledger: { live_count: number; payment_method: string | null; payment_splits: { method: string; amount: number }[] },
	proposed: readonly RouteTender[],
): string | null {
	const total = ledger.live_count + proposed.length;
	if (total > MAX_BILL_TENDERS) {
		return `A bill can be settled across at most ${String(MAX_BILL_TENDERS)} tenders; this one already carries ${String(ledger.live_count)}. Void one before recording another.`;
	}
	if (total <= 1) { return null; }
	// The methods already on the bill, read off the mirror: one live tender is
	// reported as payment_method, several as the parts.
	const existing = ledger.live_count === 1
		? (ledger.payment_method ? [ledger.payment_method] : [])
		: ledger.payment_splits.map((p) => p.method);
	const bad = [...existing, ...proposed.map((t) => t.method)]
		.find((m) => UNSPLITTABLE_TENDER_METHODS.has(m.trim().toLowerCase()));
	if (bad) {
		return `${bad} cannot be one of several payments on the same bill — it settles a bill on its own. Take the rest another way, or settle this bill as ${bad} alone.`;
	}
	return null;
}

/** One tender as it arrives on the wire. `amount` never includes the tip. */
interface RouteTender {
	method: string;
	amount: number;
	txn_ref: string | null;
	tip_amount: number;
	tip_mode: string | null;
	tip_credited_to_employee_id: string | null;
	tip_credited_to_username: string | null;
}

/**
 * Read the `tenders` array off a request body.
 *
 * RETURNS null WHEN THE KEY IS ABSENT, and that distinction is the whole parity
 * contract of the settle route: a client written before migration 037 never sends
 * the key, gets null here, and every value the settle handler computes downstream
 * is then the one it has always computed. An absent key and an empty array are
 * deliberately DIFFERENT answers — `[]` is a caller who meant to send tenders and
 * sent none, which is a 400, not a silent fall back to the legacy single-method
 * path with whatever `payment_method` happened to be in the body.
 *
 * SHAPE ONLY. It coerces types and refuses a body that could not be money. It does
 * NOT decide whether a method is one this system can settle with, whether a tip
 * names where it goes, or whether the amounts add up to the bill — those live in
 * RecordBillTenders and billing_math's reconcileTenders, and restating them here
 * would create a second copy of the money rules that could drift from the first.
 */
function readTenderList(raw: unknown): RouteTender[] | null {
	if (raw === undefined || raw === null) { return null; }
	if (!Array.isArray(raw)) { throw new Error("`tenders` must be an array of {method, amount} rows"); }
	if (raw.length === 0) { throw new Error("At least one tender is required"); }
	return raw.map((t, i) => {
		const o = (t ?? {}) as Record<string, unknown>;
		const label = `Tender ${String(i + 1)}`;
		const method = typeof o.method === "string" ? o.method.trim() : "";
		if (!method) { throw new Error(`${label} has no payment method`); }
		const amount = Number(o.amount);
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new Error(`${label} must have an amount greater than zero`);
		}
		// A tip is money ON TOP of the bill (037's header). It is carried on the
		// tender and never folded into `amount`, which is the only reason the parts
		// of a tipped bill still reconstruct the grand total.
		const tip = o.tip_amount === undefined || o.tip_amount === null ? 0 : Number(o.tip_amount);
		if (!Number.isFinite(tip) || tip < 0) { throw new Error(`${label} has an invalid tip amount`); }
		const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
		return {
			method,
			amount,
			txn_ref: str(o.txn_ref),
			tip_amount: tip,
			tip_mode: str(o.tip_mode),
			tip_credited_to_employee_id: str(o.tip_credited_to_employee_id),
			tip_credited_to_username: str(o.tip_credited_to_username),
		};
	});
}

// The printer agent's receipt for one print job. `jobId` is the SERVER-generated
// "PrintJobs".id it was handed, never a bill id — see migration 027's header for
// why bill_id cannot be the identity here. .uuid() so a malformed id is a clean
// 400 rather than a 22P02 surfacing as a 500 from the data layer.
const sPrintAck = z.object({
	jobId: z.string().uuid(),
	result: z.enum(["printed", "failed"]),
	// ADDITIVE (migration 042). Absent on every agent in the field today — the C#
	// server, every Flutter build before device registration — and those must go
	// on acking with {jobId, result} and nothing else, unchanged, because the
	// Android app ships on its own release train and the fleet will be mixed for
	// months. `.optional()`, not required, is what buys that.
	//
	// DELIBERATELY NOT `.uuid()` / `.int()`. A tightened shape here would turn a
	// malformed field from a client we have not met into a 400 on a MONEY
	// DOCUMENT'S ack — the one message whose loss makes a till retry a print. The
	// handler below validates the shape itself and simply drops what it cannot
	// use, which degrades that client to exactly today's unsigned ack.
	deviceId: z.string().nullish(),
	generation: z.number().nullish(),
}).passthrough();

// The shape of a "PrintDevices".id, checked in JS because the alternative is a
// 22P02 from `$3::uuid` surfacing as a 500 on a print ack. Module scope so one
// regex serves every ack rather than being rebuilt per request.
const PRINT_DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
	Upload a PAYMENT PROOF image and get back a URL to hand to settle.

	POST /billing/upload-payment-proof
	  body { "image_base64": "<raw or data: URL>", "content_type": "image/jpeg" }
	  -> 200 { "payment_proof_screenshot_url": "https://…", "image_url": "https://…" }

	Exists so staff no longer have to paste an image URL when settling a bill with
	a method that needs proof (UPI screenshot, cheque, bank transfer): the client
	uploads the picture, then sends the returned URL as `payment_proof_screenshot_url`
	on POST /bills/order/:orderId/waiter-confirm-payment. The settle contract itself
	is UNCHANGED — this route only produces a URL that already-valid field accepts.
	Mirrors POST /menu/upload-image (same base64 pattern, same Supabase storage),
	but lands in the existing private-ish "payment-proofs" bucket via uploadScreenshot.
	Guarded by the record-payment permission, and `image_url` is echoed so a client
	written against /menu/upload-image can reuse its parser.
*/
const PAYMENT_PROOF_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
// Base64 is ~4/3 of the byte size, so ~4M characters ≈ a 3MB image — the same
// ceiling the public guest upload (POST /qr/:slug/pay) enforces.
const PAYMENT_PROOF_MAX_B64_CHARS = 4_000_000;

/** True when the decoded bytes actually start with a JPEG/PNG/WebP signature. */
function looksLikeImage(buf: Buffer): boolean {
	if (buf.length < 12) { return false; }
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { return true; } // JPEG
	if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") { return true; } // PNG
	if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") { return true; } // WebP
	return false;
}

export function registerBillRoutes(app: Express): void {

app.post("/bills", validateAction("9186e53e-0fda-4ec8-ad20-2f9feaadb77f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const order_id = typeof body.order_id === 'string' ? body.order_id.trim() : '';
	const total_amt = Number(body.total_amt ?? 0);
	const tax_breakdown = body.tax_breakdown ?? undefined;
	const emp_id = typeof body.emp_id === 'string' ? body.emp_id.trim() : null;
	const status = typeof body.status === 'number' ? body.status : Number(body.status ?? 1);
	const reason = typeof body.reason === 'string' ? body.reason.trim() : null;

	if (!order_id || !Number.isFinite(total_amt)) {
		res.status(400).json({ error: 'Missing order_id or total_amt' });
		return;
	}

	try {
		const result = await AddBill(restaurantId, { order_id, total_amt, emp_id, status, reason, tax_breakdown });
		try {
			await log_audit(req, "9186e53e-0fda-4ec8-ad20-2f9feaadb77f", `Created bill for order ${order_id}`, Audit_log_category.Bill, { order_id });
		} catch (err) {
			logger.warn({ err }, 'log_audit add-bill failed');
		}
		res.status(201).json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'add_bill_failed');
		res.status(500).json({ error: String(error?.message ?? 'Unable to create bill') });
	}
});

app.post('/bills/replace', validateAction("383cc261-7e5c-4745-b16f-06a41e2ae047"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}

	const body = (req.body ?? {});
	const old_order_id = typeof body.old_order_id === 'string' ? body.old_order_id.trim() : '';
	const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
	const new_order = body.new_order ?? null;
	const new_bill = body.new_bill ?? null;

	if (!old_order_id) {
		return res.status(400).json({ error: 'Missing required field: old_order_id' });
	}

	if (!new_order && !new_bill) {
		return res.status(400).json({ error: 'At least one of new_order or new_bill is required' });
	}

	try {
		const result = await ReplaceBill(restaurantId, { old_order_id, reason, new_order, new_bill });
		if (!result) {return res.status(500).json({ error: 'Replace operation failed' });}
		// emit realtime events for UI updates — use order:updated for in-place changes
		try {
			const payloadForEmit = {
				order_id: old_order_id,
				bill_id: result.newBillId,
				new_order_id: result.newOrderId,
			};
			emitRestaurant(restaurantId, 'order:updated', payloadForEmit);
		} catch (e) { }
		try {
			await log_audit(req, "383cc261-7e5c-4745-b16f-06a41e2ae047", `Replaced bill for order ${old_order_id}`, Audit_log_category.Bill, { old_order_id, newBillId: result.newBillId });
		} catch (err) {
			logger.warn({ err }, 'log_audit replace-bill failed');
		}
		return res.status(200).json(result);
	} catch (err: any) {
		logger.error({ err }, 'replace_bill_failed');
		return res.status(500).json({ error: String(err?.message ?? 'Internal') });
	}
});

// --- Closed (settled) bills ------------------------------------------------
// A settled bill used to be invisible: the table is freed and its orders flip to
// Paid/Closed, so neither the floor grid nor the live orders list can show it,
// and /bill-for-table only ever returns the OPEN bill. These two reads are what
// Accounting and History use to browse and re-open a closed bill in full.
//
// Both are gated by the existing "View Bill" action (98b10bde…) — the same
// permission that already lets a role read a table's running bill. No new
// permission to hand out, and waiters/captains (who now hold it) can look up a
// bill they just settled.

// Paged, date-filterable list, newest settled first. Query params:
//   limit (1-200, default 50), offset, from, to (ISO or YYYY-MM-DD),
//   table, payment_method, search, include_open=1
// Also sets X-Total-Count / X-Has-More so a scroller can use headers alone.
app.get('/bills/closed', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	const str = (v: unknown): string | undefined =>
		typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 200) : undefined;
	try {
		const page = await ListClosedBills(restaurantId, {
			limit: clampLimit(req.query.limit, 50, 200),
			offset: Math.max(0, Math.min(Number(req.query.offset) || 0, 100000)),
			from: str(req.query.from),
			to: endOfDayBound(req.query.to),
			table: str(req.query.table),
			payment_method: str(req.query.payment_method),
			search: str(req.query.search),
			include_open: req.query.include_open === '1' || req.query.include_open === 'true',
		});
		res.setHeader("X-Total-Count", String(page.total));
		res.setHeader("X-Has-More", page.has_more ? "1" : "0");
		return res.json(page);
	} catch (err) {
		logger.error({ err }, 'list_closed_bills_failed');
		return res.status(500).json({ error: 'Unable to fetch closed bills' });
	}
});

// The complement of /bills/closed: money still on the floor. Nothing else lists
// it — accounting browses settled bills only — so this is the only answer to
// "who owes me right now". Same permission as every other bill read.
//
// Paged like /audit-logs (limit/offset, X-Total-Count + X-Has-More). The body is
// the envelope rather than that route's bare array: the array is legacy there
// (both clients already parse it that way), and the sibling /bills/closed
// established the envelope. `outstanding_total` covers EVERY open bill, not the
// page — it is the figure the owner reacts to.
app.get('/bills/open', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	try {
		const page = await ListOpenBills(restaurantId, {
			limit: clampLimit(req.query.limit, 50, 200),
			offset: Math.max(0, Math.min(Number(req.query.offset) || 0, 100000)),
		});
		res.setHeader("X-Total-Count", String(page.total));
		res.setHeader("X-Has-More", page.has_more ? "1" : "0");
		// 6.4 / C4 — a waiter holds View Bill, so this route answered them with
		// every open bill's grand total and the whole floor's live gross. The
		// counts stay; the money goes. See price_scope.ts.
		return res.json(hidesPrices(req.auth) ? redactOpenBillPage(page) : page);
	} catch (err) {
		logger.error({ err }, 'list_open_bills_failed');
		return res.status(500).json({ error: 'Unable to fetch open bills' });
	}
});

// ONE closed bill in full — line items, per-tax lines, service charge, discount/
// coupon, grand total, payment method + split parts, who confirmed/approved/
// closed it, table, covers, APC and every timestamp.
app.get('/bills/closed/:id', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	const billId = String(req.params.id ?? '').trim();
	if (!billId) {return res.status(400).json({ error: 'Missing bill id' });}
	try {
		const bill = await GetClosedBill(restaurantId, billId);
		if (!bill) {return res.status(404).json({ error: 'Bill not found' });}
		return res.json(bill);
	} catch (err) {
		logger.error({ err }, 'get_closed_bill_failed');
		return res.status(500).json({ error: 'Unable to fetch this bill' });
	}
});

app.get('/bills/order/:orderId', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	const orderId = String(req.params.orderId ?? '').trim();
	if (!orderId) {return res.status(400).json({ error: 'Missing orderId' });}
	try {
		const bill = await GetBillByOrder(restaurantId, orderId);
		if (!bill) {return res.status(404).json({ error: 'Bill not found' });}
		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit get-bill-by-order failed');
		}
		return res.json(bill);
	} catch (err) {
		logger.error({ err }, 'get bill by order failed');
		return res.status(500).json({ error: 'Internal' });
	}
});
}


export function registerBillPaymentRoutes(app: Express): void {

app.patch('/bills/order/:orderId/status', validateAction("07e364cc-f40d-46f3-b691-0f719dd38e0f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}
	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const body = (req.body ?? {}) as Record<string, unknown>;
	const status = typeof body.status === 'number' ? body.status : Number(body.status ?? 0);

	if (!orderId || !Number.isFinite(status)) {
		res.status(400).json({ error: 'Missing orderId or status' });
		return;
	}

	// C2 — THE SETTLE GATE ON THE BACK DOOR.
	//
	// This route writes "Bills".status as a RAW NUMBER, and the numbers are not
	// decorative: 1 = payment recorded, 2 = approved, 3 = closed. Writing 2 or 3
	// here marks a bill approved or settled without going through
	// admin-approve-payment or close — no re-pricing, no tender reconciliation, no
	// closed_at — and until now it needed only "Update Order Status"
	// (07e364cc…), which is a workflow permission, not a money one. Hiding the
	// Settle button while leaving this reachable is not a permission; it is a
	// button that is hard to find.
	//
	// Anything BELOW 2 is the everyday workflow write this route exists for and is
	// untouched, as is the items_split branch below it.
	const settlesBill = Number.isFinite(status) && status >= 2;
	if (settlesBill && !(await enforceSettleAuthority(req, res))) {return;}

	try {
		// If items_split is provided, update per-item statuses on the order
		if (Array.isArray(body.items_split)) {
			try {
				// THE CALLER'S IDENTITY, AND IT IS NOT OPTIONAL. UpdateOrderItemsSplit
				// now refuses a strip that hands back most of a table's value without
				// Close Bill. This call site passed NOTHING, so the gate judged every
				// caller — an owner included — against an EMPTY action set and refused
				// them. A write-off gate that refuses the person who is allowed to
				// write bills off is not a stricter gate, it is a broken screen.
				await UpdateOrderItemsSplit(restaurantId, orderId, body.items_split, {
					isAdmin: callerIsAdmin(req),
					actions: req.auth?.actions ?? [],
					closeBillPermission: PERM_CLOSE_BILL,
				});
				await log_audit(req, "07e364cc-f40d-46f3-b691-0f719dd38e0f", `Updated per-item statuses for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId });
			} catch (err) {
				logger.error({ err }, 'update_order_items_split_failed');
				res.status(400).json({ error: String((err as any)?.message ?? 'Unable to update order items') });
				return;
			}
		}

		// If numeric status provided, still update bill status
		if (Number.isFinite(status)) {
			await UpdateBillStatusByOrder(restaurantId, orderId, status);
			try {
				await log_audit(req, "07e364cc-f40d-46f3-b691-0f719dd38e0f", `Updated bill status for order ${orderId} to ${status}`, Audit_log_category.Bill, { order_id: orderId, status });
			} catch (err) {
				logger.warn({ err }, 'log_audit update-bill-status failed');
			}
		}

		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, 'update_bill_status_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to update bill status') });
	}
});

app.post("/billing/upload-payment-proof", validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const b64 = typeof body.image_base64 === "string"
		? body.image_base64
		: typeof body.screenshot_base64 === "string" ? body.screenshot_base64 : "";
	const ctRaw = typeof body.content_type === "string" ? body.content_type : "image/jpeg";
	const ct = ctRaw.split(";")[0]!.trim().toLowerCase();
	if (!b64) { res.status(400).json({ error: "image_base64 is required" }); return; }
	if (!PAYMENT_PROOF_TYPES.has(ct)) {
		res.status(415).json({ error: "content_type must be image/jpeg, image/png or image/webp" });
		return;
	}
	if (b64.length > PAYMENT_PROOF_MAX_B64_CHARS) {
		res.status(413).json({ error: "Payment proof is too large (max ~3MB)." });
		return;
	}
	// Decode once here so a corrupt/mislabelled upload is rejected with a clear
	// 400 instead of silently landing a junk object in the bucket.
	const cleaned = b64.includes(",") ? (b64.split(",").pop() ?? b64) : b64;
	let decoded: Buffer;
	try { decoded = Buffer.from(cleaned, "base64"); } catch { decoded = Buffer.alloc(0); }
	if (decoded.length === 0 || !looksLikeImage(decoded)) {
		res.status(400).json({ error: "image_base64 is not a readable JPEG/PNG/WebP image" });
		return;
	}
	try {
		const url = await uploadScreenshot(cleaned, ct === "image/jpg" ? "image/jpeg" : ct);
		if (!url) { res.status(502).json({ error: "Image upload failed (storage not configured)" }); return; }
		try {
			await log_audit(req, "2393edd7-cdd9-439c-9ff3-d563d5216967", "Uploaded a payment proof image", Audit_log_category.Bill, { bytes: decoded.length, content_type: ct });
		} catch (err) { logger.warn({ err }, "log_audit upload-payment-proof failed"); }
		res.json({ payment_proof_screenshot_url: url, image_url: url });
	} catch (err) {
		logger.error({ err }, "payment_proof_upload_failed");
		res.status(500).json({ error: "Unable to upload payment proof" });
	}
});

app.post('/bills/order/:orderId/waiter-confirm-payment', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req: Request, res: Response) => {
	// C2 — THE SETTLE GATE, and it is the SECOND gate on this route rather than a
	// replacement for the first.
	//
	// "Captain Confirm Payment Method" (2393edd7…) says WHICH SCREEN a person may
	// reach. It does not say they may take the restaurant's money, and this route
	// is where the money is taken: it re-prices the bill, writes the tender ledger
	// (migration 037), stamps waiter_confirmed_at and moves the order to "Payment
	// Pending Approval". A tenant that had granted a floor role the confirm
	// permission — which reads like a screen permission — had thereby granted it
	// the till.
	//
	// So settling additionally requires "Close Bill", checked by the ONE function
	// every settle path calls. An admin ("*") and the core cashier hold both and
	// are unchanged; the core manager now holds both (see CORE_ROLES in
	// database_supabase.ts) because C2 names managers as the role that settles.
	if (!(await enforceSettleAuthority(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const auth = { restaurantId };

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const paymentMethod = typeof req.body?.payment_method === 'string' ? req.body.payment_method.trim() : '';
	const paymentProofScreenshotUrl =
		typeof req.body?.payment_proof_screenshot_url === 'string'
			? req.body.payment_proof_screenshot_url.trim()
			: '';
	// Split tender: optional [{method, amount}] rows that must sum to the bill
	// total; payment_method becomes 'Split' (validated in the data layer).
	const splits = Array.isArray(req.body?.splits) ? req.body.splits : undefined;
	const waiterEmployeeId = extractEmployeeId(req);

	// TENDERS (037) and the TILL (038). `tenders` ABSENT reads as null, and that is
	// the parity contract of this route: a client written before either migration
	// never sends the key, so every value computed below is the one this handler
	// has always computed. A malformed `tenders` is answered here so the 400 names
	// tenders instead of a missing payment_method.
	let tenders: RouteTender[] | null;
	try {
		tenders = readTenderList((req.body ?? {}).tenders);
	} catch (err) {
		res.status(400).json({ error: String((err as { message?: unknown })?.message ?? 'Invalid tenders') });
		return;
	}
	const counterId = counterIdFrom(req);

	// `&& !tenders` WIDENS what is accepted and can never narrow it: a body that
	// carries tenders and no payment_method is now a settle (the methods are on the
	// tenders). Every request that was valid before is still valid, unchanged.
	if (!orderId || (!paymentMethod && !splits && !tenders) || !waiterEmployeeId) {
		res.status(400).json({ error: 'Missing orderId, payment_method, or employee identity' });
		return;
	}

	try {
		// THE TILL, CHECKED BEFORE ANY MONEY MOVES. An unknown counter id is a
		// misconfigured terminal, and settling the bill anyway would attribute a
		// real sale to nothing — the exact hole migration 038 exists to close.
		if (counterId) { await requireCounter(auth.restaurantId, counterId); }

		// THE LEDGER CONSULT. One narrow read (see GetBillPaymentLedger for why it
		// is not GetBillTenderState) answering the only question the settle path
		// must ask about tenders on EVERY settle: does this bill already have a
		// payment ledger? On every bill of every tenant that has never written a
		// tender the answer is `live_count: 0`, and every value below is then the
		// one this handler has always computed.
		const ledger = await GetBillPaymentLedger(auth.restaurantId, { order_id: orderId });

		// WHAT COULD BE RECORDED AND THEN NOT SETTLED, refused before it is written:
		// the six-part ceiling of `payment_splits` and the methods that column will
		// not accept as a part. See tenderSetRefusal — both rules exist so a paid
		// bill can never be stranded open with the guest already gone.
		const refusal = tenderSetRefusal(ledger, tenders ?? []);
		if (refusal) { res.status(400).json({ error: refusal }); return; }

		let settleMethod = paymentMethod;
		let settleSplits: unknown = splits;
		let tenderState: BillTenderState | null = null;

		if (tenders) {
			// The actor comes from the VERIFIED SESSION and there is no body field
			// that can set it. A till that could name its own cashier could sign
			// someone else's settlement.
			const username = extractEmployeeUsername(req);
			if (!username) {
				res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." });
				return;
			}
			// require_full: this call IS the settle, so the tenders must reconstruct
			// the grand total to the paisa or nothing is written — defence 2 of
			// migration 037, in the one place the deferred trigger cannot see.
			tenderState = await RecordBillTenders(auth.restaurantId, {
				order_id: orderId,
				tenders,
				settled_by_employee_id: waiterEmployeeId,
				settled_by_username: username,
				require_full: true,
			});
			settleMethod = tenderState.payment_method ?? '';
			settleSplits = tenderState.payment_splits.length > 0 ? tenderState.payment_splits : undefined;
		} else if (ledger.live_count > 0) {
			// A LEDGER THAT EXISTS IS THE AUTHORITY ON HOW THE BILL WAS PAID. This is
			// the case of tenders recorded through POST /bills/tenders and then
			// settled by a caller that sent only `payment_method`: taking the body's
			// word would blank payment_splits and book a split bill to a single mode.
			// The ledger's own mirror goes down instead, so the two columns and the
			// rows behind them cannot disagree. A SHORT ledger is refused a moment
			// later by assertTendersReconcileForSettle, with the outstanding named.
			settleMethod = ledger.payment_method ?? paymentMethod;
			settleSplits = ledger.payment_splits.length > 0 ? ledger.payment_splits : undefined;
		}

		// RecordBillTenders commits in its OWN transaction, so a settle that fails
		// after it (a proof-bearing method with no screenshot, a session closed
		// underneath, a re-priced bill) leaves the payments recorded on an open
		// bill. That is recoverable and the recovery is not obvious, so it is said
		// here rather than left to a cashier to work out with a guest waiting: a
		// second attempt WITHOUT the tenders field settles from the ledger that is
		// now on the bill. Re-sending the same tenders would over-tender and be
		// refused, which is correct and reads like a dead end without this sentence.
		let result;
		try {
			result = await ConfirmBillPaymentByWaiter(
				auth.restaurantId,
				orderId,
				waiterEmployeeId,
				settleMethod,
				paymentProofScreenshotUrl || null,
				settleSplits,
			);
		} catch (err) {
			if (!tenderState) { throw err; }
			throw new Error(
				`The payments were recorded, but this bill could not be settled: ${String((err as { message?: unknown })?.message ?? err)} — settle again WITHOUT the tenders field and the payments already recorded will be used.`,
			);
		}

		// Everything below is ADDITIVE: `extra` and `extraAudit` stay EMPTY for a
		// request that carried neither tenders nor a till, so such a caller receives
		// `result` itself and an audit entry with the same four fields it has always
		// had.
		const extra: Record<string, unknown> = {};
		const extraAudit: Record<string, unknown> = {};
		if (tenderState) {
			extra.tenders = tenderState.tenders;
			extra.tendered = tenderState.tendered;
			extra.outstanding = tenderState.outstanding;
			// Reported SEPARATELY and never added to `tendered`: a tip is not revenue,
			// it is money held for a named person or for the pool.
			extra.tips_total = tenderState.tips_total;
			extraAudit.tenders = tenderState.tenders.length;
			extraAudit.tendered = tenderState.tendered;
			extraAudit.tips_total = tenderState.tips_total;
		}
		if (counterId) {
			// AFTER the settle, because ConfirmBillPaymentByWaiter is what mints the
			// bill row for a table that never had one. Best-effort and logged rather
			// than fatal: the money has already moved, and failing the response over a
			// reporting attribution would tell the till that a settled bill did not
			// settle. POST /bills/counter repairs it.
			try {
				const billId = ledger.bill_id
					?? (await GetBillPaymentLedger(auth.restaurantId, { order_id: orderId })).bill_id;
				if (billId && await SetBillCounter(auth.restaurantId, billId, counterId)) {
					extra.counter_id = counterId;
					extraAudit.counter_id = counterId;
				}
			} catch (err) { logger.warn({ err }, 'settle_counter_attribution_failed'); }
		}

		try {
			emitRestaurant(auth.restaurantId, 'bill:waiter_confirmed_payment', {
				order_id: orderId,
				payment_method: result.payment_method,
				waiter: waiterEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "2393edd7-cdd9-439c-9ff3-d563d5216967", `Waiter confirmed payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, waiter: waiterEmployeeId, payment_method: result.payment_method, ...extraAudit });
		} catch (err) {
			logger.warn({ err }, 'log_audit waiter-confirm-payment failed');
		}
		res.json(Object.keys(extra).length > 0 ? { ...result, ...extra } : result);
	} catch (error: any) {
		logger.error({ err: error }, 'waiter_confirm_bill_payment_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to confirm payment') });
	}
});

app.post('/bills/order/:orderId/admin-approve-payment', validateAction("fc57d407-4bba-442c-97a2-9e6f3c57f288"), async (req: Request, res: Response) => {
	// C2 — THE SETTLE GATE. "Approve Payment" (fc57d407…) opens the door; THIS is
	// the call that CLOSES the bill: ApproveBillPaymentByAdmin re-prices at
	// approval time, reconciles the tenders and stamps closed_at, after which the
	// table is free and the sale is booked. It is a settle in every sense that
	// matters, so it answers to the same capability as every other settle path
	// rather than to a permission of its own.
	if (!(await enforceSettleAuthority(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const auth = { restaurantId };

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const adminEmployeeId = extractEmployeeId(req);
	if (!orderId || !adminEmployeeId) {
		res.status(400).json({ error: 'Missing orderId or admin identity' });
		return;
	}

	try {
		const result = await ApproveBillPaymentByAdmin(auth.restaurantId, orderId, adminEmployeeId);
		try {
			emitRestaurant(auth.restaurantId, 'bill:admin_approved_payment', {
				order_id: orderId,
				admin: adminEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Admin approved payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
		} catch (err) {
			logger.warn({ err }, 'log_audit admin-approve-payment failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'admin_approve_bill_payment_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to approve payment') });
	}
});

app.post('/bills/order/:orderId/close', validateAction("a953d044-31ba-4e31-b96f-99304fe43dfa"), async (req: Request, res: Response) => {
	// C2 — THE SETTLE GATE, already in registration position and left there. The
	// literal above IS PERM_CLOSE_BILL, the same capability enforceSettleAuthority
	// checks for the other settle paths; a guard that can be read on the route line
	// is strictly better than one buried in the handler, so this one stays where it
	// is rather than being moved into the body for symmetry's sake.
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const auth = { restaurantId };

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const adminEmployeeId = extractEmployeeId(req);
	if (!orderId || !adminEmployeeId) {
		res.status(400).json({ error: 'Missing orderId or admin identity' });
		return;
	}

	try {
		const result = await CloseBillByOrder(auth.restaurantId, orderId, adminEmployeeId);
		try {
			emitRestaurant(auth.restaurantId, 'bill:closed', {
				order_id: orderId,
				admin: adminEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "a953d044-31ba-4e31-b96f-99304fe43dfa", `Closed bill for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
		} catch (err) {
			logger.warn({ err }, 'log_audit close-bill failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'close_bill_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to close bill') });
	}
});
}


/*
	C3 — "A WAITER MAY PRINT THE BILL ONCE; THE SECOND ONE IS SOMEBODY ELSE'S."
	THE RULE ITSELF, FACTORED OUT SO THERE IS EXACTLY ONE OF IT.

	============================================================================
	THE HALF THAT WAS MISSING
	============================================================================
	The requirement is "Waiters can only execute Print Bill ONCE. Any subsequent
	actions (reprinting, overrides) must be restricted." The clients implemented
	it by hiding the button and remembering the press IN THE DEVICE. A device
	memory survives a back-navigation and an app restart; it does not survive a
	reinstall, a second tablet or a bare curl, and POST /print/bill was gated
	only on "Add Orders" (4ad474d4…), which every waiter holds. So the rule meant
	something different on every device in the building. A hidden control must be
	UNREACHABLE, not merely undrawn — the button is the courtesy, this is the
	control.

	THE COUNT IS THE SERVER'S. `bill.print_count` comes from the durable
	"PrintJobs" ledger (migration 027) scoped to this seating, counting only jobs
	that printed or are still on their way — see billPrintHistoryForTable for why
	a jammed printer does not burn the waiter's one attempt.

	WHO IS NARROWED: waiter-only identities, decided by isWaiterOnly — the SAME
	predicate role_scope.ts ships on every session payload, so the button the
	client hides and the door the server shuts are one rule rather than two that
	will drift. A manager, cashier, captain or admin reprints exactly as many
	times as they always have; the requirement names "Super Admins" as who a
	WAITER escalates to, not as a new ceiling on everyone who runs the floor.

	============================================================================
	WHY IT IS A FUNCTION AND NOT TWO COPIES
	============================================================================
	It has TWO callers now: POST /print/bill (the thermal print this server
	renders and emits) and POST /print/bill/claim (the web dashboard, which
	renders its own paper in the browser). They are different enough in every
	other respect — one produces ESC/POS and dispatches it, the other produces
	nothing and only writes the ledger — that the temptation is to restate the
	four-line check in the second one.

	A SECOND COPY OF AN AUTHORISATION RULE IS A RULE THAT WILL DIVERGE, and this
	codebase has the receipts: the client-side `roles.every(r => r == 'waiter')`
	that role_scope.ts exists to kill, the two print-count queries that
	bill_print_state.ts merged, the release preflight and the bill math
	disagreeing about status 6. The predicate, the count, the 403 status, the
	sentence, `reprint_needs_senior`, `print_count`, `bill_printed_at`,
	`printed_at` and `allowed_roles` are therefore produced HERE, once, so a
	client cannot tell which route refused it and a change to the rule cannot
	land on one door and not the other.

	Returns TRUE when it has already answered 403 — the caller must return
	immediately, the way requireSectionAdminForNewSection's callers do.

	THE KOT IS NOT ITS BUSINESS. `kind === "kot"` is a kitchen docket, not a
	bill: a waiter reprints a lost ticket all shift and always could. That test
	stays at the /print/bill call site because /print/bill/claim has no kinds —
	a browser never prints a kitchen docket.
*/
async function refuseWaiterBillReprint(
	req: Request,
	res: Response,
	tableName: string,
	bill: { print_count: number; bill_printed_at: string | null; printed_at: string | null },
): Promise<boolean> {
	if (!(bill.print_count > 0)) { return false; }
	if (!isWaiterOnly({ role: req.auth?.role, role_all: req.auth?.role_all, actions: req.auth?.actions })) {
		return false;
	}
	try {
		await log_audit(
			req, "4ad474d4-5230-449c-874f-6a238b833bca",
			`REFUSED reprint of table ${tableName}'s bill — already printed ${String(bill.print_count)} time(s); reprints need a senior role`,
			Audit_log_category.Bill,
			{ table: tableName, kind: "bill", refused: true, print_count: bill.print_count, first_printed_at: bill.bill_printed_at },
		);
	} catch {/* a failed audit write must not turn a 403 into a 500 */}
	// THE REFUSAL SAYS WHO CAN DO IT INSTEAD. A waiter handed a blank space
	// where a control was will press it again on the next device they find;
	// a waiter told "ask a manager" walks to the pass.
	res.status(403).json({
		error: "Forbidden",
		details:
			`This table's bill has already been printed. A reprint has to be made by a ${ROLES_OUTRANKING_WAITER.join(", ")} — ask one of them.`,
		reprint_needs_senior: true,
		print_count: bill.print_count,
		bill_printed_at: bill.bill_printed_at,
		printed_at: bill.printed_at,
		allowed_roles: ROLES_OUTRANKING_WAITER,
	});
	return true;
}


// Round 2 item 1 — `customer_gstin` as both bill-name routes read it off a body.
// ABSENT is undefined (leave it unchanged), which is not the same as null (clear
// it): an old client that never sends the key must not wipe a GSTIN. A value
// that is present but not a GSTIN is INVALID_GSTIN, answered 400 before anything
// is written.
const INVALID_GSTIN = Symbol("invalid_gstin");
function customerGstinFromBody(body: Record<string, unknown>): string | null | undefined | typeof INVALID_GSTIN {
	if (!Object.prototype.hasOwnProperty.call(body, "customer_gstin") || body.customer_gstin === undefined) { return undefined; }
	const r = normalizeCustomerGstin(body.customer_gstin);
	return r.ok ? r.value : INVALID_GSTIN;
}

/** The two GSTIN refusals the data layer can raise, as their HTTP answers. True when it answered. */
function sendCustomerGstinError(res: Response, err: unknown): boolean {
	const name = (err as { name?: unknown } | null)?.name;
	if (err instanceof CustomerGstinSchemaPendingError || name === "CustomerGstinSchemaPendingError") {
		res.status(503).json({ error: (err as Error).message });
		return true;
	}
	if (err instanceof CustomerGstinInvalidError || name === "CustomerGstinInvalidError") {
		res.status(400).json({ error: CUSTOMER_GSTIN_ERROR });
		return true;
	}
	return false;
}

export function registerBillPrintAndEditRoutes(app: Express): void {

// Publish a bill ESC/POS payload to the appropriate restaurant:outlet pub/sub channel
app.post('/publish/bill', validateAction("2ae797d9-2bef-4419-a33d-ab09590dbef9"), async (req: Request, res: Response) => {
	logger.info('Received request to publish bill');
	const body = (req.body ?? {}) as Record<string, unknown>;
	// Pin to the verified session so a caller cannot publish to another tenant's
	// print channel by spoofing restaurantId/outletId in the body or headers.
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	const billId = typeof body.billId === 'string' ? body.billId.trim() : '';
	const escBase64 = typeof body.escBase64 === 'string' ? body.escBase64 : (typeof body.esc === 'string' ? body.esc : null);

	if (!restaurantId || !outletId || !billId || !escBase64) {
		res.status(400).json({ error: 'restaurantId, outletId, billId and escBase64 are required' });
		return;
	}

	try {
		// verify restaurant exists, then verify the outlet belongs to THIS tenant by
		// membership in its Outlets (RLS-scoped to res_id) — not equality to the
		// profile's default outlet, which wrongly rejected valid secondary outlets.
		const profile = await GetRestaurantProfile(restaurantId);
		if (!profile) {
			res.status(404).json({ error: 'Invalid restaurantId' });
			return;
		}

		const outlets = await GetOutlets(restaurantId).catch(() => [] as { id: string }[]);
		const outletBelongs = outlets.some((o) => String(o.id) === String(outletId));
		if (!outletBelongs) {
			res.status(400).json({ error: 'Invalid outletId for the restaurant' });
			return;
		}

		// PERSIST, THEN EMIT — unchanged, and now through the router. The row is the
		// durable fact and the emit is the fast path: an emit cannot report whether
		// anything received it (an empty room is a successful no-op), so the row is
		// the only thing that survives a till whose socket is down. A null jobId
		// still means durability is unavailable (migration 027 not applied) and the
		// emit still goes out, exactly as before.
		//
		// WHAT ROUTING CHANGES HERE, AND WHAT IT DOES NOT. With a `bill` rule
		// configured for this outlet, the receipt goes to the machine bound to that
		// destination instead of to every printer in the room — which is the whole
		// of "desktop-preferred printing", deferred from 1.9.0 because bill:print
		// was a broadcast and two configured devices both printed. With NO rule —
		// every outlet in the fleet today — resolvePrintTarget returns a broadcast
		// decision and this is the same emitOutlet with the same bytes it has been
		// since 027.
		const dispatched = await dispatchPrintJob(restaurantId, {
			outlet_id: outletId, bill_id: billId, kind: "bill", station: null, esc_base64: escBase64,
		});
		// `jobId` keeps its exact meaning and position; `destination`/`device` are
		// ADDITIVE and are null for every unrouted outlet, so a till written against
		// this route before routing existed reads the same body it always did. They
		// are here so the till can say "Sent to Front Till" rather than leaving the
		// server's decision invisible to the person holding the tab.
		res.json({
			success: true,
			jobId: dispatched.jobId,
			destination: dispatched.decision.destinationName,
			device: dispatched.assignedDeviceId,
		});
	} catch (err) {
		logger.error({ err }, 'publish_bill_failed');
		res.status(500).json({ error: 'Unable to publish bill' });
	}
});

// Server-side thermal print: builds the ESC/POS receipt for a table's bill using
// the restaurant's configured currency, then emits bill:print to the printer agent.
app.post('/print/bill', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: 'Missing restaurant/outlet' }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const kind = body.kind === "kot" ? "kot" : "bill";
	if (!tableName) { res.status(400).json({ error: 'table_name is required' }); return; }
	try {
		const [bill, settings, profile] = await Promise.all([
			GetBillForTable(restaurantId, tableName),
			GetRestaurantSettings(restaurantId).catch(() => ({ currency: "₹" } as any)),
			GetRestaurantProfile(restaurantId).catch(() => null),
		]);
		if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
			res.status(400).json({ error: 'Nothing to print for this table' });
			return;
		}
		// C3 — THE ONE PRINT A WAITER GETS. The rule, the count, the audit line
		// and the 403 body all live in refuseWaiterBillReprint above, because
		// POST /print/bill/claim below has to refuse the identical thing in the
		// identical words and a second copy would drift. Returning here is the
		// whole enforcement: NOTHING is rendered and NOTHING is dispatched, so no
		// paper comes out — a 403 body alone would prove only that a message was
		// sent.
		//
		// KOT IS UNTOUCHED, and the test is here rather than inside the helper:
		// `kind === "kot"` is a kitchen docket, not a bill, and a waiter reprints
		// a lost ticket all shift and always could.
		if (kind === "bill" && await refuseWaiterBillReprint(req, res, tableName, bill)) { return; }
		// THE CHARGE CONFIG COMES FROM THE RESOLVER, NOT FROM RAW SETTINGS (F2,
		// root cause 1).
		//
		// THE FAILURE THIS CLOSES. This route used to call computeBillCharges
		// itself with `settings.taxes` and `settings.service_charge` — the RAW
		// outlet config — and suppress the charge by passing
		// includeServiceCharge=false. That flag zeroes ONE leg: the
		// "Restaurant".service_charge percent. A tenant carrying its service
		// charge as a LINE IN Outlets.default_tax — the tax_line shape, which is
		// the shipped seed and therefore the tenant that reported this — sailed
		// straight through computeBillTaxes untouched, so the bill printed WITHOUT
		// the charge came out to the same paisa as the bill printed WITH it.
		//
		// Pairing "off" with a tax config the charge has been lifted out of is now
		// one function's job (resolveServiceChargeConfig, reached through
		// GetBillChargeConfigForTable) rather than four call sites' — see its
		// header for why doing that pairing by hand at a call site IS the bug.
		//
		// Reading the raw config had a second consequence: it ignored a LIVE
		// WAIVER (migration 036), which openBillChargeConfig had already applied to
		// the bill on screen. A waived table was shown one total and handed
		// another on paper — precisely the divergence that resolver was
		// consolidated to make impossible. The stored waiver now reaches this route
		// through the same resolver the bill view and every settle path use, so the
		// printed bill and the till's bill are built from one answer.
		//
		// `no_service_charge` NO LONGER MOVES THE TOTAL — THE PAPER IS THE DRAWER.
		//
		// THE FAILURE MODE, NAMED: THE PAPER DISAGREEING WITH THE DRAWER. This
		// route used to hand the flag down as `withoutServiceCharge`, so the charge
		// came off the PRINTED ladder. No settle path has ever heard of the flag —
		// ConfirmBillPaymentByWaiter, ApproveBillPaymentByAdmin and the two
		// customer-payment paths all resolve through
		// `openBillChargeConfig(context, tableId, client)` with no options, and a
		// print-time request is not stored anywhere they could read it. On the
		// seeded tax shape at 10%, subtotal 5499: the guest was CHARGED 6323.84 and
		// HANDED a bill for 5773.94. That is worse than the F2 bug it came in with
		// — F2 printed a number that was too high, this printed one the till would
		// not honour — and it is on a tax document.
		//
		// A PRINT MUST NOT BE THE THING THAT DECIDES WHAT A GUEST PAYS, so the fix
		// is not to teach settle about the flag; it is to stop the flag from being
		// a way to reduce a total. The ONE way the charge comes off a bill is the
		// RECORDED WAIVER (migration 036): quoteServiceChargeWaiver prices it,
		// "ServiceChargeWaivers" records who asked and who authorised and why, the
		// waiver report and the audit log show it, and openBillChargeConfig honours
		// it on every read — so a waived bill prints less AND charges less AND
		// names the person who allowed it. `no_service_charge` keeps its name and
		// becomes what the name says on a bill that already carries a waiver; on an
		// un-waived bill the paper shows what the guest owes.
		//
		// THE ARGUMENTS BELOW ARE DELIBERATELY IDENTICAL TO THE SETTLE PATHS'. If a
		// reprint ever needs a "what would this cost without the charge" preview,
		// it must not be built here: whatever this route renders is what a guest is
		// handed, and the only honest way to lower it is to record the waiver first.
		const askedWithoutServiceCharge = body.no_service_charge === true;
		const chargeCfg = await GetBillChargeConfigForTable(restaurantId, tableName);
		// The flag was asked for, there IS a charge, and nobody authorised taking it
		// off. The bill below therefore prints WITH the charge and the till takes
		// the same number — so the ask itself is reported to the caller and written
		// to the audit log, because a waiter who asked for less and handed over
		// more has to be able to find out why, and a manager has to be able to see
		// that it was asked for at all.
		const waiverRequired = askedWithoutServiceCharge
			&& !chargeCfg.service_charge_removed
			&& chargeCfg.basis !== "none";
		const charges = computeBillCharges(
			bill.subtotal ?? bill.total_amt ?? 0,
			chargeCfg.taxConfig,
			chargeCfg.scPct,
			chargeCfg.includeServiceCharge,
			// The discount exactly as GetBillForTable read it, so the printed ladder
			// is built on the same base as the one the till is showing.
			bill.discount_value > 0 ? { type: bill.discount_type ?? "percent", value: bill.discount_value } : undefined,
		);
		// Column layout + logo raster width follow the configured paper size
		// (58mm = 32 cols / 384 dots, 80mm = 48 cols / 576 dots).
		const is58 = settings.bill_paper_width === "58mm";
		const cols = is58 ? 32 : 48;
		// Kitchen ticket path: enrich each item with its kitchen station (from the
		// menu, by dish name) and split the KOT into ONE ticket per station, so each
		// zone prints only its own items. Each event carries `station` so a printer
		// agent that maps station -> printer can route it; a single-printer agent
		// prints all N tickets on one roll (same paper, just split + labelled).
		if (kind === "kot") {
			// THE KOT HEADER, resolved here and printed verbatim by the renderer.
			//
			// The zone is the tenant's own ("Restaurant".timezone). Everything
			// dated on this ticket — the printing stamp AND the business day the
			// number belongs to — is derived from that one value, so a ticket
			// fired at 01:00 IST reads 01:00 and counts as the night it was
			// actually cooked, on a backend hosted in UTC.
			const tz = settings.timezone || 'Asia/Kolkata';
			// Neither lookup is allowed to take the kitchen down: an unresolvable
			// table or waiter costs a header line, not the docket.
			const [tableCtx, waiterCtx] = await Promise.all([
				GetKotTableContext(restaurantId, tableName).catch(() => null),
				GetTableFeedbackContext(restaurantId, tableName).catch(() => null),
			]);
			// "Assign to:" is whoever the table is assigned to; "Captain:" prints
			// only when that person's role really is captain/manager, so a plain
			// waiter's table does not grow a second identical line.
			const waiterName = (waiterCtx?.employee_name ?? '').trim();
			const waiterRole = (waiterCtx?.employee_role ?? '').trim().toLowerCase();
			const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
			// STATION ENRICHMENT, TICKET NUMBERING, THE PER-STATION SPLIT AND THE
			// PERSIST-THEN-EMIT OF EACH DOCKET NOW LIVE IN kot_print.ts, because
			// the bark path (routes/orders.ts) has to produce a docket that is
			// identical in every one of those respects. A second copy here is
			// exactly where the two would drift apart on the KOT number.
			const dispatched = await dispatchKot({
				restaurantId, outletId,
				tableName,
				tableId: tableCtx?.table_id ?? "",
				section: tableCtx?.section ?? null,
				// Covers come from the TABLE (num_covers, counted once per table),
				// the same number the bill divides by for APC.
				covers: tableCtx?.covers ?? bill.covers ?? 1,
				isVirtual: tableCtx?.is_virtual === true,
				orderType: tableCtx?.order_type ?? null,
				items: bill.items,
				assignedTo: waiterName || null,
				captain: waiterName && (waiterRole === 'captain' || waiterRole === 'manager') ? waiterName : null,
				// EVERY order's whole-order instruction on this table, joined for the
				// one banner the docket prints. A table-scoped docket covers several
				// orders and each may carry its own note; " | " rather than a newline
				// so the banner stays one wrapped paragraph instead of becoming a
				// second list the eye has to parse under a pass light.
				orderNote: bill.order_notes.join(' | ') || null,
				billId,
				restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
				currency: settings.currency ?? "₹",
				cols,
				tz,
				total: charges.subtotal,
			});
			logKotDispatched("print_bill_table", dispatched, { resId: restaurantId, outletId, table: tableName });
			// The KOT number goes in the audit line and the response: it is the
			// handle a manager uses to find this ticket afterwards, and `reprint`
			// distinguishes a genuine second order from a reprint of the first.
			const kotLabel = dispatched.kotNo ? `KOT-${dispatched.kotNo}${dispatched.reprint ? ' (reprint)' : ''}` : 'KOT';
			try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed ${kotLabel} for table ${tableName} (${dispatched.tickets} station ticket(s))`, Audit_log_category.Bill, { table: tableName, kind, stations: dispatched.stations, kot_no: dispatched.kotNo, business_day: dispatched.businessDay, reprint: dispatched.reprint }); } catch {/* ignore */}
			res.json({
				success: true, billId, tickets: dispatched.tickets, stations: dispatched.stations,
				kot_no: dispatched.kotNo, business_day: dispatched.businessDay, reprint: dispatched.reprint,
			});
			return;
		}
		// The kitchen ticket returned above; everything below is the customer bill,
		// which alone carries the logo, cashier line and feedback QR.
		const isBill = true;
		// THE OWNER'S SWITCH (the bill_show_qr column). Off means no QR and no QR sentence:
		// the renderer prints that whole block only when it has a URL, so leaving
		// the URL out is the entire mechanism, and the table's feedback context is
		// not even looked up. `!== false` because a settings shape without the key
		// is a tenant who never turned it off.
		const feedbackUrl = isBill && settings.bill_show_qr !== false ? await feedbackUrlForTable(restaurantId, tableName) : null;
		const logo = isBill ? await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null) : null;
		let cashier = "";
		if (isBill) {
			try {
				const emp = await GetEmployeeDetailsFromEmpID(extractEmployeeId(req) ?? "");
				cashier = `${emp?.emp_Fname ?? ""} ${emp?.emp_Lname ?? ""}`.trim();
			} catch {/* cashier optional */}
		}
		// THE OPTED-OUT LINE KEYS OFF A CHARGE HAVING ACTUALLY BEEN REMOVED — not
		// off a percent that is structurally zero on the broken tenant (F2, root
		// cause 2).
		//
		// It used to read `charges.service_charge_percent || settings.service_charge`,
		// and `settings.service_charge` is 0 on a tenant carrying the charge as a
		// tax line. So on exactly the tenant whose opt-out was already silently
		// failing, the bill did not even admit the line existed: no charge line, no
		// Opted-out line, and a total identical to the one with the charge.
		// `service_charge_removed` is the resolver's answer in BOTH shapes and
		// `service_charge_percent` is the configured percentage whichever shape
		// carries it, so the line now prints on a tax-line tenant too, at the
		// percentage the guest would otherwise have been charged.
		//
		// IT ALSO NOW PRINTS ON A LIVE WAIVER, not just on a `no_service_charge`
		// reprint: the resolver removes the charge for both, and a waived table
		// whose bill simply omitted the line left the guest no way to see that the
		// charge had been dropped rather than never applied.
		const serviceCharge = charges.service_charge > 0
			? { percent: charges.service_charge_percent, amount: charges.service_charge }
			: (chargeCfg.service_charge_removed
				? { percent: chargeCfg.service_charge_percent, amount: 0, optedOut: true }
				: null);
		const escBase64 = buildReceiptBase64({
			restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
			// Legal entity + GSTIN are tenant settings, not profile fields: they are
			// statutory identifiers for the business, not per-outlet contact details.
			// Both are "" when unset and the renderer prints nothing for "", so a
			// tenant that has configured neither gets exactly today's header.
			legalName: settings.bill_legal_name ?? null,
			address: profile?.outlet_add ?? null,
			// The outlet's own contact number ("Outlets".outlet_main_ph, surfaced by
			// GetRestaurantProfile). Address and GSTIN were already on the paper;
			// the phone was the one statutory-header field a guest could not read
			// off their own bill. Unset resolves to "" and the renderer prints no
			// line for "", so an outlet that never filled it in is unchanged.
			phone: profile?.outlet_phone ?? null,
			gstin: settings.bill_gstin ?? null,
			table: tableName,
			covers: bill.covers ?? 1,
			items: bill.items,
			total: charges.subtotal,
			customer: bill.customer,
			customerGstin: bill.customer_gstin ?? null,
			billNo: bill.bill_no,
			cashier: cashier || null,
			// THE DATE LINE, IN THE RESTAURANT'S ZONE ("13/09/26 23:19"). Unset, the
			// renderer fell back to the SERVER's clock and locale, which on the UTC
			// host printed a US-format, UTC time on a GST document, and the wrong
			// calendar date for every bill between midnight and 05:30 IST. The same
			// stamp the KOT has carried since kotStamp existed.
			printedAt: kotStamp(new Date(), settings.timezone || "Asia/Kolkata"),
			discount: charges.discount > 0 ? { amount: charges.discount, label: bill.coupon_code ? `Coupon ${bill.coupon_code}` : "Discount" } : null,
			serviceCharge,
			// The breakdown the billing layer produced for THIS bill — one line per
			// tax the outlet actually has configured in Outlets.default_tax, each
			// with its own label and percentage (so a tenant on SGST 2.5% + CGST 2.5%
			// prints two lines, and a tenant on a single GST line prints one). The
			// renderer prints them; it does not invent, merge or split them.
			taxes: charges.taxes,
			// PRINT WHAT THE BILLING LAYER COMPUTED. computeBillCharges is the single
			// authority on the tax-inclusive total, and it is the same number settle
			// records against the bill. Handing it over means the renderer has nothing
			// left to round — see the grandTotal note in escpos.ts.
			grandTotal: charges.grand_total,
			currency: settings.currency ?? "₹",
			kind,
			feedbackUrl,
			// The tenant's own sentence above the QR; "" falls back to the built-in
			// valet line inside the renderer, so an unconfigured tenant is unchanged.
			qrNote: settings.bill_qr_note ?? null,
			logo,
			// 5.3 / item 4 — A SECOND COPY SAYS SO, AS ITS FIRST LINE. The banner
			// already existed in the renderer and the accounting reprint set it, but
			// THIS route never did: a manager's reprint of an open table's bill
			// (C3 lets anyone senior to a waiter make one) came off the roll looking
			// exactly like the original. `print_count` is the server's ledger count
			// of this seating's bill prints BEFORE this one — the same number C3
			// just refused a waiter on — so a first print (0) never carries it.
			reprint: bill.print_count > 0,
			// THE DISCLAIMER FOLLOWS THE CHARGE, NOT ONE LEG OF IT (G2; F2 root
			// cause 3). This predicate was `charges.service_charge > 0` — the
			// restaurant_percent leg alone — and so carried the same blind spot as
			// the Opted-out line above it: a tenant charging through a tax line
			// never printed the sentence the requirement makes mandatory, and would
			// have gone on printing it on opted-out bills once the opt-out started
			// working. `service_charge_applied` is the resolver's "does this
			// configuration still charge for service", in both shapes, so the
			// sentence appears when and only when the guest is actually being
			// charged for one.
			serviceChargeNote: isBill && chargeCfg.service_charge_applied
				? "A Voluntary Service Charge is included to support our staff. If you prefer not to contribute, please inform your server before payment and it will be removed."
				: null,
		}, cols);
		const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
		// billId is STABLE ACROSS REPRINTS, so each reprint deliberately becomes its
		// OWN job row. A waiter who asks for a second copy must get one — which is
		// also why the router is asked again rather than the first decision being
		// reused: the till that printed the original may be off by now.
		//
		// Same persist-then-emit as /publish/bill above, same fallback: no `bill`
		// rule, or an unreadable routing table, or nothing online that serves the
		// bill destination, and this is today's outlet-wide emit with today's bytes.
		const dispatched = await dispatchPrintJob(restaurantId, {
			outlet_id: outletId, bill_id: billId, kind: "bill", station: null, esc_base64: escBase64,
		});
		// THE AUDIT LINE SAYS WHAT THE PAPER ACTUALLY SAYS. It used to read "(no
		// service charge)" off the REQUEST, which is how a print that reduced a
		// total nobody authorised left a trail claiming it was fine. It now
		// describes the bill that came out: removed (and by whose waiver), or asked
		// for and refused — which is the line a manager scans for.
		const scNote = chargeCfg.service_charge_removed
			? ` (no service charge — waiver by ${chargeCfg.waiver?.authorised_by_username ?? "unknown"})`
			: waiverRequired
				? " (asked WITHOUT the service charge; no waiver is recorded, so the charge is ON this bill)"
				: "";
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed ${kind} for table ${tableName}${scNote}`, Audit_log_category.Bill, { table: tableName, kind, no_service_charge: askedWithoutServiceCharge, service_charge_removed: chargeCfg.service_charge_removed, service_charge_waiver_required: waiverRequired, service_charge_waiver_id: chargeCfg.waiver?.id ?? null }); } catch {/* ignore */}
		// Additive, exactly as on /publish/bill: null for every unrouted outlet.
		//
		// The two service-charge fields are additive too, and a shipped till that
		// ignores them is unchanged. They exist so a till that SENT
		// `no_service_charge` can tell the waiter the charge is still on the paper
		// and that a manager has to record a waiver — without them the only signal
		// is a total that silently did not move.
		res.json({
			success: true,
			billId,
			jobId: dispatched.jobId,
			destination: dispatched.decision.destinationName,
			device: dispatched.assignedDeviceId,
			service_charge_removed: chargeCfg.service_charge_removed,
			service_charge_waiver_required: waiverRequired,
		});
	} catch (err: any) {
		logger.error({ err }, 'print_bill_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to print') });
	}
});


/*
	C3, THE WEB DASHBOARD'S HALF — CLAIM A BILL PRINT THAT THIS SERVER DOES NOT
	PRODUCE.

	POST /print/bill/claim  body { "table_name": "T7" }
	  -> 200 { success, billId, recorded, jobId, print_count, bill_printed_at, printed_at }
	  -> 403 the IDENTICAL body POST /print/bill returns (reprint_needs_senior)
	  -> 400 nothing on the table

	============================================================================
	WHY A SECOND ROUTE AT ALL
	============================================================================
	POST /print/bill does two things that are welded together: it RENDERS the
	ESC/POS receipt and it DISPATCHES it to a till. The web dashboard needs
	neither. Its Print Bill button builds an HTML page and calls
	`window.print()`, so the paper comes out of whatever printer the browser is
	pointed at — and the backend was never told, which is how a waiter on the
	dashboard printed unlimited copies of a bill while the same waiter on a
	tablet got exactly one. A rule enforced on one client and not another is the
	same defect as a rule enforced on one device and not another; it is just
	harder to see.

	So the dashboard keeps producing its own paper, and this is the route that
	makes the print a FACT on the server: the same permission, the same C3
	refusal, a row in the same ledger, a line in the same audit log.

	============================================================================
	IT EMITS NOTHING. NOT A SOCKET EVENT, NOT A BYTE.
	============================================================================
	There is deliberately no dispatchPrintJob and no `bill:print` here. A
	dashboard print that also reached the printer agent would put a SECOND,
	thermal copy of the guest's bill on every till bound to this outlet —
	"connected tills start double-printing" is not a hypothetical in this
	codebase, it is what migration 027's lease notes and the router's
	two-charge-slip path are both about.

	And that is not left to this handler remembering to be careful. The ledger
	row is written in a TERMINAL status ('acked'), which is outside the
	`status in ('pending','delivered')` set ClaimPrintJobsForAgent replays — so
	even a till that reconnects a second later cannot be handed it — and with an
	EMPTY esc_base64, so there is nothing to hand over in the first place. See
	RecordClientRenderedBillPrint for why 'acked' is the only value in the CHECK
	constraint that is both terminal and counted by C3.

	============================================================================
	THE REFUSAL IS THE SAME OBJECT, NOT THE SAME SHAPE
	============================================================================
	refuseWaiterBillReprint produces it — one predicate, one sentence, one set of
	fields — so a dashboard and a tablet answer a waiter's second print
	identically, and a change to the rule cannot land on one and not the other.

	============================================================================
	NO `idempotent()`, AND THAT IS THE CORRECT ANSWER FOR A PRINT
	============================================================================
	Same reasoning routes/printing.ts states for POST /print/test: a request for
	paper that is repeated is a request for a SECOND piece of paper, and pressing
	Print twice must cost a waiter their one attempt exactly as pressing it twice
	on a tablet does. Deduplicating it would hand back the first response and
	silently let the second copy print unrecorded — the very hole this closes.

	============================================================================
	IF MIGRATION 027 IS NOT APPLIED, THE PRINT STILL HAPPENS
	============================================================================
	`recorded: false` and an unchanged `print_count`, plus the throttled warning
	print_jobs.ts already emits for exactly this. The alternative is refusing to
	let a restaurant print a guest's bill because its print ledger is one
	migration behind, and this codebase has already decided that argument twice
	(billPrintStateForSeatings' header, and every read in routes/printing.ts): a
	floor that cannot bill a table is a far worse outage than a rule that is
	temporarily as weak as it was last week.
*/
app.post('/print/bill/claim', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: 'Missing restaurant/outlet' }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	if (!tableName) { res.status(400).json({ error: 'table_name is required' }); return; }
	try {
		// The SAME read POST /print/bill gates on, so the two routes can never
		// disagree about how many times this seating's bill has been printed.
		const bill = await GetBillForTable(restaurantId, tableName);
		// An empty table is answered "nothing to print", not "forbidden" — the
		// same 400 and the same sentence as /print/bill, because a client should
		// not have to learn a second vocabulary to find out the table is empty.
		if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
			res.status(400).json({ error: 'Nothing to print for this table' });
			return;
		}
		if (await refuseWaiterBillReprint(req, res, tableName, bill)) { return; }

		// The SAME bill_id shape /print/bill writes, including the
		// `<table>-<epoch>` fallback for a table with no "Bills" row yet.
		// bill_print_state.ts matches BOTH shapes and matches the fallback as a
		// PREFIX on the exact table name, so a claim and a thermal print of the
		// same seating land in the same count rather than in two.
		const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
		let recorded: { id: string; created_at: string } | null = null;
		try {
			recorded = await RecordClientRenderedBillPrint(restaurantId, {
				outlet_id: outletId,
				bill_id: billId,
				// Diagnostic, and deliberately not a device or a lease holder:
				// nothing holds a lease on a terminal row. It names the client
				// class and the person, so a manager reading the ledger can tell a
				// browser print from a till's.
				claimed_by: `web-client:${extractEmployeeId(req) ?? "unknown"}`,
			});
		} catch (err) {
			// 42P01 / 42501 only — migration 027 absent or ungranted. Anything else
			// is a real failure and must not be swallowed into a success.
			if (!isSchemaMissing(err)) { throw err; }
			warnSchemaMissing("print_bill_claim", err);
		}

		// THE AUDIT LINE IS THE ONE /print/bill FILES, under the same Action id
		// and the same category, worded so a manager scanning the log can see
		// which piece of paper came out of what. `recorded:false` is in the
		// metadata rather than left implicit: an unrecorded print is the one case
		// where the log is the ONLY evidence the bill was printed at all.
		try {
			await log_audit(
				req, "4ad474d4-5230-449c-874f-6a238b833bca",
				`Printed bill for table ${tableName} from the web dashboard (browser print — no thermal copy)`,
				Audit_log_category.Bill,
				{ table: tableName, kind: "bill", source: "web_dashboard", claim: true, recorded: recorded !== null, job_id: recorded?.id ?? null },
			);
		} catch {/* ignore */}

		// ENOUGH FOR THE BUTTON TO GO GREY. `print_count` is what the dashboard
		// tests to hide its own control on the next render, and `printed_at` is
		// what it shows beside it — both taken from the row that was just
		// written, so the client does not have to re-poll /bill-for-table to
		// learn what it just did. They are the SAME THREE SPELLINGS
		// /bill-for-table and /get-tables carry (bill_print_state.ts), so a
		// client needs no second code path to read them.
		//
		// On the unrecorded path the counts are returned UNCHANGED rather than
		// optimistically incremented: reporting a count the ledger does not hold
		// is how a client ends up disabling a button the server would still allow.
		res.json({
			success: true,
			billId,
			recorded: recorded !== null,
			jobId: recorded?.id ?? null,
			print_count: recorded ? bill.print_count + 1 : bill.print_count,
			// The FIRST print of this seating is the one that used up a waiter's
			// single attempt, so it only moves when there was no earlier one.
			bill_printed_at: bill.print_count === 0 ? (recorded?.created_at ?? bill.bill_printed_at) : bill.bill_printed_at,
			printed_at: recorded?.created_at ?? bill.printed_at,
			// THE PRICED BILL, BECAUSE THIS IS THE GUEST'S RECEIPT.
			//
			// THE BUG THIS CLOSES, found in a live browser pass: on the web
			// dashboard a waiter could not print a bill at all. The print page
			// builds the receipt from the open bill, reading GET /bill-for-table AS
			// THE SIGNED-IN USER — and for a waiter that read is redacted by C4, so
			// `grand_total` arrives absent, the page's `Number.isFinite` gate fails,
			// and it refuses with "No bill is available for this order yet". It
			// refuses rather than printing zeros, which is right; it just meant no
			// waiter on the web could ever produce paper. Worse, this claim had
			// already spent their single attempt by then.
			//
			// WHY RETURNING AMOUNTS HERE DOES NOT UNDO C4. C4 is scoped to the
			// ORDER-TAKING screen: "remove the prices from the list of ordered
			// dishes displayed on the right side". A printed bill is a different
			// artifact with a different reader — the guest — and a bill without
			// amounts is not a bill. The waiter will see these figures on the paper
			// they hand over; that was always true of every printed receipt.
			//
			// WHY HERE, AND NOT BY UN-REDACTING /bill-for-table. That route is read
			// continuously by the order-taking screen, which is exactly where C4
			// applies. This route is the one moment a waiter is AUTHORISED TO PRINT,
			// it already enforced the once-only rule above, and a waiter-only
			// session can only succeed at it once per seating. So the amounts
			// reach a waiter exactly once, at the instant they are needed for
			// paper, and never on the screen they take orders from.
			//
			// Sent on the UNRECORDED path too. That path means migration 027 is
			// absent, so the print could not be written to the ledger — but the
			// once-only gate above had already passed, and the gate is what
			// authorises a print; the ledger is bookkeeping. Withholding the bill
			// there would leave a waiter unable to produce paper on exactly the
			// database where nothing else is stopping them.
			printable_bill: bill,
		});
	} catch (err: any) {
		logger.error({ err }, 'print_bill_claim_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to record the print') });
	}
});

/*
	E5 — REPRINT A SETTLED BILL, from the accounting module.

	POST /print/bill/settled  body { "bill_id": "<uuid>" }
	  -> 200 { success, billId, jobId, destination, device }

	============================================================================
	IT PRINTS WHAT WAS RECORDED. IT DOES NOT RECOMPUTE ANYTHING.
	============================================================================
	This is the single rule that makes this route safe, and it is the opposite of
	what /print/bill above does. That route prints an OPEN table, so it must ask
	the resolver for the charge configuration and compute the ladder — the bill is
	still moving. This one prints a bill that was SETTLED: a guest has paid a
	specific number, that number is in "Bills", and it is on a tax document.

	Recomputing would re-derive the ladder from TODAY's configuration. Between the
	settlement and the reprint an owner may have changed the GST lines, changed
	the service-charge percentage, or moved the charge from the restaurant percent
	to a tax line. Every one of those silently produces a second copy of a tax
	document with a DIFFERENT total from the one the guest paid — which is the
	precise failure this file has already been through twice (F2's grand total,
	and the print that lowered a total the till would not honour). A reprint that
	disagrees with the original is worse than no reprint at all.

	So every number below comes from GetClosedBill, which reads the settled row,
	and the only thing this route adds is the REPRINT banner.

	============================================================================
	WHY IT SAYS "REPRINT" IN THE LARGEST TYPE THE PRINTER HAS
	============================================================================
	Off the roll, a second copy is indistinguishable from the original — and a
	bill that looks like an original gets paid a second time or filed as a second
	sale. escpos.ts's `reprint` flag puts the word above everything, before the
	logo. It is not optional here: this route can ONLY produce second copies.

	============================================================================
	WHO MAY DO IT
	============================================================================
	ACCOUNTING_PERM, not the waiter's "Add Orders". The requirement puts the
	button in the accounting module, and the audience for a settled bill's paper
	trail is whoever runs the books. A waiter who needs the open table's bill
	still uses /print/bill and still meets C3's once-only rule there.
*/
app.post('/print/bill/settled', validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: 'Missing restaurant/outlet' }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const billId = typeof body.bill_id === "string" ? body.bill_id.trim() : "";
	if (!billId) { res.status(400).json({ error: 'bill_id is required' }); return; }
	try {
		const [bill, settings, profile] = await Promise.all([
			GetClosedBill(restaurantId, billId),
			GetRestaurantSettings(restaurantId).catch(() => ({ currency: "\u20b9" } as any)),
			GetRestaurantProfile(restaurantId).catch(() => null),
		]);
		if (!bill) { res.status(404).json({ error: 'That bill could not be found.' }); return; }
		if (!Array.isArray(bill.items) || bill.items.length === 0) {
			// A settled bill whose lines cannot be reconstructed would print a
			// header, a total and nothing between them. Refusing says why.
			res.status(400).json({ error: 'This bill has no line items recorded, so it cannot be reprinted.' });
			return;
		}

		const is58 = settings.bill_paper_width === "58mm";
		const cols = is58 ? 32 : 48;
		// The same raster builder and the same dot widths as the original print
		// (58mm = 384 dots, 80mm = 576) — a reprint that rendered the logo at a
		// different width is a different-looking document.
		const logo = await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null);

		// EVERY FIGURE IS THE SETTLED ONE. Read the header: nothing here is
		// derived from today's tax or service-charge configuration.
		const escBase64 = buildReceiptBase64({
			restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
			legalName: settings.bill_legal_name ?? null,
			address: profile?.outlet_add ?? null,
			phone: profile?.outlet_phone ?? null,
			gstin: settings.bill_gstin ?? null,
			table: bill.table_name ?? "",
			covers: bill.covers ?? 1,
			items: bill.items.map((i) => ({
				name: i.variation ? `${i.name} (${i.variation})` : i.name,
				price: i.price,
				quantity: i.quantity,
				note: i.note ?? undefined,
			})),
			// The pre-discount line total, as the settled bill reconstructed it.
			total: bill.items_subtotal,
			customer: bill.customer,
			customerGstin: bill.customer_gstin ?? null,
			billNo: bill.bill_no,
			cashier: bill.created_by ?? null,
			// The date the bill was RAISED, not today: a reprint is a second copy of
			// that document, and the REPRINT banner already says it is a copy.
			// An unreadable created_at would make Intl throw, and a date line is not
			// worth the reprint: it falls back to now.
			printedAt: kotStamp(Number.isFinite(Date.parse(String(bill.created_at ?? ""))) ? new Date(bill.created_at) : new Date(), settings.timezone || "Asia/Kolkata"),
			discount: (bill.discount_amount ?? 0) > 0
				? { amount: bill.discount_amount ?? 0, label: bill.coupon_code ? `Coupon ${bill.coupon_code}` : "Discount" }
				: null,
			// Zero is not the same as absent: a bill settled with the charge waived
			// prints the Opted-out line, exactly as the original did.
			serviceCharge: bill.service_charge > 0
				? { percent: bill.service_charge_percent, amount: bill.service_charge }
				: (bill.service_charge_percent > 0
					? { percent: bill.service_charge_percent, amount: 0, optedOut: true }
					: null),
			taxes: bill.taxes,
			grandTotal: bill.grand_total,
			currency: settings.currency ?? "\u20b9",
			kind: "bill",
			logo,
			// NOT OPTIONAL. This route can only ever produce a second copy.
			reprint: true,
			// NO FEEDBACK QR ON A REPRINT. The QR is signed for a live seating and
			// invites a guest who has left to rate a meal they already rated; a
			// reprint is an accounting document, not a table-side courtesy.
			feedbackUrl: null,
			// The disclaimer follows the charge that was ACTUALLY TAKEN, which for a
			// settled bill is a recorded fact rather than a configuration question.
			serviceChargeNote: bill.service_charge > 0
				? "A Voluntary Service Charge is included to support our staff. If you prefer not to contribute, please inform your server before payment and it will be removed."
				: null,
		}, cols);

		const dispatched = await dispatchPrintJob(restaurantId, {
			outlet_id: outletId, bill_id: bill.id, kind: "bill", station: null, esc_base64: escBase64,
		});
		try {
			await log_audit(req, ACCOUNTING_PERM,
				`Reprinted settled bill ${bill.bill_no ?? bill.id}${bill.table_name ? ` (table ${bill.table_name})` : ""} \u2014 ${settings.currency ?? "\u20b9"}${bill.grand_total.toFixed(2)}`,
				Audit_log_category.Bill,
				{ bill_id: bill.id, bill_no: bill.bill_no, grand_total: bill.grand_total, reprint: true });
		} catch {/* a failed audit write must never fail the print */}

		res.json({
			success: true,
			billId: bill.id,
			billNo: bill.bill_no,
			jobId: dispatched.jobId,
			destination: dispatched.decision.destinationName,
			device: dispatched.assignedDeviceId,
		});
	} catch (err: any) {
		logger.error({ err }, 'reprint_settled_bill_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to reprint this bill') });
	}
});

/*
	The printer agent reports what it did with one job.

	POST /print/ack  body { "jobId": "<uuid>", "result": "printed" | "failed" }
	                       optional: { "deviceId": "<uuid>", "generation": <int> }
	  -> 200 { "success": true, "duplicate": false }

	THE TWO OPTIONAL FIELDS ARE ADDITIVE AND THE ROUTE DOES NOT DEPEND ON THEM.
	Every agent in the field today sends the first pair and nothing else, and must
	keep working exactly as it does — the Android app ships on its own release
	train, so the fleet stays mixed for months. A routing-aware build that sends
	both buys the kitchen one thing: a jammed printer's 'failed' can be tied to the
	device that was holding the job, so the docket moves to the next printer in
	about a second instead of waiting out the 75-second verdict deadline. See the
	handler for why a wrong value can only ever be ignored.

	AN HTTP ROUTE RATHER THAN A SOCKET.IO ACK CALLBACK, deliberately. A Socket.IO
	ack is scoped to one emit on one connection: if the socket drops between
	delivery and acknowledgement — which is exactly the failure this whole change
	exists to survive — the callback is discarded and can never be retried. An HTTP
	ack is retryable over a fresh channel, works while the socket is down, rides the
	existing requireAuth path so the write lands under the right RLS context, and is
	testable without standing up a socket server.

	A DUPLICATE IS A 200, NOT AN ERROR. The ack can fail after the paper has come
	out, so a correct agent retries; punishing the retry teaches it not to retry,
	which loses the acks that matter. `duplicate: true` simply says the job was
	already settled.

	Gated on the EXISTING print permission (4ad474d4…) rather than a new one:
	whoever may print may confirm a print, and minting a new Action id would strip
	the capability from every role that exists today. (Migration 025's rule.)
*/
app.post('/print/ack', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sPrintAck), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: 'Missing restaurantId' }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const jobId = String(body.jobId ?? "").trim();
	const result = body.result === "failed" ? "failed" : "printed";
	// WHO IS ACKING, AS THE CLIENT REPORTS ITSELF — and every use of it makes a
	// stale ack LESS powerful, never more. AckPrintJobRouted fences on it: an ack
	// naming a device that is not the row's assignee is recorded and stops there,
	// which is precisely what a revoked assignee's late 'failed' should do instead
	// of tearing down the live assignee that is spooling at that moment. Without
	// it the statement falls back to trusting an unsigned ack only in the one
	// state where nobody else can have held the job (generation 0, no failures),
	// so a jam at generation 1 waits out the 75-second verdict deadline rather
	// than moving the docket in a second.
	//
	// IT IS NOT AN IDENTITY AND IS NEVER TREATED AS ONE. `printed_by_device` —
	// receipt history, who produced a money document — is taken from the ROW
	// inside AckPrintJobRouted and never from this body; see the SET list there.
	// An HTTP ack has no server-held device identity to bind to (the socket beats
	// do, via socket.data.print), so this stays a self-report, and the only thing
	// a wrong one can buy is being ignored.
	//
	// PARSED, NOT TRUSTED TO BE WELL-FORMED (see PRINT_DEVICE_ID_RE): anything
	// that is not a uuid is dropped here and the ack proceeds unsigned, i.e.
	// exactly as it does today.
	const claimedDevice = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
	const deviceId = PRINT_DEVICE_ID_RE.test(claimedDevice) ? claimedDevice : null;
	// A generation is a fence, so a negative or fractional one is not a smaller
	// fence — it is a value that can never equal assign_generation and would make
	// every ack from that client unattributable. Dropped for the same reason.
	const rawGeneration = Number(body.generation);
	const generation = Number.isInteger(rawGeneration) && rawGeneration >= 0 ? rawGeneration : null;
	try {
		const outcome = await ackPrintJob(restaurantId, jobId, result, { deviceId, generation });
		res.json({ success: true, duplicate: outcome.duplicate });
	} catch (err: any) {
		logger.error({ err }, 'print_ack_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to record print ack') });
	}
});

/*
	Reprint ONE ORDER's kitchen docket — the manual half of auto-print-on-bark.

	POST /print/kot/order/:id
	  -> 200 { success, billId, tickets, stations, kot_no, business_day, reprint }

	WHY THIS IS NOT /print/bill{kind:"kot"}. That route is TABLE-scoped: it goes
	through GetBillForTable, which aggregates every active order on the table. It
	is the right document for "print this table's ticket again", and the wrong one
	for "the printer jammed, send order 47's docket again" — on a table that has
	since taken a second order it would hand the kitchen the first order's food a
	second time.

	IT IS A REPRINT IN THE STRICT SENSE, and that is the whole point. The ticket
	key is (outlet, business day, table, item set), so an unchanged order resolves
	to the number already on paper via migration 029's memo and comes back with
	reprint:true. The kitchen gets the SAME docket, not a new ticket that happens
	to list the same food.

	Gated on the existing print permission (4ad474d4...), like every other print
	route: whoever may print may reprint. Minting a new Action id would strip the
	capability from every role that has it today (migration 025's rule).
*/
app.post('/print/kot/order/:id', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: 'Missing restaurant/outlet' }); return; }
	const orderId = String(req.params.id ?? "").trim();
	if (!orderId) { res.status(400).json({ error: 'order id is required' }); return; }
	try {
		const [order, settings, profile] = await Promise.all([
			GetOrderKotContext(restaurantId, orderId),
			GetRestaurantSettings(restaurantId).catch(() => ({ currency: "\u20b9" } as any)),
			GetRestaurantProfile(restaurantId).catch(() => null),
		]);
		if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
		if (order.items.length === 0) { res.status(400).json({ error: 'This order has no items to print' }); return; }
		const waiterCtx = order.table_name
			? await GetTableFeedbackContext(restaurantId, order.table_name).catch(() => null)
			: null;
		const waiterName = (waiterCtx?.employee_name ?? '').trim();
		const waiterRole = (waiterCtx?.employee_role ?? '').trim().toLowerCase();
		const dispatched = await dispatchKot({
			restaurantId, outletId,
			tableName: order.table_name,
			tableId: order.table_id,
			section: order.section,
			covers: order.covers,
			isVirtual: order.is_virtual,
			orderType: order.order_type,
			items: order.items,
			assignedTo: waiterName || null,
			captain: waiterName && (waiterRole === 'captain' || waiterRole === 'manager') ? waiterName : null,
			// The SAME bill_id shape the bark path uses, so a docket and its
			// reprint group together in "PrintJobs" instead of looking like two
			// unrelated tickets.
			billId: `order-${order.order_id}`,
			restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
			currency: settings.currency ?? "\u20b9",
			cols: settings.bill_paper_width === "58mm" ? 32 : 48,
			tz: settings.timezone || 'Asia/Kolkata',
		});
		logKotDispatched("print_kot_order", dispatched, { resId: restaurantId, outletId, orderId });
		const kotLabel = dispatched.kotNo ? `KOT-${dispatched.kotNo}${dispatched.reprint ? ' (reprint)' : ''}` : 'KOT';
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Reprinted ${kotLabel} for order ${orderId} (${dispatched.tickets} station ticket(s))`, Audit_log_category.Bill, { order_id: orderId, table: order.table_name, kind: 'kot', stations: dispatched.stations, kot_no: dispatched.kotNo, business_day: dispatched.businessDay, reprint: dispatched.reprint }); } catch {/* ignore */}
		res.json({
			success: true, billId: dispatched.billId, tickets: dispatched.tickets, stations: dispatched.stations,
			kot_no: dispatched.kotNo, business_day: dispatched.businessDay, reprint: dispatched.reprint,
		});
	} catch (err: any) {
		logger.error({ err, orderId }, 'print_kot_order_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to print the docket') });
	}
});

// Admin: remove a wrongly-added item from a table's running bill.
app.post('/bills/remove-item', validateBody(sBillRemoveItem), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
	const price = Number(body.price ?? 0) || 0;
	if (!tableName || !itemName) { res.status(400).json({ error: "table_name and item_name are required" }); return; }
	try {
		const result = await RemoveBillItem(auth.restaurantId, tableName, itemName, price);
		try { emitRestaurant(auth.restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Removed item ${result.removed.name} from table ${tableName}`, Audit_log_category.Bill, { table: tableName, item: itemName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'remove_bill_item_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to remove item') });
	}
});

// Move a wrongly-placed item from one table to another (front-of-house fix).
app.post('/bills/move-item', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillMoveItem), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
	const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
	const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
	const price = Number(body.price ?? 0) || 0;
	if (!fromTable || !toTable || !itemName) { res.status(400).json({ error: "from_table, to_table and item_name are required" }); return; }
	try {
		const result = await MoveBillItem(restaurantId, fromTable, toTable, itemName, price);
		try { emitRestaurant(restaurantId, "bill:updated", { table: fromTable }); emitRestaurant(restaurantId, "bill:updated", { table: toTable }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Moved item ${result.moved.name} from ${fromTable} to ${toTable}`, Audit_log_category.Bill, { from: fromTable, to: toTable, item: itemName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'move_bill_item_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to move item') });
	}
});

/*
	Set or clear a discount on a table's open bill (% or flat, off the subtotal).
	When the restaurant configures a discount-approval threshold, a NON-admin
	discount above it is parked as a pending request (managers get a bell ping)
	instead of applying — the response then carries { pending: true, request_id }.

	THE ROUTE GATE IS STILL 4ad474d4 "Add Orders", AND THAT IS DELIBERATE. Taking
	₹50 off for a slow starter is why this control exists and every floor role
	must keep it. What a waiter must NOT be able to do is write the bill off: a
	100% discount zeroes a table exactly as releasing it does, through a wider
	door, and the rationale that "large discounts need approval" is FALSE on a
	default tenant — "Restaurant".discount_approval_threshold defaults to 0 and
	the approval queue only engages above zero, so an unconfigured restaurant
	auto-applies whatever is typed.

	So the gate is on the DISCOUNT, not on the route, and it lives beside the
	subtotal it is sized against (SetBillDiscountWithApproval, inside the
	transaction) rather than here, where a pre-check would decide against a number
	another order could change before the write. This handler's job is to hand the
	data layer the caller's actions and to turn its refusal into a 403 THAT STILL
	HAS A BODY — see the catch: a bare 400 {error} would flatten the sentence
	naming the permission and the money into a "couldn't-do-that" toast, which is
	the very defect both clients were just fixed for.
*/
app.post('/bills/discount', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillDiscount), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const type = body.type === "flat" ? "flat" : "percent";
	const value = Number(body.value ?? 0) || 0;
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
		const result = await SetBillDiscountWithApproval(restaurantId, tableName, value > 0 ? type : null, value, {
			isAdmin: callerIsAdmin(req),
			requestedBy: extractEmployeeId(req),
			reason: reason || null,
			// THE WRITE-OFF GATE'S INPUTS. PERM_CLOSE_BILL is the SAME uuid
			// enforceSettleAuthority and the release gate check — never a new one
			// (migration 025's rule) — so a tenant that has decided who settles has
			// already decided who may write a bill off by discounting it.
			actions: req.auth?.actions ?? [],
			closeBillPermission: PERM_CLOSE_BILL,
		});
		if (result.pending) {
			const label = `${value}${type === "percent" ? "%" : ""} (≈${result.amount})`;
			try {
				await AddNotification(restaurantId, {
					type: "warning",
					title: "Discount approval needed",
					body: `Table ${tableName}: ${label} discount requested — review in Orders`,
					meta: { request_id: result.request_id, table: tableName, amount: result.amount },
				});
			} catch {/* best-effort bell ping */}
			try {
				await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Requested ${label} discount on table ${tableName} (above approval threshold ${result.threshold})`, Audit_log_category.Bill, { table: tableName, type, value, request_id: result.request_id });
			} catch {/* ignore */}
			res.json(result);
			return;
		}
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try {
			const desc = value > 0 ? `Applied ${value}${type === "percent" ? "%" : ""} discount to table ${tableName}` : `Cleared discount on table ${tableName}`;
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", desc, Audit_log_category.Bill, { table: tableName, type, value });
		} catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		// A REFUSED WRITE-OFF IS A 403 WITH A BODY, NOT A 400 WITH A SENTENCE
		// NOBODY SEES. `details` carries the rupee figures and names the
		// permission, which is both the explanation for the waiter standing at the
		// table and the checkbox for the owner in the role editor. AUDITED because
		// an attempt to write a bill off is exactly the event a manager wants to
		// see, and a refusal that leaves no trace is indistinguishable from one
		// that was never made; best-effort, so a failed audit write cannot turn a
		// 403 into a 500.
		if (isDiscountAuthorityError(e)) {
			try {
				await log_audit(
					req, "4ad474d4-5230-449c-874f-6a238b833bca",
					`REFUSED ${value}${type === "percent" ? "%" : ""} discount on table ${tableName} — would have written off ${e.discount_amount.toFixed(2)}, leaving ${e.remaining_value.toFixed(2)}, without Close Bill`,
					Audit_log_category.Bill,
					{ table: tableName, type, value, refused: true, discount_amount: e.discount_amount, remaining_value: e.remaining_value },
				);
			} catch (err) { logger.warn({ err }, 'log_audit discount refusal failed'); }
			res.status(403).json({
				error: "Forbidden",
				details: e.details,
				requiredPermission: e.requiredPermission,
				discount_amount: e.discount_amount,
				remaining_value: e.remaining_value,
			});
			return;
		}
		logger.error({ err: e }, 'set_bill_discount_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to set discount') });
	}
});
}


export function registerBillOpsRoutes(app: Express): void {

// Apply a coupon code to a table's open bill (staff / in-app).
app.post('/bills/apply-coupon', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillApplyCoupon), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
	if (!tableName || !code) { res.status(400).json({ error: "table_name and code are required" }); return; }
	try {
		const result = await ApplyCouponToBill(restaurantId, tableName, code, phone, {
			// THE SAME GATE AS THE MANUAL DISCOUNT, because a coupon writes the same
			// flat discount onto the same bill. Gating one and not the other would
			// leave a refused waiter one keystroke from the identical outcome, under
			// an audit line that says "coupon applied" instead of "written off".
			isAdmin: callerIsAdmin(req),
			actions: req.auth?.actions ?? [],
			closeBillPermission: PERM_CLOSE_BILL,
		});
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Applied coupon ${result.code} to table ${tableName}`, Audit_log_category.Bill, { table: tableName, code: result.code }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		// A refused write-off is a 403 WITH A BODY and an audit row — see the same
		// block on /bills/discount. Anything else stays a 400, unchanged.
		if (isDiscountAuthorityError(e)) {
			try {
				await log_audit(
					req, "4ad474d4-5230-449c-874f-6a238b833bca",
					`REFUSED coupon ${code} on table ${tableName} — would have written off ${e.discount_amount.toFixed(2)}, leaving ${e.remaining_value.toFixed(2)}, without Close Bill`,
					Audit_log_category.Bill,
					{ table: tableName, code, refused: true, discount_amount: e.discount_amount, remaining_value: e.remaining_value },
				);
			} catch (err) { logger.warn({ err }, 'log_audit coupon refusal failed'); }
			res.status(403).json({
				error: "Forbidden",
				details: e.details,
				requiredPermission: e.requiredPermission,
				discount_amount: e.discount_amount,
				remaining_value: e.remaining_value,
			});
			return;
		}
		logger.error({ err: e }, 'apply_coupon_failed');
		res.status(400).json({ error: String(e?.message ?? "Unable to apply coupon") });
	}
});

// H6 — change the name on a running table's bill.
//
// SAME GATE AS EVERY OTHER BILL EDIT, and deliberately not a new permission:
// 4ad474d4 "Add Orders" is what already lets this person type the name when the
// order is placed, so requiring something stronger to CORRECT a typo would only
// mean the wrong name stays on the paper. A settled bill is refused inside
// SetBillCustomerName by the same assertBillEditable every other edit meets.
//
// Round 2 item 1 — `customer_gstin` rides along. OMITTED LEAVES IT UNCHANGED, so
// a till built before the field existed renames a bill without wiping a GSTIN;
// null or "" clears it. The response gains `customer_gstin` and nothing else
// moves.
app.post('/bills/customer-name', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const customer = typeof body.customer === "string" ? body.customer : "";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	const gstin = customerGstinFromBody(body);
	if (gstin === INVALID_GSTIN) { res.status(400).json({ error: CUSTOMER_GSTIN_ERROR }); return; }
	try {
		const result = await SetBillCustomerName(restaurantId, tableName, customer, gstin);
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try {
			const nameLine = result.customer
				? `Set the bill name on table ${tableName} to "${result.customer}"`
				: `Cleared the bill name on table ${tableName}`;
			const gstinLine = gstin === undefined ? "" : (gstin ? ` (GSTIN ${gstin})` : " (GSTIN cleared)");
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca",
				`${nameLine}${gstinLine}`,
				Audit_log_category.Bill,
				{ table: tableName, customer: result.customer, ...(gstin === undefined ? {} : { customer_gstin: gstin }) });
		} catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		if (sendCustomerGstinError(res, e)) { return; }
		logger.error({ err: e }, 'set_bill_customer_name_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to change the name on this bill') });
	}
});

/*
	Round 2 item 1 — THE NAME AND GSTIN ON A PAST (SETTLED) BILL, from Accounting.

	POST /bills/:billId/customer-details  body { "customer": "...", "customer_gstin": "..." | null }
	  -> 200 { success: true, bill_id, customer, customer_gstin }
	  -> 400 { error: "GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5" }
	  -> 404 { error: "Bill not found" }       not a settled bill of this tenant
	  -> 503 { error: "This server has not finished updating — try again shortly" }
	                                           a GSTIN write before migration 046

	WHO MAY DO IT: ACCOUNTING_PERM — exactly what E5's /print/bill/settled
	requires, because the button lives beside that reprint in the same past-bills
	screen, and whoever may put a second copy of this invoice on paper is whoever
	may correct who it is made out to. A waiter does not hold it and gets
	validateAction's 403. /bills/customer-name stays the waiter's door for the
	RUNNING bill, and still refuses a settled one.

	WHAT IT CHANGES: the name and the GSTIN, nothing else — see
	SetClosedBillCustomerDetails. `customer_gstin` omitted leaves it unchanged, the
	same rule as the live route, so a name-only correction works before 046.
*/
app.post('/bills/:billId/customer-details', validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const billId = String(req.params.billId ?? "").trim();
	if (!billId) { res.status(404).json({ error: "Bill not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const customer = typeof body.customer === "string" ? body.customer : "";
	const gstin = customerGstinFromBody(body);
	if (gstin === INVALID_GSTIN) { res.status(400).json({ error: CUSTOMER_GSTIN_ERROR }); return; }
	try {
		const result = await SetClosedBillCustomerDetails(restaurantId, billId, customer, gstin);
		if (!result) { res.status(404).json({ error: "Bill not found" }); return; }
		try {
			const what = gstin === undefined ? "name" : "name/GSTIN";
			await log_audit(req, ACCOUNTING_PERM,
				`Changed the ${what} on bill #${result.bill_no ?? result.bill_id}${result.table_name ? ` (table ${result.table_name})` : ""} \u2014 ` +
					`name "${result.customer ?? "Guest"}"${gstin === undefined ? "" : `, GSTIN ${result.customer_gstin ?? "cleared"}`}`,
				Audit_log_category.Bill,
				{ bill_id: result.bill_id, bill_no: result.bill_no, customer: result.customer, ...(gstin === undefined ? {} : { customer_gstin: result.customer_gstin }), settled_bill_edit: true });
		} catch {/* a failed audit write must never fail the edit */}
		res.json({ success: true, bill_id: result.bill_id, customer: result.customer, customer_gstin: result.customer_gstin });
	} catch (e: any) {
		if (sendCustomerGstinError(res, e)) { return; }
		logger.error({ err: e }, 'set_closed_bill_customer_details_failed');
		res.status(500).json({ error: 'Unable to change the details on this bill' });
	}
});

// Add / edit / clear the kitchen note on a single bill item (by name + price),
// at any time. Front-of-house staff with bill access can annotate items.
app.post('/bills/item-note', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillItemNote), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
	const price = Number(body.price ?? 0) || 0;
	const note = typeof body.note === "string" ? body.note : "";
	if (!tableName || !itemName) { res.status(400).json({ error: "table_name and item_name are required" }); return; }
	try {
		const result = await SetBillItemNote(restaurantId, tableName, itemName, price, note);
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `${note.trim() ? "Set" : "Cleared"} note on ${itemName} (table ${tableName})`, Audit_log_category.Bill, { table: tableName, item: itemName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'set_bill_item_note_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to set item note') });
	}
});

/**
 * WHICH CUT OF THE MENU A SECTION SPLIT DIVIDES A BILL ALONG.
 *
 * Read leniently and refused explicitly. A till that sends an axis this build
 * has never heard of gets a 400 naming the three, rather than a split silently
 * computed along a different axis than the one the cashier picked — the guest is
 * about to be asked to pay one of these amounts.
 *
 * An ABSENT axis is `category`, because it is the one that works with no
 * configuration at all: every menu item has a category, and none has a group
 * until somebody sets them up. See the data layer's SPLITTING A BILL header.
 */
function readSectionAxis(raw: unknown): BillSectionAxis | null {
	const wanted = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (!wanted) { return "category"; }
	if (["category", "categories", "menu_category"].includes(wanted)) { return "category"; }
	if (["revenue_group", "revenue", "group", "groups"].includes(wanted)) { return "revenue_group"; }
	if (["production_group", "production"].includes(wanted)) { return "production_group"; }
	return null;
}

// Compute a split of a table's bill (read-only — does not change the bill).
//
// THREE MODES, and the third is the new one: 'even' N ways, 'item' by
// caller-named guest groups, 'section' by the part of the menu the food came
// from (`axis`: category / revenue_group / production_group). Only 'section'
// reads the menu; the other two are untouched, byte for byte, because they are
// what every till in the field is calling today.
app.post('/bills/split', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), validateBody(sBillSplit), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const mode = body.mode === "item" ? "item" : body.mode === "section" ? "section" : "even";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
		if (mode === "section") {
			const axis = readSectionAxis(body.axis ?? body.by);
			if (!axis) {
				res.status(400).json({ error: `Unknown split axis. Use one of: ${BILL_SECTION_AXES.join(", ")}` });
				return;
			}
			const split = await SplitBillForTableBySection(restaurantId, tableName, axis);
			// THE CEILING IS SAID HERE, NOT DISCOVERED AT THE TILL. A bill settles
			// across at most MAX_BILL_TENDERS payments (see that constant's header —
			// `payment_splits` accepts 2..6 and a seventh tender would record and then
			// be impossible to settle). A menu can easily have more sections than
			// that, so a split that cannot be taken as separate payments has to say
			// so while there is still time to take some of the sections together.
			const overCeiling = split.payable_parts > MAX_BILL_TENDERS;
			res.json({
				...split,
				tender_ceiling: MAX_BILL_TENDERS,
				exceeds_tender_ceiling: overCeiling,
				notes: overCeiling
					? [...split.notes, `This splits into ${String(split.payable_parts)} sections that need paying, but a bill can be settled across at most ${String(MAX_BILL_TENDERS)} payments. Take some of these sections on one payment, or settle the bill whole.`]
					: split.notes,
			});
			return;
		}
		const result = await SplitBillForTable(restaurantId, tableName, mode, {
			parts: Number(body.parts ?? 0) || undefined,
			groups: Array.isArray(body.groups) ? (body.groups as any) : undefined,
		});
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'split_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to split bill') });
	}
});

/*
	F3 — PRINT THE SPLIT. One document per part, on paper.

	POST /print/bill/split  { table_name, mode, parts?, groups?, axis? }
	  -> 200 { success, parts, jobs: [{ index, of, label, grandTotal, jobId, destination }] }

	============================================================================
	THE RENDERER EXISTED AND NOTHING CALLED IT
	============================================================================
	V3: "Ensure the system successfully generates and PRINTS TWO SEPARATE BILLS
	when an order is split, and that this split registers correctly on the
	dashboard."

	`buildSplitReceiptsBase64` (escpos.ts) was written for exactly this, it has a
	test suite, and grep found its only importer was that suite. `POST /bills/split`
	computed the parts and handed them back as JSON for the screen to display —
	so the dashboard half worked and the PAPER half did not exist. That is this
	codebase's most repeated defect: something correct built on the server that no
	caller ever reaches, which is why the test below asserts the wiring and not
	just the bytes.

	============================================================================
	THE SPLIT IS RECOMPUTED HERE, NOT TAKEN FROM THE REQUEST
	============================================================================
	The obvious shape is to let the client post back the parts it is already
	showing. It is also the one that hands a guest a bill the till will not
	honour: between the preview and the print somebody adds a round, applies a
	coupon, or a waiver lands — and the printed parts would then sum to a total
	nobody owes. So the body carries the same INPUTS `/bills/split` takes and the
	parts are derived again, from the bill as it stands at this instant, by the
	same functions that produced the preview.

	============================================================================
	ITEM-MODE GOES THROUGH THE SECTION LADDER
	============================================================================
	`computeBillSplit`'s item mode returns each group's own item value as
	`subtotal` and its share of the grand total as `total`. On a screen the gap
	between them is obviously tax and service; on PAPER an unexplained gap between
	a subtotal and a total is the thing a guest queries. So an item split is fed
	through `computeSectionSplit` with each guest group as a "section", which
	allocates the discount, the service charge and every tax line across the parts
	with the same largest-remainder arithmetic the section split already uses —
	and the parts come out fully laddered, printing exactly like a whole bill.

	An EVEN split has no items to ladder: `computeBillSplit` gives each part the
	same tax-inclusive share, so subtotal equals total and the part prints one
	figure with nothing unexplained between.
*/
app.post('/print/bill/split', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: 'Missing restaurant/outlet' }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const mode = body.mode === "item" ? "item" : body.mode === "section" ? "section" : "even";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }

	try {
		const [bill, settings, profile] = await Promise.all([
			GetBillForTable(restaurantId, tableName),
			GetRestaurantSettings(restaurantId).catch(() => ({ currency: "\u20b9" } as any)),
			GetRestaurantProfile(restaurantId).catch(() => null),
		]);
		if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
			res.status(400).json({ error: 'Nothing to print for this table' });
			return;
		}

		// --- the parts, derived NOW -------------------------------------------
		let parts: SplitReceiptPart[] = [];
		if (mode === "section") {
			const axis = readSectionAxis(body.axis ?? body.by);
			if (!axis) {
				res.status(400).json({ error: `Unknown split axis. Use one of: ${BILL_SECTION_AXES.join(", ")}` });
				return;
			}
			const split = await SplitBillForTableBySection(restaurantId, tableName, axis);
			parts = split.parts;
		} else if (mode === "item" && Array.isArray(body.groups) && body.groups.length > 0) {
			// Each guest group becomes a "section", so the ladder allocation is the
			// one already proven rather than a second implementation. See the header.
			const groups = body.groups as { label?: string; items?: { name: string; price: number; quantity: number }[] }[];
			const lines = groups.flatMap((g, i) => {
				const key = `guest-${String(i + 1)}`;
				const label = String(g.label ?? "").trim() || `Guest ${String(i + 1)}`;
				return (Array.isArray(g.items) ? g.items : []).map((it) => ({
					section_key: key,
					section_label: label,
					name: String(it.name ?? "Item"),
					price: Number(it.price) || 0,
					quantity: Number(it.quantity) || 1,
				}));
			});
			const split = computeSectionSplit(
				{
					subtotal: bill.subtotal,
					discount: bill.discount,
					discounted_subtotal: round2(Math.max(0, bill.subtotal - bill.discount)),
					service_charge: bill.service_charge,
					taxes: bill.taxes,
					tax_total: bill.tax_total,
					grand_total: bill.grand_total,
				},
				lines,
				{ fallbackLabel: "Unassigned" },
			);
			parts = split.parts;
		} else {
			const even = await SplitBillForTable(restaurantId, tableName, "even", {
				parts: Number(body.parts ?? 0) || undefined,
			});
			// subtotal === total on an even part, so nothing is left unexplained
			// between the two lines. See the header.
			parts = even.parts.map((pt) => ({
				label: pt.label,
				subtotal: pt.subtotal,
				grand_total: pt.total,
				items: [],
			}));
		}

		// --- the paper ---------------------------------------------------------
		const is58 = settings.bill_paper_width === "58mm";
		const cols = is58 ? 32 : 48;
		const logo = await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null);
		const receipts = buildSplitReceiptsBase64({
			restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
			legalName: settings.bill_legal_name ?? null,
			address: profile?.outlet_add ?? null,
			phone: profile?.outlet_phone ?? null,
			gstin: settings.bill_gstin ?? null,
			table: tableName,
			covers: bill.covers ?? 1,
			items: bill.items,
			total: bill.subtotal,
			customer: bill.customer,
			customerGstin: bill.customer_gstin ?? null,
			billNo: bill.bill_no,
			// Restaurant-zone stamp, as on the whole bill (see /print/bill).
			printedAt: kotStamp(new Date(), settings.timezone || "Asia/Kolkata"),
			discount: bill.discount > 0 ? { amount: bill.discount, label: bill.coupon_code ? `Coupon ${bill.coupon_code}` : "Discount" } : null,
			// The bill's PERCENTAGE; each part carries its own share as the amount.
			// A waived charge stays waived on every part — the renderer prints the
			// word rather than a figure, which is the point of a waiver being
			// visible on paper instead of inferred from a missing line.
			serviceCharge: bill.service_charge > 0
				? { percent: bill.service_charge_percent, amount: bill.service_charge }
				: (bill.service_charge_waived
					? { percent: bill.service_charge_percent, amount: 0, optedOut: true }
					: null),
			taxes: bill.taxes,
			grandTotal: bill.grand_total,
			currency: settings.currency ?? "\u20b9",
			kind: "bill",
			logo,
			// NO FEEDBACK QR ON A SPLIT PART. The QR is signed for the seating, so
			// every part would carry the same link and the first guest to scan it
			// would rate the meal on behalf of the table.
			feedbackUrl: null,
			serviceChargeNote: bill.service_charge > 0
				? "A Voluntary Service Charge is included to support our staff. If you prefer not to contribute, please inform your server before payment and it will be removed."
				: null,
		}, parts, cols);

		// --- dispatch, one job per part ----------------------------------------
		//
		// SEQUENTIALLY, and that is deliberate. The printer agent takes jobs off a
		// queue; firing N in parallel lets them interleave on the roll, and "part 2
		// of 3" printed between the two halves of part 1 is worse than slow.
		const jobs: { index: number; of: number; label: string; grandTotal: number; jobId: string | null; destination: string | null }[] = [];
		for (const r of receipts) {
			const dispatched = await dispatchPrintJob(restaurantId, {
				outlet_id: outletId,
				// Its OWN bill_id per part, so each is its own job row and a failed
				// part can be retried without reprinting the others.
				bill_id: `${bill.bill_id ?? tableName}-split-${String(r.index)}of${String(r.of)}`,
				kind: "bill", station: null, esc_base64: r.escBase64,
			});
			jobs.push({
				index: r.index, of: r.of, label: r.label, grandTotal: r.grandTotal,
				jobId: dispatched.jobId, destination: dispatched.decision.destinationName,
			});
		}

		try {
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca",
				`Printed ${String(receipts.length)} split bill(s) for table ${tableName} (${mode})`,
				Audit_log_category.Bill,
				{ table: tableName, mode, parts: receipts.length, totals: receipts.map((r) => r.grandTotal) });
		} catch {/* a failed audit write must never fail the print */}

		res.json({ success: true, mode, parts: receipts.length, jobs });
	} catch (err: any) {
		logger.error({ err }, 'print_split_bill_failed');
		res.status(400).json({ error: String(err?.message ?? 'Unable to print the split bills') });
	}
});

// Merge one table's active orders into another (combine checks).
app.post('/bills/merge', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillMerge), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
	const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
	if (!fromTable || !toTable) { res.status(400).json({ error: "from_table and to_table are required" }); return; }
	try {
		const result = await MergeTableBills(restaurantId, fromTable, toTable);
		try { emitRestaurant(restaurantId, "bill:updated", { table: fromTable }); emitRestaurant(restaurantId, "bill:updated", { table: toTable }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Merged table ${fromTable} into ${toTable} (${result.moved_orders} orders)`, Audit_log_category.Bill, { from: fromTable, to: toTable }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'merge_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to merge bills') });
	}
});

// Refund a settled bill (admin only). Records the reversal; for a Razorpay payment
// it also attempts a gateway refund when keys are configured.
app.post('/bills/refund', validateBody(sBillRefund), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}
	const restaurantId = auth.restaurantId;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const billId = typeof body.bill_id === "string" ? body.bill_id.trim() : "";
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const amount = Number(body.amount ?? 0) || 0;
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";
	if (!billId && !tableName) { res.status(400).json({ error: "bill_id or table_name is required" }); return; }
	const byUsername = extractEmployeeId(req) ?? undefined;
	try {
		const result = await RefundBill(restaurantId, {
			billId: billId || undefined,
			tableName: tableName || undefined,
			amount: amount || undefined,
			reason: reason || undefined,
			byUsername,
		});
		// For an online (Razorpay) payment, attempt the gateway refund too.
		let gateway: "skipped" | "ok" | "failed" | "manual" = "skipped";
		if (result.payment_method === "Razorpay" && result.payment_ref) {
			const keys = (await GetRestaurantRazorpayKeys(restaurantId).catch(() => null))
				?? ((RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) ? { key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET } : null);
			if (!keys) {
				gateway = "manual";
			} else {
				try {
					const rp = await fetchWithTimeout(`https://api.razorpay.com/v1/payments/${encodeURIComponent(result.payment_ref)}/refund`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
							// Stable per-bill key so retrying a failed refund can't double-refund
							// at the gateway — Razorpay returns the same refund for the same key.
							"X-Razorpay-Idempotency-Key": `refund:${result.bill_id}`,
						},
						body: JSON.stringify({ amount: Math.round(result.amount * 100) }),
					});
					if (rp.ok) {
						const j: any = await rp.json().catch(() => ({}));
						gateway = "ok";
						if (typeof j?.id === "string" && j.id) { try { await SetBillRefundRef(restaurantId, result.bill_id, j.id); } catch {/* ignore */} }
					} else {
						// A failed real-money refund must be diagnosable.
						const errText = await rp.text().catch(() => "");
						logger.error({ bill_id: result.bill_id, status: rp.status, body: errText.slice(0, 500) }, "razorpay_refund_failed");
						gateway = "failed";
					}
				} catch (e) { logger.error({ bill_id: result.bill_id, error: String((e as any)?.message ?? e) }, "razorpay_refund_error"); gateway = "failed"; }
			}
		}
		try { await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Refunded bill ${result.bill_id} (amount ${result.amount}, gateway ${gateway})`, Audit_log_category.Bill, { bill_id: result.bill_id, amount: result.amount, gateway }); } catch {/* ignore */}
		try { if (tableName) {emitRestaurant(restaurantId, "bill:updated", { table: tableName });} } catch {/* ignore */}
		res.json({ ...result, gateway });
	} catch (e: any) {
		logger.error({ err: e }, 'refund_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to refund bill') });
	}
});

// Re-open a closed bill (admin only) within the restaurant's configured window
// (Settings → bill_reopen_window_min, default 240). Refunded bills are refused.
app.post('/bills/:id/reopen', validate, async (req: Request, res: Response) => {
	if (!(await enforceAdmin(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const billId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!billId) { res.status(400).json({ error: "Bill id is required" }); return; }
	try {
		const result = await ReopenBill(restaurantId, billId, extractEmployeeId(req));
		try { if (result.bill.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: result.bill.table_name });} } catch {/* ignore */}
		try {
			await log_audit(req, "d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a", `Re-opened bill ${result.bill.bill_no ?? result.bill.id} (table ${result.bill.table_name ?? "?"}, ${result.restored_orders} orders restored)`, Audit_log_category.Bill, { bill_id: result.bill.id, table: result.bill.table_name, restored_orders: result.restored_orders });
		} catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'reopen_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to re-open bill') });
	}
});
}


/**
 * TENDERS, TIPS AND TILLS — the HTTP surface over migrations 037 and 038.
 *
 * Registered LAST (index.ts), after every other bill route, so nothing here can
 * shadow a path that already exists and nothing that already exists can swallow
 * one of these. Every path is a literal or a literal followed by an id, and the
 * route manifest is the check that stays true.
 *
 * ============================================================================
 * WHAT A TENDER IS, AND WHAT IT IS NOT
 * ============================================================================
 * A tender is ONE payment against ONE bill: a method, an amount, and the
 * acquirer's reference. `amount` is the portion of the BILL it settles and never
 * includes the tip. The tip rides on the same row because that is how it is
 * physically taken — "put fifty on the card" — but it is excluded from every sum
 * that reconciles against the grand total, so a tipped bill still balances to
 * the paisa. A tip reaches no sales figure, no APC and no ABV; the only reader
 * that reports it is GetTipLedger, and it reports nothing else.
 *
 * ============================================================================
 * OVER-TENDER AND UNDER-TENDER, DECIDED RATHER THAN LEFT OPEN
 * ============================================================================
 *   * OVER-TENDER IS REFUSED, never recorded, and never netted off. Change
 *     handed back in cash is not a negative tender; if it were, the sum of
 *     tenders would stop meaning "money that entered the till" and every
 *     drawer-level reconciliation built on that sum would quietly become wrong.
 *     The tender is the amount APPLIED TO THE BILL. What the guest actually held
 *     out is not a fact this system has, and inventing it is worse than
 *     admitting it.
 *   * UNDER-TENDER ON AN OPEN BILL IS A PARTIAL SETTLEMENT and is a legal,
 *     named state: the guest has paid some of it, `outstanding` says how much is
 *     left, and the bill stays open. That is the whole reason POST /bills/tenders
 *     exists separately from the settle.
 *   * UNDER-TENDER AT SETTLE IS REFUSED. The settle passes require_full, so the
 *     tenders must reconstruct the grand total exactly or nothing is written —
 *     and if a short ledger somehow reaches approval anyway,
 *     assertTendersReconcileForSettle refuses there too.
 *
 * ============================================================================
 * COUNTERS AND "CashSessions" ARE TWO DIFFERENT NOUNS
 * ============================================================================
 * "BillingCounters" is an IDENTITY — a till, configured once, durable, existing
 * whether or not anyone is trading. "CashSessions" is an EVENT — one drawer
 * counted once at the end of one shift. The relationship is one-to-many, counter
 * to sessions, and migration 038 puts counter_id on BOTH "Bills" (which till
 * RANG the sale) and "CashSessions" (which till was COUNTED), because only with
 * both can a cash-up be reconciled against the sales it is supposed to explain.
 * So this file configures and attributes counters and does NOT reimplement the
 * cash-up: /cash/open, /cash/close and /cash/current in routes/accounting.ts now
 * take the same counter and stay the one place a drawer is counted.
 *
 * A NULL counter still means "this outlet's single till", which is what every
 * existing bill and every existing session is. A tenant that never configures a
 * counter never sends the header and sees no change anywhere.
 *
 * ============================================================================
 * NO idempotent() ON ANY ROUTE HERE — SO THE FLUTTER OUTBOX ALLOWLIST IS UNTOUCHED
 * ============================================================================
 * Deliberate, and said loudly because outbox.dart mirrors the server opt-in
 * exactly. Recording a tender mints a "Bills" row (and with it an invoice
 * number) for a table that has none, which idempotency.ts's header puts
 * explicitly out of scope; and a queued payment is a bill that says one thing on
 * the printed copy and another on the server. The right offline behaviour for
 * taking money is "refuse now", not "apply later" — the same rule settle already
 * lives by.
 */
export function registerTenderRoutes(app: Express): void {

/*
	What this bill is worth and what has been paid against it.

	GET /bills/tenders?bill_id= | ?table_name= | ?order_id=
	  -> 200 { bill_id, grand_total, tenders, tendered, outstanding,
	           exact, partial, over, tips_total, payment_method, payment_splits }

	READ-ONLY, INCLUDING WHEN THERE IS NO BILL ROW YET. A table that has ordered
	and not yet asked for the bill has no "Bills" row, and this must not create
	one: a GET that allocated an invoice number is how a polling payment screen
	mints phantom bills. It answers with the grand total the guest currently owes
	and nothing tendered, which is the true state and the one a payment screen
	needs before the first tender is taken.

	`grand_total` here is a LIVE quote on an open bill, not a promise: the settle
	recomputes it inside its own transaction, so an order landing in between moves
	the number rather than settling at a stale one.
*/
app.get('/bills/tenders', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const q = (req.query ?? {}) as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : Array.isArray(v) && typeof v[0] === "string" ? v[0].trim() : "");
	const billId = str(q.bill_id);
	const tableName = str(q.table_name);
	const orderId = str(q.order_id);
	if (!billId && !tableName && !orderId) {
		res.status(400).json({ error: "bill_id, table_name or order_id is required" });
		return;
	}
	try {
		res.json(await GetBillTenderState(restaurantId, {
			...(billId ? { bill_id: billId } : {}),
			...(tableName ? { table_name: tableName } : {}),
			...(orderId ? { order_id: orderId } : {}),
		}));
	} catch (e: any) {
		logger.error({ err: e }, 'get_bill_tenders_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to read the payments on this bill') });
	}
});

/*
	Record one or more payments against an OPEN bill.

	POST /bills/tenders
	  body { bill_id | table_name | order_id, tenders: [ {method, amount, txn_ref?,
	         tip_amount?, tip_mode?, tip_credited_to_username?, tip_credited_to_employee_id?} ] }
	  -> 201 { ...state }

	This is the PART-PAYMENT route: the amounts may come to less than the bill and
	the bill stays open, with `outstanding` saying what is left. The tender that
	FINISHES the bill is normally sent on the settle call itself
	(POST /bills/order/:orderId/waiter-confirm-payment), which appends it to
	whatever is already here and checks the total in one transaction — but a set
	recorded here that happens to complete the bill is still correct, because the
	settle consults this ledger and mirrors it rather than overwriting it.

	WHO TOOK THE PAYMENT COMES FROM THE VERIFIED SESSION. There is no body field
	that can set it, for the same reason no control ledger accepts an actor from
	the client: a till that could name its own cashier could sign someone else's
	settlement. `tip_credited_to_username` DOES come from the body, because it is
	a destination rather than an actor, and it is deliberately not resolved
	against the staff list — tips are routinely owed to the kitchen or to a pool,
	i.e. to people who hold no POS permission at all and may not be POS users.
	What the schema guarantees is that a tip always says how it arrived and where
	it is going; who that is remains an operator's word.
*/
app.post('/bills/tenders', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), validateBody(sBillTenders), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const username = extractEmployeeUsername(req);
	if (!username) { res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." }); return; }
	const body = req.body as { bill_id?: string; table_name?: string; order_id?: string };
	const target = {
		...(body.bill_id ? { bill_id: String(body.bill_id).trim() } : {}),
		...(body.table_name ? { table_name: String(body.table_name).trim() } : {}),
		...(body.order_id ? { order_id: String(body.order_id).trim() } : {}),
	};

	let tenders: RouteTender[] | null;
	try { tenders = readTenderList((req.body as Record<string, unknown>).tenders); }
	catch (err) { res.status(400).json({ error: String((err as { message?: unknown })?.message ?? 'Invalid tenders') }); return; }
	if (!tenders) { res.status(400).json({ error: "At least one tender is required" }); return; }

	try {
		// The same refusals the settle applies, for the same reason and from the
		// same function: a tender recorded here that the settle could not mirror
		// would leave a paid bill permanently open.
		const ledger = await GetBillPaymentLedger(restaurantId, target);
		const refusal = tenderSetRefusal(ledger, tenders);
		if (refusal) { res.status(400).json({ error: refusal }); return; }
		const state = await RecordBillTenders(restaurantId, {
			...target,
			tenders,
			settled_by_employee_id: extractEmployeeId(req),
			settled_by_username: username,
		});
		try {
			await log_audit(
				req, "2393edd7-cdd9-439c-9ff3-d563d5216967",
				`Recorded ${String(tenders.length)} payment(s) totalling ${state.tendered} on bill ${state.bill_id}${state.tips_total > 0 ? ` (tips ${state.tips_total})` : ""}${state.outstanding > 0 ? ` — ${state.outstanding} still outstanding` : ""}`,
				Audit_log_category.Bill,
				{
					bill_id: state.bill_id, tenders: tenders.length, tendered: state.tendered,
					tips_total: state.tips_total, outstanding: state.outstanding,
					grand_total: state.grand_total, payment_method: state.payment_method,
				},
			);
		} catch (err) { logger.warn({ err }, 'log_audit record-tenders failed'); }
		try { if (body.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: String(body.table_name).trim() });} } catch {/* ignore */}
		res.status(201).json(state);
	} catch (e: any) {
		logger.error({ err: e }, 'record_bill_tenders_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to record that payment') });
	}
});

/*
	Void one recorded payment.

	POST /bills/tenders/:id/void
	  body { reason }
	  -> 200 { ...state }

	SUPERSEDED, NEVER DELETED. The row stays, stamped with who voided it and why,
	and drops out of every sum. This is what closes the double-count: a card
	payment keyed twice leaves two rows and one live amount, and the evidence that
	it was keyed twice survives for the day the acquirer's statement shows two
	authorisations.

	OPEN BILLS ONLY, enforced in the data layer inside the same transaction. On a
	settled bill the constraint trigger already refuses a partial void, but it
	stays silent when the LAST tender goes — which would leave a closed bill
	reading 'Split' with no parts, i.e. a settlement the reports cannot allocate.
	Money that has already moved is corrected with a refund, which has its own
	path, its own columns and its own audit entry.
*/
app.post('/bills/tenders/:id/void', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), validateBody(sTenderVoid), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const username = extractEmployeeUsername(req);
	if (!username) { res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." }); return; }
	const tenderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!tenderId) { res.status(400).json({ error: "A tender id is required" }); return; }
	const body = req.body as { reason: string };
	try {
		const state = await VoidBillTender(restaurantId, tenderId, { reason: body.reason, by_username: username });
		try {
			await log_audit(
				req, "2393edd7-cdd9-439c-9ff3-d563d5216967",
				`Voided a payment on bill ${state.bill_id} — ${state.tendered} now tendered, ${state.outstanding} outstanding`,
				Audit_log_category.Bill,
				{
					reversal: true, bill_id: state.bill_id, tender_id: tenderId, reason: body.reason,
					tendered: state.tendered, outstanding: state.outstanding,
					grand_total: state.grand_total, payment_method: state.payment_method,
				},
			);
		} catch (err) { logger.warn({ err }, 'log_audit void-tender failed'); }
		res.json(state);
	} catch (e: any) {
		logger.error({ err: e }, 'void_bill_tender_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to void that payment') });
	}
});

/*
	Attribute a bill to the till that rang it.

	POST /bills/counter
	  body { bill_id | table_name | order_id, counter_id? }   (or the X-Counter-Id header)
	  -> 200 { bill_id, counter_id }

	The settle route already does this automatically from `X-Counter-Id`, so this
	exists for the two cases that route cannot serve: attributing a bill BEFORE it
	is settled (a food-court stall that rings and prints from one till), and
	CORRECTING an attribution after a terminal was found to be misconfigured. A
	closed bill is not refused, because the reason to reach for this is usually
	that a settled bill went to the wrong till and a cash-up will not balance
	until it is moved.

	An omitted counter_id (and no header) CLEARS the attribution back to "this
	outlet's single till", which is the state of every bill that predates
	migration 038.
*/
app.post('/bills/counter', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), validateBody(sBillCounter), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = req.body as { bill_id?: string; table_name?: string; order_id?: string };
	const target = {
		...(body.bill_id ? { bill_id: String(body.bill_id).trim() } : {}),
		...(body.table_name ? { table_name: String(body.table_name).trim() } : {}),
		...(body.order_id ? { order_id: String(body.order_id).trim() } : {}),
	};
	const counterId = counterIdFrom(req);
	try {
		if (counterId) { await requireCounter(restaurantId, counterId); }
		const ledger = await GetBillPaymentLedger(restaurantId, target);
		if (!ledger.bill_id) { res.status(404).json({ error: "No bill to attribute — this table has not been billed yet" }); return; }
		const ok = await SetBillCounter(restaurantId, ledger.bill_id, counterId);
		if (!ok) { res.status(404).json({ error: "Bill not found" }); return; }
		try {
			await log_audit(
				req, "2393edd7-cdd9-439c-9ff3-d563d5216967",
				counterId
					? `Attributed bill ${ledger.bill_id} to counter ${counterId}`
					: `Cleared the counter attribution on bill ${ledger.bill_id}`,
				Audit_log_category.Bill,
				{ bill_id: ledger.bill_id, counter_id: counterId },
			);
		} catch (err) { logger.warn({ err }, 'log_audit bill-counter failed'); }
		res.json({ bill_id: ledger.bill_id, counter_id: counterId });
	} catch (e: any) {
		logger.error({ err: e }, 'set_bill_counter_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to attribute that bill') });
	}
});

/*
	The outlet's tills.

	GET /billing-counters?include_inactive=1 -> 200 { counters: [...] }

	Gated on the RECORD-PAYMENT permission rather than on settings, deliberately
	and asymmetrically with the write below: whoever can take money has to be able
	to see which till they are on, and a cashier picking their counter at the
	start of a shift is not a configuration act. Creating and renaming tills is,
	and that stays with settings.

	EMPTY IS THE NORMAL ANSWER. Most tenants have one till per outlet and never
	configure a counter; they get `[]` here and NULL attribution everywhere, which
	reads as "this outlet's till" in every report.
*/
app.get('/billing-counters', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const raw = req.query.include_inactive;
	const v = Array.isArray(raw) ? raw[0] : raw;
	const includeInactive = v === "1" || v === "true";
	try {
		res.json({ counters: await ListBillingCounters(restaurantId, { includeInactive }) });
	} catch (e: any) {
		logger.error({ err: e }, 'list_billing_counters_failed');
		res.status(500).json({ error: "Unable to list the billing counters" });
	}
});

/*
	Create or rename a till.

	POST /billing-counters
	  body { code, name?, kind?, device_hint?, active?, sort_order?, id? }
	  -> 200 { counter }

	UPSERTS ON THE CODE, case-insensitively per outlet, so re-saving the
	configuration screen updates rather than duplicating and "C1" and "c1" can
	never become two tills nobody can tell apart on a cash-up sheet at 1am.

	DEACTIVATION, NOT DELETION — there is no DELETE here on purpose. Removing a
	counter would orphan the counter_id on every bill it ever rang, which is
	precisely the history the column exists to keep. `active: false` retires it:
	it stops being offered, and every bill and cash session it is named on still
	resolves.
*/
app.post('/billing-counters', validateAction(PERM_SETTINGS), validateBody(sCounterUpsert), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = req.body as { id?: string; code: string; name?: string; kind?: string; device_hint?: string | null; active?: boolean; sort_order?: number };
	try {
		const counter = await UpsertBillingCounter(restaurantId, body);
		try {
			await log_audit(
				req, PERM_SETTINGS,
				`Saved billing counter ${counter.code} (${counter.name}, ${counter.kind}${counter.active ? "" : ", inactive"})`,
				Audit_log_category.General,
				{ counter_id: counter.id, code: counter.code, kind: counter.kind, active: counter.active },
			);
		} catch (err) { logger.warn({ err }, 'log_audit billing-counter failed'); }
		res.json({ counter });
	} catch (e: any) {
		logger.error({ err: e }, 'upsert_billing_counter_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to save that counter') });
	}
});

/*
	THE TIP LEDGER — who is owed what, over a window.

	GET /tips?from=YYYY-MM-DD&to=YYYY-MM-DD
	  -> 200 { from, to, total_tips, by_credited_to: [{credited_to, tips, tender_count, by_mode}], rows }

	This is a PAYROLL read, not a sales read, and it is gated with payroll and the
	other accounting reports for that reason. It reports tips and nothing else:
	`total_tips` never appears in any sales figure, in APC or ABV, or on any rung
	of the money ladder, because a tip lives on the tender beside `amount` and is
	excluded from every sum that reconciles against the bill.

	The window is INCLUSIVE day keys in the RESTAURANT'S timezone, resolved in the
	data layer like every other report — a route that parsed them here would be
	answering a calendar question in the server's zone and would silently drop the
	last day of every range.
*/
app.get('/tips', validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
	try {
		res.json(await GetTipLedger(restaurantId, str(req.query.from), str(req.query.to)));
	} catch (e: any) {
		logger.error({ err: e }, 'tip_ledger_failed');
		res.status(500).json({ error: "Unable to build the tip ledger" });
	}
});
}
