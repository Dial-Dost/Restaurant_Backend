// ADVERSARIAL VERIFICATION — written by the reviewer, not the author.
//
// Drives the SHIPPED path (real express + real idempotent() + the real
// statements in database_supabase.ts) over the same stubbed Pool the author's
// suite uses, but asks the questions the author did not:
//
//   * can a settle be smuggled through a guard that is not on its route?
//   * what EXACTLY happens when the process dies after the effect committed but
//     before the key did — the one window where "exactly once" can break?
//   * five concurrent duplicates, not two.
//   * does a handler that THROWS wedge the key for the whole lease?
//   * is a no-key request really statement-for-statement identical?

import { describe, test, expect, beforeAll, beforeEach, afterAll, jest } from "@jest/globals";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import {
  EMPLOYEE_ID, OUTLET_ID, RES_ID,
  addRow, keyQueryLog, resetStore, rowByKey, rows,
} from "./idempotency_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __idemFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__idemFixtureConnect;
    if (!make) { throw new Error("fixture harness not loaded"); }
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

/** THE EFFECT COUNTER. Every "applied once" claim is a claim about this. */
let effects = 0;
let nextStatus = 200;
let handlerDelayMs = 0;
/** When true the handler applies its effect and then NEVER answers — a process
 *  that died between the write committing and the response being produced. */
let dieAfterEffect = false;
/** When true the handler applies its effect and then throws. */
let throwAfterEffect = false;
let nextPayload: () => unknown;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  for (const k of ["IDEMPOTENCY_TTL_SEC", "IDEMPOTENCY_LEASE_SEC",
    "IDEMPOTENCY_MAX_BODY_BYTES", "IDEMPOTENCY_PURGE_LIMIT"]) { delete process.env[k]; }
  mod = await import("../idempotency");

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth?: unknown }).auth = {
      employeeId: EMPLOYEE_ID, res_id: RES_ID, outlet_id: OUTLET_ID,
      role: "waiter", role_all: ["waiter"], actions: ["*"],
      features: {}, limits: {}, allOutlets: false,
    };
    next();
  });

  const apply = async (): Promise<unknown> => {
    effects++;
    if (handlerDelayMs > 0) { await new Promise((r) => setTimeout(r, handlerDelayMs)); }
    return nextPayload();
  };

  // Non-literal paths so scripts/route_manifest.ts's repo rescan skips them.
  const P_ORDER = "/fake-orders";
  const P_SETTLE = "/fake-bills/settle";

  // A guarded write, standing in for POST /orders.
  app.post(P_ORDER, mod.idempotent(), async (req: Request, res: Response) => {
    const body = await apply();
    if (dieAfterEffect) { return; }            // effect committed, no answer ever
    // Thrown, NOT caught here — express 5 forwards it to the terminal handler
    // below, exactly as a real route's uncaught rejection is forwarded.
    if (throwAfterEffect) { throw new Error("boom"); }
    res.status(nextStatus).json(body);
  });

  // A settlement route, registered with NO guard — exactly as routes/bills.ts is.
  app.post(P_SETTLE, (req: Request, res: Response) => {
    void apply().then((body) => { res.status(nextStatus).json(body); });
  });

  // THE PRODUCTION TERMINAL ERROR HANDLER, copied in shape from index.ts:456.
  // It matters that this answers through res.status().json() — the WRAPPED
  // method — because that is what lets a thrown handler release its key instead
  // of wedging it for the whole lease.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { return; }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  await new Promise<void>((resolve) => { server = app.listen(0, () => { resolve(); }); });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
});

beforeEach(() => {
  resetStore();
  effects = 0; nextStatus = 200; handlerDelayMs = 0;
  dieAfterEffect = false; throwAfterEffect = false;
  let n = 0;
  nextPayload = () => ({ applied: ++n, order_id: `order-${String(n)}` });
});

interface Res { status: number; body: any; replay: string | null }
/** Every request carries an abort deadline: one test deliberately leaves a
 *  handler that never answers, and an un-abortable fetch would hang teardown. */
async function post(
  path: string, key: string | null, body: unknown = { table: "T1" }, timeoutMs = 2000,
): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) { headers["Idempotency-Key"] = key; }
  const ac = new AbortController();
  const t = setTimeout(() => { ac.abort(); }, timeoutMs);
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ac.signal,
    });
    const text = await r.text();
    return {
      status: r.status,
      body: text ? JSON.parse(text) : null,
      replay: r.headers.get("Idempotent-Replay"),
    };
  } finally { clearTimeout(t); }
}

// =============================================================================
describe("PRIME DIRECTIVE — a request with no key is untouched", () => {
  test("no header: two identical posts apply TWICE and issue ZERO key statements", async () => {
    const a = await post("/fake-orders", null);
    const b = await post("/fake-orders", null);
    expect(effects).toBe(2);                    // today's behaviour, preserved
    expect(a.body).toEqual({ applied: 1, order_id: "order-1" });
    expect(b.body).toEqual({ applied: 2, order_id: "order-2" });
    expect(a.replay).toBeNull();
    expect(b.replay).toBeNull();
    expect(keyQueryLog()).toEqual([]);          // not one statement
    expect(rows()).toEqual([]);                 // not one row
  });
});

// =============================================================================
describe("EXACTLY ONCE", () => {
  test("same key twice, sequentially: ONE effect, the FIRST answer replayed verbatim", async () => {
    const a = await post("/fake-orders", "key-sequential-01");
    const b = await post("/fake-orders", "key-sequential-01");
    expect(effects).toBe(1);
    expect(b.body).toEqual(a.body);
    expect(b.body).toEqual({ applied: 1, order_id: "order-1" });
    expect(b.replay).toBe("true");
    expect(rows()).toHaveLength(1);
  });

  test("FIVE concurrent duplicates: exactly ONE effect, nothing else applied", async () => {
    handlerDelayMs = 60;
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => post("/fake-orders", "key-concurrent-01")));
    expect(effects).toBe(1);
    const ok = all.filter((r) => r.status === 200);
    const busy = all.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(4);
    for (const r of busy) { expect(r.body.retryable).toBe(true); }
    // and the loser's retry gets the winner's answer, not a second order
    const late = await post("/fake-orders", "key-concurrent-01");
    expect(effects).toBe(1);
    expect(late.body).toEqual(ok[0]!.body);
    expect(late.replay).toBe("true");
  });

  test("key reused with a DIFFERENT body is refused, and the first effect is undisturbed", async () => {
    const a = await post("/fake-orders", "key-mismatch-001", { table: "T1" });
    const b = await post("/fake-orders", "key-mismatch-001", { table: "T9" });
    expect(b.status).toBe(422);
    expect(b.body.retryable).toBe(false);
    expect(effects).toBe(1);
    const again = await post("/fake-orders", "key-mismatch-001", { table: "T1" });
    expect(again.body).toEqual(a.body);   // original still replayable
    expect(effects).toBe(1);
  });
});

// =============================================================================
describe("CRASH MID-REQUEST — the one window where exactly-once can break", () => {
  test("effect committed but key never completed: a retry UNDER THE LEASE is refused, not doubled", async () => {
    dieAfterEffect = true;
    // The handler applies its effect and never answers. The client gives up.
    await post("/fake-orders", "key-crashwindow-1", { table: "T1" }, 250)
      .then(() => { throw new Error("expected no answer"); })
      .catch((e: Error) => { expect(e.name).toBe("AbortError"); });
    expect(effects).toBe(1);
    const row = rowByKey("key-crashwindow-1");
    expect(row?.status).toBe("in_flight");           // key never completed
    expect(row?.lease_until).not.toBeNull();

    dieAfterEffect = false;
    const retry = await post("/fake-orders", "key-crashwindow-1");
    expect(retry.status).toBe(409);                  // held off by the live lease
    expect(effects).toBe(1);                         // NOT doubled
  });

  test("MEASURED, NOT ASSUMED: once the lease lapses the same key RE-APPLIES", async () => {
    // Seed the state a killed process leaves behind: the effect landed, the key
    // is in_flight, and its lease is in the past.
    addRow({
      idem_key: "key-deadlease-01", status: "in_flight",
      lease_until: new Date(Date.now() - 1000),
      expires_at: new Date(Date.now() + 3600_000),
    });
    const r = await post("/fake-orders", "key-deadlease-01");
    expect(r.status).toBe(200);
    expect(effects).toBe(1);       // the handler ran again
    expect(rowByKey("key-deadlease-01")?.attempts).toBe(2);
    // This is the documented trade: the lease exists so a killed process cannot
    // pin a key forever (a LOST order). The cost is that a crash in the window
    // between effect-commit and key-commit degrades to at-least-once, which is
    // exactly today's behaviour and no worse.
  });
});

// =============================================================================
describe("SETTLEMENT CANNOT BE SMUGGLED", () => {
  test("a key sent to an UNGUARDED settle route is inert — no row, no statement, applies twice", async () => {
    const a = await post("/fake-bills/settle", "key-settlement-01");
    const b = await post("/fake-bills/settle", "key-settlement-01");
    expect(effects).toBe(2);              // no dedup, because no guard
    expect(a.replay).toBeNull();
    expect(b.replay).toBeNull();
    expect(keyQueryLog()).toEqual([]);
    expect(rows()).toEqual([]);
  });
});

// =============================================================================
describe("ORDERING — a rejection must stay retryable", () => {
  test("a 404 releases the key so the SAME key succeeds once the prerequisite lands", async () => {
    nextStatus = 404;
    const early = await post("/fake-orders", "key-outoforder-1");
    expect(early.status).toBe(404);
    expect(rows()).toHaveLength(0);            // released, not cached

    nextStatus = 200;
    const later = await post("/fake-orders", "key-outoforder-1");
    expect(later.status).toBe(200);
    expect(effects).toBe(2);                   // rejected once, applied once
    expect(rows()).toHaveLength(1);
  });

  test("a 4xx is never cached: replaying it does not return a stored rejection", async () => {
    nextStatus = 400;
    const a = await post("/fake-orders", "key-fourhundred1");
    expect(a.status).toBe(400);
    expect(a.replay).toBeNull();
    const b = await post("/fake-orders", "key-fourhundred1");
    expect(b.replay).toBeNull();               // ran again, not replayed
    expect(effects).toBe(2);
  });
});

// =============================================================================
describe("A HANDLER THAT THROWS", () => {
  test("an uncaught throw 500s through the terminal handler and RELEASES the key", async () => {
    throwAfterEffect = true;
    const a = await post("/fake-orders", "key-throwing-001");
    expect(a.status).toBe(500);
    expect(effects).toBe(1);
    // The terminal handler answers via the WRAPPED res.json, so record() sees a
    // non-2xx and deletes the row. Nothing is wedged.
    expect(rowByKey("key-throwing-001")).toBeUndefined();
    expect(rows()).toHaveLength(0);

    // CONSEQUENCE, and it is the right one: the client may retry immediately —
    // no 120-second lease wait — and the retry applies.
    throwAfterEffect = false;
    const retry = await post("/fake-orders", "key-throwing-001");
    expect(retry.status).toBe(200);
    expect(effects).toBe(2);
  });
});
