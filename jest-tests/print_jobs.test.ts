// Durable printing.
//
// THE DEFECT THIS SUITE EXISTS FOR: printing was fire-and-forget. The backend
// built ESC/POS bytes, called emitOutlet(), and answered {success:true} whatever
// happened — and `io.to(room).emit()` on an empty room is a SUCCESSFUL no-op, so
// a bill emitted while a till's socket was down was silently gone. The first test
// below asserts that no-op rather than describing it, because everything else
// here is a consequence of it.
//
// The suite that matters is "exactly once, eventually":
//
//   never lost      — a job outlives an emit that reached nobody, a backend
//                     restart, and an agent that died mid-print;
//   never doubled   — a terminal status is terminal, a lease keeps two tills on
//                     one outlet from both taking the same receipt, and a
//                     duplicate ack changes nothing.
//
// Both halves are enforced in SQL, not in TypeScript, so every test drives the
// shipped path (print_jobs.ts -> database_supabase.ts) over the stubbed Pool in
// print_fixtures.ts, whose dispatch derives its behaviour from the statement text
// rather than restating the rules. Widening a status list or deleting the lease
// clause therefore turns these red.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import {
  RES_ID,
  OUTLET_ID,
  OTHER_OUTLET_ID,
  FOREIGN_OUTLET_ID,
  addJob,
  breakPrintJobsTable,
  jobById,
  jobs,
  resetStore,
} from "./print_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __printFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__printFixtureConnect;
    if (!make) {throw new Error("print fixture harness was not loaded");}
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

type PrintJobs = typeof import("../print_jobs");
type Realtime = typeof import("../realtime");
let mod: PrintJobs;
let realtime: Realtime;

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = new Date("2026-08-18T12:00:00Z").getTime();

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  // Clear any inherited tuning so the SHIPPED DEFAULTS are what is under test:
  // 30-minute KOT TTL, 12-hour bill TTL, 2-minute lease, 20 jobs per resume,
  // 7-day retention. A developer with one of these exported would otherwise get a
  // green run that proves something different from CI's.
  for (const k of [
    "PRINT_JOB_KOT_TTL_MIN", "PRINT_JOB_BILL_TTL_MIN", "PRINT_JOB_LEASE_MIN",
    "PRINT_JOB_REPLAY_LIMIT", "PRINT_JOB_RETENTION_DAYS", "PRINT_JOB_MAX_B64_CHARS",
    "PRINT_JOB_PURGE_LIMIT",
  ]) { delete process.env[k]; }
  mod = await import("../print_jobs");
  realtime = await import("../realtime");
});

// Only the clock is faked. Timer functions stay real, or the awaits inside the
// resume path would never resolve.
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval",
      "setImmediate", "clearImmediate", "nextTick", "queueMicrotask"],
  });
  jest.setSystemTime(new Date(T0));
  resetStore();
});
afterEach(() => { jest.useRealTimers(); });

// --- helpers -----------------------------------------------------------------

/** A persisted job id, or a loud failure. Keeps the null-handling out of every
 *  assertion without reaching for a non-null assertion. */
function must(id: string | null): string {
  if (id === null) { throw new Error("expected the job to have been persisted"); }
  return id;
}

function row(id: string) {
  const r = jobById(id);
  if (!r) { throw new Error(`no PrintJobs row ${id}`); }
  return r;
}

interface Till {
  id: string;
  received: Record<string, unknown>[];
}
const till = (id: string): Till => ({ id, received: [] });

/** What realtime.ts's joinOutlet handler does, minus the socket. */
async function connect(
  t: Till,
  over: Partial<{ outletId: string; agentVersion: string | null }> = {},
): Promise<number> {
  return mod.resumePrintJobsForAgent({
    resId: RES_ID,
    outletId: over.outletId ?? OUTLET_ID,
    agentId: t.id,
    agentVersion: over.agentVersion === undefined ? "1.0.8" : over.agentVersion,
    employeeId: "emp-1",
    role: "cashier",
    deliver: (p) => { t.received.push(p); },
  });
}

async function enqueueBill(billId = "B1", outletId = OUTLET_ID): Promise<string> {
  return must(await mod.enqueuePrintJob(RES_ID, {
    outlet_id: outletId, bill_id: billId, kind: "bill", station: null, esc_base64: `esc-${billId}`,
  }));
}

// ---------------------------------------------------------------------------
describe("the defect", () => {
  test("emitOutlet with no io is a silent, unreportable no-op", () => {
    // This is the whole reason durability is needed: there is no return value, no
    // delivery count and no throw — the caller cannot tell a receipt reached a
    // printer from one that reached nobody. `io` is null here for the same reason
    // it is null during a redeploy.
    expect(realtime.getIo()).toBeNull();
    expect(() => { realtime.emitOutlet(RES_ID, OUTLET_ID, "bill:print", { billId: "B1" }); }).not.toThrow();
  });
});

describe("persistence and replay", () => {
  test("a bill emitted with NO till connected is persisted, and replayed when one connects", async () => {
    realtime.emitOutlet(RES_ID, OUTLET_ID, "bill:print", { billId: "B1" });   // reaches nobody
    const jobId = await enqueueBill("B1");
    expect(row(jobId).status).toBe("pending");

    const a = till("till-a");
    await expect(connect(a)).resolves.toBe(1);
    expect(a.received).toHaveLength(1);
    expect(a.received[0]).toMatchObject({
      billId: "B1", escBase64: "esc-B1", jobId, replay: true,
    });
    // A replayed BILL carries no station/kind, exactly like a live one.
    expect(a.received[0]).not.toHaveProperty("station");
    expect(row(jobId)).toMatchObject({ status: "delivered", attempts: 1, claimed_by: "till-a" });
  });

  test("replay is oldest-first and bounded, so an hour offline is not dumped in one shot", async () => {
    for (let i = 0; i < 25; i++) {
      jest.setSystemTime(new Date(T0 + i * 1000));
      await enqueueBill(`B${String(i).padStart(2, "0")}`);
    }
    const a = till("till-a");
    await expect(connect(a)).resolves.toBe(20);
    expect(a.received.map((p) => p.billId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `B${String(i).padStart(2, "0")}`),
    );
  });

  test("the N station tickets of one KOT share a bill_id and ALL replay", async () => {
    // The exact bug deduplicating on bill_id would cause: one kitchen prints, the
    // others silently never do.
    for (const station of ["Grill", "Fry", "Bar"]) {
      await mod.enqueuePrintJob(RES_ID, {
        outlet_id: OUTLET_ID, bill_id: "KOT-7", kind: "kot", station, esc_base64: `esc-${station}`,
      });
    }
    const a = till("till-a");
    await expect(connect(a)).resolves.toBe(3);
    expect(a.received.map((p) => p.station)).toEqual(["Grill", "Fry", "Bar"]);
    expect(a.received.every((p) => p.kind === "kot")).toBe(true);
    expect(new Set(a.received.map((p) => p.jobId)).size).toBe(3);
  });

  test("a deliberate reprint of the same bill is its own job, not a swallowed duplicate", async () => {
    const first = await enqueueBill("B9");
    const second = await enqueueBill("B9");
    expect(second).not.toBe(first);
    const a = till("till-a");
    await expect(connect(a)).resolves.toBe(2);
  });
});

describe("never doubled", () => {
  test("a job acked once is never replayed again", async () => {
    const jobId = await enqueueBill();
    const a = till("till-a");
    await connect(a);
    expect(a.received).toHaveLength(1);

    await expect(mod.ackPrintJob(RES_ID, jobId, "printed"))
      .resolves.toEqual({ settled: true, duplicate: false });
    expect(row(jobId).status).toBe("acked");

    // Well past the lease, so nothing but the terminal status can be keeping it back.
    jest.setSystemTime(new Date(T0 + 10 * MIN));
    const b = till("till-a-reconnected");
    await expect(connect(b)).resolves.toBe(0);
    const c = till("till-b");
    await expect(connect(c)).resolves.toBe(0);
  });

  test("a duplicate ack is harmless: no error, no second state change", async () => {
    const jobId = await enqueueBill();
    await connect(till("till-a"));
    await mod.ackPrintJob(RES_ID, jobId, "printed");
    const settled = { ...row(jobId) };

    jest.setSystemTime(new Date(T0 + 1 * MIN));
    await expect(mod.ackPrintJob(RES_ID, jobId, "printed"))
      .resolves.toEqual({ settled: false, duplicate: true });
    // A retry must not re-stamp when it printed, nor overwrite the outcome.
    expect(row(jobId).settled_at).toEqual(settled.settled_at);
    expect(row(jobId).ack_result).toBe("printed");
    expect(row(jobId).status).toBe("acked");

    // Not even a contradictory retry can flip a printed job to failed.
    await expect(mod.ackPrintJob(RES_ID, jobId, "failed"))
      .resolves.toEqual({ settled: false, duplicate: true });
    expect(row(jobId).ack_result).toBe("printed");
  });

  test("an ack for an id that does not exist is answered the same way, not with an error", async () => {
    await expect(mod.ackPrintJob(RES_ID, "job-does-not-exist", "printed"))
      .resolves.toEqual({ settled: false, duplicate: true });
  });

  test("two tills on one outlet do not both print the same job", async () => {
    const jobId = await enqueueBill();
    const a = till("till-a");
    const b = till("till-b");
    await connect(a);
    await connect(b);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(0);
    expect(row(jobId).claimed_by).toBe("till-a");
  });

  test("two tills resuming CONCURRENTLY still yield exactly one copy", async () => {
    await enqueueBill();
    const a = till("till-a");
    const b = till("till-b");
    const [ca, cb] = await Promise.all([connect(a), connect(b)]);
    expect(ca + cb).toBe(1);
  });

  test("a 'failed' ack is terminal — a jammed printer is not retried forever", async () => {
    const jobId = await enqueueBill();
    await connect(till("till-a"));
    await expect(mod.ackPrintJob(RES_ID, jobId, "failed"))
      .resolves.toEqual({ settled: true, duplicate: false });
    expect(row(jobId)).toMatchObject({ status: "failed", ack_result: "failed" });

    jest.setSystemTime(new Date(T0 + 10 * MIN));
    await expect(connect(till("till-a-again"))).resolves.toBe(0);
  });
});

describe("never lost", () => {
  test("a backend restart mid-flight neither loses nor duplicates a job", async () => {
    // Emitted into the void while the process was coming back up.
    const jobId = await enqueueBill();

    const a = till("till-a");
    await connect(a);
    expect(a.received).toHaveLength(1);

    // The agent dies before the paper comes out, so no ack ever arrives. Its
    // neighbour must NOT take the job while the lease is live.
    const b = till("till-b");
    jest.setSystemTime(new Date(T0 + 30_000));
    await expect(connect(b)).resolves.toBe(0);

    // Once the lease lapses the job is recoverable rather than stranded.
    jest.setSystemTime(new Date(T0 + 3 * MIN));
    const c = till("till-c");
    await expect(connect(c)).resolves.toBe(1);
    expect(c.received[0].jobId).toBe(jobId);
    expect(row(jobId).attempts).toBe(2);      // handed over twice…

    // …and settled exactly once.
    await expect(mod.ackPrintJob(RES_ID, jobId, "printed"))
      .resolves.toEqual({ settled: true, duplicate: false });
    await expect(mod.ackPrintJob(RES_ID, jobId, "printed"))
      .resolves.toEqual({ settled: false, duplicate: true });
    expect(jobs().filter((j) => j.status === "acked")).toHaveLength(1);
  });

  test("a job written but never emitted still reaches the first till that connects", async () => {
    // No emit at all — the row alone is the delivery mechanism.
    const jobId = must(await mod.enqueuePrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "B-silent", kind: "bill", station: null, esc_base64: "esc",
    }));
    const a = till("till-a");
    await expect(connect(a)).resolves.toBe(1);
    expect(a.received[0].jobId).toBe(jobId);
  });
});

describe("the agent-version interlock", () => {
  test("an agent that cannot ack is never replayed to", async () => {
    const jobId = await enqueueBill();
    const legacy = till("legacy-till");
    await expect(connect(legacy, { agentVersion: null })).resolves.toBe(0);
    expect(legacy.received).toHaveLength(0);
    // Untouched, so a capable agent still gets it later.
    expect(row(jobId).status).toBe("pending");
    expect(row(jobId).attempts).toBe(0);
    await expect(connect(till("new-till"))).resolves.toBe(1);
  });
});

describe("tenant and outlet scoping", () => {
  test("a job for another outlet of the same tenant is not replayed here", async () => {
    await enqueueBill("B-other", OTHER_OUTLET_ID);
    await expect(connect(till("till-a"))).resolves.toBe(0);
    await expect(connect(till("till-b"), { outletId: OTHER_OUTLET_ID })).resolves.toBe(1);
  });

  test("an outlet the tenant does not own is refused outright", async () => {
    // joinOutlet's payload is client-supplied; RLS keys on res_id alone, so this
    // membership check is the only thing standing in the way.
    addJob({ outlet_id: FOREIGN_OUTLET_ID, bill_id: "B-foreign" });
    await expect(connect(till("till-a"), { outletId: FOREIGN_OUTLET_ID })).resolves.toBe(0);
    expect(row("job-1").status).toBe("pending");
  });
});

describe("the read-time TTL", () => {
  test("a stale kitchen docket is never replayed, while a bill of the same age is", async () => {
    // 45 minutes: past the 30-minute KOT life, nowhere near the 12-hour bill life.
    addJob({ kind: "kot", station: "Grill", bill_id: "KOT-old", created_at: new Date(T0 - 45 * MIN) });
    addJob({ kind: "bill", bill_id: "BILL-old", created_at: new Date(T0 - 45 * MIN) });

    const a = till("till-a");
    await expect(connect(a)).resolves.toBe(1);
    expect(a.received[0].billId).toBe("BILL-old");
  });

  test("a bill older than its own TTL is not replayed either", async () => {
    addJob({ kind: "bill", bill_id: "BILL-ancient", created_at: new Date(T0 - 13 * HOUR) });
    await expect(connect(till("till-a"))).resolves.toBe(0);
  });

  test("the TTL is enforced at READ time, so it holds with no reaper ever having run", async () => {
    addJob({ kind: "kot", station: "Grill", created_at: new Date(T0 - 45 * MIN) });
    // No sweep is called anywhere in this test.
    await expect(connect(till("till-a"))).resolves.toBe(0);
    expect(row("job-1").status).toBe("pending");   // still 'pending', still not replayed
  });
});

describe("the reaper", () => {
  test("expires what outlived its TTL, purges settled history, and leaves live jobs alone", async () => {
    const staleKot = addJob({ kind: "kot", station: "Grill", created_at: new Date(T0 - 45 * MIN) });
    const staleBill = addJob({ kind: "bill", created_at: new Date(T0 - 13 * HOUR) });
    const liveBill = addJob({ kind: "bill", created_at: new Date(T0 - 5 * MIN) });
    const inFlight = addJob({
      kind: "bill", status: "delivered", created_at: new Date(T0 - 10 * MIN),
      claimed_by: "till-a", claimed_until: new Date(T0 + MIN),
    });
    const oldHistory = addJob({
      kind: "bill", status: "acked", ack_result: "printed",
      created_at: new Date(T0 - 8 * 24 * HOUR), settled_at: new Date(T0 - 8 * 24 * HOUR),
    });
    const recentHistory = addJob({
      kind: "bill", status: "acked", ack_result: "printed",
      created_at: new Date(T0 - 2 * 24 * HOUR), settled_at: new Date(T0 - 2 * 24 * HOUR),
    });

    await mod.runPrintJobReaperSweep();

    expect(row(staleKot.id).status).toBe("expired");
    expect(row(staleBill.id).status).toBe("expired");
    expect(row(liveBill.id).status).toBe("pending");
    expect(row(inFlight.id).status).toBe("delivered");
    expect(jobById(oldHistory.id)).toBeUndefined();      // purged
    expect(row(recentHistory.id).status).toBe("acked");  // inside retention
  });

  test("a job expired by this sweep survives it — retention runs from settlement, not creation", async () => {
    // THE BUG THIS PINS: keying retention on created_at expires a month-old
    // pending job and deletes it in the SAME sweep, destroying the only record
    // that those receipts were never printed.
    const ancientPending = addJob({ status: "pending", created_at: new Date(T0 - 30 * 24 * HOUR) });
    await mod.runPrintJobReaperSweep();
    expect(row(ancientPending.id).status).toBe("expired");
    expect(row(ancientPending.id).settled_at).toEqual(new Date(T0));

    // It becomes purgeable only once the retention window has run from THERE.
    jest.setSystemTime(new Date(T0 + 8 * 24 * HOUR));
    await mod.runPrintJobReaperSweep();
    expect(jobById(ancientPending.id)).toBeUndefined();
  });

  test("a job an agent is holding is neither expired nor purged out from under it", async () => {
    // If the sweep expired a leased job, the agent would spool it, report success,
    // and have its ack rejected as already-settled — losing the only record that
    // the receipt really printed. The row here is a month old and still untouched
    // because the lease is live.
    const inFlight = addJob({
      status: "delivered", created_at: new Date(T0 - 30 * 24 * HOUR),
      claimed_by: "till-a", claimed_until: new Date(T0 + MIN),
    });
    await mod.runPrintJobReaperSweep();
    expect(row(inFlight.id).status).toBe("delivered");
    expect(row(inFlight.id).settled_at).toBeNull();

    // Once the lease lapses the next sweep collects it.
    jest.setSystemTime(new Date(T0 + 5 * MIN));
    await mod.runPrintJobReaperSweep();
    expect(row(inFlight.id).status).toBe("expired");
  });
});

describe("degrading when migration 027 has not been applied", () => {
  test("printing keeps working, loudly undurable, instead of 500ing every bill", async () => {
    breakPrintJobsTable();
    await expect(mod.enqueuePrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "B1", kind: "bill", station: null, esc_base64: "esc",
    })).resolves.toBeNull();
    await expect(connect(till("till-a"))).resolves.toBe(0);
    await expect(mod.ackPrintJob(RES_ID, "job-1", "printed"))
      .resolves.toEqual({ settled: false, duplicate: true });
    await expect(mod.runPrintJobReaperSweep()).resolves.toBeUndefined();
  });

  test("an absurd payload is emitted but not stored", async () => {
    process.env.PRINT_JOB_MAX_B64_CHARS = "16";
    try {
      await expect(mod.enqueuePrintJob(RES_ID, {
        outlet_id: OUTLET_ID, bill_id: "B1", kind: "bill", station: null,
        esc_base64: "x".repeat(64),
      })).resolves.toBeNull();
      expect(jobs()).toHaveLength(0);
    } finally {
      delete process.env.PRINT_JOB_MAX_B64_CHARS;
    }
  });
});

describe("the wire payload", () => {
  test("a bill keeps exactly its pre-existing fields, plus an additive jobId", () => {
    const p = mod.printJobPayload({
      billId: "B1", escBase64: "esc", kind: "bill", jobId: "job-1",
      publishedAt: "2026-08-18T12:00:00.000Z",
    });
    // station/kind were never on a bill payload and must not appear now — a
    // fielded agent branches on them.
    expect(Object.keys(p).sort()).toEqual(["billId", "escBase64", "jobId", "publishedAt"]);
  });

  test("a KOT ticket keeps station and kind", () => {
    const p = mod.printJobPayload({
      billId: "K1", escBase64: "esc", kind: "kot", station: "Grill", jobId: "job-1",
      publishedAt: "2026-08-18T12:00:00.000Z",
    });
    expect(p).toMatchObject({ station: "Grill", kind: "kot", jobId: "job-1" });
  });

  test("an unpersisted job still emits, carrying a null jobId", () => {
    const p = mod.printJobPayload({
      billId: "B1", escBase64: "esc", kind: "bill", jobId: null,
      publishedAt: "2026-08-18T12:00:00.000Z",
    });
    expect(p.jobId).toBeNull();
    expect(p.escBase64).toBe("esc");
  });
});
