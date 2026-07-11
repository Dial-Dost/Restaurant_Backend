// Tenant-facing subscription/billing logic. Reads/writes the `platform` schema via
// platformQuery (the control-plane pool) but is driven by tenant-authed endpoints
// scoped to the caller's res_id. Upgrade = pay now & switch; downgrade = scheduled
// at period end (pending_plan_id, applied by the billing cycle).
import { platformQuery, platformDbConfigured } from "./db.js";

export type PlanRow = {
  id: string;
  code: string;
  name: string;
  price_cents: number;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  active: boolean;
};
export type SubRow = {
  res_id: string;
  plan_id: string | null;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  pending_plan_id: string | null;
};
export type InvoiceRow = {
  id: string;
  res_id: string;
  plan_id: string | null;
  amount_cents: number;
  status: string;
  period_start: string | null;
  period_end: string | null;
  note: string | null;
  created_at: string;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
  paid_at?: string | null;
};

export function billingConfigured(): boolean {
  return platformDbConfigured();
}

export async function getActivePlans(): Promise<PlanRow[]> {
  return platformQuery<PlanRow>(`select * from platform.plans where active = true order by price_cents asc, created_at asc`);
}

async function getPlanById(planId: string): Promise<PlanRow | null> {
  const rows = await platformQuery<PlanRow>(`select * from platform.plans where id = $1 limit 1`, [planId]);
  return rows[0] ?? null;
}

async function getDefaultPlanId(): Promise<string | null> {
  const rows = await platformQuery<{ id: string }>(
    `select id from platform.plans where active = true order by price_cents asc, created_at asc limit 1`,
  );
  return rows[0]?.id ?? null;
}

export async function getSubscription(resId: string): Promise<SubRow | null> {
  const rows = await platformQuery<SubRow>(`select * from platform.subscriptions where res_id = $1 limit 1`, [resId]);
  return rows[0] ?? null;
}

// Start a trial on the default plan when a restaurant has no subscription. Called
// at registration; idempotent (no-op if a subscription already exists).
export async function startTrialIfMissing(resId: string, trialDays: number): Promise<void> {
  const planId = await getDefaultPlanId();
  await platformQuery(
    `insert into platform.subscriptions (res_id, plan_id, status, trial_ends_at, current_period_end, updated_at)
     values ($1, $2, 'trial', now() + ($3 || ' days')::interval, now() + ($3 || ' days')::interval, now())
     on conflict (res_id) do nothing`,
    [resId, planId, String(Math.max(1, Math.round(trialDays)))],
  );
}

export async function getTenantBilling(resId: string): Promise<{
  subscription: SubRow | null;
  plan: PlanRow | null;
  pending_plan: PlanRow | null;
  plans: PlanRow[];
  invoices: InvoiceRow[];
}> {
  const [sub, plans] = await Promise.all([getSubscription(resId), getActivePlans()]);
  const byId = new Map(plans.map((p) => [p.id, p]));
  const plan = sub?.plan_id ? byId.get(sub.plan_id) ?? (await getPlanById(sub.plan_id)) : null;
  const pending_plan = sub?.pending_plan_id ? byId.get(sub.pending_plan_id) ?? (await getPlanById(sub.pending_plan_id)) : null;
  const invoices = await platformQuery<InvoiceRow>(
    `select * from platform.invoices where res_id = $1 order by created_at desc limit 50`,
    [resId],
  );
  return { subscription: sub, plan: plan ?? null, pending_plan: pending_plan ?? null, plans, invoices };
}

export async function getInvoice(invoiceId: string): Promise<InvoiceRow | null> {
  const rows = await platformQuery<InvoiceRow>(`select * from platform.invoices where id = $1 limit 1`, [invoiceId]);
  return rows[0] ?? null;
}

export async function createPendingInvoice(resId: string, planId: string, amountCents: number, note: string): Promise<InvoiceRow> {
  // Reuse an existing OPEN plan-change invoice (no period) for the same plan so a
  // double-click / retry doesn't stack duplicate pending invoices.
  const existing = await platformQuery<InvoiceRow>(
    `select * from platform.invoices
       where res_id = $1 and plan_id = $2 and status = 'pending' and period_end is null
       order by created_at desc limit 1`,
    [resId, planId],
  );
  if (existing[0]) return existing[0];
  const rows = await platformQuery<InvoiceRow>(
    `insert into platform.invoices (res_id, plan_id, amount_cents, status, note) values ($1, $2, $3, 'pending', $4) returning *`,
    [resId, planId, Math.max(0, Math.round(amountCents)), note],
  );
  if (!rows[0]) throw new Error("Failed to create invoice");
  return rows[0];
}

// Persist the Razorpay order id on a pending invoice so verify can bind the
// payment to THIS invoice (not just any valid signature).
export async function setInvoiceOrderId(invoiceId: string, orderId: string): Promise<void> {
  await platformQuery(`update platform.invoices set razorpay_order_id = $2 where id = $1 and status = 'pending'`, [invoiceId, orderId]);
}

// Set the subscription to a plan, active, extending the period by 1 month from
// max(now, current_period_end) so re-activation never shortens a paid period and a
// replay can't extend it (combined with the idempotent invoice transition below).
// Clears any scheduled downgrade.
export async function activateSubscriptionPlan(resId: string, planId: string): Promise<void> {
  await platformQuery(
    `insert into platform.subscriptions (res_id, plan_id, status, current_period_end, pending_plan_id, updated_at)
     values ($1, $2, 'active', now() + interval '1 month', null, now())
     on conflict (res_id) do update set
       plan_id = excluded.plan_id, status = 'active',
       current_period_end = greatest(now(), coalesce(platform.subscriptions.current_period_end, now())) + interval '1 month',
       pending_plan_id = null, updated_at = now()`,
    [resId, planId],
  );
}

// Mark a PENDING invoice paid AND activate its plan — idempotent. The UPDATE only
// transitions a row that is still pending, so a replay/duplicate call returns null
// and does NOT re-extend the period. Optionally records the consuming Razorpay
// payment id (UNIQUE index → a captured payment settles at most one invoice;
// a replayed payment id throws 23505, surfaced as a 409 by the caller).
export async function markInvoicePaidAndActivate(invoiceId: string, paymentId?: string | null): Promise<{ res_id: string; plan_id: string | null } | null> {
  const inv = await platformQuery<{ res_id: string; plan_id: string | null }>(
    `update platform.invoices
        set status = 'paid', paid_at = now(), razorpay_payment_id = coalesce($2, razorpay_payment_id)
      where id = $1 and status = 'pending'
      returning res_id, plan_id`,
    [invoiceId, paymentId ?? null],
  );
  const row = inv[0];
  if (!row) return null; // already paid / not pending — idempotent no-op
  if (row.plan_id) await activateSubscriptionPlan(row.res_id, row.plan_id);
  return { res_id: row.res_id, plan_id: row.plan_id };
}

export type PlanChangeResult = { mode: "upgrade" | "downgrade_scheduled" | "noop"; invoice?: InvoiceRow; plan: PlanRow };

// Decide upgrade vs downgrade and act. Upgrade (or converting a trial / first paid
// plan): a paid plan returns a pending invoice for the caller to pay (then
// markInvoicePaidAndActivate switches it); a free plan activates immediately.
// Downgrade/same-price: scheduled at period end via pending_plan_id (no charge now).
export async function requestPlanChange(resId: string, targetPlanId: string): Promise<PlanChangeResult> {
  const target = await getPlanById(targetPlanId);
  if (!target || !target.active) throw new Error("Plan not available");
  const sub = await getSubscription(resId);
  const currentPlan = sub?.plan_id ? await getPlanById(sub.plan_id) : null;
  const currentPrice = currentPlan?.price_cents ?? 0;
  const isActivePaid = sub?.status === "active";

  // Already on this plan & active: clear any scheduled downgrade, no-op.
  if (isActivePaid && sub?.plan_id === target.id) {
    if (sub.pending_plan_id) {
      await platformQuery(`update platform.subscriptions set pending_plan_id = null, updated_at = now() where res_id = $1`, [resId]);
    }
    return { mode: "noop", plan: target };
  }

  // Upgrade, or first paid subscription, or converting a trial → charge now.
  if (!isActivePaid || target.price_cents > currentPrice) {
    if (target.price_cents <= 0) {
      // Don't let a tenant in arrears (past_due/expired/etc.) escape an unpaid
      // balance by switching to a free tier — only first-subscription/trial/active
      // may free-activate immediately. A paid (price>0) change still goes through
      // the invoice path below.
      const st = sub?.status;
      if (st && st !== "trial" && st !== "active") {
        throw new Error("Please settle your outstanding balance before switching plans.");
      }
      await activateSubscriptionPlan(resId, target.id);
      return { mode: "upgrade", plan: target };
    }
    const invoice = await createPendingInvoice(resId, target.id, target.price_cents, `Plan change → ${target.name}`);
    return { mode: "upgrade", invoice, plan: target };
  }

  // Downgrade (or same price, different plan): schedule at period end.
  await platformQuery(`update platform.subscriptions set pending_plan_id = $2, updated_at = now() where res_id = $1`, [resId, target.id]);
  return { mode: "downgrade_scheduled", plan: target };
}

// Apply scheduled downgrades whose period has ended. Run inside the billing cycle.
// Returns the number applied.
export async function applyScheduledDowngrades(): Promise<number> {
  const rows = await platformQuery<{ res_id: string }>(
    `update platform.subscriptions
        set plan_id = pending_plan_id, pending_plan_id = null, updated_at = now()
      where pending_plan_id is not null
        and (current_period_end is null or current_period_end < now())
      returning res_id`,
  );
  return rows.length;
}
