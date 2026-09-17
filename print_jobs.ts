/**
 * Durable printing — the policy layer over migration 027's "PrintJobs".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Printing used to be fire-and-forget. The backend built ESC/POS bytes, called
 * emitOutlet(), and answered {success:true} whatever happened. Three separate
 * silent drops sat on that path:
 *
 *   1. realtime.ts returns early when `io` is null (before init, after shutdown);
 *   2. `io.to(room).emit()` on an EMPTY room is a SUCCESSFUL no-op — no return
 *      value, no delivery count, nothing a caller could check;
 *   3. without a Redis adapter the emit never crosses replicas at all.
 *
 * The receiving Windows agent then held its queue in a plain in-memory List that
 * stop() cleared. So a bill emitted while that till's socket was down was simply
 * gone: no retry, no persistence, no error, no log line, and a green tick for the
 * waiter. Rare on a laptop that never restarts; routine on a host that redeploys.
 *
 * The fix is not a better emit. It is that THE ROW IS THE FACT and the emit is an
 * optimisation: every job is written before it is pushed, and an agent that
 * reconnects replays whatever it never acknowledged.
 *
 * WHAT LIVES WHERE
 * ----------------
 * Every "PrintJobs" statement is in database_supabase.ts behind a named export
 * (runQuery is module-private there, deliberately). This file holds the policy:
 * the per-kind TTL, the lease window, the agent-version gate, and what to do when
 * migration 027 has not been applied yet. realtime.ts and routes/bills.ts call in
 * here and never touch the SQL.
 *
 * Since migration 042 there is a third neighbour: print_routing.ts DECIDES which
 * device a job is for. It is not imported statically from here — it imports this
 * module for the degradation helpers below — so the one place this file calls
 * back into it (escalating a 'failed' ack to the next device) uses a lazy import.
 * Nothing about routing is required for a job to print: every routing failure
 * ends at the outlet-wide broadcast this file already emitted before 042 existed.
 *
 * THE DEGRADATION RULE, stated once because it is easy to get backwards
 * ------------------------------------------------------------------
 * A deployment can reach this code with migration 027 unapplied — the rollout
 * order is migration, then backend, then agent, and orders slip. In that window
 * every "PrintJobs" statement raises 42P01 (or 42501, if the grants half did not
 * run). Letting that propagate would 500 every print route and stop the
 * restaurant printing at all, which is far worse than the defect being fixed. So
 * that ONE error class — and no other — degrades to today's fire-and-forget
 * behaviour with a loud log. A constraint violation, a dead connection, a
 * serialisation failure: all still throw, because all of them mean something is
 * wrong that hiding would not fix.
 */

import {
  AckPrintJob,
  AckPrintJobRouted,
  ClaimPrintJobsForAgent,
  EnqueuePrintJob,
  ExpireClaimedPrintJobs,
  ExpirePrintJobs,
  GetPrintJobAssignment,
  ListRestaurantIds,
  OutletBelongsToRestaurant,
  PurgeSettledPrintJobs,
  isRoutedPrintJob,
  withTenant,
  type PrintJobAssignmentRow,
  type PrintJobInput,
  type RoutedPrintAck,
} from "./database_supabase.js";
import { logger } from "./observability.js";

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * PER-KIND TTL, because a late docket and a late bill are different harms.
 *
 * A kitchen ticket for food ordered an hour ago is ACTIVELY HARMFUL: the kitchen
 * cooks a dish that already went out and the restaurant eats the cost. Thirty
 * minutes is roughly one ticket's life on the pass.
 *
 * A bill is merely stale. Twelve hours covers an overnight outage, so a service
 * that lost its till at 21:00 still prints the night's outstanding bills when the
 * morning shift signs in — and a bill for a table that left yesterday is noise
 * rather than damage.
 *
 * These are enforced AT READ TIME by ClaimPrintJobsForAgent, not by the reaper.
 * That ordering is deliberate: the guarantee must not depend on a background
 * timer having run.
 */
const KOT_TTL_MIN = (): number => envInt("PRINT_JOB_KOT_TTL_MIN", 30);
const BILL_TTL_MIN = (): number => envInt("PRINT_JOB_BILL_TTL_MIN", 12 * 60);

/**
 * How long a claimed job is off-limits to any OTHER till on the same outlet.
 *
 * Short on purpose. It only has to outlast one agent's spool-and-ack round trip;
 * past that, an agent that died mid-print must be able to lose the job to its
 * neighbour rather than pin it forever.
 */
const LEASE_MIN = (): number => envInt("PRINT_JOB_LEASE_MIN", 2);

/**
 * Jobs handed over per resume. BOUNDED, and the bound is load-bearing twice: it
 * is backpressure (a till that has been offline for hours does not get the whole
 * backlog in one shot) and it is the thundering-herd cap when a redeploy drops
 * every till in the fleet and they all reconnect within the same second.
 */
const REPLAY_LIMIT = (): number => envInt("PRINT_JOB_REPLAY_LIMIT", 20);

const RETENTION_DAYS = (): number => envInt("PRINT_JOB_RETENTION_DAYS", 7);
const PURGE_LIMIT = (): number => envInt("PRINT_JOB_PURGE_LIMIT", 500);

/**
 * Ceiling on a persisted payload. ~2M base64 chars is ~1.5MB of ESC/POS — orders
 * of magnitude past any real receipt, logo raster included.
 *
 * POST /publish/bill takes escBase64 straight from the client, so without this a
 * buggy or hostile caller could push arbitrary blobs into a table that now KEEPS
 * them. Over the cap the job is emitted but not persisted: the payload is not one
 * a printer could render anyway, and refusing the request outright would change a
 * route contract for input that has never legitimately occurred.
 */
const MAX_B64_CHARS = (): number => envInt("PRINT_JOB_MAX_B64_CHARS", 2_000_000);

/**
 * Server-side spread for a reconnect storm.
 *
 * A redeploy drops EVERY till in the fleet at once and every one of them
 * reconnects and asks to resume within the same second or two. The agents cannot
 * be relied on to jitter — the fielded builds do not, and this backend must ship
 * before they do — so the spread is applied here, where it protects the database
 * whatever the client does. It delays only the replay; the room join is immediate,
 * so nothing about live printing is slowed.
 */
export function resumeJitterMs(): number {
  return Math.floor(Math.random() * envInt("PRINT_RESUME_JITTER_MS", 3000));
}

const MIN = 60_000;

/** The two read-time TTL boundaries, as of now. */
export function ttlCutoffs(now: Date = new Date()): { kot: Date; bill: Date } {
  return {
    kot: new Date(now.getTime() - KOT_TTL_MIN() * MIN),
    bill: new Date(now.getTime() - BILL_TTL_MIN() * MIN),
  };
}

// --- test slips --------------------------------------------------------------

/**
 * POST /print/test's slips ride the same queue as a real docket, and that is
 * deliberate: the answer the button gives is only worth having if the slip took
 * the route a real ticket takes. But the queue's REPLAY is not something a test
 * slip should inherit whole.
 *
 * A slip nobody printed — the kitchen PC was off, so it broadcast and no device
 * took it — used to sit as an ordinary 'kot' job for the KOT TTL (thirty
 * minutes), or as a 'bill' job for TWELVE HOURS, and print on whichever till
 * joined the outlet next. Three presses at a dead printer became three "PRINTER
 * TEST" dockets in the middle of service, rendered in whatever style and size
 * the restaurant had at press time — which, after an owner has followed the
 * advice to switch to the classic docket, is the one it just switched away from.
 * A test slip that prints ten minutes later tests nothing, and a pile of them is
 * noise on the pass.
 *
 * SO REPLAY HANDS A TILL AT MOST ONE TEST SLIP PER ROLE, AND ONLY A FRESH ONE:
 *   * older than PRINT_JOB_TEST_REPLAY_MIN (five minutes — the time somebody
 *     stands at a printer after pressing the button, and past the two-minute
 *     lease, so a directed slip whose device flapped still gets its reconnect
 *     door) — not handed over, and settled 'expired';
 *   * of several fresh ones for the same role, only the newest — the rest
 *     settled 'expired' the same way.
 * The owner is told this window: POST /print/test answers `replayMinutes`, and
 * both Settings cards say it under a slip that broadcast.
 *
 * THIS IS DONE AFTER THE CLAIM, IN TYPESCRIPT, AND NOT IN ITS SQL. The claim's
 * statement is pinned (its latch-false text is what 027 shipped) and is the
 * double-print guard for every receipt in the estate; a test-slip clause in it
 * would put the rarest job on the hottest path. Here the extra statement runs
 * only when a claim actually picked up a stale test slip.
 *
 * WHAT MAKES A ROW A TEST SLIP is its bill_id, which only testSlipBillId below
 * writes — AND a role in it that agrees with the row's own kind and station.
 * bill_id is free text (a real bill's fallback is `<table>-<epoch>`), so the
 * prefix alone would let a table somebody named "print-test-…" lose its bill;
 * with the agreement check a real job would need a station literally named after
 * the epoch it was printed at.
 */
export const TEST_SLIP_REPLAY_MIN = (): number =>
  Math.max(1, Math.round(envInt("PRINT_JOB_TEST_REPLAY_MIN", 5)));

const TEST_SLIP_ID = /^print-test-(\d{13})-(.+)$/;

/** A role as it appears inside a test slip's bill_id. */
const testSlipRoleKey = (role: string): string => role.replace(/[^a-z0-9:]+/gi, "-");

/**
 * The bill_id of one test slip. Stamped with the clock so two presses are two
 * rows — a test slip is deliberately not deduplicated at press time; replay is
 * where the extras are dropped (above). The one writer: routes/printing.ts.
 */
export function testSlipBillId(stamp: Date, role: string): string {
  return `print-test-${String(stamp.getTime())}-${testSlipRoleKey(role)}`;
}

/**
 * The role a job was pressed for, or null when the job is not a test slip.
 * POST /print/test dispatches role "bill" as kind 'bill', "kot" as kind 'kot'
 * with no station, and "kot:<STATION>" as kind 'kot' with that station — so the
 * row's own kind and station must spell the role its bill_id names.
 */
export function testSlipRole(job: { bill_id: string; kind: string; station: string | null }): string | null {
  const m = TEST_SLIP_ID.exec(job.bill_id);
  if (!m) { return null; }
  const role = job.kind === "kot" ? (job.station ? `kot:${job.station}` : "kot") : "bill";
  return testSlipRoleKey(role) === m[2] ? role : null;
}

/**
 * Of the rows one claim returned, the ids of the test slips NOT to hand over:
 * every one older than the replay window, and every fresh one but the newest per
 * role. `rows` is the claim's own order (created_at, then seq), so of two slips
 * stamped in the same millisecond the later row is the newer. Real jobs are
 * never in the set.
 */
export function testSlipsNotToReplay(
  rows: readonly { id: string; bill_id: string; kind: string; station: string | null; created_at: Date | string }[],
  now: Date = new Date(),
): Set<string> {
  const cutoff = now.getTime() - TEST_SLIP_REPLAY_MIN() * MIN;
  const drop = new Set<string>();
  const newest = new Map<string, { id: string; at: number }>();
  for (const r of rows) {
    const role = testSlipRole(r);
    if (role === null) { continue; }
    const at = new Date(r.created_at).getTime();
    // `!(at > cutoff)` rather than `at <= cutoff`: an unreadable timestamp is
    // not fresh.
    if (!(at > cutoff)) { drop.add(r.id); continue; }
    const kept = newest.get(role);
    if (kept && kept.at > at) { drop.add(r.id); continue; }
    if (kept) { drop.add(kept.id); }
    newest.set(role, { id: r.id, at });
  }
  return drop;
}

// --- migration-not-applied tolerance ----------------------------------------

/** 42P01 undefined_table, 42501 insufficient_privilege — i.e. migration 027 has
 *  not run, or ran without the app_runtime grants. Nothing else qualifies.
 *
 *  Exported for print_routing.ts, which reads 042's four new tables and needs the
 *  same one error class to mean the same one thing: route lookups come back empty
 *  and every job broadcasts. Two copies of this predicate would drift, and the
 *  copy that drifted would throw into a print path. */
export function isSchemaMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42501";
}

let schemaWarnedAt = 0;
/** Loud, but not once per receipt: an unmigrated deployment prints all day.
 *  Shared with print_routing.ts on purpose — one throttle, so a deployment that
 *  is missing both migrations still logs a readable number of lines. */
export function warnSchemaMissing(where: string, err: unknown): void {
  const now = Date.now();
  if (now - schemaWarnedAt < 10 * MIN) { return; }
  schemaWarnedAt = now;
  logger.error(
    { err, where },
    'print job durability is OFF — "PrintJobs" is unreadable (apply migration 027). ' +
      "Printing continues fire-and-forget: a bill emitted while a till is offline is lost.",
  );
}

/**
 * The SECOND, softer degradation: migration 042 is pending, so "PrintJobs" is
 * fine but has none of the assignment columns.
 *
 * 42703 undefined_column is deliberately NOT folded into isSchemaMissing. That
 * one means the whole table is unreadable and durability is off, which is an
 * error; this one means routing is off and every job takes the broadcast path,
 * which is exactly how this backend behaved before 042 and is therefore a warn.
 * Conflating them would make a routine deploy window look like data loss — and,
 * worse, would let a routing read that hit a real missing-table swallow it.
 *
 * Deploy Gate B has twice swapped containers with migrations still pending, so
 * this window is a thing that happens, not a hypothetical.
 */
export function isRoutingSchemaMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || isSchemaMissing(err);
}

let routingWarnedAt = 0;
export function warnRoutingSchemaMissing(where: string, err: unknown): void {
  const now = Date.now();
  if (now - routingWarnedAt < 10 * MIN) { return; }
  routingWarnedAt = now;
  logger.warn(
    { err, where },
    'print routing is OFF — "PrintJobs" has no assignment columns (apply migration 042). ' +
      "Every job broadcasts to the whole outlet, which is this backend's pre-042 behaviour.",
  );
}

// --- the wire payload --------------------------------------------------------

/**
 * Where the server decided this job prints, sent only to the one device it was
 * decided for.
 *
 * This block is the whole difference between a directed job and a broadcast one
 * on the wire. An agent that has never heard of routing receives no `route` key
 * and behaves as it always has; an agent that has, prefers `target` over its own
 * local rules but still falls through to them when it cannot reach that address
 * — a server target must never be a device's only option, or a mistyped address
 * turns into a docket that prints nowhere.
 */
export interface PrintJobRoute {
  destinationId: string;
  /** For the operator, not for the machine: "Sent to Bar Printer". */
  destinationName: string | null;
  /** The device this job was assigned to. Echoed back so a late ack can be
   *  attributed even after the assignment has moved on. */
  deviceId: string;
  /** The printer address as THAT device reported it — a spooler name or a
   *  tcp://host:port. Meaningless on any other machine, which is why a directed
   *  job never enters the outlet room. */
  target: string;
  /** THE FENCE. Every reassignment bumps it, so an ack, an accept or a reject
   *  naming an older generation is answering about an assignment that has since
   *  been revoked and must not disturb the live one. */
  generation: number;
}

export interface PrintJobPayloadInput {
  billId: string;
  escBase64: string;
  kind: "bill" | "kot";
  station?: string | null;
  /** null when the job could not be persisted — see the degradation rule. */
  jobId: string | null;
  publishedAt: string;
  replay?: boolean;
  /** Present ONLY on a directed job. Absent is not "unknown", it is "this is a
   *  broadcast, use your own rules". */
  route?: PrintJobRoute | null;
}

/**
 * The `bill:print` payload, built in ONE place so a replayed job is
 * indistinguishable from a live one to the agent.
 *
 * The pre-existing fields keep their exact names and their exact
 * present/absent-ness — `station` and `kind` appear on a KOT ticket and on
 * nothing else, as before. `jobId` and `replay` are ADDITIVE: an agent built
 * before this change ignores them and behaves exactly as it does today, which is
 * what makes the backend deployable ahead of the agent.
 *
 * A BILL STILL HAS NO `kind` KEY, AND THAT IS THE CONTRACT, NOT AN OVERSIGHT.
 * Every fielded agent reads `payload['kind'] == 'kot' ? 'kot' : 'bill'`, so
 * "tidying" this by always writing kind:'bill' would change a wire format that
 * hundreds of installed builds infer from ABSENCE. `route` obeys the same rule
 * from the other direction: an outlet with no routing rules must produce a
 * payload byte-identical to the one it produced before 042, which is what makes
 * "we shipped routing and nothing changed for anyone who has not configured it"
 * a testable claim rather than a hope. It is pinned.
 */
export function printJobPayload(j: PrintJobPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { billId: j.billId, escBase64: j.escBase64 };
  if (j.kind === "kot") {
    payload.station = j.station ?? null;
    payload.kind = "kot";
  }
  payload.jobId = j.jobId;
  payload.publishedAt = j.publishedAt;
  if (j.replay) { payload.replay = true; }
  if (j.route) {
    // Rebuilt field by field rather than spread: the wire names are pinned here,
    // so renaming a field of PrintJobRoute is a compile error instead of a silent
    // change to what every printer app parses.
    payload.route = {
      destinationId: j.route.destinationId,
      destinationName: j.route.destinationName,
      deviceId: j.route.deviceId,
      target: j.route.target,
      generation: j.route.generation,
    };
  }
  return payload;
}

// --- producer side -----------------------------------------------------------

/**
 * Persist a job and hand back its id, or null if it could not be persisted.
 *
 * Call this BEFORE emitting and put the returned id in the payload. A null id is
 * the honest signal that this particular bill is back to fire-and-forget; the
 * caller still emits, because an unpersisted print that reaches a connected till
 * is strictly better than no print at all.
 *
 * Runs on the request's ambient tenant connection (openTenantConnection binds it
 * for the whole handler chain), so RLS and the outlet context are already right
 * and no transaction is opened here.
 */
export async function enqueuePrintJob(resId: string, job: PrintJobInput): Promise<string | null> {
  if (job.esc_base64.length > MAX_B64_CHARS()) {
    logger.error(
      { resId, outletId: job.outlet_id, billId: job.bill_id, chars: job.esc_base64.length },
      "print_job_payload_too_large — emitted but not persisted",
    );
    return null;
  }
  try {
    return await EnqueuePrintJob(resId, job);
  } catch (err) {
    if (isSchemaMissing(err)) {
      warnSchemaMissing("enqueue", err);
      return null;
    }
    throw err;
  }
}

// --- agent side --------------------------------------------------------------

export interface ResumeRequest {
  resId: string;
  outletId: string;
  /** Stable per socket connection. Written to claimed_by; diagnostic only —
   *  claimed_until is the guard. */
  agentId: string;
  /** Absent for a build that predates durable printing. See the gate below. */
  agentVersion: string | null;
  /**
   * THE MACHINE, as registered under migration 042 — null for the C# agent, for
   * every build that predates device registration, and for a phone that has not
   * registered yet.
   *
   * Threaded into the claim so that reconnect replay and routing failover are one
   * mechanism instead of two: with an id a device also picks up the jobs assigned
   * to IT across a flap, without one it matches only unassigned jobs, which is
   * precisely the row set it sees today. It is NOT written to claimed_by — that
   * stays the per-connection agentId, because the lease wants an identity that
   * dies with the socket, not one that survives a reinstall.
   */
  deviceId: string | null;
  employeeId: string;
  role: string;
  deliver: (payload: Record<string, unknown>) => void;
}

/**
 * Replay this outlet's outstanding jobs to one just-connected agent.
 *
 * THE AGENT-VERSION GATE IS A SAFETY INTERLOCK, NOT A FEATURE FLAG. A build that
 * predates this change has no per-job dedup and no ack: replaying to it would
 * reprint every outstanding receipt on every reconnect, and it would never tell
 * us to stop. Silence is the only safe response to an agent that cannot ack, so
 * an agent that does not name a version gets nothing. That is also what makes the
 * intermediate rollout state (backend shipped, agents not yet) strictly safer
 * than today: jobs are recorded, and nobody is replayed to.
 *
 * The claim happens inside the tenant transaction; the emits happen AFTER it
 * commits. Emitting inside would mean the till could receive, print and ack a job
 * whose claim had not landed yet, and a transaction that later rolled back would
 * have "delivered" jobs it then disowned.
 */
export async function resumePrintJobsForAgent(req: ResumeRequest): Promise<number> {
  if (!req.agentVersion) { return 0; }

  let rows;
  try {
    rows = await withTenant(
      { res_id: req.resId, outlet_id: req.outletId, employeeId: req.employeeId, role: req.role },
      async () => {
        // res_id comes from the verified session, but outletId came off the wire.
        // RLS keys on res_id alone, so this is the only thing standing between one
        // branch's till and another branch's receipts.
        if (!(await OutletBelongsToRestaurant(req.resId, req.outletId))) {
          logger.warn(
            { resId: req.resId, outletId: req.outletId, agentId: req.agentId },
            "print_resume_rejected_unknown_outlet",
          );
          return [];
        }
        return ClaimPrintJobsForAgent(
          req.resId,
          req.outletId,
          req.agentId,
          ttlCutoffs(),
          new Date(Date.now() + LEASE_MIN() * MIN),
          REPLAY_LIMIT(),
          req.deviceId,
        );
      },
    );
  } catch (err) {
    if (isSchemaMissing(err)) { warnSchemaMissing("resume", err); return 0; }
    logger.error({ err, resId: req.resId, outletId: req.outletId }, "print_resume_failed");
    return 0;
  }

  // STALE AND SURPLUS TEST SLIPS ARE NOT HANDED OVER (see "test slips" above).
  // Settled in their OWN transaction, after the claim committed: a failure here
  // must not undo the claim and cost the till its real dockets. If it does fail,
  // the rows are simply leased to this till and not delivered — the next claim
  // after the lease drops them again, and the reaper collects them at the TTL.
  const notReplayed = testSlipsNotToReplay(rows);
  if (notReplayed.size > 0) {
    rows = rows.filter((r) => !notReplayed.has(r.id));
    try {
      const settled = await withTenant(
        { res_id: req.resId, outlet_id: req.outletId, employeeId: req.employeeId, role: req.role },
        () => ExpireClaimedPrintJobs(req.resId, [...notReplayed], req.agentId),
      );
      logger.info(
        { resId: req.resId, outletId: req.outletId, agentId: req.agentId, jobs: notReplayed.size, settled },
        "print_test_slips_not_replayed",
      );
    } catch (err) {
      logger.warn({ err, resId: req.resId, outletId: req.outletId }, "print_test_slip_settle_failed");
    }
  }

  for (const row of rows) {
    req.deliver(printJobPayload({
      billId: row.bill_id,
      escBase64: row.esc_base64,
      kind: row.kind === "kot" ? "kot" : "bill",
      station: row.station,
      jobId: row.id,
      publishedAt: new Date(row.created_at).toISOString(),
      replay: true,
    }));
  }
  if (rows.length > 0) {
    logger.info(
      { resId: req.resId, outletId: req.outletId, agentId: req.agentId, jobs: rows.length },
      "print_jobs_replayed",
    );
  }
  return rows.length;
}

export interface AckOutcome {
  /** True when THIS call settled the job. */
  settled: boolean;
  /** True when it was already settled — a retry, and explicitly harmless. */
  duplicate: boolean;
  /**
   * Routed jobs only: this 'failed' did NOT kill the job, it moved it to the
   * next device in the chain. ADDITIVE and deliberately not surfaced on
   * POST /print/ack's response: the acking till has nothing to do differently,
   * and a till that learned its failure had been re-routed would be tempted to
   * do something about it.
   */
  reassigned?: boolean;
  /**
   * Routed jobs only: the ack named an assignment that has already been revoked.
   * Recorded against that device and otherwise ignored — a straggler must never
   * disturb the assignee that is holding the job right now.
   */
  superseded?: boolean;
}

/**
 * Who is acking, as the SERVER knows it.
 *
 * THESE ARE FENCES, NOT PROVENANCE, AND THE DIFFERENCE IS THE WHOLE RULE.
 *
 * `deviceId` is what AckPrintJobRouted fences the release of a live assignment
 * on: a 'failed' that names a device the row no longer has is recorded and left
 * to lie there, instead of tearing down whoever holds the job now.
 *
 * WHAT IT IS NOT is the source of `printed_by_device`. That column is receipt
 * history — the record of which machine printed a money document — and it is
 * written from `p.assigned_device_id` in the SET list and from nowhere else, so
 * a till cannot write itself out of, or another machine into, that record no
 * matter what it sends. Read the SET before changing it; the property is one
 * `case` expression deep and is easy to undo by accident.
 *
 * BOTH FIELDS NOW ARRIVE ON THE WIRE, and an earlier version of this comment
 * said flatly that they never could. POST /print/ack grew them as OPTIONAL
 * fields when routing landed, because the alternative was worse: every ack in
 * production was unsigned, so a device whose printer jammed was never recorded
 * in `failed_devices`, and the ladder re-offered the docket to the printer that
 * had just refused it — which the client answers with a false 'printed'. A
 * silently destroyed kitchen docket is a worse failure than a spoofable fence.
 *
 * WHAT A SPOOFED FENCE COULD DO, stated plainly so nobody has to re-derive it: a
 * client that names another device's id and the matching generation can push a
 * live assignment onward a rung early. That costs a recall and a re-offer — the
 * ladder's ordinary machinery, bounded by the generation cap — and it cannot
 * write receipt history, settle a bill, or reach any other tenant (the route is
 * action-gated and tenant-scoped like every other). It is a nuisance available
 * to an already-authenticated staff device, not an escalation. The clean fix is
 * still the one this comment originally asked for — bind the identity to the
 * session server-side rather than accepting it from the body — and the socket
 * beats already do exactly that with `socket.data.print.deviceId`.
 *
 * ABSENT IS NOT "CURRENT". An earlier cut filled both fields in from the row when
 * the caller supplied neither — which every caller does — so the stale-assignee
 * and stale-generation guards were comparing the row against itself and passed by
 * construction. A revoked device's late 'failed' then tore down the LIVE
 * assignee's assignment while it was spooling, poisoned that healthy printer into
 * failed_devices, and handed the same bytes to a third device: two charge slips
 * for one guest. Nothing here is ever synthesised.
 */
export interface AckSource {
  deviceId?: string | null;
  generation?: number | null;
}

/**
 * Was this job ROUTED, and what does the row say about it?
 *
 * ONE EXTRA SELECT PER ACK, ON PURPOSE. The obvious saving is to let the ack's
 * own body decide — a client that was sent a `route` block sends its deviceId
 * back, so its silence could mean "broadcast". That hands a till the choice of
 * which statement settles a money document: a routing-aware app that omitted the
 * field would take the unrouted path, where 'failed' is TERMINAL, and the docket
 * would die instead of moving to the next printer. The row already knows. Acks
 * are one per receipt, not one per keystroke.
 *
 * THE TEN-MINUTE PROCESS-WIDE SKIP WINDOW THAT USED TO LIVE HERE IS GONE. It was
 * armed by isRoutingSchemaMissing, which subsumes 42501 — a per-TENANT grant
 * fault — so one restaurant's missing grant disabled routed acks for every
 * restaurant on the replica for ten minutes, and inside that window a jammed
 * printer at a correctly configured tenant took the broadcast branch, where
 * 'failed' is terminal, and lost its docket. It is also no longer needed:
 * GetPrintJobAssignment short-circuits on the boot latch before issuing a
 * statement under a pending 042, and routes its query through routingQuery, which
 * absorbs 42P01/42501/42703 and answers empty. The catch below is the belt to
 * those braces.
 *
 * Returns null — meaning "treat as unrouted", which is this backend's pre-042
 * behaviour — for an unknown job and for a database that cannot answer.
 */
async function printJobAssignment(resId: string, jobId: string): Promise<PrintJobAssignmentRow | null> {
  try {
    return await GetPrintJobAssignment(resId, jobId);
  } catch (err) {
    // DURABILITY FIRST, ROUTING SECOND. isRoutingSchemaMissing is a superset of
    // isSchemaMissing, so testing it first reported an unreadable "PrintJobs" —
    // migration 027 pending, or app_runtime without its grants — as "apply
    // migration 042" at warn, when the operator needs to hear that print
    // durability is off and receipts are being lost. The severe line does fire
    // afterwards from the broadcast branch, but a log that names the wrong
    // migration first is a log that sends somebody to the wrong screen.
    if (isSchemaMissing(err)) { warnSchemaMissing("ack", err); return null; }
    if (isRoutingSchemaMissing(err)) { warnRoutingSchemaMissing("ack", err); return null; }
    throw err;
  }
}

/**
 * Record what the agent did with a job.
 *
 * A duplicate is a SUCCESS, not an error. The ack rides an HTTP call that can
 * fail after the paper has come out, so a correct agent retries — and an agent
 * punished for retrying learns to stop retrying, which loses the acks that matter.
 * Zero rows from the compare-and-swap therefore reports duplicate:true, never a
 * 4xx, and an unknown id is answered the same way rather than confirming whether
 * it exists.
 *
 * The fork below is decided by the ROW, not by the caller — and it is decided by
 * DURABLE facts about the row, not by `assigned_device_id`.
 *
 * FORKING ON assigned_device_id LOST DOCKETS, silently, with no bell. That column
 * is NULLED by the routed ack's own retry arm: D1's printer jams, D1 acks
 * 'failed', the row is released to 'pending' for the next printer — and then D1's
 * ack retry (it retries up to three times, and one lost HTTP response on
 * restaurant Wi-Fi is all it takes) read a null assignee, fell through to the
 * broadcast branch, and AckPrintJob's CAS matched that 'pending' row and wrote
 * status='failed', TERMINAL. Nothing recovers a terminal row: ExpirePrintJobs
 * only touches non-terminal ones, so print_jobs_expired_undelivered never fires
 * and the kitchen ticket simply never existed. isRoutedPrintJob asks only about
 * facts the router writes once and never takes back.
 *
 * An unknown job, a job no router ever touched, and a database that predates
 * migration 042 all take the second branch, so the unrouted answer is still the
 * default in every sense — including when the routing half of the system is
 * missing entirely.
 */
export async function ackPrintJob(
  resId: string,
  jobId: string,
  result: "printed" | "failed",
  from: AckSource = {},
): Promise<AckOutcome> {
  const assignment = await printJobAssignment(resId, jobId);
  if (assignment && isRoutedPrintJob(assignment)) {
    return ackRoutedPrintJob(resId, jobId, result, from, assignment);
  }
  return ackBroadcastPrintJob(resId, jobId, result);
}

/**
 * The pre-042 path, unchanged to the character, and it stays that way.
 *
 * Every job an unconfigured tenant produces lands here, so this is the branch
 * that has to keep behaving exactly as it did before routing existed — including
 * 'failed' being terminal, which is right when there is no next device to try.
 */
async function ackBroadcastPrintJob(
  resId: string,
  jobId: string,
  result: "printed" | "failed",
): Promise<AckOutcome> {
  try {
    const settled = await AckPrintJob(resId, jobId, result);
    return { settled, duplicate: !settled };
  } catch (err) {
    if (isSchemaMissing(err)) {
      warnSchemaMissing("ack", err);
      // Nothing to settle, and nothing the till can usefully do about it.
      return { settled: false, duplicate: true };
    }
    throw err;
  }
}

/**
 * The ack for a job that was aimed at one machine.
 *
 * WHY THIS IS A DIFFERENT STATEMENT AT ALL: AckPrintJob makes 'failed' terminal
 * for the JOB. That is correct for a broadcast — the agent only says 'failed'
 * after exhausting its own retries, and replaying to the same jammed printer
 * forever helps nobody. Under routing it is the single most common kitchen fault
 * (printer off, jammed, out of paper) and there is a second printer standing
 * ready, so 'failed' has to become terminal for the DEVICE instead. That is the
 * whole of AckPrintJobRouted's reason to exist, and it is why an escalation is
 * driven from HERE, on the ack, rather than from a deadline: a device that says
 * its printer is jammed must not make the kitchen wait out a 75-second verdict
 * timer for paper that is never coming.
 */
async function ackRoutedPrintJob(
  resId: string,
  jobId: string,
  result: "printed" | "failed",
  from: AckSource,
  assignment: PrintJobAssignmentRow,
): Promise<AckOutcome> {
  // NOTHING IS SYNTHESISED FROM THE ROW. An absent device id and an absent
  // generation are passed through as nulls, which AckPrintJobRouted reads as "not
  // attributable" and "no generation fence" respectively — not as "the current
  // one". Filling them in from the row is what made both fences tautological and
  // let a revoked device's late 'failed' tear down the live assignee (see
  // AckSource). The one case that still moves in a second — an unsigned ack for a
  // job at generation 0 with an empty failed_devices, i.e. the ordinary jammed
  // printer — is recognised inside the statement, where the row is under lock.
  const claimedDevice = typeof from.deviceId === "string" ? from.deviceId.trim() : "";
  const deviceId = claimedDevice.length > 0 ? claimedDevice : null;
  const generation = typeof from.generation === "number" && Number.isFinite(from.generation)
    ? Math.trunc(from.generation)
    : null;

  let routed: RoutedPrintAck;
  try {
    routed = await AckPrintJobRouted(resId, jobId, { deviceId, generation }, result);
  } catch (err) {
    if (isSchemaMissing(err)) {
      warnSchemaMissing("ack_routed", err);
      return { settled: false, duplicate: true };
    }
    if (isRoutingSchemaMissing(err)) {
      // The row carried routing facts and the ack statement says the columns are
      // gone, so a migration was rolled back under a live job. Settle it the old
      // way rather than leaving a printed receipt unrecorded.
      warnRoutingSchemaMissing("ack_routed", err);
      return ackBroadcastPrintJob(resId, jobId, result);
    }
    throw err;
  }

  // THE TIMER MUST DIE WITH THE JOB. Until this call existed, nothing told
  // print_routing.ts that a docket had settled, so the escalation deadline fired
  // on every successfully printed directed job, revoked the device that had just
  // printed it, found an empty chain and re-broadcast the whole payload into the
  // outlet room — where the C# agent, which prints unconditionally and cannot
  // dedup, produced a second copy of the guest's bill.
  //
  // ONLY THE OUTCOMES THAT PROVE THIS CALL SETTLED THE ROW CANCEL. A bare
  // `duplicate` covers two different rows — one settled by somebody else, and one
  // still LIVE whose acking device is merely already in failed_devices — and
  // cancelling the second would strip the live assignee of its deadline.
  if (routed.printed || routed.terminal) {
    await cancelEscalationAfterAck(jobId);
  }

  if (routed.reassign) {
    // THE ROW IS RELEASED AND OWNED BY NOBODY AT THIS INSTANT: status 'pending',
    // assignment cleared, lease cleared. Everything the ladder needs to re-offer
    // it — including its own bytes, so a re-offer never re-renders — is handed
    // over, because the replica that dispatched this job may not be this one.
    await escalateAfterAck(
      resId,
      // `||`, not `??`: the ack statement maps a null outlet_id to the empty
      // string, and an empty outlet routes an emit into a room nobody is in.
      routed.job?.outlet_id || assignment.outlet_id,
      jobId,
      "device_failed",
      // The generation the ROW was at when this ack committed, threaded so that a
      // reassignment which happened between the commit and this call (the accept
      // timer can fire into that window) makes the escalation a no-op instead of
      // burning a second generation and revoking a device that is already
      // spooling.
      routed.generation ?? generation ?? undefined,
      routed,
      deviceId,
      assignment,
    );
  }

  return {
    settled: routed.settled,
    // A superseded ack and an already-settled one are the same thing to the
    // till: stop retrying, nothing here is your problem any more.
    duplicate: routed.duplicate || routed.superseded,
    reassigned: routed.reassign,
    superseded: routed.superseded,
  };
}

/**
 * Stop the ladder watching a job this ack has just settled.
 *
 * A LAZY import, for the reason spelled out on escalateAfterAck below. A failure
 * is swallowed: the row is already terminal, and the worst a surviving timer can
 * now do is one wasted escalation that broadcastRung refuses to emit.
 */
async function cancelEscalationAfterAck(jobId: string): Promise<void> {
  try {
    const { cancelEscalation } = await import("./print_routing.js");
    cancelEscalation(jobId);
  } catch (err) {
    logger.warn({ err, jobId }, "print_cancel_escalation_failed");
  }
}

/**
 * Hand the job to the next device in the chain, here, before this request ends.
 *
 * AWAITED, for two independent reasons. The reassignment's statements have to run
 * while the request's tenant connection is still bound — a floating promise would
 * resume on a connection that had already gone back to the pool, which is the
 * shape of every pool incident this codebase has had. And the point of a device
 * being able to report 'failed' is that the docket moves in about a second
 * instead of waiting out the verdict deadline; not awaiting would put that back
 * in the hands of a timer.
 *
 * A LAZY import because print_routing.ts imports THIS module for the degradation
 * helpers above. A static import in both directions is a cycle, and ESM resolves
 * a cycle by handing one side a half-initialised module — here that would be a
 * `logger`-less print_jobs or an `escalatePrintJob` that is still undefined at
 * the moment the first receipt is acked.
 *
 * THE ROW IS PASSED BECAUSE THE REGISTRY IS PER-REPLICA AND THIS IS HTTP. The
 * escalation used to be given a job id and nothing else, and print_routing
 * returned silently when it held no entry for it — which is the NORMAL case on
 * any multi-replica deploy (the device's socket and its ack need not land on the
 * same box) and happens on one replica too, after any restart between dispatch
 * and a ~62-second 'failed' ack. By then AckPrintJobRouted has already released
 * the row: 'pending', unassigned, unleased, un-emitted, and owned by nobody. The
 * comment that used to sit here claimed three backstops covered that, and none of
 * them did — runPrintOrphanSweep iterates the dispatching replica's own registry
 * and cannot see a job it never dispatched, and the 15-minute reaper does not
 * print anything, it EXPIRES it. Handing the row over lets any replica adopt the
 * docket and run the ladder to a new device or to the outlet-wide broadcast.
 *
 * A failure is logged and swallowed. The ack itself already landed; the paper
 * either came out or it did not, and telling a till its ack failed only makes it
 * retry the ACK. The one real backstop for a swallowed failure here is the
 * reconnect claim predicate — the reaper's answer to a job nobody printed is
 * 'expired', not paper.
 */
async function escalateAfterAck(
  resId: string,
  outletId: string,
  jobId: string,
  reason: string,
  atGeneration: number | undefined,
  routed: RoutedPrintAck,
  fromDeviceId: string | null,
  assignment: PrintJobAssignmentRow,
): Promise<void> {
  try {
    const { escalatePrintJob } = await import("./print_routing.js");
    const job = routed.job;
    await escalatePrintJob(
      resId,
      outletId,
      jobId,
      reason,
      atGeneration,
      // Only when the statement actually returned the row's contents. Without the
      // bytes there is nothing to re-offer, and re-rendering is forbidden: it
      // would mint a second KOT number, or a bill carrying figures the guest was
      // never shown.
      job
        ? {
          billId: job.bill_id,
          escBase64: job.esc_base64,
          kind: job.kind === "kot" ? "kot" : "bill",
          station: job.station,
          destinationId: job.destination_id ?? assignment.destination_id,
          generation: routed.generation ?? assignment.assign_generation ?? 0,
          failedDevices: routed.failed_devices,
          fromDeviceId,
        }
        : undefined,
    );
  } catch (err) {
    logger.warn({ err, resId, outletId, jobId, reason }, "print_escalate_after_ack_failed");
  }
}

// --- reaper ------------------------------------------------------------------

/**
 * Hygiene, on a timer. Two statements per tenant:
 *
 *   1. flip outstanding-but-expired jobs to 'expired', so "this till missed N
 *      receipts" is a queryable fact rather than a row that quietly stopped
 *      matching a predicate;
 *   2. delete settled rows past the retention window, so a table holding rendered
 *      receipts does not grow without bound.
 *
 * NEITHER IS A CORRECTNESS DEPENDENCY. The TTL that stops a stale docket printing
 * is the read-time predicate inside ClaimPrintJobsForAgent; if this sweep never
 * runs, nothing is replayed that should not be. That is why it is safe to let it
 * bail out on the first tenant when the table is missing.
 *
 * Per-tenant withTenant, matching the exception sweep in index.ts — there is no
 * cross-replica leader lock on the tenant pool, and none is needed: both
 * statements are idempotent and two replicas racing them converge.
 */
export async function runPrintJobReaperSweep(): Promise<void> {
  const cutoffs = ttlCutoffs();
  const retention = new Date(Date.now() - RETENTION_DAYS() * 24 * 60 * MIN);
  const tenantIds = await ListRestaurantIds();
  for (const resId of tenantIds) {
    try {
      await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
        const expired = await ExpirePrintJobs(resId, cutoffs);
        const purged = await PurgeSettledPrintJobs(resId, retention, PURGE_LIMIT());
        if (expired > 0 || purged > 0) {
          logger.info({ resId, expired, purged }, "print_job_reaper_swept");
        }
        if (expired > 0) {
          // Every expired job is a receipt a customer never got. Worth its own
          // line at warn, because it is the only place that fact surfaces until
          // printer-down alerting lands.
          logger.warn({ resId, expired }, "print_jobs_expired_undelivered");
        }
      });
    } catch (err) {
      if (isSchemaMissing(err)) {
        // Same table for every tenant — one failure means all of them.
        warnSchemaMissing("reaper", err);
        return;
      }
      logger.warn({ err, resId }, "print_job_reaper_tenant_failed");
    }
  }
}
