-- Migration 017: per-table MAXIMUM capacity.
--
-- "Tables".capacity stays the normal (comfortable) seat count. max_capacity is
-- the most the table can take with extra chairs pulled up, and drives the
-- seating suggester (GET /tables/seating-suggestion) that proposes clubbing
-- consecutively-numbered tables for a party too big for one table.
--
-- Left NULL on existing rows on purpose: every read does
-- coalesce(max_capacity, capacity) (effectiveMaxCapacity in the app), so an
-- un-set table behaves exactly as it did before. The same guarded ALTER runs
-- lazily from the app (ensureTableMaxCapacityColumn) — whichever side runs
-- first wins and the other is a no-op.

ALTER TABLE "Tables" ADD COLUMN IF NOT EXISTS max_capacity integer;
