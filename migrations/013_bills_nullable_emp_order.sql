-- Migration 013: allow NULL Bills.emp_id and Bills.order_id.
--
-- WHY: a consolidated per-table bill is NOT tied to a single order, and when it is
-- materialized lazily by a system action (applying a coupon or a discount before any
-- payment), there is no acting employee yet. The code already inserts these as NULL
-- (ApplyCouponToBill / SetBillDiscount), but the original Supabase schema marked both
-- columns NOT NULL — so the first coupon/discount on a not-yet-materialized bill
-- fails with a not-null violation. (Caught by the money integration test; latent in
-- prod only because the Coupons table has never been created there.)
--
-- Both columns keep their foreign keys, which already permit NULL. Existing rows are
-- unaffected; the normal payment paths still set emp_id/order_id.

ALTER TABLE "Bills" ALTER COLUMN emp_id DROP NOT NULL;
ALTER TABLE "Bills" ALTER COLUMN order_id DROP NOT NULL;
