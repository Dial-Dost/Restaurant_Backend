/**
 * Billing: bill creation and lookup, payment capture and approval, settlement,
 * printing, and the bill-edit operations (remove/move item, discount, coupon,
 * split, merge, refund, reopen).
 */
import type { Express, Request, Response } from "express";
import type { BillTenderState } from "../database_supabase.js";
import { z } from "zod";
import { AddBill, AddNotification, ApplyCouponToBill, ApproveBillPaymentByAdmin, Audit_log_category, CloseBillByOrder, ConfirmBillPaymentByWaiter, GetBillByOrder, GetBillForTable, GetBillPaymentLedger, GetBillTenderState, GetClosedBill, GetTipLedger, GetEmployeeDetailsFromEmpID, GetKotTableContext, GetMenuItems, GetOutlets, GetRestaurantProfile, GetRestaurantRazorpayKeys, GetRestaurantSettings, GetTableFeedbackContext, ListBillingCounters, ListClosedBills, ListOpenBills, MergeTableBills, MoveBillItem, RecordBillTenders, RefundBill, RemoveBillItem, ReopenBill, ReplaceBill, SetBillCounter, SetBillDiscountWithApproval, SetBillItemNote, SetBillRefundRef, SplitBillForTable, UpdateBillStatusByOrder, UpdateOrderItemsSplit, UpsertBillingCounter, VoidBillTender, computeBillCharges, dayKeyOf } from "../database_supabase.js";
import { buildKotBase64, buildReceiptBase64 } from "../escpos.js";
import { allocateKotNumber, kotOrderContext, kotStamp, kotTicketKey, serviceModeLabel } from "../kot_numbers.js";
import { logger } from "../observability.js";
import { ackPrintJob, enqueuePrintJob, printJobPayload } from "../print_jobs.js";
import { emitOutlet, emitRestaurant } from "../realtime.js";
import { uploadScreenshot } from "../storage_bucket_supabase.js";
import { ACCOUNTING_PERM, PERM_SETTINGS, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, buildLogoEscPos, callerIsAdmin, clampLimit, counterIdFrom, endOfDayBound, enforceAdmin, enforcePermission, enforceRoles, extractEmployeeId, extractEmployeeUsername, extractOutletId, extractRestaurantId, feedbackUrlForTable, fetchWithTimeout, log_audit, requireCounter, validate, validateAction, validateBody } from "./_shared.js";


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
}).passthrough();

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
		return res.json(page);
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

	try {
		// If items_split is provided, update per-item statuses on the order
		if (Array.isArray(body.items_split)) {
			try {
				await UpdateOrderItemsSplit(restaurantId, orderId, body.items_split);
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
	// Permission is enforced by validateAction above, so any role (admin or a
	// custom role granted this permission) may record payment.
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
	// Approval is gated by the permission (validateAction), so admin OR any
	// custom role granted "approve payment" can approve.
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
	// Gated by the close permission (validateAction) — admin or permissioned custom role.
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

		// PERSIST, THEN EMIT. The row is the durable fact and the emit is the fast
		// path — emitOutlet cannot report whether anything received it (an empty
		// room is a successful no-op), so the row is the only thing that survives a
		// till whose socket is down. A null jobId means durability is unavailable
		// (migration 027 not applied); the emit still goes out, exactly as before.
		const jobId = await enqueuePrintJob(restaurantId, {
			outlet_id: outletId, bill_id: billId, kind: "bill", station: null, esc_base64: escBase64,
		});
		emitOutlet(restaurantId, outletId, 'bill:print', printJobPayload({
			billId, escBase64, kind: "bill", jobId, publishedAt: new Date().toISOString(),
		}));
		res.json({ success: true, jobId });
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
		// Reprint without service charge on request (waiver). Recompute taxes on the
		// (discounted) subtotal so the printed total matches the actual bill.
		const includeServiceCharge = body.no_service_charge !== true;
		const charges = computeBillCharges(
			bill.subtotal ?? bill.total_amt ?? 0,
			settings.taxes ?? [],
			settings.service_charge ?? 0,
			includeServiceCharge,
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
			const stationByName = new Map<string, string>();
			try {
				const menu = await GetMenuItems(restaurantId);
				for (const m of menu) {if (m.station) {stationByName.set(m.name.trim().toLowerCase(), m.station);}}
			} catch {/* menu unavailable — items fall under a single General ticket */}
			const kotItems = bill.items.map((it) => ({ ...it, station: stationByName.get(String(it.name).trim().toLowerCase()) ?? null }));

			// THE KOT HEADER, resolved here and printed verbatim by the renderer.
			//
			// The zone is the tenant's own ("Restaurant".timezone). Everything
			// dated on this ticket — the printing stamp AND the business day the
			// number belongs to — is derived from that one value, so a ticket
			// fired at 01:00 IST reads 01:00 and counts as the night it was
			// actually cooked, on a backend hosted in UTC.
			const tz = settings.timezone || 'Asia/Kolkata';
			const firedAt = new Date();
			// Neither lookup is allowed to take the kitchen down: an unresolvable
			// table or waiter costs a header line, not the docket.
			const [tableCtx, waiterCtx] = await Promise.all([
				GetKotTableContext(restaurantId, tableName).catch(() => null),
				GetTableFeedbackContext(restaurantId, tableName).catch(() => null),
			]);
			const serviceMode = serviceModeLabel(tableCtx?.order_type);
			// Covers come from the TABLE (num_covers, counted once per table), the
			// same number the bill divides by for APC.
			const covers = tableCtx?.covers ?? bill.covers ?? 1;
			// "Assign to:" is whoever the table is assigned to; "Captain:" prints
			// only when that person's role really is captain/manager, so a plain
			// waiter's table does not grow a second identical line.
			const waiterName = (waiterCtx?.employee_name ?? '').trim();
			const waiterRole = (waiterCtx?.employee_role ?? '').trim().toLowerCase();

			// ONE NUMBER FOR THE WHOLE KOT, allocated BEFORE the per-station split
			// so all N dockets of one order carry the same "KOT - n" and the expo
			// can pair them. A reprint of the same table with the same items
			// resolves to the number already on paper instead of burning a new
			// one; a null means migration 029 is unapplied and the ticket prints
			// unnumbered rather than failing.
			const businessDay = dayKeyOf(firedAt, tz);
			const kot = tableCtx
				? await allocateKotNumber(
					restaurantId,
					kotTicketKey({ outletId, businessDay, tableId: tableCtx.table_id, items: kotItems }),
					firedAt,
				)
				: null;

			const tickets = buildKotBase64({
				restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
				table: tableName,
				covers,
				items: kotItems,
				total: charges.subtotal,
				currency: settings.currency ?? "₹",
				kind: "kot",
				kotNo: kot?.kot_no ?? null,
				printedAt: kotStamp(firedAt, tz),
				orderContext: kotOrderContext(tableCtx?.is_virtual === true, serviceMode),
				serviceMode,
				section: tableCtx?.section ?? null,
				assignedTo: waiterName || null,
				captain: waiterName && (waiterRole === 'captain' || waiterRole === 'manager') ? waiterName : null,
			}, cols);
			const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
			// ONE DURABLE JOB PER STATION TICKET, all sharing this one billId. That
			// sharing is precisely why the job uuid — not billId — is the identity
			// every downstream guard keys on: deduplicating on billId would print the
			// first station's docket and silently drop every other kitchen's.
			for (const t of tickets) {
				const jobId = await enqueuePrintJob(restaurantId, {
					outlet_id: outletId, bill_id: billId, kind: "kot", station: t.station, esc_base64: t.escBase64,
				});
				emitOutlet(restaurantId, outletId, 'bill:print', printJobPayload({
					billId, escBase64: t.escBase64, kind: "kot", station: t.station, jobId,
					publishedAt: new Date().toISOString(),
				}));
			}
			// The KOT number goes in the audit line and the response: it is the
			// handle a manager uses to find this ticket afterwards, and `reused`
			// distinguishes a genuine second order from a reprint of the first.
			const kotLabel = kot ? `KOT-${kot.kot_no}${kot.reused ? ' (reprint)' : ''}` : 'KOT';
			try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed ${kotLabel} for table ${tableName} (${tickets.length} station ticket(s))`, Audit_log_category.Bill, { table: tableName, kind, stations: tickets.map((t) => t.station), kot_no: kot?.kot_no ?? null, business_day: kot?.business_day ?? null, reprint: kot?.reused ?? null }); } catch {/* ignore */}
			res.json({
				success: true, billId, tickets: tickets.length, stations: tickets.map((t) => t.station),
				kot_no: kot?.kot_no ?? null, business_day: kot?.business_day ?? null, reprint: kot?.reused ?? false,
			});
			return;
		}
		// The kitchen ticket returned above; everything below is the customer bill,
		// which alone carries the logo, cashier line and feedback QR.
		const isBill = true;
		const feedbackUrl = isBill ? await feedbackUrlForTable(restaurantId, tableName) : null;
		const logo = isBill ? await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null) : null;
		let cashier = "";
		if (isBill) {
			try {
				const emp = await GetEmployeeDetailsFromEmpID(extractEmployeeId(req) ?? "");
				cashier = `${emp?.emp_Fname ?? ""} ${emp?.emp_Lname ?? ""}`.trim();
			} catch {/* cashier optional */}
		}
		// Show the service-charge line even when waived ("Opted-out"), matching the web bill.
		const scPercent = charges.service_charge_percent || settings.service_charge || 0;
		const serviceCharge = charges.service_charge > 0
			? { percent: charges.service_charge_percent, amount: charges.service_charge }
			: (!includeServiceCharge && scPercent > 0 ? { percent: scPercent, amount: 0, optedOut: true } : null);
		const escBase64 = buildReceiptBase64({
			restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
			// Legal entity + GSTIN are tenant settings, not profile fields: they are
			// statutory identifiers for the business, not per-outlet contact details.
			// Both are "" when unset and the renderer prints nothing for "", so a
			// tenant that has configured neither gets exactly today's header.
			legalName: settings.bill_legal_name ?? null,
			address: profile?.outlet_add ?? null,
			gstin: settings.bill_gstin ?? null,
			table: tableName,
			covers: bill.covers ?? 1,
			items: bill.items,
			total: charges.subtotal,
			customer: bill.customer,
			billNo: bill.bill_no,
			cashier: cashier || null,
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
			serviceChargeNote: isBill && charges.service_charge > 0
				? "A Voluntary Service Charge is included to support our staff. If you prefer not to contribute, please inform your server before payment and it will be removed."
				: null,
		}, cols);
		const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
		// billId is STABLE ACROSS REPRINTS, so each reprint deliberately becomes its
		// OWN job row. A waiter who asks for a second copy must get one.
		const jobId = await enqueuePrintJob(restaurantId, {
			outlet_id: outletId, bill_id: billId, kind: "bill", station: null, esc_base64: escBase64,
		});
		emitOutlet(restaurantId, outletId, 'bill:print', printJobPayload({
			billId, escBase64, kind: "bill", jobId, publishedAt: new Date().toISOString(),
		}));
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed ${kind} for table ${tableName}${includeServiceCharge ? "" : " (no service charge)"}`, Audit_log_category.Bill, { table: tableName, kind, no_service_charge: !includeServiceCharge }); } catch {/* ignore */}
		res.json({ success: true, billId, jobId });
	} catch (err: any) {
		logger.error({ err }, 'print_bill_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to print') });
	}
});

/*
	The printer agent reports what it did with one job.

	POST /print/ack  body { "jobId": "<uuid>", "result": "printed" | "failed" }
	  -> 200 { "success": true, "duplicate": false }

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
	try {
		const outcome = await ackPrintJob(restaurantId, jobId, result);
		res.json({ success: true, duplicate: outcome.duplicate });
	} catch (err: any) {
		logger.error({ err }, 'print_ack_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to record print ack') });
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

// Set or clear a discount on a table's open bill (% or flat, off the subtotal).
// When the restaurant configures a discount-approval threshold, a NON-admin
// discount above it is parked as a pending request (managers get a bell ping)
// instead of applying — the response then carries { pending: true, request_id }.
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
		const result = await ApplyCouponToBill(restaurantId, tableName, code, phone);
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Applied coupon ${result.code} to table ${tableName}`, Audit_log_category.Bill, { table: tableName, code: result.code }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, 'apply_coupon_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to apply coupon") }); }
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

// Compute a split of a table's bill (read-only — does not change the bill).
app.post('/bills/split', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), validateBody(sBillSplit), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const mode = body.mode === "item" ? "item" : "even";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
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
