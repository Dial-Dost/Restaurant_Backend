-- Migration 043: the one column that makes a KOT number findable again.
--
-- ============================================================================
-- THE GAP THIS CLOSES
-- ============================================================================
-- Migration 029 gave the kitchen a short daily number to shout across a pass,
-- and it is gapless and reprint-stable, which is the hard part. What it does NOT
-- do is let anything ever ask "which number did THIS order get?".
--
--   "KotTickets" (029)  res_id, outlet_id, business_day, kot_no, ticket_key
--                       -> no order id. The ticket_key is an opaque fingerprint
--                          of the FOOD (kot_numbers.ts:kotTicketKey), so it can
--                          be recomputed forward but never joined backward.
--   "PrintJobs"  (027)  res_id, outlet_id, bill_id, kind, station, esc_base64
--                       -> no kot_no. The number is inside the rendered ESC/POS
--                          bytes and nowhere else.
--
-- database_supabase.ts says it in as many words: "KOT NUMBER IS NOT RECOVERABLE
-- ... There is no column joining a KOT number back to an order." That one
-- sentence is what blocks six separate requirements — A1 (a cancellation slip
-- must name the KOT it cancels), A3 (KOT ids in the KOT dashboard), B1 (the
-- number on the kitchen card), B2 (the number on the order row, so a human can
-- reprint/cancel/move a ticket BY it), B3 (interval orders shown as N distinct
-- numbered KOTs rather than one stacked list), and the "Token No.: 214, 218,
-- 236, …" line on the real GAIA bill the client photographed, which lists every
-- KOT number that fed that bill.
--
-- Every one of those is a DISPLAY problem. None of them needs a new number, a
-- new allocator, or a different guarantee from the one 029 already gives. They
-- need the number that was already minted to be readable later.
--
-- ============================================================================
-- WHY A COLUMN ON "PrintJobs", AND NOT THE TWO OBVIOUS ALTERNATIVES
-- ============================================================================
-- ALTERNATIVE 1 — order_id on "KotTickets". Wrong SHAPE, not merely heavier.
-- A ticket is not per-order. The table-scoped print path (POST /print/bill with
-- kind:'kot') tickets a whole TABLE, whose running bill is the sum of several
-- orders, so one "KotTickets" row would need N order ids. Single-valued column:
-- lies. Array column: a join table wearing a hat, with none of its constraints.
--
-- ALTERNATIVE 2 — a "KotOrders" join table. Correct shape, unacceptable blast
-- radius. It would have to be written inside allocateKotNumber's transaction,
-- which is the transaction that serialises on "KotCounters" and is the only
-- reason the daily sequence is gapless under concurrent prints from several
-- tills. Adding a second write to the hot path of the one invariant nobody in
-- this system may break — a kitchen calls a ticket BY its number, and two
-- dockets printing "KOT 26" is a dish cooked twice or not at all — to gain a
-- number that is only ever shown on a screen, is a trade nobody should take.
--
-- WHAT THIS DOES INSTEAD. The number is already in hand one line below the
-- allocation in kot_print.ts:dispatchKot: allocate once for the whole ticket,
-- split into per-station dockets, enqueue each. This column carries it into the
-- row that enqueue already writes. No extra statement, no extra transaction,
-- nothing added to or near "KotCounters"/"KotTickets", and therefore no way for
-- this migration to perturb numbering at all. The allocator keeps its single
-- responsibility; "PrintJobs" — which already stores the rendered docket — also
-- stores the number printed on it.
--
-- HOW THE LOOKUPS WORK, since they rest on a convention rather than a foreign
-- key. "PrintJobs".bill_id is deliberately not unique and deliberately not an
-- FK (see 027's header), and for a KOT it is the grouping handle for "these N
-- station dockets came from one press". An ORDER-scoped docket is enqueued with
-- bill_id = 'order-<order uuid>' — kot_print.ts:autoPrintOrderKot and
-- routes/bills.ts's POST /print/kot/order/:id both spell that exact shape, so a
-- docket and its later reprint group together. So:
--
--   one order's KOT numbers  = distinct kot_no of its 'order-<id>' rows
--   one bill's Token No. list = distinct kot_no across that bill's order ids,
--                               in allocation order ("PrintJobs".seq, which 027
--                               added precisely because it is the only total
--                               order this table has)
--
-- A KOT printed through the TABLE-scoped path carries a table-scoped bill_id and
-- is therefore not attributable to a single order. That is honest rather than a
-- bug: that docket really was for the table, not for one order, and the bill's
-- Token No. line is the place it belongs.
--
-- ============================================================================
-- WHY NULLABLE, AND WHY IT MUST STAY NULLABLE
-- ============================================================================
-- Three populations of rows legitimately have no number, and NOT NULL would
-- have to invent one for each:
--
--   1. EVERY ROW PRINTED BEFORE TODAY. The number lives only inside esc_base64
--      as rendered pixels; there is nothing to back-fill from short of parsing
--      receipts. A default of 0 would be a fabricated KOT number on a document
--      the kitchen reads.
--   2. CUSTOMER BILLS (kind='bill'). They have no KOT number by definition.
--   3. A DOCKET THAT GENUINELY COULD NOT BE NUMBERED. allocateKotNumber returns
--      null when migration 029 is unapplied, and dispatchKot prints an unnumbered
--      ticket rather than refusing to print. That degrade is load-bearing — paper
--      on the pass beats a 500 — so the enqueue that follows must still succeed
--      with nothing to put here.
--
-- NULL therefore means exactly one thing, "no number is known for this docket",
-- and every reader treats it as "omit", which is today's behaviour.
--
-- ============================================================================
-- DIAGNOSTIC AND DISPLAY ONLY. NEVER A SOURCE OF A NUMBER.
-- ============================================================================
-- Nothing allocates from here, nothing reprints from here, and nothing may ever
-- decide what to PRINT from here. The source of a KOT number is, and remains,
-- allocateKotNumber against 029's "KotTickets" memo — the only place a number can
-- be made gapless per outlet-day and stable across a reprint. This column is a
-- copy, written after the fact, for screens and for the bill's Token No. line. If
-- it and "KotTickets" ever disagree, "KotTickets" is right.
--
-- The practical consequence: losing this column costs six displays and zero
-- correctness. That is deliberately the whole risk surface of this migration.

-- The column. Additive, idempotent, and a catalogue-only change: a nullable
-- column with no DEFAULT does not rewrite the table in PostgreSQL 11+, so this
-- does not hold ACCESS EXCLUSIVE on "PrintJobs" long enough to matter — which is
-- the lock every live settle and every docket contends with, and the shape of the
-- 2026-08-24 pool standstill.
ALTER TABLE "PrintJobs"
  ADD COLUMN IF NOT EXISTS kot_no integer;

COMMENT ON COLUMN "PrintJobs".kot_no IS
  'The KOT number printed on this docket (migration 029''s "KotTickets".kot_no), '
  'copied here at enqueue so it can be read back. DISPLAY/DIAGNOSTIC ONLY: never '
  'allocated from, never the source of a printed number, and authoritative only '
  'in "KotTickets". NULL on customer bills, on every row printed before migration '
  '043, and on a docket that could not be numbered (029 unapplied).';

-- ONE INDEX, AND THE QUERY IT EXISTS FOR IS NAMED.
--
--   GetKotNumbersForOrders / GetKotNumbersForBill (database_supabase.ts):
--     select bill_id, kot_no from "PrintJobs"
--      where res_id = $1 and ($2::uuid is null or outlet_id = $2::uuid)
--        and kot_no is not null and bill_id = any($3::text[])
--      group by bill_id, kot_no order by min(seq)
--
-- That read is NOT cold. It rides GetOrders — the hot-polled live orders grid —
-- and GetBillForTable, which every bill preview and every print hits. There is no
-- index on bill_id today: 027's two indexes are partial on status and exist for
-- the replay and the purge, and neither can serve a bill_id probe. Without this
-- index the orders grid would sequential-scan a table that grows by one row per
-- docket for ever, on every poll.
--
-- WHY PARTIAL ON kot_no IS NOT NULL: it indexes only numbered dockets. Customer
-- bills and the entire pre-043 history are excluded, so on the day this lands the
-- index is empty and it never grows faster than the kitchen prints. That is also
-- the answer to the write-amplification objection — this is the hottest table in
-- the print path, and a full index would add an entry for every bill as well.
--
-- NOT CONCURRENTLY, deliberately, even though this is a live restaurant: the
-- build reads only the rows matching the partial predicate, and on the day this
-- migration runs there are none, so it is a catalogue write inside the ACCESS
-- EXCLUSIVE lock the ALTER above already holds. CREATE INDEX CONCURRENTLY cannot
-- run inside a transaction block, which would take this migration out of the
-- all-or-nothing shape every other migration here has, in exchange for avoiding a
-- lock that is measured in milliseconds over an empty predicate.
--
-- WHY (res_id, bill_id) AND NOT (res_id, outlet_id, bill_id): the orders grid can
-- run in all-outlets mode, where outlet_id is not constrained and a middle column
-- it cannot use would push the selective term out of the index. bill_id is a uuid
-- inside a string and is selective on its own; the outlet filter is applied to the
-- handful of rows that come back. Tenant key first, matching every other index in
-- this schema and the RLS predicate.
CREATE INDEX IF NOT EXISTS printjobs_kot_link_idx
  ON "PrintJobs" (res_id, bill_id)
  WHERE kot_no IS NOT NULL;

-- NO RLS RE-ASSERTION HERE, AND THAT IS A DECISION, NOT AN OMISSION.
-- 033 and 041 restate their table's policy because migration 003 applies RLS by a
-- dynamic loop over information_schema that does not retro-cover tables created
-- later, so a database branched between the CREATE TABLE and the policy could
-- exist unprotected. "PrintJobs" has no such window: migration 027 created the
-- table AND its tenant_isolation policy in one transaction, so there is no state
-- of this schema in which the table exists without it. Restating it would mean a
-- DROP POLICY / CREATE POLICY cycle on the hottest table in the print path, for a
-- gap that provably cannot exist — and this table holds rendered customer
-- receipts, so the one moment worth avoiding is the moment its policy is absent.
-- A column does not carry its own RLS; 027's row policy already governs every
-- read and write of this one.

-- The grants, on the other hand, ARE restated. 002's ALTER DEFAULT PRIVILEGES
-- only covers tables created by the role that set it, so 027 spelled them out and
-- so does this — a migration run under a different owner would otherwise leave the
-- runtime unable to write the column it just added. Strictly this is belt to 027's
-- braces, because "PrintJobs" has no COLUMN-level grants and a new column is
-- therefore already covered by the table-level ones; it costs one idempotent
-- statement inside a lock this migration is holding anyway. The bigserial's
-- sequence grant is 027's and is deliberately not repeated: nothing here creates a
-- sequence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintJobs" TO app_runtime;
  END IF;
END $$;
