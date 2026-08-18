-- Migration 027: durable print jobs.
--
-- THE DEFECT THIS CLOSES: printing was fire-and-forget. A bill's ESC/POS bytes
-- were handed to emitOutlet() and nothing else. realtime.ts returns early when
-- `io` is null, and `io.to(room).emit()` on an EMPTY room is a successful no-op
-- with no return value — so a bill emitted while that till's socket was down was
-- gone, with no retry, no persistence, no error and no log line. The waiter saw
-- {success:true} and no receipt appeared. On a laptop that never restarts this is
-- rare; on a host that redeploys it is every deploy, for every till.
--
-- This table makes the ROW the durable fact and the socket emit an optimisation:
-- the job is written before it is emitted, and an agent that reconnects replays
-- whatever it never acked.
--
-- IDENTITY IS `id`, NOT `bill_id`, and that is load-bearing:
--   * bill_id is STABLE ACROSS REPRINTS ("Bills".bill_id, or the
--     `<table>-<epoch>` fallback at routes/bills.ts). Deduplicating on it would
--     silently swallow a waiter's deliberate reprint.
--   * ONE bill_id fans out to N KOT tickets — buildKotBase64 returns one ticket
--     per kitchen station and the route emits N times under a single billId.
--     Deduplicating on it would print one station's docket and drop the rest.
-- Both are correctness bugs that present as "the printer is flaky", so bill_id is
-- deliberately NOT unique here and every guard keys on the per-job uuid.
--
-- text + CHECK rather than Postgres enums, matching the house convention for
-- workflow state (024's note applies verbatim).
--
-- NOT CREATED LAZILY, deliberately. Two dozen tables in this schema exist only as
-- `create table if not exists` inside database_supabase.ts; migration 026's header
-- records the production outage that pattern caused under the least-privilege
-- app_runtime role, which has USAGE but not CREATE on public (002:28). A table on
-- the money path does not get to be the twenty-fifth.

CREATE TABLE IF NOT EXISTS "PrintJobs" (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- TIEBREAKER, and the only total order that exists here. Replay is served
  -- oldest-first because the N station tickets of one KOT are a unit and kitchen
  -- dockets must arrive in the order they were rung up — but created_at is
  -- transaction time, and the KOT loop inserts its tickets in a tight loop.
  -- Postgres' microsecond resolution makes a tie unlikely rather than impossible,
  -- and "unlikely" is not an ordering guarantee. Ordering by (created_at, seq)
  -- makes it one, at the cost of one column.
  seq          bigserial NOT NULL,
  res_id       uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- NOT NULL and a real FK. A till holds ONE outlet's socket room
  -- (`restaurant:<res>:outlet:<outlet>`), so a job with no outlet is a job no
  -- agent can ever be handed. Every producer already has a resolved outlet_id
  -- from requireAuth (routes/_shared.ts extractOutletId returns the RESOLVED
  -- auth.outlet_id, never a raw header), so there is no caller that would need
  -- this nullable.
  outlet_id    uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  -- DELIBERATELY NOT UNIQUE, and deliberately not a FK. See the header: reprints
  -- reuse it and N KOT tickets share it, and the fallback value
  -- (`<table>-<epoch>`) is not a "Bills" key at all.
  bill_id      text NOT NULL,
  kind         text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill','kot')),
  -- KOT only: the kitchen station this ticket belongs to, so an agent that maps
  -- station -> printer can route it. NULL on a customer bill.
  station      text,
  -- The rendered ESC/POS bytes, base64. Stored rather than re-rendered on replay
  -- BECAUSE re-rendering is not idempotent: the bill moves (items added, discount
  -- applied, settled) between the emit and the reconnect, and a receipt that
  -- prints different numbers than the one the customer was shown is worse than no
  -- receipt. A bill with an embedded logo raster is a few KB; TOAST handles it.
  esc_base64   text NOT NULL,

  -- pending   : written, emitted live, nobody has claimed it
  -- delivered : handed to a named agent, which holds a lease (claimed_until)
  -- acked     : that agent confirmed the paper came out. TERMINAL.
  -- failed    : that agent gave up after its own retries. TERMINAL — replaying to
  --             a printer that already refused it three times just loops.
  -- expired   : outlived its TTL before any agent took it. TERMINAL.
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','delivered','acked','expired','failed')),
  attempts     smallint NOT NULL DEFAULT 0,
  -- Diagnostic + the lease holder's name. The GUARD is claimed_until, not this.
  claimed_by   text,
  -- THE LEASE. A job handed to one till is off-limits to every other till until
  -- this lapses, which is what stops two tills on one outlet both replaying the
  -- same receipt. It must be a LEASE and not a backoff: setting it to a retry
  -- delay would make a job an agent is still spooling eligible for the other
  -- till's next resume (migration 026's next_attempt_at note, same reasoning).
  claimed_until timestamptz,
  delivered_at timestamptz,
  -- When the job reached a TERMINAL state, by any route — acked, failed or
  -- expired. Retention is measured from HERE and never from created_at, and that
  -- distinction is the difference between the 'expired' status being a signal and
  -- being noise: a job that sat pending for a fortnight because its till was gone
  -- is expired the moment the reaper first sees it, and purging it in the same
  -- sweep (which keying on created_at does) destroys the only record that those
  -- receipts were lost. NULL here also means "not settled", so a live job can
  -- never be deleted however old the row is.
  settled_at   timestamptz,
  -- What the AGENT reported, when an agent reported at all. NULL on an expired
  -- job — nobody ever took it, so there is no outcome to record.
  ack_result   text CHECK (ack_result IN ('printed','failed'))
);

-- THE hot read: "everything outstanding for this outlet, oldest first", issued
-- once per till reconnect. PARTIAL so it stays an index-only scan over a handful
-- of live rows however much acked history accumulates behind it. The reaper's
-- expiry scan rides the same index.
CREATE INDEX IF NOT EXISTS printjobs_outstanding_idx
  ON "PrintJobs" (res_id, outlet_id, created_at)
  WHERE status IN ('pending','delivered');

-- The purge's only read. Also partial, and on the complementary predicate, so the
-- two scans never walk each other's rows. Keyed on settled_at, matching what the
-- retention window is actually measured from.
CREATE INDEX IF NOT EXISTS printjobs_settled_idx
  ON "PrintJobs" (res_id, settled_at)
  WHERE status NOT IN ('pending','delivered');

-- Fail-closed from the moment it exists, in migration 003's exact policy form.
-- Migration 003 applies RLS by a dynamic loop over information_schema.columns
-- (003:30-45), which does not retro-cover tables created later, so this is not
-- redundant. It matters more here than for most: these rows carry rendered
-- customer receipts.
ALTER TABLE "PrintJobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintJobs" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintJobs";
CREATE POLICY tenant_isolation ON "PrintJobs"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it. Spell it out so a migration run under a different owner still leaves the
-- runtime able to read its own rows. (Migration 024's exact guard.)
-- The bigserial above owns a SEQUENCE, and INSERT on the table is not enough to
-- use it: without USAGE the runtime's every print insert fails with 42501. Looked
-- up rather than named, so this keeps working if the implicit sequence is ever
-- renamed.
DO $$
DECLARE seqname text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintJobs" TO app_runtime;
    seqname := pg_get_serial_sequence('"PrintJobs"', 'seq');
    IF seqname IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO app_runtime', seqname);
    END IF;
  END IF;
END $$;
