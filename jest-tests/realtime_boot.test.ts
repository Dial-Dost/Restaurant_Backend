// BOOT MUST NOT WAIT ON A CACHE.
//
// initRealtime builds a node-redis client when REDIS_URL is set and awaits its
// connect(). node-redis's DEFAULT RECONNECT STRATEGY RETRIES FOREVER, so against
// an address with nothing behind it that promise never settles — and it never
// rejects either, which made the catch written to degrade to single-replica
// unreachable. Since the whole boot sequence awaits initRealtime, a Redis that
// was down, wrong or firewalled did not cost the adapter. It cost the server.
//
// Nobody had hit it because REDIS_URL had only ever been set where a Redis
// really was. It surfaced when the print-routing suite became the first thing in
// CI to call initRealtime at all, on a runner whose REDIS_URL points at a
// service its own workflow never declares: the step hung for thirty-three
// minutes against seventy-five seconds locally.
//
// This pins the fix in the only terms that matter operationally — initRealtime
// RETURNS, and it returns without an adapter — rather than asserting on a
// timeout value somebody will later tune.
import { describe, test, expect, beforeAll, afterEach, jest } from "@jest/globals";

jest.mock("socket.io", () => ({
  Server: class {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    on(): void {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    use(): void {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    adapter(): void {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    to(): { emit: () => void } { return { emit: (): void => {} }; }
  },
}));

type Realtime = typeof import("../realtime");
let realtime: Realtime;

const ORIGINAL = process.env.REDIS_URL;

beforeAll(async () => {
  // realtime.ts pulls in the data layer transitively, which refuses to load
  // without a connection string. Never dialled here — nothing in this file
  // touches the database — but it has to parse.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  realtime = await import("../realtime");
});

afterEach(() => {
  if (ORIGINAL === undefined) { delete process.env.REDIS_URL; }
  else { process.env.REDIS_URL = ORIGINAL; }
  delete process.env.REDIS_CONNECT_TIMEOUT_MS;
});

describe("initRealtime and an unreachable Redis", () => {
  test("returns instead of hanging, and says it has no adapter", async () => {
    // A port nothing is listening on. Deliberately NOT a hostname that fails to
    // resolve: DNS failure is the easy case and fails fast on its own. A refused
    // or silently dropped TCP connection is the one that retries forever, and it
    // is what a wedged Redis, a firewall rule or a wrong port actually look like.
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    process.env.REDIS_CONNECT_TIMEOUT_MS = "1000";

    const started = Date.now();
    await realtime.initRealtime({} as unknown as Parameters<Realtime["initRealtime"]>[0]);
    const took = Date.now() - started;

    // The property is that it CAME BACK. The bound is loose on purpose: this
    // test must fail when boot hangs, not when a CI runner is slow.
    expect(took).toBeLessThan(20_000);
    // …and it came back honest. Something later decides whether to trust
    // cross-replica delivery on the strength of this.
    expect(realtime.realtimeAdapterReady()).toBe(false);
  }, 30_000);

  test("with no REDIS_URL it does not try at all", async () => {
    delete process.env.REDIS_URL;
    await realtime.initRealtime({} as unknown as Parameters<Realtime["initRealtime"]>[0]);
    expect(realtime.realtimeAdapterReady()).toBe(false);
  });
});
