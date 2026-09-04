-- Migration 033: the idempotency key store.
--
-- THE DEFECT THIS CLOSES: nothing in this API has ever been safe to retry.
-- `grep -rE "client_id|idempotency|event_id" routes/` returns nothing, so every
-- mutating route is apply-on-arrival. A POST /orders whose response was lost —
-- Wi-Fi dropped between the write landing and the 201 reaching the till, a
-- Railway redeploy cut the socket mid-flight, the 15-slot pooler answered 503
-- after the insert committed — leaves the client with no way to distinguish
-- "never applied" from "applied, answer lost". Its only options are to drop the
-- write or to send it again, and sending it again rings the order twice.
--
-- That is survivable today only because the client never retries. It stops being
-- survivable the moment an offline outbox replays a queue of writes: replay is
-- retry, by definition, and at-least-once delivery without a dedup key is
-- at-least-once APPLICATION. Two dockets, two wastage deductions, two clock-ins.
--
-- WHAT A ROW IS: one client-generated key, the request it was first used for,
-- and the response that request produced. A repeat of that key inside the window
-- REPLAYS the stored response and never reaches the handler.
--
-- IDENTITY IS (res_id, idem_key), and both halves are load-bearing:
--   * idem_key alone would put every tenant's keys in one namespace, so one
--     restaurant's client could collide with another's (and, worse, learn that
--     it had).
--   * res_id alone is obviously not unique.
-- The key is generated per WRITE by the device, not per session, so it is the
-- only thing that can identify "this exact intent" across a reconnect.
--
-- WHAT IS DELIBERATELY NOT HERE: anything that mints a bill or KOT number.
-- "Outlets".bill_seq and AllocateKotNumber are cloud atomic counters feeding a
-- gap-free per-outlet GST invoice series; a key store cannot make an invoice
-- number safe to allocate offline, and pretending otherwise would put duplicate
-- or gapped numbers on real tax documents. Settlement stays online-only. This
-- table exists for the writes a waiter performs DURING service.
--
-- text + CHECK rather than a Postgres enum, matching the house convention for
-- workflow state (024's note applies verbatim).
--
-- NOT CREATED LAZILY, deliberately — same reasoning as 027: migration 026's
-- header records the production outage that `create table if not exists` inside
-- database_supabase.ts caused under the least-privilege app_runtime role, which
-- has USAGE but not CREATE on public (002:28).

CREATE TABLE IF NOT EXISTS "IdempotencyKeys" (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  res_id       uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- The outlet requireAuth RESOLVED for the request (routes/_shared.ts
  -- extractOutletId returns auth.outlet_id, never a raw header). Recorded, and
  -- folded into the fingerprint below, so a key replayed against a different
  -- branch is refused rather than answered with the first branch's result.
  -- Nullable ONLY because a key store must never be the thing that fails a write.
  outlet_id    uuid REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- Diagnostics: who made the write. NOT part of identity — the same device
  -- replaying its own outbox is the same intent regardless of who is now signed
  -- in, and a shift change mid-outage must not turn a queued order into a
  -- duplicate.
  employee_id  uuid,

  -- The client-generated key. Opaque to the server: a v4 uuid from the device in
  -- practice, but nothing here depends on its shape beyond the length bound the
  -- middleware enforces.
  idem_key     text NOT NULL,
  -- "POST /orders", "PATCH /orders/:id/status" — the Express PATTERN, not the
  -- concrete path. Diagnostics only (the fingerprint already covers the concrete
  -- URL); it is what makes this table readable when someone asks which writes a
  -- till replayed after an outage.
  route_key    text NOT NULL,
  -- sha256 over method + concrete URL + resolved outlet + canonical body. THE
  -- REUSE GUARD: a key that comes back carrying a DIFFERENT request is a client
  -- bug, and replaying the first response to it would answer a question nobody
  -- asked. Compared, never trusted for identity — identity is idem_key.
  fingerprint  text NOT NULL,

  -- in_flight : claimed, the handler is running (or its process died — see
  --             lease_until). NOT a promise that anything was applied.
  -- completed : the handler produced a 2xx and it is stored below. TERMINAL
  --             until expiry.
  --
  -- THERE IS NO 'failed' STATE, and its absence is the whole ordering story.
  -- A non-2xx DELETES the row instead (ReleaseIdempotencyKey), because a
  -- rejection is not an application: an outbox replaying a table release before
  -- the order that table is carrying gets today's 404, and that 404 must stay
  -- retryable once the prerequisite lands. Caching it would wedge the queue
  -- permanently on the first out-of-order arrival.
  status       text NOT NULL DEFAULT 'in_flight'
               CHECK (status IN ('in_flight','completed')),
  -- How many times this key has been claimed, including takeovers. A value above
  -- 1 means a previous holder died mid-request; worth having when a duplicate
  -- effect is being investigated.
  attempts     smallint NOT NULL DEFAULT 1,

  -- THE LEASE, and THE CLAIM TOKEN. Together they are what makes a crash
  -- recoverable without making a concurrent duplicate unsafe.
  --
  -- lease_until: a row whose holder has not reported back by this instant may be
  --   re-claimed. Without it a process killed between the claim and the response
  --   (a redeploy is exactly this) would pin its key as permanently in_flight and
  --   the client could never retry that write at all — the failure mode is a
  --   LOST order, which is worse than the duplicate this table exists to stop.
  --   It must be a LEASE and not a backoff, for migration 027's reason.
  -- claim_token: reissued on every claim, so the completion write is a
  --   compare-and-swap against the CURRENT holder. Without it, a slow request
  --   whose lease lapsed and was taken over could still write its own (stale)
  --   response over the winner's, and the client would replay an answer to a
  --   request that was superseded. 027's claimed_by is diagnostic and says so;
  --   this one is a guard, and both halves are checked.
  claim_token  uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_until  timestamptz,

  completed_at timestamptz,
  -- The response to replay, verbatim. Stored rather than recomputed, for exactly
  -- 027's reason: recomputing is not idempotent. The order moves between the
  -- first call and the retry, and a till that receives a DIFFERENT answer to the
  -- same question cannot tell a replay from a second write.
  response_status smallint,
  -- NULL means "no body" (a 204, or a response too large to keep — see
  -- IDEMPOTENCY_MAX_BODY_BYTES). No route in scope calls res.json(null), so the
  -- overload is unambiguous.
  response_body   jsonb,

  -- THE WINDOW, enforced at READ TIME by the claim's takeover predicate and only
  -- swept by the reaper as hygiene — 027's lesson, restated: a guarantee that
  -- depends on a background timer having run is not a guarantee. Set from
  -- IDEMPOTENCY_TTL_SEC (48h default) at claim time, and RE-set on completion so
  -- the window is measured from when the write actually landed.
  expires_at   timestamptz NOT NULL
);

-- THE identity, and the claim's ON CONFLICT target. Every read this table serves
-- goes through it, so there is no second lookup index to keep warm.
CREATE UNIQUE INDEX IF NOT EXISTS idempotencykeys_tenant_key_uidx
  ON "IdempotencyKeys" (res_id, idem_key);

-- The reaper's only read. Bounded to rows that can actually be purged so the
-- sweep never walks the live set.
CREATE INDEX IF NOT EXISTS idempotencykeys_expiry_idx
  ON "IdempotencyKeys" (res_id, expires_at);

-- Fail-closed from the moment it exists, in migration 003's exact policy form.
-- 003 applies RLS by a dynamic loop over information_schema.columns (003:30-45),
-- which does not retro-cover tables created later, so this is not redundant. It
-- matters here for two reasons at once: response_body holds whole API responses
-- (order contents, guest names, table state), and a cross-tenant read of
-- idem_key would let one tenant burn another tenant's keys.
ALTER TABLE "IdempotencyKeys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyKeys" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "IdempotencyKeys";
CREATE POLICY tenant_isolation ON "IdempotencyKeys"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it, so spell the grants out — a migration run under a different owner would
-- otherwise leave the runtime unable to read its own rows. (024's exact guard.)
-- No sequence to grant here: identity is a uuid, deliberately, because nothing
-- about a key store needs a total order.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "IdempotencyKeys" TO app_runtime;
  END IF;
END $$;
