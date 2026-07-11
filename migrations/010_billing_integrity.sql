-- Migration 010: billing payment integrity + atomic dedup.
--   * Bind a Razorpay order/payment to the invoice it settles, and make a captured
--     payment single-use (replay guard) — closes the verify-replay flaw.
--   * Atomic one-invoice-per-(restaurant, period) for recurring billing (this is the
--     guard migration 007 deferred; applied here independently of the RLS work).
-- platform schema only; idempotent. Requires migration 006.

ALTER TABLE platform.invoices ADD COLUMN IF NOT EXISTS razorpay_order_id   text;
ALTER TABLE platform.invoices ADD COLUMN IF NOT EXISTS razorpay_payment_id text;
ALTER TABLE platform.invoices ADD COLUMN IF NOT EXISTS paid_at             timestamptz;

-- A captured Razorpay payment can settle at MOST one invoice (replay/reuse guard).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_razorpay_payment_uniq
  ON platform.invoices (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

-- One invoice per (restaurant, period) — makes recurring-cycle dedup atomic.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_res_period_uniq
  ON platform.invoices (res_id, period_end)
  WHERE period_end IS NOT NULL;

-- Verify:
-- \d platform.invoices
