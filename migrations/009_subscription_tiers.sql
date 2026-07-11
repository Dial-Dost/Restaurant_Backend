-- Migration 009: subscription self-serve tiers.
--   * pending_plan_id on subscriptions = a scheduled downgrade applied at period end.
--   * seed 3 default, EDITABLE tiers so there's something to subscribe to (prices
--     and features are placeholders — adjust them in the platform console).
-- Lives entirely in the `platform` schema. Idempotent. Requires migration 004.

ALTER TABLE platform.subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id uuid REFERENCES platform.plans(id);

INSERT INTO platform.plans (code, name, price_cents, features, limits, active) VALUES
  ('starter', 'Starter', 0,
   '{"accounting":true,"analytics":true,"inventory":true,"valet":false,"coupons":false,"attendance":false,"multi_outlet":false}'::jsonb,
   '{"employees":5,"outlets":1}'::jsonb, true),
  ('growth', 'Growth', 149900,
   '{"accounting":true,"analytics":true,"inventory":true,"valet":true,"coupons":true,"attendance":true,"multi_outlet":false}'::jsonb,
   '{"employees":25,"outlets":1}'::jsonb, true),
  ('enterprise', 'Enterprise', 399900,
   '{"accounting":true,"analytics":true,"inventory":true,"valet":true,"coupons":true,"attendance":true,"multi_outlet":true}'::jsonb,
   '{}'::jsonb, true)
ON CONFLICT (code) DO NOTHING;

-- Verify:
-- SELECT code, name, price_cents, features, limits FROM platform.plans ORDER BY price_cents;
