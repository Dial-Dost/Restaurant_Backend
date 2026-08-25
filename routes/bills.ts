/**
 * Billing: bill creation and lookup, payment capture and approval, settlement,
 * printing, and the bill-edit operations (remove/move item, discount, coupon,
 * split, merge, refund, reopen).
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { AddBill, AddNotification, ApplyCouponToBill, ApproveBillPaymentByAdmin, Audit_log_category, CloseBillByOrder, ConfirmBillPaymentByWaiter, GetBillByOrder, GetBillForTable, GetClosedBill, GetEmployeeDetailsFromEmpID, GetKotTableContext, GetMenuItems, GetOutlets, GetRestaurantProfile, GetRestaurantRazorpayKeys, GetRestaurantSettings, GetTableFeedbackContext, ListClosedBills, ListOpenBills, MergeTableBills, MoveBillItem, RefundBill, RemoveBillItem, ReopenBill, ReplaceBill, SetBillDiscountWithApproval, SetBillItemNote, SetBillRefundRef, SplitBillForTable, UpdateBillStatusByOrder, UpdateOrderItemsSplit, computeBillCharges, dayKeyOf } from "../database_supabase.js";
import { buildKotBase64, buildReceiptBase64 } from "../escpos.js";
import { allocateKotNumber, kotOrderContext, kotStamp, kotTicketKey, serviceModeLabel } from "../kot_numbers.js";
import { logger } from "../observability.js";
import { ackPrintJob, enqueuePrintJob, printJobPayload } from "../print_jobs.js";
import { emitOutlet, emitRestaurant } from "../realtime.js";
import { uploadScreenshot } from "../storage_bucket_supabase.js";
import { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, buildLogoEscPos, callerIsAdmin, clampLimit, endOfDayBound, enforceAdmin, enforceRoles, extractEmployeeId, extractOutletId, extractRestaurantId, feedbackUrlForTable, fetchWithTimeout, log_audit, validate, validateAction, validateBody } from "./_shared.js";


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

	if (!orderId || (!paymentMethod && !splits) || !waiterEmployeeId) {
		res.status(400).json({ error: 'Missing orderId, payment_method, or employee identity' });
		return;
	}

	try {
		const result = await ConfirmBillPaymentByWaiter(
			auth.restaurantId,
			orderId,
			waiterEmployeeId,
			paymentMethod,
			paymentProofScreenshotUrl || null,
			splits,
		);
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
			await log_audit(req, "2393edd7-cdd9-439c-9ff3-d563d5216967", `Waiter confirmed payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, waiter: waiterEmployeeId, payment_method: result.payment_method });
		} catch (err) {
			logger.warn({ err }, 'log_audit waiter-confirm-payment failed');
		}
		res.json(result);
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
