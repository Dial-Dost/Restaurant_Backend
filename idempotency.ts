/**
 * Retry-safe writes — the policy layer over migration 033's "IdempotencyKeys".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Nothing in this API has ever been safe to retry. There is no client_id, no
 * event_id, no idempotency key on any route: every mutating handler applies on
 * arrival. That is fine only while no client ever retries — and it stops being
 * fine the moment an offline outbox replays a queue of writes, because replay IS
 * retry. At-least-once delivery over apply-on-arrival is at-least-once
 * APPLICATION: two dockets, two wastage deductions, two clock-ins.
 *
 * It is already not fine today, just quietly. A POST /orders whose 201 was lost
 * on the way back — Wi-Fi dropped, a redeploy cut the socket, the 15-slot pooler
 * answered 503 after the insert had committed — leaves the till unable to tell
 * "never applied" from "applied, answer lost". Its only choices are to drop the
 * order or to ring it twice.
 *
 * THE CONTRACT
 * ------------
 *   Idempotency-Key: <opaque, client-generated, one per WRITE>
 *
 * Send it and a repeat of that key inside the window returns the ORIGINAL
 * response — same status, same body, plus `Idempotent-Replay: true` — without
 * the handler running again. Omit it and the request takes precisely the path it
 * takes today, down to the number of SQL statements issued (the header read is
 * the first thing this middleware does, and a missing header returns before any
 * work). That asymmetry is the whole safety argument for shipping this to a live
 * POS: a restaurant with a good connection cannot tell it happened.
 *
 * WHY A HEADER AND NOT A BODY FIELD
 * ---------------------------------
 * Four reasons, any one of which would be enough:
 *   1. There are ~119 write call sites in the Flutter client. A header is
 *      stamped ONCE, at the RestClient seam where the read cache and the outbox
 *      already live. A body field would mean touching 119 payload shapes.
 *   2. Half the routes in scope have no body to put it in — DELETE
 *      /orders/:id/items/:itemId, POST /orders/:id/bark, the timing toggles.
 *   3. Several handlers forward the body WHOLESALE to the data layer
 *      (`AddOrder(restaurantId, body)`, and POST /orders/:id/items where the
 *      body IS the item). A body key would have to be stripped per route, and
 *      the first route that forgot would persist it into an order row.
 *   4. It keeps the key out of the request's own fingerprint problem: the thing
 *      being hashed stays exactly the request the client meant to send.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE
 * ---------------------------------
 * Anything that mints a bill or KOT number. "Outlets".bill_seq and
 * AllocateKotNumber are cloud atomic counters behind a gap-free per-outlet GST
 * invoice series, and no key store makes an invoice number safe to allocate
 * offline. routes/bills.ts carries no guard from this file. A settle request is
 * not queueable and must not be queued; if one arrives carrying a key anyway it
 * behaves exactly as it does today, because the key is only ever read by the
 * guard, and the guard is not on that route.
 *
 * THE ADDITIVE RULE, stated once because everything else depends on it
 * -------------------------------------------------------------------
 * The key is never a gate. It cannot make a request succeed that would fail, and
 * it cannot make one fail that would succeed. It is read after the permission
 * guard, so an unauthorised call is refused before a key is ever claimed.
 *
 * THE DEGRADATION RULE
 * --------------------
 * A deployment can reach this code with migration 033 unapplied — the rollout
 * order is migration, then backend, then clients, and orders slip. In that
 * window every "IdempotencyKeys" statement raises 42P01 (or 42501, if the grants
 * half did not run). This FAILS OPEN: the request proceeds unguarded, exactly as
 * it does today, with a loud rate-limited log. Failing closed would refuse
 * writes on a route a waiter needs mid-service to protect against a duplicate
 * that only occurs on retry — trading a certain outage for a possible one. Same
 * single error class as print_jobs.ts, and no other: a constraint violation, a
 * dead connection or a serialisation failure still throws.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "crypto";
import {
  ClaimIdempotencyKey,
  CompleteIdempotencyKey,
  ListRestaurantIds,
  PurgeExpiredIdempotencyKeys,
  ReleaseIdempotencyKey,
  withTenant,
} from "./database_supabase.js";
import { logger } from "./observability.js";

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The header, and the one the reply is marked with. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAY_HEADER = "Idempotent-Replay";

/**
 * THE WINDOW: 48 hours.
 *
 * Long enough for the outage this exists for. A venue that loses its line during
 * Friday dinner service and does not get it back until Saturday evening still
 * has every queued write land exactly once when the outbox drains — the failure
 * mode a shorter window produces is not a lost write, it is a DUPLICATED one,
 * because the client still replays and the server has forgotten why it must not
 * re-apply. So the window has to cover the worst outage anyone will actually sit
 * through, not the typical one.
 *
 * Short enough to bound the table. A busy outlet writes on the order of a couple
 * of thousand keyed requests a day, each row a key, a hash and a small response
 * body, so 48 hours is single-digit thousands of rows per outlet behind one
 * unique index — and every one of them is deleted by expiry, never accumulated.
 *
 * And short enough to be honest about staleness: past two days, replaying a
 * write is arguably the wrong thing to do at all, and the server forgetting is
 * the backstop for a client whose outbox has no TTL of its own.
 */
const TTL_SEC = (): number => envInt("IDEMPOTENCY_TTL_SEC", 48 * 60 * 60);

/**
 * How long a claim is off-limits to a concurrent duplicate.
 *
 * Short on purpose, and the trade is explicit: it only has to outlast one
 * handler's work (all of these are sub-second; the slowest fans out web-push to
 * a party's browsers), and past that a request whose process DIED must lose its
 * key to the retry rather than pin it. Two minutes matches the print queue's
 * lease and is comfortably longer than any request this backend can serve —
 * statement timeouts land far below it — while still freeing a crashed key well
 * inside one outbox retry cycle.
 */
const LEASE_SEC = (): number => envInt("IDEMPOTENCY_LEASE_SEC", 120);

/**
 * Ceiling on a stored response body.
 *
 * Every response in scope is a small object — a created order, a seated party, a
 * stock level. The cap exists so a route added to the guard later cannot turn
 * this table into a copy of the API's whole output. Over the cap the key is
 * still COMPLETED (the write happened; re-applying it is the thing to avoid) but
 * the body is dropped, and the replay carries the original status with an empty
 * body. A client replaying only needs to learn that its write landed; it does
 * not need the payload a second time.
 */
const MAX_BODY_BYTES = (): number => envInt("IDEMPOTENCY_MAX_BODY_BYTES", 1_000_000);

const PURGE_LIMIT = (): number => envInt("IDEMPOTENCY_PURGE_LIMIT", 1000);

/** Bounds on the key itself. Long enough for a uuid or a compound client id,
 *  short enough that the unique index stays small and a hostile caller cannot
 *  push kilobytes into it. */
const KEY_MIN = 8;
const KEY_MAX = 200;
/** Printable ASCII only — the value is echoed into logs and error messages. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

// --- migration-not-applied tolerance ----------------------------------------

/** 42P01 undefined_table, 42501 insufficient_privilege — i.e. migration 033 has
 *  not run, or ran without the app_runtime grants. Nothing else qualifies. */
function isSchemaMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42501";
}

let schemaWarnedAt = 0;
/** Loud, but not once per write: an unmigrated deployment writes all day. */
function warnSchemaMissing(where: string, err: unknown): void {
  const now = Date.now();
  if (now - schemaWarnedAt < 10 * 60_000) { return; }
  schemaWarnedAt = now;
  logger.error(
    { err, where },
    'idempotency is OFF — "IdempotencyKeys" is unreadable (apply migration 033). ' +
      "Writes proceed unguarded: a retried request applies twice.",
  );
}

// --- the fingerprint ---------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, recursively.
 *
 * Two clients (or two builds of one client) can serialise the same order with
 * their map iteration in a different order. Hashing the raw bytes would make
 * that a fingerprint MISMATCH and turn a legitimate replay into a 422, which is
 * a retry the outbox can never win. Arrays keep their order — an item list is
 * not a set.
 *
 * Depth-bounded. A cyclic or absurdly nested body cannot be produced by
 * express.json (JSON has no cycles) but the bound also stops a pathological
 * payload turning this into the request's dominant cost; past it the subtree is
 * hashed by its raw serialisation instead.
 */
/** JSON.stringify's return type is `string`, but its runtime contract is
 *  `string | undefined`. Narrowed once, here, rather than at three call sites. */
function jsonOrNull(value: unknown): string {
  // Typed `unknown` rather than trusting the lib signature: JSON.stringify is
  // declared to return `string`, but it genuinely returns undefined for a
  // function or a symbol, and createHash().update(undefined) throws — a 500 on
  // POST /orders is not an acceptable price for believing a .d.ts.
  const s: unknown = JSON.stringify(value);
  return typeof s === "string" ? s : "null";
}

function canonical(value: unknown, depth = 0): string {
  // JSON.stringify answers `undefined` (not the string "undefined") for
  // undefined, a function or a symbol. express.json can produce none of those,
  // but canonical() is also handed req.body itself, which is undefined on a
  // bodyless DELETE — so the case is real and hashing `undefined` would throw
  // inside createHash.update.
  if (value === undefined) { return "null"; }
  if (value === null || typeof value !== "object") { return jsonOrNull(value); }
  if (depth > 24) { return jsonOrNull(value); }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(",")}}`;
}

/**
 * What "the same request" means, exactly.
 *
 * method + concrete URL (path AND query — `?undo=1` flips the serve toggle into
 * an un-serve, so it is part of the request) + the RESOLVED outlet + the body.
 *
 * The outlet is in here because an admin can move between branches with
 * X-Outlet-Id and the same key must not be answered with another branch's
 * result. The employee is deliberately NOT: a device replaying its own outbox
 * across a shift change is still the same intent, and folding the actor in would
 * turn that into a 422 the client can never resolve.
 */
export function requestFingerprint(req: Request, outletId: string | null): string {
  const body = (req.body === undefined || req.body === null) ? "" : canonical(req.body);
  return createHash("sha256")
    .update(req.method).update("\n")
    .update(req.originalUrl || req.url || "").update("\n")
    .update(outletId ?? "").update("\n")
    .update(body)
    .digest("hex");
}

/** The Express PATTERN this request matched ("POST /orders/:id/status"), for
 *  diagnostics. Falls back to the concrete path if the route layer has not
 *  attached one — still correct, just less groupable. */
function routeKey(req: Request): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  const path = typeof pattern === "string" && pattern.length > 0 ? pattern : req.path;
  return `${req.method} ${path}`;
}

// --- the guard ---------------------------------------------------------------

interface KeyRejection { status: number; body: Record<string, unknown> }

/** Shape check on the client's key. A key we cannot store is worse than no key:
 *  the client believes it is protected and is not, so say so instead. */
function keyRejection(key: string): KeyRejection | null {
  if (key.length < KEY_MIN || key.length > KEY_MAX || !KEY_SHAPE.test(key)) {
    return {
      status: 400,
      body: {
        error: `Idempotency-Key must be ${String(KEY_MIN)}-${String(KEY_MAX)} printable ASCII characters.`,
      },
    };
  }
  return null;
}

/**
 * THE 2xx RULE, and it is the whole of the ordering answer.
 *
 * Only a 2xx is recorded. Everything else RELEASES the key.
 *
 * A rejection is not an application, and treating it as one is how an outbox
 * deadlocks. The outbox replays in the order the writes were made, but nothing
 * guarantees the server SEES them in that order — a retry of an earlier item can
 * land after a later one, and a client that parallelises loses the order
 * outright. So a release-table that arrives before the order it is releasing
 * gets today's 404. If that 404 were cached, the queue entry would be poisoned
 * for the whole 48-hour window and the write would never land. Released, the
 * SAME key succeeds the moment the prerequisite does.
 *
 * The server therefore REJECTS out-of-order arrivals rather than repairing or
 * reordering them, and the rejection is retryable by construction. It does not
 * invent a dependency graph between requests it cannot see, and it does not
 * silently accept a write whose precondition is absent — both of those would
 * decide, on the client's behalf, something only the client knows.
 *
 * The cost of the rule, stated plainly: a handler that half-applied and then
 * answered 400 releases its key and a retry re-runs it. That is exactly what
 * happens today without any key, so this makes such a route no worse — but it
 * does not make it better either, and a route with a non-atomic body should be
 * fixed there rather than papered over here.
 */
async function record(
  resId: string,
  key: string,
  claimToken: string,
  status: number,
  body: unknown,
): Promise<void> {
  if (status < 200 || status >= 300) {
    await ReleaseIdempotencyKey(resId, key, claimToken);
    return;
  }
  let stored: unknown = body ?? null;
  if (stored !== null) {
    const serialized: unknown = JSON.stringify(stored);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES()) {
      // ERROR, not warn: a replay of this key will carry the right status and an
      // EMPTY body, which a client that parses the response as JSON cannot read.
      // The write is still protected from re-application, which is the trade
      // being made — but no route currently in scope returns anything remotely
      // this large, so seeing this line means the guard has been put on a route
      // it was not sized for.
      logger.error({ resId, key, status }, "idempotency_response_too_large — replay will be bodyless");
      stored = null;
    }
  }
  await CompleteIdempotencyKey(
    resId, key, claimToken, status, stored,
    new Date(Date.now() + TTL_SEC() * 1000),
  );
}

/**
 * Wrap the response so the outcome is recorded BEFORE the client can see it.
 *
 * WHY NOT res.on("finish"). index.ts registers `res.once("finish", release)` for
 * the tenant connection when it opens it, and listeners fire in registration
 * order — so by the time a finish handler here ran, the connection carrying
 * app.res_id would already be back in the pool and every statement would fail
 * (or, worse, run under another tenant's GUCs). The record has to be written on
 * the request's own connection, which means before the response goes out.
 *
 * That ordering is also the correct one on its own merits, and it is the same
 * one the print queue uses: persist first, then hand it over. A response that
 * reached the client before its key was recorded is a window in which a retry
 * re-applies the write.
 *
 * Both res.json and res.send are wrapped because express's res.json calls
 * res.send internally — the `settled` latch is what stops that internal call
 * being captured a second time, and it is also what makes a handler that calls
 * res.json twice behave as it does today (the second call falls through to
 * express, which warns about headers already sent).
 *
 * A handler that answers some OTHER way (res.end, an express error handler,
 * a crash) never reaches here, and the key stays in_flight until its LEASE
 * lapses — which is exactly what the lease is for. Nothing is wedged.
 */
function capture(res: Response, resId: string, key: string, claimToken: string): void {
  const realJson = res.json.bind(res);
  const realSend = res.send.bind(res);
  let settled = false;

  // THE CLIENT WENT AWAY BEFORE WE ANSWERED.
  //
  // index.ts releases the tenant connection on BOTH "finish" and "close", and
  // "close" fires the instant an aborted socket dies — which, on a waiter's
  // phone at the edge of the Wi-Fi, is the single most likely way this request
  // ends. By the time the handler then calls res.json, the pooled client bound
  // to this request's AsyncLocalStorage store has been reset and handed to
  // somebody else, and issuing a statement on it would at best be rejected by
  // RLS and at worst land inside another request's open transaction.
  //
  // So when the socket is already gone, nothing is written. This listener is
  // registered AFTER index.ts's release listener and therefore cannot be
  // mistaken for the normal path: finish() below runs before a single byte of
  // the response is emitted, so "close" having already fired can only mean an
  // abort.
  //
  // The cost is bounded and is not a regression: the key stays in_flight, its
  // LEASE lapses within two minutes, and the client's retry re-applies the
  // write — which is precisely what happens today, with no key at all. What we
  // give up is the one case where we could have done better than today.
  //
  // BEST-EFFORT, AND SAYING SO IS THE POINT. A dead socket is discovered on an
  // IO tick, so a handler that answered in the very same tick the connection
  // died can still get past this — which is why the lease, not this check, is
  // what guarantees the key is never wedged. Two signals are read rather than
  // one because they become true at different moments: the event fires once
  // listeners are drained, while res.destroyed flips as soon as the stream is
  // torn down. Real handlers do database work between the abort and their
  // answer, so in practice both have landed by then.
  let socketGone = false;
  res.on("close", () => { socketGone = true; });
  const clientGone = (): boolean =>
    socketGone || res.destroyed || res.socket === null || res.socket.destroyed;

  const finish = (status: number, body: unknown, emit: () => void): Response => {
    settled = true;
    void (async () => {
      if (clientGone()) {
        logger.warn({ resId, key, status }, "idempotency_settle_skipped_client_gone");
        emit();
        return;
      }
      try {
        await record(resId, key, claimToken, status, body);
      } catch (err) {
        if (isSchemaMissing(err)) { warnSchemaMissing("settle", err); }
        // The write already happened; the response MUST still go out. All this
        // costs is that a retry of this key re-applies — i.e. today's behaviour.
        else { logger.error({ err, resId, key, status }, "idempotency_settle_failed"); }
      }
      emit();
    })();
    return res;
  };

  res.json = function patchedJson(body?: unknown): Response {
    if (settled) { return realJson(body); }
    return finish(res.statusCode, body, () => { realJson(body); });
  } as Response["json"];

  res.send = function patchedSend(body?: unknown): Response {
    if (settled) { return realSend(body); }
    // A bodyless send (the 204 on DELETE /orders/:id) records a null body and
    // replays as a bodyless response of the same status.
    return finish(res.statusCode, body === undefined ? null : body, () => { realSend(body); });
  } as Response["send"];
}

/**
 * The claim-and-dispatch half of the guard, split out so idempotent() itself
 * stays synchronous — an express middleware that returns a promise is not
 * awaited by the router, so any throw inside it would become an unhandled
 * rejection rather than a 500. Everything async lives here, behind one void.
 */
async function run(
  req: Request,
  res: Response,
  next: NextFunction,
  key: string,
  resId: string,
  outletId: string | null,
  employeeId: string | null,
): Promise<void> {
  const fingerprint = requestFingerprint(req, outletId);
  const now = Date.now();

  let claim;
  try {
    claim = await ClaimIdempotencyKey(resId, {
      outlet_id: outletId,
      employee_id: employeeId,
      idem_key: key,
      route_key: routeKey(req),
      fingerprint,
      lease_until: new Date(now + LEASE_SEC() * 1000),
      expires_at: new Date(now + TTL_SEC() * 1000),
    });
  } catch (err) {
    if (isSchemaMissing(err)) { warnSchemaMissing("claim", err); next(); return; }
    // A key store that is merely unreachable must not fail a waiter's order.
    // Unguarded is what this route is today; refusing would be a regression.
    logger.error({ err, resId, routeKey: routeKey(req) }, "idempotency_claim_failed");
    next();
    return;
  }

  switch (claim.outcome) {
    case "completed":
      res.setHeader(REPLAY_HEADER, "true");
      if (claim.response_body === null || claim.response_body === undefined) {
        res.status(claim.response_status).end();
      } else {
        res.status(claim.response_status).json(claim.response_body);
      }
      return;

    case "in_flight":
      res.setHeader("Retry-After", "1");
      res.status(409).json({
        error: "A request with this Idempotency-Key is still in progress.",
        retryable: true,
      });
      return;

    case "mismatch":
      res.status(422).json({
        error: "This Idempotency-Key was already used for a different request.",
        details: `First seen on ${claim.route_key}.`,
        retryable: false,
      });
      return;

    case "vanished":
      // The row was purged between the claim and the read-back. Vanishingly
      // rare (see ClaimIdempotencyKey) and not worth a second round trip to
      // resolve: proceed unguarded, which is today's behaviour, and say so.
      logger.warn({ resId, key }, "idempotency_row_vanished — proceeding unguarded");
      next();
      return;

    case "claimed":
      capture(res, resId, key, claim.claim_token);
      next();
      return;
  }
}

/**
 * Registration-position guard, exactly like validateAction / validateBody.
 *
 * Put it AFTER the permission guard on a route, so a caller who may not perform
 * the action is refused before any key is claimed. It is opt-in per route by
 * design: the routes it is on are the ones a waiter performs during service, and
 * the route manifest is therefore the coverage list — adding or removing a guard
 * shows up as a one-line diff in scripts/route_manifest.baseline.txt.
 *
 * WHAT IT DOES, in order:
 *   no header            -> next(), having touched nothing. This is the "no
 *                           behaviour change without a key" guarantee, and it is
 *                           the first branch for exactly that reason.
 *   bad header           -> 400.
 *   no auth / GET / HEAD -> next(). Nothing to scope a key to, or nothing to
 *                           protect.
 *   claimed              -> wrap the response, run the handler.
 *   completed            -> replay the stored response verbatim.
 *   in_flight            -> 409 + Retry-After. NOT a wait: parking a request
 *                           here would hold one of the pooler's 15 session slots
 *                           for the duration of another request, which is how
 *                           the 2026-08-24 standstill happened. The outbox
 *                           retries; the retry gets the replay.
 *   mismatch             -> 422. The key was reused for a different request.
 *   schema missing       -> next(), unguarded, with a rate-limited error log.
 */
export function idempotent(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers[IDEMPOTENCY_HEADER];
    const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    // THE FAST PATH. No key, no work — not a query, not a hash, not a wrapped
    // response object. A request without the header is byte-for-byte the request
    // this route served before this guard existed.
    if (!key) { next(); return; }

    const bad = keyRejection(key);
    if (bad) { res.status(bad.status).json(bad.body); return; }

    const auth = req.auth;
    // Unauthenticated (or a read) — nothing to scope a key to and nothing to
    // make safe. Never an error: the key is additive.
    if (!auth || req.method === "GET" || req.method === "HEAD") { next(); return; }

    void run(req, res, next, key, auth.res_id, auth.outlet_id || null, auth.employeeId || null);
  };
}

// --- reaper ------------------------------------------------------------------

/**
 * Hygiene, on a timer: delete keys past their window.
 *
 * NOT A CORRECTNESS DEPENDENCY, for print_jobs.ts's reason restated — the claim
 * refuses to honour an expired row at READ time, so a database whose sweep never
 * ran still applies every key exactly once. What the sweep buys is a bounded
 * table.
 *
 * Per-tenant withTenant, matching the sweeps in index.ts: there is no leader
 * lock on the tenant pool and none is needed, because the statement is
 * idempotent and two replicas racing it converge.
 */
export async function runIdempotencyReaperSweep(): Promise<void> {
  const tenantIds = await ListRestaurantIds();
  for (const resId of tenantIds) {
    try {
      await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
        const purged = await PurgeExpiredIdempotencyKeys(resId, PURGE_LIMIT());
        if (purged > 0) { logger.info({ resId, purged }, "idempotency_keys_purged"); }
      });
    } catch (err) {
      if (isSchemaMissing(err)) {
        // Same table for every tenant — one failure means all of them.
        warnSchemaMissing("reaper", err);
        return;
      }
      logger.warn({ err, resId }, "idempotency_reaper_tenant_failed");
    }
  }
}
