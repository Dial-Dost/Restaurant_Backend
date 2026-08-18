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
  ClaimPrintJobsForAgent,
  EnqueuePrintJob,
  ExpirePrintJobs,
  ListRestaurantIds,
  OutletBelongsToRestaurant,
  PurgeSettledPrintJobs,
  withTenant,
  type PrintJobInput,
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

// --- migration-not-applied tolerance ----------------------------------------

/** 42P01 undefined_table, 42501 insufficient_privilege — i.e. migration 027 has
 *  not run, or ran without the app_runtime grants. Nothing else qualifies. */
function isSchemaMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42501";
}

let schemaWarnedAt = 0;
/** Loud, but not once per receipt: an unmigrated deployment prints all day. */
function warnSchemaMissing(where: string, err: unknown): void {
  const now = Date.now();
  if (now - schemaWarnedAt < 10 * MIN) { return; }
  schemaWarnedAt = now;
  logger.error(
    { err, where },
    'print job durability is OFF — "PrintJobs" is unreadable (apply migration 027). ' +
      "Printing continues fire-and-forget: a bill emitted while a till is offline is lost.",
  );
}

// --- the wire payload --------------------------------------------------------

export interface PrintJobPayloadInput {
  billId: string;
  escBase64: string;
  kind: "bill" | "kot";
  station?: string | null;
  /** null when the job could not be persisted — see the degradation rule. */
  jobId: string | null;
  publishedAt: string;
  replay?: boolean;
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
        );
      },
    );
  } catch (err) {
    if (isSchemaMissing(err)) { warnSchemaMissing("resume", err); return 0; }
    logger.error({ err, resId: req.resId, outletId: req.outletId }, "print_resume_failed");
    return 0;
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
 */
export async function ackPrintJob(
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
