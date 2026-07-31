-- Migration 021: "when did this happen" instants on the records that mutate.
--
-- Every money/ops table already stamped its CREATION instant (created_at default
-- now(), or clock_in / opened_at / submitted_at), and the bill workflow already
-- dated each payment step (waiter_confirmed_at, admin_approved_at, closed_at,
-- refunded_at). Three gaps remained for tally/accounting:
--
--   Orders.updated_at    — an order's status walks Pending -> Preparing -> Served
--                          -> Paid -> Closed, and its items can be added, split,
--                          moved or removed, all as UPDATEs of the SAME row. Only
--                          the placing instant was recorded, so "when was this
--                          ticket last touched" was unanswerable.
--   Bookings.updated_at  — a booking's status, table assignment and deposit all
--                          live inside the `slot` text blob and are rewritten in
--                          place, so a cancellation or a seating left no trace of
--                          WHEN it happened.
--   Bills.discount_applied_at
--                        — a discount taken through the approval flow is dated by
--                          DiscountRequests.decided_at, but one applied directly
--                          (admin, or under the approval threshold) only wrote
--                          discount_type/discount_value, with no instant at all.
--
-- NOT BACKFILLED, deliberately. Rows that existed before this migration read
-- NULL, which honestly means "no recorded change". Copying created_at into
-- updated_at would invent an edit that never happened and would corrupt exactly
-- the tally the columns exist to serve. (This is why 016's one-time barked_at
-- backfill is NOT imitated here — that one restored prior BEHAVIOUR; this would
-- fabricate HISTORY.)
--
-- All three are timestamptz: instants are stored in UTC, always. The per-tenant
-- Restaurant.timezone is a DISPLAY/PARSE concern only and never changes what is
-- written here.
--
-- updated_at is maintained by a BEFORE UPDATE trigger rather than by each write
-- site, for the same reason table_sessions_trg is a trigger (migration-free
-- coverage of every path): POS, KDS, QR ordering, queue seating, settlement,
-- merge/split and audit-undo all mutate these rows, and a future path that
-- forgot to set the column would silently report a stale instant — worse for
-- accounting than no column at all. The same guarded DDL runs lazily from the
-- app (ensureRecordTimestampColumns), so whichever side runs first wins and the
-- other is a no-op, matching 016/017/020.

ALTER TABLE "Orders"   ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE "Bookings" ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE "Bills"    ADD COLUMN IF NOT EXISTS discount_applied_at timestamptz;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  new.updated_at := now();
  RETURN new;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_touch_trg ON "Orders";
CREATE TRIGGER orders_touch_trg
  BEFORE UPDATE ON "Orders"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS bookings_touch_trg ON "Bookings";
CREATE TRIGGER bookings_touch_trg
  BEFORE UPDATE ON "Bookings"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
