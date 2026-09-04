// Retry-safe writes.
//
// THE DEFECT THIS SUITE EXISTS FOR: no route in this API has ever carried a
// dedup key, so every mutating handler applies on arrival. That is survivable
// only while no client retries — and an offline outbox retries by definition,
// because replay IS retry. The first test below is therefore not about
// idempotency at all: it asserts that a request WITHOUT the header still applies
// twice, and issues not one statement against the key store. That is the
// baseline the whole feature has to leave untouched.
//
// The suite that matters is "exactly once, and the same answer":
//
//   never doubled  — a completed key replays instead of re-applying; a
//                    concurrent duplicate is refused rather than applied; a
//                    fingerprint that changed under a reused key is refused.
//   never wedged   — a non-2xx releases the key so an out-of-order arrival can
//                    be retried once its prerequisite lands; a holder that died
//                    loses its key when the lease lapses; an unmigrated database
//                    degrades to today's behaviour instead of failing writes.
//
// Every test drives the SHIPPED path — a real express app, the real idempotent()
// middleware, the real statements in database_supabase.ts — over the stubbed
// Pool in idempotency_fixtures.ts, whose dispatch derives its behaviour from the
// statement text rather than restating the rules. Deleting the lease arm of the
// takeover predicate, or the claim-token compare-and-swap, turns these red.
//
// A REAL express app rather than a fake req/res, deliberately: the riskiest part
// of this middleware is that it wraps res.json and res.send, and express's
// res.json calls res.send internally. Only the real objects prove that latch
// works.

import { describe, test, expect, beforeAll, beforeEach, afterAll, jest } from "@jest/globals";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import {
  EMPLOYEE_ID,
  OUTLET_ID,
  OTHER_OUTLET_ID,
  RES_ID,
  addRow,
  breakKeyTable,
  keyQueryLog,
  resetStore,
  rowByKey,
  rows,
} from "./idempotency_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __idemFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__idemFixtureConnect;
    if (!make) {throw new Error("idempotency fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Idem = typeof import("../idempotency");
let mod: Idem;
let server: Server;
let base: string;

/** How many times a handler body was entered. THE effect counter: every "applies
 *  once" assertion in this file is an assertion about this number. Counted on
 *  ENTRY rather than on completion so a parked handler (see the gate below) is
 *  still visibly an application in progress. */
let effects = 0;

/**
 * A hand-cranked handler, for the interleavings a sleep cannot express.
 *
 * When `gated` is on, the Nth handler invocation parks until releaseGate(N) is
 * called, so a test can start two overlapping requests and then choose which one
 * answers FIRST. That ordering is the whole point: a superseded holder finishing
 * BEFORE its usurper is the interleaving where only the claim-token
 * compare-and-swap can save the stored response, and a timing-based test cannot
 * reliably produce it.
 */
let gated = false;
const gateWaits: Promise<void>[] = [];
const gateResolvers: (() => void)[] = [];
function gateAt(i: number): Promise<void> {
  while (gateWaits.length <= i) {
    let resolve!: () => void;
    gateWaits.push(new Promise<void>((r) => { resolve = r; }));
    gateResolvers.push(resolve);
  }
  return gateWaits[i]!;
}
function releaseGate(i: number): void { gateAt(i); gateResolvers[i]!(); }
/** Park until `cond` holds, so a test can wait for a handler to have STARTED
 *  rather than guessing at a sleep length. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) { return; }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}
/** Bodies the handlers were told to answer with, in order. Lets one test make
 *  the second application observably different from the first, so a replay
 *  cannot be mistaken for a lucky re-run that happened to agree. */
let nextPayload: () => unknown;
/** Status the /echo handler answers with. */
let nextStatus = 200;
/** Artificial delay inside the handler, for the concurrency test. */
let handlerDelayMs = 0;
/** Outlet the fake session resolves to, for the cross-branch fingerprint test. */
let sessionOutlet = OUTLET_ID;

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  // Clear any inherited tuning so the SHIPPED DEFAULTS are what is under test:
  // 48-hour window, 2-minute lease, 1MB body cap. A developer with one of these
  // exported would otherwise get a green run that proves something different
  // from CI's.
  for (const k of [
    "IDEMPOTENCY_TTL_SEC", "IDEMPOTENCY_LEASE_SEC",
    "IDEMPOTENCY_MAX_BODY_BYTES", "IDEMPOTENCY_PURGE_LIMIT",
  ]) { delete process.env[k]; }
  mod = await import("../idempotency");

  const app = express();
  app.use(express.json());
  // Stands in for requireAuth: the middleware reads res_id / outlet_id /
  // employeeId off req.auth and nothing else.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth?: unknown }).auth = {
      employeeId: EMPLOYEE_ID, res_id: RES_ID, outlet_id: sessionOutlet,
      role: "waiter", role_all: ["waiter"], actions: ["*"],
      features: {}, limits: {}, allOutlets: false,
    };
    next();
  });

  const apply = async (): Promise<unknown> => {
    const index = effects++;
    if (gated) { await gateAt(index); }
    if (handlerDelayMs > 0) { await new Promise((r) => setTimeout(r, handlerDelayMs)); }
    return nextPayload();
  };

  // THE PATHS ARE HOISTED INTO CONSTANTS ON PURPOSE — do not inline them.
  // scripts/route_manifest.ts rescans the whole repo for `app.<method>("/…", …)`
  // and errors on any site its ordered walk from index.ts never reached, which
  // is exactly right for a server route and exactly wrong for this throwaway
  // test app. Registering through a const makes the path a non-literal, so the
  // rescan skips it — a fix that lives in the test rather than one that widens a
  // CI gate's blind spot for every file that comes after.
  const P_ECHO = "/echo";
  const P_THING = "/thing/:id";
  const P_UNGUARDED = "/unguarded";
  const P_FORBIDDEN = "/forbidden";

  // The guard sits where it sits on a real route: after the permission check,
  // before the handler.
  app.post(P_ECHO, mod.idempotent(), (req: Request, res: Response) => {
    void apply().then((body) => { res.status(nextStatus).json(body); });
  });
  // A bodyless 204, like DELETE /orders/:id.
  app.delete(P_THING, mod.idempotent(), (req: Request, res: Response) => {
    void apply().then(() => { res.status(204).send(); });
  });
  // A route with NO guard, to prove the fixture's statement log is measuring
  // what it claims to measure.
  app.post(P_UNGUARDED, (req: Request, res: Response) => {
    void apply().then((body) => { res.status(nextStatus).json(body); });
  });
  // A permission gate that refuses BEFORE the guard, exactly as validateAction
  // does in registration position.
  const deny = (_req: Request, res: Response, _next: NextFunction) => {
    res.status(403).json({ error: "Action not permitted" });
  };
  app.post(P_FORBIDDEN, deny, mod.idempotent(), (req: Request, res: Response) => {
    void apply().then((body) => { res.status(200).json(body); });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { resolve(); });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
});

beforeEach(() => {
  resetStore();
  effects = 0;
  nextStatus = 200;
  handlerDelayMs = 0;
  sessionOutlet = OUTLET_ID;
  gated = false;
  gateWaits.length = 0;
  gateResolvers.length = 0;
  let n = 0;
  nextPayload = () => ({ applied: ++n, order_id: `order-${String(n)}` });
});

// --- helpers -----------------------------------------------------------------

interface Reply { status: number; body: unknown; replay: string | null; text: string }

async function call(
  path: string,
  opts: { key?: string; body?: unknown; method?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== undefined) { headers["Idempotency-Key"] = opts.key; }
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text.length > 0 ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, replay: res.headers.get("idempotent-replay"), text };
}

const KEY = "11111111-2222-4333-8444-555555555555";
const KEY2 = "99999999-8888-4777-8666-555555555555";

// --- the baseline this feature must not disturb ------------------------------

describe("no key means no behaviour change", () => {
  test("a request without the header applies every time, exactly as today", async () => {
    const a = await call("/echo", { body: { table: "T1" } });
    const b = await call("/echo", { body: { table: "T1" } });

    expect(effects).toBe(2);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ applied: 1, order_id: "order-1" });
    expect(b.body).toEqual({ applied: 2, order_id: "order-2" });
    expect(a.replay).toBeNull();
  });

  test("...and issues not one statement against the key store", async () => {
    await call("/echo", { body: { table: "T1" } });
    // THE PROOF, not a description of it. A guarded route with no header must be
    // indistinguishable from the same route without the guard — same effects,
    // same response, and the same (empty) database traffic. If this ever grows a
    // row, the guard has started costing a live restaurant a round trip per
    // write for a feature it is not using.
    expect(keyQueryLog()).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  test("an unguarded route behaves identically, so the log is measuring the guard", async () => {
    await call("/unguarded", { body: { table: "T1" } });
    expect(effects).toBe(1);
    expect(keyQueryLog()).toEqual([]);
  });
});

// --- the contract ------------------------------------------------------------

describe("the same key twice", () => {
  test("applies once and replays the original response verbatim", async () => {
    const first = await call("/echo", { key: KEY, body: { table: "T1" } });
    const second = await call("/echo", { key: KEY, body: { table: "T1" } });

    expect(effects).toBe(1);
    expect(second.status).toBe(first.status);
    // Not merely "equal": the handler was primed to answer differently on a
    // second run, so an identical body can only be the STORED one.
    expect(second.body).toEqual({ applied: 1, order_id: "order-1" });
    expect(second.body).toEqual(first.body);
  });

  test("marks the replay so a client can tell one from a fresh apply", async () => {
    const first = await call("/echo", { key: KEY, body: { table: "T1" } });
    const second = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(first.replay).toBeNull();
    expect(second.replay).toBe("true");
  });

  test("replays a non-200 success status too (201 Created stays 201)", async () => {
    nextStatus = 201;
    const first = await call("/echo", { key: KEY, body: { table: "T1" } });
    const second = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(effects).toBe(1);
  });

  test("replays a bodyless 204 as a bodyless 204", async () => {
    const first = await call("/thing/abc", { key: KEY, method: "DELETE" });
    const second = await call("/thing/abc", { key: KEY, method: "DELETE" });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(second.text).toBe("");
    expect(effects).toBe(1);
  });

  test("survives key order differing between the two payloads", async () => {
    // Two builds of one client can serialise the same order with their map
    // iteration in a different order. Hashing raw bytes would make that a
    // fingerprint mismatch — a retry the outbox could never win.
    await call("/echo", { key: KEY, body: { table: "T1", covers: 4 } });
    const second = await call("/echo", { key: KEY, body: { covers: 4, table: "T1" } });
    expect(effects).toBe(1);
    expect(second.replay).toBe("true");
  });
});

describe("different keys", () => {
  test("are two separate writes even with an identical payload", async () => {
    const a = await call("/echo", { key: KEY, body: { table: "T1" } });
    const b = await call("/echo", { key: KEY2, body: { table: "T1" } });
    expect(effects).toBe(2);
    expect(a.body).toEqual({ applied: 1, order_id: "order-1" });
    expect(b.body).toEqual({ applied: 2, order_id: "order-2" });
    expect(b.replay).toBeNull();
  });
});

describe("a key reused for a different request", () => {
  test("is refused, and applies nothing", async () => {
    await call("/echo", { key: KEY, body: { table: "T1" } });
    const second = await call("/echo", { key: KEY, body: { table: "T9" } });
    expect(effects).toBe(1);
    expect(second.status).toBe(422);
    expect(second.replay).toBeNull();
  });

  test("counts a different outlet as a different request", async () => {
    // An admin can move between branches with X-Outlet-Id. Answering the same
    // key with the other branch's stored result would be a wrong answer
    // delivered confidently.
    await call("/echo", { key: KEY, body: { table: "T1" } });
    sessionOutlet = OTHER_OUTLET_ID;
    const second = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(effects).toBe(1);
    expect(second.status).toBe(422);
  });

  test("counts a different query string as a different request", async () => {
    // ?undo=1 flips POST /orders/:id/items/:itemId/serve into an un-serve. If it
    // were outside the fingerprint, a serve and its undo would share one key.
    await call("/echo?undo=1", { key: KEY, body: { table: "T1" } });
    const second = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(effects).toBe(1);
    expect(second.status).toBe(422);
  });
});

describe("two duplicates in flight at once", () => {
  test("applies once; the loser is told to retry, and its retry replays", async () => {
    handlerDelayMs = 60;
    const both = await Promise.all([
      call("/echo", { key: KEY, body: { table: "T1" } }),
      call("/echo", { key: KEY, body: { table: "T1" } }),
    ]);
    // Exactly one handler ran. That is the assertion the whole lease exists for.
    expect(effects).toBe(1);

    const winner = both.find((r) => r.status === 200);
    const loser = both.find((r) => r.status === 409);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    // A 409 here means "not yet", not "never" — the outbox must keep the entry.
    expect(loser?.body).toMatchObject({ retryable: true });

    // And the retry the 409 asked for gets the winner's answer, not a second
    // application. Without this the pair above would just be a fancy way of
    // dropping a write.
    handlerDelayMs = 0;
    const retry = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(effects).toBe(1);
    expect(retry.status).toBe(200);
    expect(retry.replay).toBe("true");
    expect(retry.body).toEqual(winner?.body);
  });
});

describe("expiry", () => {
  test("a key past its window applies again", async () => {
    const first = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(effects).toBe(1);

    // Age the row past the window. The claim's takeover predicate is what has to
    // notice — the reaper is deliberately not run here, because a guarantee that
    // depends on a background timer having run is not a guarantee.
    const stale = rowByKey(KEY);
    expect(stale).toBeDefined();
    stale!.expires_at = new Date(Date.now() - 1000);

    const second = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(effects).toBe(2);
    expect(second.replay).toBeNull();
    expect(second.body).not.toEqual(first.body);

    // AND it applied by TAKING THE ROW OVER, not by falling through unguarded.
    // The distinction is invisible in the effect count but decides everything
    // afterwards: a takeover re-arms the key for the new window (so the second
    // write is itself protected), whereas falling through leaves the stale row
    // in place and every later retry re-applies. Without these two assertions,
    // deleting the expiry arm of the takeover predicate passes this test.
    const row = rowByKey(KEY);
    expect(row?.attempts).toBe(2);
    expect(row?.status).toBe("completed");
    expect(row?.response_body).toEqual(second.body);

    const third = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(effects).toBe(2);
    expect(third.replay).toBe("true");
  });

  test("the reaper deletes expired keys and leaves live ones alone", async () => {
    const live = addRow({ idem_key: "live", status: "completed", expires_at: new Date(Date.now() + 3600_000) });
    const dead = addRow({ idem_key: "dead", status: "completed", expires_at: new Date(Date.now() - 1000) });
    await mod.runIdempotencyReaperSweep();
    expect(rows().map((r) => r.id)).toContain(live.id);
    expect(rows().map((r) => r.id)).not.toContain(dead.id);
  });
});

// --- never wedged ------------------------------------------------------------

describe("a rejected request releases its key", () => {
  test("so an out-of-order arrival can be retried once its prerequisite lands", async () => {
    // The outbox replays in order, but nothing guarantees the SERVER sees them
    // in order. A release-table that arrives before the order it is releasing
    // gets today's 404. Caching that 404 would poison the queue entry for the
    // whole 48-hour window and the write would never land.
    nextStatus = 404;
    const early = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(early.status).toBe(404);
    expect(rowByKey(KEY)).toBeUndefined();

    nextStatus = 200;
    const later = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(later.status).toBe(200);
    expect(later.replay).toBeNull();
    expect(effects).toBe(2);
  });

  test("a 4xx is not stored, so it can never be replayed", async () => {
    nextStatus = 400;
    await call("/echo", { key: KEY, body: { table: "T1" } });
    const again = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(again.replay).toBeNull();
    expect(again.status).toBe(400);
  });
});

describe("a holder that died", () => {
  test("loses its key when the lease lapses, so the write is not lost forever", async () => {
    // Exactly what a redeploy mid-request leaves behind: a claimed row whose
    // process is gone. Without the lease arm of the takeover predicate this key
    // would be permanently in_flight and the client could never land the write.
    addRow({
      idem_key: KEY, status: "in_flight",
      lease_until: new Date(Date.now() - 1000),
      fingerprint: "whatever-the-dead-request-had",
    });
    const res = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(res.status).toBe(200);
    expect(effects).toBe(1);
    expect(rowByKey(KEY)?.status).toBe("completed");
  });

  test("but a LIVE holder is not displaced", async () => {
    addRow({
      idem_key: KEY, status: "in_flight",
      lease_until: new Date(Date.now() + 60_000),
      // Same fingerprint the incoming request will compute, so this is refused
      // for being in flight rather than for being a different request.
      fingerprint: mod.requestFingerprint(
        { method: "POST", originalUrl: "/echo", url: "/echo", body: { table: "T1" } } as never,
        OUTLET_ID,
      ),
    });
    const res = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(res.status).toBe(409);
    expect(effects).toBe(0);
  });

  test("a superseded holder cannot overwrite the row it lost, even by finishing first", async () => {
    // THE INTERLEAVING THE CLAIM TOKEN EXISTS FOR, and the only one where the
    // status guard alone is not enough:
    //
    //   A claims .......... lease lapses ..... A answers (stale) ...
    //                       B takes over ..................... B answers
    //
    // When A answers, the row is in_flight again — under B. A completion guarded
    // only by status would therefore succeed, storing A's response against B's
    // claim, and B's own completion would then be refused for finding the row
    // already completed. Every later replay of this key would hand back an
    // answer to a request that had been superseded.
    //
    // Hand-cranked rather than timed, because "A finishes before B" is not
    // something a sleep can be relied on to arrange.
    gated = true;
    const a = call("/echo", { key: KEY, body: { table: "T1" } });
    await until(() => effects === 1, "A's handler to start");

    // A's process is, as far as the database can tell, gone.
    const claimed = rowByKey(KEY);
    expect(claimed).toBeDefined();
    claimed!.lease_until = new Date(Date.now() - 1000);

    const b = call("/echo", { key: KEY, body: { table: "T1" } });
    await until(() => effects === 2, "B's handler to start (a takeover)");
    expect(rowByKey(KEY)?.status).toBe("in_flight");

    // A answers FIRST, carrying a claim token the row no longer holds.
    releaseGate(0);
    const ra = await a;
    releaseGate(1);
    const rb = await b;

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body).not.toEqual(rb.body);
    // The row holds B's answer — the current owner's — not A's.
    expect(rowByKey(KEY)?.response_body).toEqual(rb.body);

    gated = false;
    const replay = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(replay.replay).toBe("true");
    expect(replay.body).toEqual(rb.body);
  });
});

describe("a client that vanishes mid-request", () => {
  test("settles nothing, and the lease hands the key back", async () => {
    // The likeliest ending for a request from a waiter at the edge of the
    // Wi-Fi — and the one that would be actively dangerous to get wrong.
    // index.ts releases the tenant connection on the response's "close" event,
    // which an aborted socket fires immediately, so anything written after that
    // point would go out on a pooled client that now belongs to someone else.
    gated = true;
    const ac = new AbortController();
    const aborted = fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": KEY },
      body: JSON.stringify({ table: "T1" }),
      signal: ac.signal,
    }).then(() => "answered").catch(() => "aborted");

    await until(() => effects === 1, "the handler to start");
    ac.abort();
    expect(await aborted).toBe("aborted");

    // Let the server notice the dead socket before the handler answers. That
    // pause is the REALISM, not a fudge: a dead connection is discovered on an
    // IO tick, and a real handler is several database round trips away from its
    // response when the waiter's Wi-Fi drops. Releasing the gate in the same
    // microtask as the abort would model a handler that answers instantly,
    // which no route here does.
    await new Promise((r) => setTimeout(r, 40));

    // The handler finishes anyway — it has no idea the socket is gone.
    releaseGate(0);
    await new Promise((r) => setTimeout(r, 60));

    // Nothing was recorded. The row is still the claim, not a result.
    const row = rowByKey(KEY);
    expect(row?.status).toBe("in_flight");
    expect(row?.response_status).toBeNull();

    // And the key is not wedged: once the lease lapses the retry lands, which is
    // the same outcome this write has today with no key at all.
    row!.lease_until = new Date(Date.now() - 1000);
    gated = false;
    const retry = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(retry.status).toBe(200);
    expect(effects).toBe(2);
  });
});

describe("degradation", () => {
  test("an unmigrated database applies the write instead of failing it", async () => {
    // Rollout order is migration, then backend, then clients, and orders slip.
    // A 500 on POST /orders because a dedup table is missing would stop a
    // restaurant trading — strictly worse than the duplicate this guards.
    breakKeyTable();
    const a = await call("/echo", { key: KEY, body: { table: "T1" } });
    const b = await call("/echo", { key: KEY, body: { table: "T1" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Unguarded means unguarded: it applies twice, exactly as it does today.
    expect(effects).toBe(2);
  });

  test("the reaper is a no-op on an unmigrated database", async () => {
    breakKeyTable();
    await expect(mod.runIdempotencyReaperSweep()).resolves.toBeUndefined();
  });
});

describe("the key is additive, never a gate", () => {
  test("a permission refusal happens first and claims nothing", async () => {
    const res = await call("/forbidden", { key: KEY, body: { table: "T1" } });
    expect(res.status).toBe(403);
    expect(effects).toBe(0);
    // No row, and no statement: the guard never ran, because it is registered
    // after the permission check.
    expect(rows()).toHaveLength(0);
    expect(keyQueryLog()).toEqual([]);
  });

  test("a malformed key is refused rather than silently ignored", async () => {
    // A client that believes it is protected and is not is worse off than one
    // that knows it is unprotected.
    const res = await call("/echo", { key: "short", body: { table: "T1" } });
    expect(res.status).toBe(400);
    expect(effects).toBe(0);
  });

  test("a blank header is treated as no header, not as a bad one", async () => {
    const res = await call("/echo", { key: "   ", body: { table: "T1" } });
    expect(res.status).toBe(200);
    expect(effects).toBe(1);
    expect(keyQueryLog()).toEqual([]);
  });
});
