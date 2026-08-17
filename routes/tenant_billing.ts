/**
 * The tenant's own SaaS subscription: plan view, plan change and self-serve
 * Razorpay checkout against the platform account.
 */
import type { Express, Request, Response } from "express";
import { createHmac } from "crypto";
import { logger } from "../observability.js";
import { billingConfigured, getInvoice, getTenantBilling, markInvoicePaidAndActivate, requestPlanChange, setInvoiceOrderId } from "../platform/tenant_billing.js";
import { PERM_BILLING, PLATFORM_RAZORPAY_KEY_ID, PLATFORM_RAZORPAY_KEY_SECRET, enforcePermission, fetchWithTimeout, platformRazorpayReady, timingSafeStrEqual } from "./_shared.js";


export function registerTenantBillingRoutes(app: Express): void {

app.get("/billing", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	if (!billingConfigured()) {
		res.json({ configured: false, online_pay: false, subscription: null, plan: null, pending_plan: null, plans: [], invoices: [] });
		return;
	}
	try {
		const data = await getTenantBilling(auth.restaurantId);
		res.json({ configured: true, online_pay: platformRazorpayReady, ...data });
	} catch (e) { logger.error({ err: e }, "billing_get_failed"); res.status(500).json({ error: "Unable to load billing" }); }
});

app.post("/billing/change-plan", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
	if (!planId) { res.status(400).json({ error: "plan_id is required" }); return; }
	try {
		const result = await requestPlanChange(auth.restaurantId, planId);
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, "billing_change_plan_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to change plan") }); }
});

app.post("/billing/pay/create", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	if (!platformRazorpayReady) { res.status(503).json({ error: "Online payment isn't set up. Your provider will confirm the payment manually." }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id.trim() : "";
	if (!invoiceId) { res.status(400).json({ error: "invoice_id is required" }); return; }
	try {
		const inv = await getInvoice(invoiceId);
		if (!inv || inv.res_id !== auth.restaurantId) { res.status(404).json({ error: "Invoice not found" }); return; }
		if (inv.status === "paid") { res.status(409).json({ error: "This invoice is already paid" }); return; }
		const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Basic " + Buffer.from(`${PLATFORM_RAZORPAY_KEY_ID}:${PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64"),
			},
			body: JSON.stringify({ amount: Math.max(100, Math.round(inv.amount_cents)), currency: "INR", receipt: `inv_${inv.id}` }),
		});
		if (!rp.ok) { const t = await rp.text().catch(() => ""); logger.error({ status: rp.status, body: t.slice(0, 300) }, "platform_razorpay_order_failed"); res.status(502).json({ error: "Payment gateway error" }); return; }
		const order: any = await rp.json();
		// Bind the order to THIS invoice so verify can require they match.
		await setInvoiceOrderId(inv.id, String(order.id));
		res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: PLATFORM_RAZORPAY_KEY_ID, invoice_id: inv.id });
	} catch (e: any) { logger.error({ err: e }, "billing_pay_create_failed"); res.status(500).json({ error: "Unable to start payment" }); }
});

app.post("/billing/pay/verify", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	if (!platformRazorpayReady) { res.status(503).json({ error: "Online payment isn't set up." }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id.trim() : "";
	const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
	const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
	const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
	if (!invoiceId || !orderId || !paymentId || !signature) { res.status(400).json({ error: "invoice_id and razorpay_* fields are required" }); return; }
	try {
		const inv = await getInvoice(invoiceId);
		if (!inv || inv.res_id !== auth.restaurantId) { res.status(404).json({ error: "Invoice not found" }); return; }
		if (inv.status !== "pending") { res.status(409).json({ error: "This invoice is no longer payable" }); return; }
		// The order MUST be the one we created for this invoice (no reusing another
		// order's valid signature to settle this invoice).
		if (!inv.razorpay_order_id || inv.razorpay_order_id !== orderId) { res.status(400).json({ error: "Payment does not match this invoice" }); return; }
		// Signature authenticity (constant-time).
		const expected = createHmac("sha256", PLATFORM_RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
		if (!timingSafeStrEqual(expected, signature)) { res.status(400).json({ error: "Payment verification failed" }); return; }
		// Independently confirm with Razorpay that THIS order was actually captured
		// for the FULL invoice amount (never trust the client's claim alone).
		const expectedAmount = Math.max(100, Math.round(inv.amount_cents));
		const ordRes = await fetchWithTimeout(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
			headers: { Authorization: "Basic " + Buffer.from(`${PLATFORM_RAZORPAY_KEY_ID}:${PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64") },
		});
		if (!ordRes.ok) { logger.error({ err: ordRes.status }, "platform_razorpay_order_fetch_failed"); res.status(502).json({ error: "Could not confirm payment with the gateway" }); return; }
		const ord: any = await ordRes.json();
		const paid = ord?.status === "paid" || Number(ord?.amount_paid) >= expectedAmount;
		if (!paid || Number(ord?.amount) !== expectedAmount) {
			res.status(400).json({ error: "Payment amount/status mismatch" });
			return;
		}
		// Idempotent + replay-safe: the UPDATE only transitions a pending invoice, and
		// razorpay_payment_id is UNIQUE (a captured payment settles one invoice only).
		let result;
		try {
			result = await markInvoicePaidAndActivate(invoiceId, paymentId);
		} catch (e: any) {
			if (e?.code === "23505") { res.status(409).json({ error: "This payment has already been applied" }); return; }
			throw e;
		}
		if (!result) { res.status(409).json({ error: "This invoice is already paid" }); return; }
		res.json({ ok: true, ...result });
	} catch (e: any) { logger.error({ err: e }, "billing_pay_verify_failed"); res.status(500).json({ error: "Unable to verify payment" }); }
});
}
