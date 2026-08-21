/**
 * Public guest surface reached from a table QR code: menu, ordering, coupons,
 * payment, reservations, the waitlist join flow, web-push and branding. Every route
 * here runs unauthenticated (exempted from requireAuth by the /qr/ prefix).
 */
import type { Express, Request, Response } from "express";
import { createHmac, randomUUID } from "crypto";
import { AddBooking, AddNotification, AddOrder, AddWaitlistMember, AllocateBestTable, ApplyCouponToBill, CancelWaitlistByToken, CheckCoupon, ClaimWaitlistPreorder, ConfirmWaitlistPreorder, DeclineWaitlistPreorder, DeletePushSubscription, FinalizeOnlinePayment, GetBillForTable, GetBookingSummaryById, GetMenuCategories, GetMenuItems, GetPublicBranding, GetRestaurantProfile, GetRestaurantSettings, GetWaitlistEntryByToken, JoinWaitlist, SavePushSubscription, SetWaitlistPreorder, SubmitCustomerPayment, UpdateBookingDeposit, VerifyTableOtp, getRestaurantIdFromUsername, parseWallClockInZone, repriceFromMenu, resolveBrandConfig, resolveBrandPalette, withTenant } from "../database_supabase.js";
import { logger } from "../observability.js";
import { decodeTableToken, verifyTable } from "../qr_signing.js";
import { emitRestaurant } from "../realtime.js";
import { uploadScreenshot } from "../storage_bucket_supabase.js";
import { isPushConfigured, pushPublicKey } from "../web_push.js";
import type { CreatedOrderInfo } from "./_shared.js";
import { GetCustomerIdOrCreateCustomer, emitOrderCreated, feedbackUrlForTable, fetchWithTimeout, linkOrderToCustomer, notifyOrderCreated, optionalMobile10, queueBookingConfirm, rateLimit, refuseGuestWriteIfClosed, requireMobile10, resolveRazorpayKeys, safeClientError, timingSafeStrEqual } from "./_shared.js";


// Resolve the table for a public QR request. Prefers the opaque ?t= token; falls
// back to table_name+sig. Returns the verified table name, or null if invalid.
function resolveQrTable(
	resId: string,
	src: { t?: unknown; table_name?: unknown; table?: unknown; sig?: unknown },
): string | null {
	const token = typeof src.t === "string" ? src.t : "";
	if (token) {return decodeTableToken(resId, token);}
	const name = typeof src.table_name === "string"
		? src.table_name.trim()
		: typeof src.table === "string" ? src.table.trim() : "";
	const sig = typeof src.sig === "string" ? src.sig : "";
	return name && verifyTable(resId, name, sig) ? name : null;
}

export function registerGuestOrderingRoutes(app: Express): void {

// ---------------------------------------------------------------------------
// Public QR self-ordering (no staff login). The restaurant is identified by the
// slug in the URL; queries run inside that tenant's context so RLS still
// isolates data, and orders append to the table's single bill (AddOrder syncs).
// ---------------------------------------------------------------------------
app.get("/qr/:slug/menu", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}
	try {
		const data = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			const [items, categories, profile, branding] = await Promise.all([
				GetMenuItems(slug),
				GetMenuCategories(slug),
				GetRestaurantProfile(slug),
				GetPublicBranding(slug).catch(() => ({ logo_url: null, theme_color: null, theme_primary: null, theme_secondary: null, currency: "₹", payment_methods: [], queue_show_menu: true, require_table_otp: false, brand_config: resolveBrandConfig(null, null, null), brand_palette: resolveBrandPalette(null, null, null) })),
			]);
			return {
				restaurant_name: profile?.restaurant_name ?? slug,
				logo_url: branding.logo_url,
				theme_color: branding.theme_color,
				theme_primary: branding.theme_primary,
				theme_secondary: branding.theme_secondary,
				currency: branding.currency,
				payment_methods: branding.payment_methods,
				queue_show_menu: branding.queue_show_menu,
				// Guest QR order page reads this to know whether to prompt for the
				// per-table OTP before letting the guest place an order.
				require_table_otp: branding.require_table_otp,
				// Customer-page customization, resolved with sane defaults. The LIVE
				// keys the dark guest design consumes are color_primary (accent ramp),
				// font, header_style, button_shape and surface_style; the legacy colour
				// keys are still returned when set but drive nothing (BRAND_LIVE_FIELDS).
				brand_config: branding.brand_config,
				// The RESOLVED palette: every guest colour role as a #rrggbb, never
				// null, defaults reproducing the shipped design exactly. Guest pages
				// should theme from THIS and stop deriving colours themselves.
				brand_palette: branding.brand_palette,
				categories,
				items,
			};
		});
		res.json(data);
	} catch (err) {
		logger.error({ err }, "qr_menu_failed");
		res.status(500).json({ error: "Unable to load menu" });
	}
});

app.post("/qr/:slug/order", rateLimit("qr_order", 30, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}

	// THE GUEST WRITE GATE. A restaurant the operator archived (or the platform
	// suspended) has no live sessions and nobody who can sign in, so an order
	// accepted here can never be cooked, billed or settled — it just accrues
	// against a bill no one can close. Refused as "Restaurant not found", the same
	// answer an unknown slug gets. See routes/_shared.ts for the full argument,
	// including why it fails open when the control plane is absent.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const customer = typeof body.customer === "string" ? body.customer.trim() : "";
	// Optional guest phone — captured into the order JSON and used to register
	// the guest as a Customer (CRM) when present. Blank stays blank; anything
	// typed must be a real 10-digit mobile (it becomes the CRM identity).
	const phoneCheck = optionalMobile10(res, body.customer_phone);
	if (!phoneCheck.ok) {return;}
	const customerPhone = phoneCheck.value ?? "";
	const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
	const items = (Array.isArray(body.items) ? body.items : [])
		.slice(0, 100) // cap line count (anti-DoS), like the waitlist preorder path
		.map((it: any) => {
			// Per-item note (e.g. "no onions") — optional, kept on the line item so
			// the kitchen sees it. Customers can add a note to any item they order.
			const itemNote = typeof it?.note === "string" ? it.note.trim().slice(0, 280) : "";
			return {
				id: String(it?.id ?? randomUUID()),
				name: String(it?.name ?? "Item"),
				price: Number(it?.price ?? 0) || 0,
				quantity: Math.max(1, Math.round(Number(it?.quantity ?? 1) || 1)),
				...(itemNote ? { note: itemNote } : {}),
			};
		})
		.filter((it) => it.name.length > 0);
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	if (items.length === 0) {
		res.status(400).json({ error: "At least one item is required" });
		return;
	}

	// OTP gate: when the tenant requires a per-table code, the guest must present
	// the 4-digit OTP staff read off the floor grid before any order is accepted.
	// When the setting is OFF, VerifyTableOtp returns ok:true and this is a no-op.
	const providedOtp = typeof body.otp === "string" ? body.otp.trim() : "";
	try {
		const gate = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => VerifyTableOtp(slug, tableName, providedOtp),
		);
		if (!gate.ok) {
			// Distinguish "you typed the wrong code" (otp_wrong) from "you haven't
			// entered one yet / the table isn't seated" (otp_required) so the guest
			// UI can prompt correctly. VerifyTableOtp folds an empty code into
			// reason:"wrong", so key the code off whether an OTP was actually sent.
			const wrongCode = gate.reason === "wrong" && providedOtp.length > 0;
			res.status(403).json(
				wrongCode
					? { error: "That table OTP is incorrect. Please check the code shown by staff.", code: "otp_wrong" }
					: { error: "Enter the table OTP shown by staff before ordering.", code: "otp_required" },
			);
			return;
		}
	} catch (err) {
		// A transient failure verifying the OTP shouldn't hard-block ordering —
		// AddOrder still refuses unoccupied tables, which is the real guard.
		logger.warn({ err: (err as any)?.message ?? err }, "qr_order_otp_gate_error (failing open)");
	}

	// Server-computed total — never trust a client-sent total for billing.
	const subtotal = Math.round(items.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;

	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			// SECURITY: never bill at client-sent prices. Re-price every line from the
			// menu (floor mode keeps modifier upcharges that are >= the menu base);
			// items with no current menu match are dropped.
			const priced = await repriceFromMenu(slug, items, true);
			if (priced.length === 0) {throw new Error("None of those items are available right now. Please refresh the menu.");}
			const pricedSubtotal = Math.round(priced.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;
			// When the restaurant disables auto-push, customer orders land as
			// "Pending" and a staffer must approve them before the kitchen sees them.
			const settings = await GetRestaurantSettings(slug).catch(() => ({ auto_push_orders: true }));
			const orderStatus = settings.auto_push_orders ? "Preparing" : "Pending";
			const orderPayload = {
				table: tableName,
				customer: customer || "QR Guest",
				...(customerPhone ? { customer_phone: customerPhone } : {}),
				note,
				items: priced,
				subtotal: pricedSubtotal,
				total: pricedSubtotal,
				taxes: [],
				applyServiceCharge: false,
				status: orderStatus,
			};
			let order: { id: string };
			try {
				order = await AddOrder(slug, orderPayload as any);
			} catch (e: any) {
				// Customers may only order at a table a staff member has already
				// seated/occupied — never self-seat from the QR page.
				if (String(e?.message ?? "").toLowerCase().includes("unoccupied")) {
					throw new Error("This table isn't active yet. Please ask a staff member to start your table before ordering.");
				}
				throw e;
			}
			// Register the guest as a Customer (best-effort) so QR orders count as
			// CRM visits instead of leaving everyone at 0 bookings.
			await linkOrderToCustomer(slug, order.id, customer, customerPhone);
			const bill = await GetBillForTable(slug, tableName).catch(() => null);
			return { order_id: order.id, bill_total: bill?.total_amt ?? subtotal, status: orderStatus };
		});
		try {
			const count = items.reduce((s, it) => s + it.quantity, 0);
			const pending = result.status === "Pending";
			await AddNotification(slug, {
				type: "order",
				title: pending ? `Order to approve · Table ${tableName}` : `New order · Table ${tableName}`,
				body: `${count} item${count > 1 ? "s" : ""} · ₹${result.bill_total}${pending ? " · tap Orders to approve" : ""}`,
				meta: { table: tableName, order_id: result.order_id, needs_approval: pending },
			});
		} catch {/* ignore */}
		// This path already notifies (above) — it only lacked the realtime nudge,
		// so the orders grid and the KDS sat on their poll for up to 10s.
		emitOrderCreated(resId, { orderId: result.order_id, table: tableName });
		res.status(201).json({ success: true, ...result });
	} catch (err: any) {
		logger.error({ err }, "qr_order_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to place order") });
	}
});

// Public: verify a per-table OTP for the guest QR flow (resolve the table via the
// signed ?t= token, exactly like the other /qr/:slug/* routes). Rate-limited to a
// few tries/min so the 4-digit code can't be brute-forced. Response shape:
//   { ok:true, required:false }            — gate OFF (no code needed)
//   { ok:false, reason:"not_seated" }      — gate ON, table not occupied yet
//   { ok:false, reason:"wrong" }           — gate ON, code missing/incorrect
//   { ok:true, required:true }             — gate ON, code accepted
app.post("/qr/:slug/verify-otp", rateLimit("qr_verify_otp", 10, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	if (!tableName) { res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." }); return; }
	const otp = typeof body.otp === "string" ? body.otp : "";
	try {
		const result = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => VerifyTableOtp(slug, tableName, otp),
		);
		res.json(result);
	} catch (err) {
		logger.error({ err }, "qr_verify_otp_failed");
		res.status(500).json({ error: "Unable to verify code" });
	}
});

// Customer pays from the QR page. Uploads the screenshot (if any), records the
// payment as PENDING STAFF APPROVAL, and notifies staff in realtime.
// Customer: preview a coupon code (read-only) against a subtotal.
app.post("/qr/:slug/check-coupon", rateLimit("coupon", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const subtotal = Number(body.subtotal ?? 0) || 0;
	const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
	if (!code) { res.status(400).json({ error: "code is required" }); return; }
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => CheckCoupon(slug, code, subtotal, phone));
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, "qr_check_coupon_failed"); res.status(400).json({ error: safeClientError(e, "Unable to check coupon") }); }
});

// Customer: apply a coupon code to their table's open bill.
app.post("/qr/:slug/coupon", rateLimit("coupon", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	// Guest write gate (see /qr/:slug/order): applying a coupon rewrites an open
	// bill's total, which nobody can settle on a closed restaurant.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
	if (!tableName) { res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." }); return; }
	if (!code) { res.status(400).json({ error: "code is required" }); return; }
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => ApplyCouponToBill(slug, tableName, code, phone));
		try { emitRestaurant(resId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, "qr_apply_coupon_failed"); res.status(400).json({ error: safeClientError(e, "Unable to apply coupon") }); }
});

app.post("/qr/:slug/pay", rateLimit("qr_pay", 15, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	// Guest write gate (see /qr/:slug/order). This is a guest DECLARING a payment
	// for staff to approve — on a closed restaurant no one ever will, so the guest
	// would be told "paid" against a bill that stays open forever.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const method = typeof body.payment_method === "string" ? body.payment_method.trim() : "";
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	if (!method) {
		res.status(400).json({ error: "payment_method is required" });
		return;
	}
	// Cap the decoded upload at ~3MB (base64 is ~4/3 the byte size) so the public
	// payment-proof upload can't be abused to fill storage.
	if (typeof body.screenshot_base64 === "string" && body.screenshot_base64.length > 4_000_000) {
		res.status(413).json({ error: "Payment screenshot is too large (max ~3MB)." });
		return;
	}
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			// Enforce the restaurant's configured payment methods + screenshot rules.
			const settings = await GetRestaurantSettings(slug).catch(() => null);
			const cfg = settings?.payment_methods?.find((m) => m.id.toLowerCase() === method.toLowerCase());
			if (settings && (!cfg?.enabled)) {
				throw new Error("This payment method isn't accepted here.");
			}
			let screenshotUrl = typeof body.screenshot_url === "string" ? body.screenshot_url.trim() : "";
			if (!screenshotUrl && typeof body.screenshot_base64 === "string" && body.screenshot_base64.length > 0) {
				const url = await uploadScreenshot(
					body.screenshot_base64,
					typeof body.screenshot_content_type === "string" ? body.screenshot_content_type : "image/jpeg",
				);
				if (url) {screenshotUrl = url;}
			}
			return SubmitCustomerPayment(slug, tableName, method, screenshotUrl || null, cfg?.requires_screenshot);
		});
		try {
			emitRestaurant(resId, "bill:payment_submitted", {
				table: tableName,
				payment_method: result.payment_method,
				total: result.total_amt,
			});
		} catch {/* ignore realtime errors */}
		try {
			await AddNotification(slug, {
				type: "payment",
				title: `Table ${tableName} paid`,
				body: `₹${result.total_amt} via ${result.payment_method} — review & approve`,
				meta: { table: tableName, order_id: result.order_id },
			});
		} catch {/* ignore */}
		// After paying, the customer is sent to the feedback form for the waiter
		// who handled this table (null when no waiter is assigned).
		const feedback_url = await feedbackUrlForTable(slug, tableName);
		res.json({ ...result, feedback_url });
	} catch (err: any) {
		logger.error({ err }, "qr_pay_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to submit payment") });
	}
});

// Customer views their table's running bill (public).
app.get("/qr/:slug/bill", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const tableName = resolveQrTable(resId, req.query);
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	try {
		const bill = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetBillForTable(slug, tableName),
		);
		res.json(bill ?? { total_amt: 0, covers: 0, apc: 0, order_ids: [], payment_status: null });
	} catch (err: any) {
		logger.error({ err }, "qr_bill_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to load bill") });
	}
});

// Public customer reservation (from the reservation web page). Auto-allocates a
// table if one is free; records the booking as "Requested" for staff to confirm.
app.post("/qr/:slug/reserve", rateLimit("qr_reserve", 8, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	// Guest write gate (see /qr/:slug/order): a table booked at a closed restaurant
	// is a guest who turns up to a locked door.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
	const email = typeof body.email === "string" ? body.email.trim() : undefined;
	const notes = typeof body.notes === "string" ? body.notes.trim() : null;
	const partySize = Number.parseInt(String(body.party_size ?? body.number_of_people ?? ""), 10);
	const duration = Number.isFinite(Number(body.duration)) ? Number(body.duration) : 90;
	const dateStr = typeof body.date === "string" ? body.date.trim() : "";
	if (!name || !rawPhone) { res.status(400).json({ error: "Name and phone are required" }); return; }
	// The reservation's phone is how staff (and the confirmation SMS) reach the
	// guest, so it must be a real 10-digit mobile.
	const phone = requireMobile10(res, rawPhone);
	if (!phone) {return;}
	if (!Number.isFinite(partySize) || partySize <= 0) { res.status(400).json({ error: "A valid party size is required" }); return; }
	if (!dateStr) { res.status(400).json({ error: "A valid date/time is required" }); return; }
	try {
		// Deposit / min-spend rules (settings). The deposit only ever applies when
		// Razorpay is usable for this restaurant — a booking is NEVER blocked on a
		// missing/broken gateway (order-create failure falls back to no deposit).
		const settings = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetRestaurantSettings(slug),
		).catch(() => null);
		// The guest picks a wall-clock date+time in the restaurant's local zone —
		// interpret it in that timezone so a UTC prod server stores the correct
		// instant (bare wall-clock only; an ISO string carrying an explicit offset
		// is an absolute instant and is left untouched).
		const date = parseWallClockInZone(dateStr, settings?.timezone ?? "Asia/Kolkata");
		if (Number.isNaN(date.getTime())) { res.status(400).json({ error: "A valid date/time is required" }); return; }
		if (date.getTime() < Date.now() - 60_000) { res.status(400).json({ error: "Please pick a future date and time" }); return; }
		const depositAmount = settings?.booking_deposit_amount ?? 0;
		const depositMinParty = settings?.booking_deposit_min_party ?? 0;
		const minSpend = settings?.booking_min_spend ?? 0;
		const depositRuleTriggers = depositAmount > 0 && (depositMinParty <= 0 || partySize >= depositMinParty);
		let depositOrder: { order_id: string; key_id: string } | null = null;
		if (depositRuleTriggers) {
			const keys = await resolveRazorpayKeys(slug, resId);
			if (keys) {
				try {
					const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
						},
						body: JSON.stringify({ amount: Math.round(depositAmount * 100), currency: "INR", receipt: `dep:${slug}:${Date.now()}` }),
					});
					const data = (await rp.json()) as Record<string, unknown>;
					if (rp.ok && typeof data.id === "string" && data.id) {
						depositOrder = { order_id: data.id, key_id: keys.key_id };
					} else {
						logger.error({ err: data }, "reserve_deposit_order_failed"); // booking proceeds without deposit
					}
				} catch (err) {
					logger.error({ err }, "reserve_deposit_order_error"); // booking proceeds without deposit
				}
			}
		}
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			const custId = await GetCustomerIdOrCreateCustomer(slug, name, phone, email);
			if (!custId) {throw new Error("Unable to record the guest");}
			let tableName: string | null = null;
			try { tableName = await AllocateBestTable(slug, date, duration, partySize); } catch {/* assign later */}
			const booking = await AddBooking(
				slug, custId, date, duration, partySize, tableName, "Online",
				depositOrder ? "Awaiting Deposit" : "Requested", "qr", notes,
				depositOrder ? { amount: depositAmount, status: "pending", order_id: depositOrder.order_id } : null,
				minSpend > 0 ? minSpend : null,
			);
			return { booking_id: String(booking._id), table_name: tableName };
		});
		try { emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "online" }); } catch {/* ignore */}
		// Staff bell: deposit bookings ping on VERIFY instead (avoids a second ping
		// and flags only bookings that are actually actionable).
		if (!depositOrder) {
			try {
				await AddNotification(slug, {
					type: "reservation",
					title: "New reservation request",
					body: `${name} · party ${partySize} · ${date.toLocaleString()}${result.table_name ? ` · ${result.table_name}` : ""}`,
					meta: { booking_id: result.booking_id },
				});
			} catch {/* ignore */}
		}
		// Automated guest confirmation (SMS/WhatsApp — fire-and-forget, logged to
		// OutboundMessages even when no provider is configured).
		queueBookingConfirm(resId, slug, {
			bookingId: result.booking_id,
			phone,
			party: partySize,
			date,
			table: result.table_name,
			depositAmount: depositOrder ? depositAmount : null,
		});
		res.status(201).json({
			success: true,
			status: depositOrder ? "Awaiting Deposit" : "Requested",
			...result,
			...(minSpend > 0 ? { min_spend: minSpend } : {}),
			...(depositOrder
				? { deposit_required: true, amount: depositAmount, order_id: depositOrder.order_id, key_id: depositOrder.key_id }
				: {}),
		});
	} catch (err: any) {
		logger.error({ err }, "qr_reserve_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to create reservation") });
	}
});

// Customer completes the reservation deposit: verify the Razorpay signature
// (same HMAC scheme as /qr/:slug/razorpay/verify), mark the deposit paid and
// promote the booking from "Awaiting Deposit" to the normal "Requested" state.
app.post("/qr/:slug/reserve/verify-deposit", rateLimit("qr_reserve", 12, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const keys = await resolveRazorpayKeys(slug, resId);
	if (!keys) { res.status(503).json({ error: "Online payment isn't set up for this restaurant" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const bookingId = typeof body.booking_id === "string" ? body.booking_id.trim() : "";
	const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
	const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
	const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
	if (!bookingId || !orderId || !paymentId || !signature) {
		res.status(400).json({ error: "booking_id and razorpay_* fields are required" });
		return;
	}
	// Verify the gateway signature (with the restaurant's secret) before trusting it.
	const expected = createHmac("sha256", keys.key_secret).update(`${orderId}|${paymentId}`).digest("hex");
	if (!timingSafeStrEqual(expected, signature)) {
		res.status(400).json({ error: "Payment signature verification failed" });
		return;
	}
	try {
		const booking = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetBookingSummaryById(slug, bookingId),
		);
		if (!booking) { res.status(404).json({ error: "Booking not found" }); return; }
		if (!booking.deposit) { res.status(400).json({ error: "This booking has no deposit to pay" }); return; }
		// Bind the payment to THIS booking's order (a signature for some other
		// order must not settle this deposit).
		if (booking.deposit.order_id !== orderId) { res.status(400).json({ error: "Payment does not match this booking" }); return; }
		if (booking.deposit.status === "paid") { res.status(200).json({ success: true, status: booking.status ?? "Requested", already_paid: true }); return; }
		if (booking.deposit.status !== "pending") { res.status(400).json({ error: "This deposit can no longer be paid" }); return; }
		await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => UpdateBookingDeposit(slug, bookingId, { deposit_status: "paid", payment_id: paymentId, slot_status: "Requested" }),
		);
		try { emitRestaurant(resId, "booking:status_updated", { booking_id: bookingId, status: "Requested" }); } catch {/* ignore */}
		try {
			await AddNotification(slug, {
				type: "reservation",
				title: "Reservation deposit received",
				body: `${booking.customer_name} · party ${booking.number_of_people} · ₹${booking.deposit.amount} deposit paid${booking.table_name ? ` · ${booking.table_name}` : ""}`,
				meta: { booking_id: bookingId, deposit_amount: booking.deposit.amount },
			});
		} catch {/* ignore */}
		res.json({ success: true, status: "Requested" });
	} catch (err: any) {
		logger.error({ err }, "reserve_verify_deposit_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to confirm the deposit") });
	}
});
}


export function registerGuestWaitlistAndPaymentRoutes(app: Express): void {

// --- Public waitlist / queue (walk-ins, no session) ---
app.post("/qr/:slug/waitlist/join", rateLimit("waitlist", 12, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	// Guest write gate (see /qr/:slug/order): joining a queue nobody is calling
	// from is worse than being told the restaurant isn't there.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	// Phone stays optional on a walk-in join (staff can call the party by name),
	// REQUIRED: staff call a waiting party on this number when their table is
	// ready, and the waitlist board shows it beside the party size. Enforced here
	// too so an API caller cannot join without one.
	const phone = requireMobile10(res, body.phone);
	if (!phone) {return;}
	const party = Number(body.party_size ?? 1) || 1;
	// Multi-outlet: a branch's entrance QR can carry ?outlet=<id> so the walk-in
	// lands in that branch's queue (where its staff are looking). Single-outlet
	// restaurants omit it and fall back to the default outlet.
	const outlet = (typeof body.outlet === "string" && body.outlet.trim()) || (typeof req.query.outlet === "string" ? req.query.outlet.trim() : "");
	if (!name) { res.status(400).json({ error: "Please enter your name" }); return; }
	try {
		const entry = await withTenant({ res_id: resId, outlet_id: outlet, employeeId: "", role: "" }, async () => {
			const e = await JoinWaitlist(slug, { name, phone, party_size: party });
			try { await AddNotification(slug, { type: "waitlist", title: `New in queue: ${name}`, body: `Party of ${e.party_size}`, meta: { waitlist_id: e.id } }); } catch {/* ignore */}
			return e;
		});
		try { emitRestaurant(resId, "waitlist:updated", { action: "join" }); } catch {/* ignore */}
		res.status(201).json({ token: entry.token, id: entry.id, position: entry.position, status: entry.status, party_size: entry.party_size });
	} catch (e: any) { logger.error({ err: e }, "waitlist_join_failed"); res.status(400).json({ error: safeClientError(e, "Unable to join the queue") }); }
});

app.get("/qr/:slug/waitlist/:token", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		const entry = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => GetWaitlistEntryByToken(slug, String(req.params.token)));
		if (!entry) { res.status(404).json({ error: "Queue entry not found" }); return; }
		res.json(entry);
	} catch (e: any) { logger.error({ err: e }, "waitlist_get_failed"); res.status(500).json({ error: "Unable to fetch queue status" }); }
});

app.post("/qr/:slug/waitlist/:token/preorder", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => SetWaitlistPreorder(slug, String(req.params.token), body.items));
		if ("error" in r) { res.status(400).json(r); return; }
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_failed"); res.status(500).json({ error: "Unable to save your selection" }); }
});

// A companion who scanned the shared "join party" QR adds their own name/phone to
// the joiner's queue entry. Additive contact capture only — party_size is untouched.
app.post("/qr/:slug/waitlist/:token/member", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	// A party member's phone is their identity in the party list (it dedupes on
	// it), so it is required AND must be exactly 10 digits.
	const memberPhone = requireMobile10(res, body.phone);
	if (!memberPhone) {return;}
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => AddWaitlistMember(slug, String(req.params.token), { name: body.name, phone: memberPhone }));
		if ("error" in r) { res.status(400).json(r); return; }
		try { emitRestaurant(resId, "waitlist:updated", { action: "member" }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_member_failed"); res.status(500).json({ error: "Unable to add you to the party" }); }
});

app.post("/qr/:slug/waitlist/:token/cancel", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => CancelWaitlistByToken(slug, String(req.params.token)));
		try { emitRestaurant(resId, "waitlist:updated", { action: "cancel" }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "waitlist_cancel_failed"); res.status(500).json({ error: "Unable to leave the queue" }); }
});

// --- Guest confirmation of a held pre-order --------------------------------
// Seating a queued party no longer fires its pre-order at the kitchen (see
// SeatWaitlistEntry). These three let the GUEST resolve it from their own queue
// page, using the token they already hold; staff have the same actions under
// /waitlist/:id/preorder/*.
//
// confirm -> places the order exactly as seating used to (idempotent)
// decline -> nothing is placed, items stay on the entry
// claim   -> the table's order page pulls the declined items to seed the cart
//            (?peek=1 reads them WITHOUT consuming, for a preview)
app.post("/qr/:slug/waitlist/:token/preorder/confirm", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	// This is the ONE token-scoped waitlist route that places a real order:
	// ConfirmWaitlistPreorder calls AddOrder. The sibling token routes (decline,
	// claim, member, cancel) move no money and create no ticket, so they stay open
	// deliberately — a queued party must always be able to cancel. Without this
	// line a diner could still put a live order into an archived restaurant.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => ConfirmWaitlistPreorder(slug, { token: String(req.params.token) }));
		if ("error" in r) { res.status(400).json(r); return; }
		// A confirmed pre-order is a real new kitchen ticket — same fan-out as any
		// other order. Skipped on the idempotent replay so it isn't announced twice.
		if (r.placed_order_id && !r.already) {
			const placed: CreatedOrderInfo = { orderId: r.placed_order_id, table: r.table_name };
			try { await notifyOrderCreated(resId, placed); } catch {/* ignore */}
			try { emitOrderCreated(resId, placed); } catch {/* ignore */}
		}
		try { emitRestaurant(resId, "waitlist:updated", { action: "preorder_confirm" }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_confirm_failed"); res.status(500).json({ error: "Unable to confirm your order" }); }
});

app.post("/qr/:slug/waitlist/:token/preorder/decline", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => DeclineWaitlistPreorder(slug, { token: String(req.params.token) }));
		if ("error" in r) { res.status(400).json(r); return; }
		try { emitRestaurant(resId, "waitlist:updated", { action: "preorder_decline" }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_decline_failed"); res.status(500).json({ error: "Unable to update your order" }); }
});

app.post("/qr/:slug/waitlist/:token/preorder/claim", rateLimit("waitlist", 30, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const peek = req.query.peek === "1" || req.query.peek === "true";
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => ClaimWaitlistPreorder(slug, String(req.params.token), peek));
		if ("error" in r) { res.status(404).json(r); return; }
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_claim_failed"); res.status(500).json({ error: "Unable to load your saved items" }); }
});

// --- Web Push for the queue (public) ---------------------------------------
// The guest's browser needs the PUBLIC application server key before it can
// create a subscription; `enabled` tells the page whether to offer push at all.
app.get("/qr/:slug/push/key", async (_req: Request, res: Response) => {
	res.json({ enabled: isPushConfigured(), vapid_public_key: pushPublicKey() });
});

app.post("/qr/:slug/push/subscribe", rateLimit("push_sub", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, any>;
	// Accept the browser's PushSubscription verbatim (subscription.keys.*) or the
	// same three values flattened, so a client can post either shape.
	const sub = body.subscription && typeof body.subscription === "object" ? body.subscription : body;
	const keys = sub?.keys && typeof sub.keys === "object" ? sub.keys : sub;
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => SavePushSubscription(slug, {
			token: String(body.token ?? req.query.token ?? ""),
			endpoint: sub?.endpoint,
			p256dh: keys?.p256dh,
			auth: keys?.auth,
			user_agent: req.get("user-agent"),
		}));
		if ("error" in r) { res.status(400).json(r); return; }
		res.status(201).json({ success: true, enabled: isPushConfigured() });
	} catch (e: any) { logger.error({ err: e }, "push_subscribe_failed"); res.status(500).json({ error: "Unable to enable notifications" }); }
});

app.post("/qr/:slug/push/unsubscribe", rateLimit("push_sub", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => DeletePushSubscription(slug, { endpoint: body.endpoint, token: body.token }));
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "push_unsubscribe_failed"); res.status(500).json({ error: "Unable to turn off notifications" }); }
});

app.post("/qr/:slug/razorpay/create", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	// Guest write gate (see /qr/:slug/order). This STARTS a card/UPI payment, so it
	// is the right half of the Razorpay pair to refuse: no new money is taken.
	// /qr/:slug/razorpay/verify below is deliberately NOT gated — it finishes a
	// payment the guest has ALREADY made, and refusing it would take their money
	// and record nothing.
	if (await refuseGuestWriteIfClosed(res, resId)) {return;}
	const keys = await resolveRazorpayKeys(slug, resId);
	if (!keys) { res.status(503).json({ error: "Online payment isn't set up for this restaurant" }); return; }
	const tableName = resolveQrTable(resId, (req.body ?? {}) as Record<string, unknown>);
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	try {
		const bill = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetBillForTable(slug, tableName),
		);
		const amount = Math.round((bill?.grand_total ?? bill?.total_amt ?? 0) * 100); // paise (tax-inclusive)
		if (amount <= 0) { res.status(400).json({ error: "Nothing to pay yet" }); return; }
		const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
			},
			body: JSON.stringify({ amount, currency: "INR", receipt: `${slug}:${tableName}:${Date.now()}` }),
		});
		const data = (await rp.json()) as Record<string, unknown>;
		if (!rp.ok) {
			logger.error({ err: data }, "razorpay_create_failed");
			res.status(502).json({ error: "Razorpay order creation failed" });
			return;
		}
		res.json({ razorpay_order_id: data.id, key_id: keys.key_id, amount, currency: "INR" });
	} catch (err) {
		logger.error({ err }, "razorpay_create_error");
		res.status(500).json({ error: "Unable to start payment" });
	}
});

app.post("/qr/:slug/razorpay/verify", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const keys = await resolveRazorpayKeys(slug, resId);
	if (!keys) { res.status(503).json({ error: "Online payment isn't set up for this restaurant" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
	const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
	const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	if (!orderId || !paymentId || !signature) {
		res.status(400).json({ error: "razorpay_* fields are required" });
		return;
	}
	// Verify the gateway signature (with the restaurant's secret) before trusting it.
	const expected = createHmac("sha256", keys.key_secret).update(`${orderId}|${paymentId}`).digest("hex");
	if (!timingSafeStrEqual(expected, signature)) {
		res.status(400).json({ error: "Payment signature verification failed" });
		return;
	}
	try {
		const result = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => FinalizeOnlinePayment(slug, tableName, paymentId),
		);
		const feedback_url = await feedbackUrlForTable(slug, tableName);
		res.json({ ...result, feedback_url });
	} catch (err: any) {
		logger.error({ err }, "razorpay_verify_finalize_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to finalize payment") });
	}
});
}


export function registerGuestBrandingRoute(app: Express): void {

// Public read of branding (used by the reservation page).
app.get("/qr/:slug/branding", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		const result = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			async () => {
				const [profile, branding] = await Promise.all([
					GetRestaurantProfile(slug),
					GetPublicBranding(slug).catch(() => ({ logo_url: null, theme_color: null, theme_primary: null, theme_secondary: null, currency: "₹", payment_methods: [], queue_show_menu: true, timezone: "Asia/Kolkata", require_table_otp: false, brand_config: resolveBrandConfig(null, null, null), brand_palette: resolveBrandPalette(null, null, null) })),
				]);
				return { restaurant_name: profile?.restaurant_name ?? slug, ...branding };
			},
		);
		res.json(result);
	} catch (err) {
		logger.error({ err }, "qr_branding_failed");
		res.status(500).json({ error: "Unable to load branding" });
	}
});
}
