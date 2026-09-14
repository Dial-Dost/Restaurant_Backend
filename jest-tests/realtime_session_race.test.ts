// A JOIN SENT BEFORE THE SESSION IS KNOWN MUST STILL BE HEARD.
//
// The defect. initRealtime's connection handler was `async`: it awaited
// getSession(token) and only then attached its listeners. Socket.IO sends CONNECT
// before 'connection' handlers run and dispatches incoming events with no
// buffering, and the printer agent emits joinOutlet the instant it sees CONNECT.
// Whenever the store round trip was slower than the client's — a cold Redis after
// a deploy, an event loop busy with a fleet-wide reconnect — the join reached a
// socket with no listener and was silently dropped: no room, no replay, no
// answer. The till showed "Connected" and printed nothing until somebody closed
// and reopened the app. Reproduced on loopback with the backend's own socket.io:
// 4/15 joins survived a one-tick lookup, 0/15 a 20ms one.
//
// And its twin. A socket whose session was dead got silence, which to the agent
// is indistinguishable from a slow server, so it never told anybody to sign in.
//
// What is pinned here, driven through the SHIPPED handler over a fake socket.io:
//
//   * joinOutlet emitted before the lookup resolves joins the outlet room, is
//     answered with joinedOutlet and schedules the replay;
//   * a dead session is answered with joinRejected {reason:'session_invalid'} and
//     is NOT disconnected (the Dart client never reconnects after a server-side
//     disconnect, so that would turn a sign-in prompt into a till offline for good);
//   * a store ERROR is never reported as a rejection (the app signs its user out
//     on that word), and it is retried rather than leaving the socket deaf;
//   * the restaurant room — what every KDS, order screen and dashboard socket
//     depends on — is joined on exactly the condition it always was;
//   * events queued behind the lookup are applied in the order they arrived;
//   * one store read per connection, however many events wait on it;
//   * joins repeated on one connection share one replay transaction per outlet,
//     while every one of them is still answered.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";

type Listener = (payload?: unknown) => void;

interface Emitted { event: string; payload: unknown }

class FakeSocket {
  static seq = 0;
  readonly id = `sock-${String(++FakeSocket.seq)}`;
  readonly handshake: { auth: Record<string, unknown> };
  readonly data: Record<string, unknown> = {};
  readonly rooms = new Set<string>();
  readonly emitted: Emitted[] = [];
  connected = true;
  disconnectCalls = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(auth: Record<string, unknown>) { this.handshake = { auth }; }

  on(event: string, fn: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  join(room: string): void { this.rooms.add(room); }
  leave(room: string): void { this.rooms.delete(room); }
  disconnect(): this { this.disconnectCalls++; this.connected = false; return this; }

  /** A packet from the client. */
  fire(event: string, payload?: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) { fn(payload); }
  }
  listenerCount(event: string): number { return (this.listeners.get(event) ?? []).length; }
  emitsOf(event: string): Emitted[] { return this.emitted.filter((e) => e.event === event); }
}

const harness: { connection: ((socket: FakeSocket) => unknown) | null } = { connection: null };
(globalThis as unknown as { __realtimeRaceHarness: typeof harness }).__realtimeRaceHarness = harness;

jest.mock("socket.io", () => ({
  Server: class {
    on(event: string, fn: (socket: unknown) => unknown): void {
      if (event === "connection") {
        (globalThis as unknown as { __realtimeRaceHarness: { connection: unknown } }).__realtimeRaceHarness.connection = fn;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    use(): void {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    adapter(): void {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    to(): { emit: () => void } { return { emit: (): void => {} }; }
  },
}));

jest.mock("../auth/sessions", () => ({ getSession: jest.fn() }));

jest.mock("../print_jobs", () => ({
  resumeJitterMs: (): number => 0,
  resumePrintJobsForAgent: jest.fn(() => Promise.resolve(0)),
}));

// Never dialled — joinOutlet without a deviceId touches no table — but
// realtime.ts imports it statically and the real module refuses to load without
// a connection string and a pool.
jest.mock("../database_supabase", () => ({
  GetPrintDeviceTargets: jest.fn(),
  ListPrintDevices: jest.fn(),
  withTenant: jest.fn(),
}));

type Realtime = typeof import("../realtime");
type Sessions = typeof import("../auth/sessions");
type PrintJobs = typeof import("../print_jobs");

let getSession: jest.MockedFunction<Sessions["getSession"]>;
let resume: jest.MockedFunction<PrintJobs["resumePrintJobsForAgent"]>;

const RES_ID = "res-1";
const OUTLET_ID = "0b9f1d9e-7c4b-4a3e-9f57-1f6c2f0a8d11";
const OUTLET_ROOM = `restaurant:${RES_ID}:outlet:${OUTLET_ID}`;
const RESTAURANT_ROOM = `restaurant:${RES_ID}`;

const SESSION = {
  employeeId: "emp-1",
  res_id: RES_ID,
  outlet_id: OUTLET_ID,
  role: "admin",
  role_all: ["admin"],
  actions: ["*"],
  features: {},
  limits: {},
  action_names: [],
  emp_Fname: "Till",
  emp_Lname: null,
  employeeUsername: "till",
  restaurantUsername: "gaia",
  restaurantName: "Gaia",
};

const JOIN = { restaurantId: RES_ID, outletId: OUTLET_ID, agentVersion: "flutter-owner/1.9.8" };

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Drain the microtask queue. No real timers are involved in a lookup. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) { await Promise.resolve(); }
}

function connect(auth: Record<string, unknown> = { token: "TOKEN_B", restaurantId: RES_ID }): FakeSocket {
  const socket = new FakeSocket(auth);
  if (!harness.connection) { throw new Error("initRealtime did not register a connection handler"); }
  void harness.connection(socket);
  return socket;
}

beforeAll(async () => {
  delete process.env.REDIS_URL;
  const realtime: Realtime = await import("../realtime");
  getSession = (await import("../auth/sessions")).getSession as jest.MockedFunction<Sessions["getSession"]>;
  resume = (await import("../print_jobs")).resumePrintJobsForAgent as jest.MockedFunction<PrintJobs["resumePrintJobsForAgent"]>;
  await realtime.initRealtime({} as unknown as Parameters<Realtime["initRealtime"]>[0]);
});

beforeEach(() => {
  jest.useFakeTimers();
  getSession.mockReset();
  resume.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("a join that arrives before the session lookup resolves", () => {
  test("is still handled: outlet room, joinedOutlet, replay scheduled", async () => {
    const lookup = deferred<typeof SESSION | null>();
    getSession.mockReturnValueOnce(lookup.promise);

    const socket = connect();
    // Every listener exists the moment the handler returns — that is the fix.
    expect(socket.listenerCount("joinOutlet")).toBe(1);

    // The agent's first packet, sent the instant it saw CONNECT.
    socket.fire("joinOutlet", JOIN);
    await flush();
    expect(socket.rooms.size).toBe(0);
    expect(socket.emitsOf("joinedOutlet")).toHaveLength(0);

    lookup.resolve(SESSION);
    await flush();

    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(true);
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(true);
    expect(socket.emitsOf("joinedOutlet")).toEqual([
      { event: "joinedOutlet", payload: { restaurantId: RES_ID, outletId: OUTLET_ID } },
    ]);
    expect(socket.emitsOf("joinRejected")).toHaveLength(0);

    jest.runOnlyPendingTimers();
    expect(resume).toHaveBeenCalledTimes(1);
    const req = resume.mock.calls[0][0];
    expect(req.resId).toBe(RES_ID);
    expect(req.outletId).toBe(OUTLET_ID);
    expect(req.agentId).toBe(socket.id);
    expect(req.agentVersion).toBe("flutter-owner/1.9.8");
    expect(req.employeeId).toBe("emp-1");
    expect(req.role).toBe("admin");
  });

  test("the tenant comes from the session, never from the payload", async () => {
    getSession.mockResolvedValueOnce(SESSION);
    const socket = connect({ token: "TOKEN_B", restaurantId: "someone-else" });
    socket.fire("joinOutlet", { ...JOIN, restaurantId: "someone-else" });
    await flush();
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(true);
    expect([...socket.rooms].some((r) => r.includes("someone-else"))).toBe(false);
  });

  test("one store read per connection, however many events wait on it", async () => {
    const lookup = deferred<typeof SESSION | null>();
    getSession.mockReturnValueOnce(lookup.promise);
    const socket = connect();
    socket.fire("join", RES_ID);
    socket.fire("joinOutlet", JOIN);
    socket.fire("joinOutlet", JOIN);
    lookup.resolve(SESSION);
    await flush();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(socket.emitsOf("joinedOutlet")).toHaveLength(2);
  });

  test("queued events are applied in the order they arrived", async () => {
    const lookup = deferred<typeof SESSION | null>();
    getSession.mockReturnValueOnce(lookup.promise);
    const socket = connect();
    socket.fire("joinOutlet", JOIN);
    socket.fire("leaveOutlet", { outletId: OUTLET_ID });
    lookup.resolve(SESSION);
    await flush();
    // join-then-leave must not be replayed as leave-then-join.
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(false);
    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(true);
  });

  test("a socket that disconnects mid-lookup is not put back into any room", async () => {
    const lookup = deferred<typeof SESSION | null>();
    getSession.mockReturnValueOnce(lookup.promise);
    const socket = connect();
    socket.fire("joinOutlet", JOIN);
    socket.connected = false; // the transport dropped while Redis was answering
    lookup.resolve(SESSION);
    await flush();
    jest.runOnlyPendingTimers();
    expect(socket.rooms.size).toBe(0);
    expect(socket.emitted).toHaveLength(0);
    expect(resume).not.toHaveBeenCalled();
  });
});

// ONE REPLAY PER BURST, NOT ONE PER JOIN. Queueing joins behind the lookup is
// what stopped them being dropped, but every queued join used to schedule its own
// resumePrintJobsForAgent — a tenant transaction each. The agent's watchdog
// re-asks at 5s and again 10s later while unanswered, so a session-store stall
// left each till with two or three joins waiting, and at recovery they all ran
// replay transactions together against the fifteen-slot pooler: extra load in
// exactly the failure the standstill incident was about. Every join is still
// answered and still joins the room; only the replay is shared.
describe("repeated joins share one replay", () => {
  const OTHER_OUTLET = "5d2c7e1a-3b9f-4c6d-8e0a-7f1b2c3d4e5f";

  test("joins queued behind one lookup are all answered, and replay once", async () => {
    const lookup = deferred<typeof SESSION | null>();
    getSession.mockReturnValueOnce(lookup.promise);
    const socket = connect();
    // The connect join, the watchdog's 5s re-ask, and a window regaining focus.
    socket.fire("joinOutlet", JOIN);
    socket.fire("joinOutlet", JOIN);
    socket.fire("joinOutlet", JOIN);
    lookup.resolve(SESSION);
    await flush();

    expect(socket.emitsOf("joinedOutlet")).toHaveLength(3);
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(true);
    jest.runOnlyPendingTimers();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test("a join that lands while the replay is running adds none; the next window after it is served", async () => {
    getSession.mockResolvedValueOnce(SESSION);
    const running = deferred<number>();
    resume.mockImplementationOnce(() => running.promise);
    const socket = connect();
    socket.fire("joinOutlet", JOIN);
    await flush();
    jest.runOnlyPendingTimers();
    expect(resume).toHaveBeenCalledTimes(1);

    // A re-ask that was already on the wire arrives mid-transaction.
    socket.fire("joinOutlet", JOIN);
    await flush();
    jest.runOnlyPendingTimers();
    expect(socket.emitsOf("joinedOutlet")).toHaveLength(2);
    expect(resume).toHaveBeenCalledTimes(1);

    // The window is delivered; the agent drains it and asks for the next one.
    running.resolve(20);
    await flush();
    socket.fire("joinOutlet", JOIN);
    await flush();
    jest.runOnlyPendingTimers();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  test("a replay that fails does not hold back the next join's", async () => {
    getSession.mockResolvedValueOnce(SESSION);
    resume.mockImplementationOnce(() => Promise.reject(new Error("pool exhausted")));
    const socket = connect();
    socket.fire("joinOutlet", JOIN);
    await flush();
    jest.runOnlyPendingTimers();
    await flush();
    socket.fire("joinOutlet", JOIN);
    await flush();
    jest.runOnlyPendingTimers();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  test("the share is per outlet and per connection, never wider", async () => {
    getSession.mockResolvedValueOnce(SESSION).mockResolvedValueOnce(SESSION);
    const running = deferred<number>();
    resume.mockImplementation(() => running.promise);
    try {
      const socket = connect();
      socket.fire("joinOutlet", JOIN);
      socket.fire("joinOutlet", { ...JOIN, outletId: OTHER_OUTLET });
      await flush();
      jest.runOnlyPendingTimers();
      expect(resume.mock.calls.map((c) => c[0].outletId)).toEqual([OUTLET_ID, OTHER_OUTLET]);

      // A reconnect is a new socket, and its replay must not wait on the dead one's.
      const reconnected = connect();
      reconnected.fire("joinOutlet", JOIN);
      await flush();
      jest.runOnlyPendingTimers();
      expect(resume).toHaveBeenCalledTimes(3);
      expect(resume.mock.calls[2][0].agentId).toBe(reconnected.id);
    } finally {
      running.resolve(0);
      resume.mockImplementation(() => Promise.resolve(0));
    }
  });
});

describe("a dead session", () => {
  test("is answered with joinRejected and is NOT disconnected", async () => {
    getSession.mockResolvedValueOnce(null);
    const socket = connect({ token: "TOKEN_A_DESTROYED", restaurantId: RES_ID });
    socket.fire("joinOutlet", JOIN);
    await flush();
    jest.runOnlyPendingTimers();

    expect(socket.emitsOf("joinRejected")).toEqual([
      { event: "joinRejected", payload: { reason: "session_invalid" } },
    ]);
    expect(socket.disconnectCalls).toBe(0);
    expect(socket.rooms.size).toBe(0);
    expect(socket.emitsOf("joinedOutlet")).toHaveLength(0);
    expect(resume).not.toHaveBeenCalled();
  });

  test("a handshake with no token is rejected without asking the store", async () => {
    const socket = connect({ restaurantId: RES_ID });
    socket.fire("joinOutlet", JOIN);
    await flush();
    expect(getSession).not.toHaveBeenCalled();
    expect(socket.emitsOf("joinRejected")).toHaveLength(1);
    expect(socket.disconnectCalls).toBe(0);
    expect(socket.rooms.size).toBe(0);
  });

  test("still cannot name its own restaurant room", async () => {
    getSession.mockResolvedValueOnce(null);
    const socket = connect();
    socket.fire("join", RES_ID);
    await flush();
    expect(socket.rooms.size).toBe(0);
    // Only joinOutlet is answered: a dashboard socket that never asks to print
    // hears nothing new.
    expect(socket.emitted).toHaveLength(0);
  });
});

describe("a store that cannot be reached is not a dead session", () => {
  test("a failed lookup is retried, and the join then succeeds", async () => {
    getSession.mockRejectedValueOnce(new Error("redis timeout")).mockResolvedValueOnce(SESSION);
    const socket = connect();
    socket.fire("joinOutlet", JOIN);
    await flush();
    expect(socket.emitsOf("joinRejected")).toHaveLength(0);
    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(true);
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(true);
    expect(socket.emitsOf("joinedOutlet")).toHaveLength(1);
    // The retry was SHARED: the connection-level wait and the queued join did not
    // each run their own.
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  test("a store that stays down is never reported as a rejection", async () => {
    getSession.mockRejectedValue(new Error("redis down"));
    const socket = connect();
    socket.fire("joinOutlet", JOIN);
    await flush();
    expect(socket.emitsOf("joinRejected")).toHaveLength(0);
    expect(socket.rooms.size).toBe(0);
    expect(socket.disconnectCalls).toBe(0);

    // The store comes back; the agent's next re-join is heard on the SAME socket,
    // and the restaurant room it never got at connect is joined with it.
    getSession.mockReset();
    getSession.mockResolvedValueOnce(SESSION);
    socket.fire("joinOutlet", JOIN);
    await flush();
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(true);
    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(true);
    expect(socket.emitsOf("joinedOutlet")).toHaveLength(1);
  });
});

describe("restaurant-room semantics for every other socket", () => {
  test("a socket that asks for nothing is in its restaurant room once the session resolves", async () => {
    const lookup = deferred<typeof SESSION | null>();
    getSession.mockReturnValueOnce(lookup.promise);
    const socket = connect();
    expect(socket.rooms.size).toBe(0);
    lookup.resolve(SESSION);
    await flush();
    expect([...socket.rooms]).toEqual([RESTAURANT_ROOM]);
    expect(socket.emitted).toHaveLength(0);
  });

  test("join/leave stay pinned to the caller's own restaurant, and a leave sticks", async () => {
    getSession.mockResolvedValueOnce(SESSION);
    const socket = connect();
    await flush();
    socket.fire("join", "res-other");
    await flush();
    expect(socket.rooms.has("restaurant:res-other")).toBe(false);

    socket.fire("leave", RES_ID);
    await flush();
    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(false);
    // A later event must not quietly re-admit a socket that left.
    socket.fire("joinOutlet", JOIN);
    await flush();
    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(false);
    expect(socket.rooms.has(OUTLET_ROOM)).toBe(true);

    socket.fire("join", RES_ID);
    await flush();
    expect(socket.rooms.has(RESTAURANT_ROOM)).toBe(true);
  });
});
