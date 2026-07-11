-- Migration 006: SaaS billing history (invoices per subscription).
--
-- Records charges/payments against priced subscription plans so the control
-- plane can show a billing history per restaurant. Additive to 004/005; lives
-- entirely in the `platform` schema (tenant runtime role has no access).
--
-- !! Apply on STAGING first. Requires migration 004.

CREATE TABLE IF NOT EXISTS platform.invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  res_id        uuid NOT NULL REFERENCES "Restaurant"(id) ON DELETE CASCADE,
  plan_id       uuid REFERENCES platform.plans(id),
  amount_cents  integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'paid',   -- paid | pending | void
  period_start  date,
  period_end    date,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_res_recent ON platform.invoices (res_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.invoices TO platform_runtime;

-- Verify:
-- SELECT * FROM platform.invoices ORDER BY created_at DESC LIMIT 5;
