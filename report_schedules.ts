// Scheduled report delivery — the background sweep.
//
// Orchestration only: every database statement lives in database_supabase.ts
// behind a named export (runQuery is module-private there, deliberately), and
// every byte of CSV comes from report_render.ts.
//
// THE SHAPE OF THIS FILE IS LOAD-BEARING. Two rules cost real money if broken:
//
//  1) Pass A collects RAW ROWS and nothing else. It runs under an empty outlet,
//     where resolveRestaurantContext cannot resolve a real one, so any decision
//     taken there — which day is "today", which occurrence is due, what period it
//     covers — would be taken in the wrong zone for the wrong branch. All of that
//     happens per-schedule, bound to the schedule's own outlet_id.
//
//  2) withTenant is RE-ENTRANT (database_supabase.ts:1460-1462): a nested call
//     with a different outlet_id is SILENTLY IGNORED and the outer context is
//     kept. So the per-schedule transactions must never be nested inside pass A.
//     Nesting them does not fail — it quietly reports the oldest outlet's numbers
//     as the whole business.

import { randomUUID } from "node:crypto";
import {
  ListRestaurantIds,
  GetRestaurantAccountStatus,
  GetTenantTimezone,
  ListDueReportSchedules,
  ListRetryableReportDeliveries,
  ReapExhaustedReportDeliveries,
  ClaimReportOccurrence,
  TakeReportDeliveryAttempt,
  MarkReportDeliveryRendered,
  DeliverReportToInbox,
  MarkReportDelivered,
  RecordReportDeliveryFailure,
  TouchReportScheduleOutcome,
  GetSalesReport,
  GetGstReport,
  GetProfitAndLoss,
  AddNotification,
  withTenant,
  isAllOutlets,
  dayKeyOf,
  addDaysToKey,
  weekdayOfDayKey,
  zonedWallToUtc,
  zonedClockParts,
  REPORT_MAX_ATTEMPTS,
  type DueReportSchedule,
  type RetryableReportDelivery,
  type SalesReport,
  type GstReport,
  type ProfitAndLoss,
} from "./database_supabase.js";
import { renderReport, REPORT_LABELS, type ReportKey, type ReportFormat } from "./report_render.js";
import { sendMail, normalizeRecipients, isMailNotConfiguredError } from "./mailer.js";
import { logger } from "./observability.js";

// Diagnostic only. Written to ReportDeliveries.claimed_by so a stuck row names
// the process that touched it last; NO guard reads it. The guards are the partial
// unique index and the attempts compare-and-swap, both of which work across
// replicas that know nothing about each other.
const WORKER_ID = randomUUID();

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** How long a claimed/attempted row is off-limits to other replicas. */
const LEASE_MS = (): number => envInt("REPORT_ATTEMPT_LEASE_MIN", 10) * 60_000;
/** Past this much lateness an occurrence is recorded rather than run: a report
 *  that arrives half a day late with yesterday's numbers is worse than a visible
 *  "this one was missed". */
const CATCHUP_MS = (): number => envInt("REPORT_CATCHUP_MINUTES", 360) * 60_000;
const ARTIFACT_MAX_BYTES = (): number => envInt("REPORT_ARTIFACT_MAX_BYTES", 524_288);

/** REPORT_LABELS is keyed on the three report_keys migration 026 admits; a row
 *  carrying anything else falls back to the tenant's own name for the schedule. */
function reportLabel(reportKey: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(REPORT_LABELS, reportKey)
    ? REPORT_LABELS[reportKey as ReportKey]
    : fallback;
}

/** Retry backoff per FAILED attempt. Applied only on a recorded failure — an
 *  attempt in flight holds a lease instead (see TakeReportDeliveryAttempt). */
const BACKOFF_MIN = [5, 30, 120];

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ScheduleShape {
  frequency: string;
  hour_local: number;
  minute_local: number;
  weekday: number | null;
  day_of_month: number | null;
  created_at: Date;
}

export interface DueOccurrence {
  occurrence_key: string;
  fire_at: Date;
  period_from: string;
  period_to: string;
  status: "claimed" | "abandoned";
}

/** Does this schedule fire on the tenant-local calendar day `key`? */
export function occursOn(s: Pick<ScheduleShape, "frequency" | "weekday" | "day_of_month">, key: string): boolean {
  if (s.frequency === "daily") { return true; }
  if (s.frequency === "weekly") { return weekdayOfDayKey(key) === s.weekday; }
  return Number(key.slice(8, 10)) === s.day_of_month;   // monthly
}

/** The UTC instant at which the schedule's local fire time occurs on `dayKey`. */
export function fireInstant(dayKey: string, hourLocal: number, minuteLocal: number, tz: string): Date {
  const m = DAY_KEY_RE.exec(dayKey);
  if (!m) { return new Date(NaN); }
  // zonedWallToUtc takes a 1-INDEXED month and does the -1 itself
  // (database_supabase.ts:696). Number(m[2]) is already 1-12 — subtracting 1 here
  // is the bug that once shifted every report back by a whole month.
  return zonedWallToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hourLocal, minuteLocal, tz);
}

/**
 * The business period a run on `fireDayKey` reports on — always CLOSED days, never
 * the day in progress.
 *
 * Pure day-key arithmetic. addDaysToKey is Date.UTC(Y, M-1, D + days)
 * (database_supabase.ts:13146), so month, year and leap-February rollover
 * normalize for free, and normalizeReportRange (:13186) takes a bare YYYY-MM-DD
 * literally and builds zone-midnight bounds from it — so day keys are exactly
 * what the report functions want.
 */
export function periodFor(frequency: string, fireDayKey: string): { from: string; to: string } {
  if (frequency === "daily") {
    const d = addDaysToKey(fireDayKey, -1);            // yesterday's business day
    return { from: d, to: d };
  }
  if (frequency === "weekly") {
    const to = addDaysToKey(fireDayKey, -1);           // the 7 local days ending yesterday
    return { from: addDaysToKey(to, -6), to };
  }
  // monthly: the whole PREVIOUS calendar month.
  const firstOfThisMonth = `${fireDayKey.slice(0, 7)}-01`;
  const to = addDaysToKey(firstOfThisMonth, -1);
  return { from: `${to.slice(0, 7)}-01`, to };
}

/**
 * Which occurrences of `schedule` are due at `now`, in the tenant's zone.
 *
 * TWO candidate day keys, today and yesterday: with a 23:30 fire time and a
 * catch-up window, "now" is frequently already the next local day, and scanning
 * only today would drop last night's report silently.
 *
 * The created_at FLOOR is not optional. Without it, creating a daily 08:00
 * schedule at 09:00 local immediately claims yesterday's 08:00 — which is past
 * the catch-up window, so the tenant's first ever interaction with the feature is
 * a report recorded as missed for a day the schedule did not exist.
 */
export function dueOccurrences(schedule: ScheduleShape, tz: string, now: Date, catchupMs: number): DueOccurrence[] {
  const out: DueOccurrence[] = [];
  const todayKey = dayKeyOf(now, tz);
  const createdAt = schedule.created_at instanceof Date ? schedule.created_at : new Date(schedule.created_at);
  for (const key of [todayKey, addDaysToKey(todayKey, -1)]) {
    if (!occursOn(schedule, key)) { continue; }
    const fireAt = fireInstant(key, schedule.hour_local, schedule.minute_local, tz);
    if (Number.isNaN(fireAt.getTime()) || now.getTime() < fireAt.getTime()) { continue; }
    if (!Number.isNaN(createdAt.getTime()) && fireAt.getTime() < createdAt.getTime()) { continue; }
    const period = periodFor(schedule.frequency, key);
    out.push({
      occurrence_key: key,
      fire_at: fireAt,
      period_from: period.from,
      period_to: period.to,
      status: now.getTime() - fireAt.getTime() > catchupMs ? "abandoned" : "claimed",
    });
  }
  return out;
}

/** One occurrence this process is about to work on. `attempts` is the CAS token:
 *  the value the row is expected to still hold when the attempt is taken. */
interface PendingDelivery {
  delivery_id: string;
  schedule_id: string;
  outlet_id: string;
  occurrence_key: string | null;
  period_from: string;
  period_to: string;
  timezone: string;
  attempts: number;
  name: string;
  report_key: string;
  format: string;
  /** The channel the occurrence was CLAIMED on, not the schedule's current one:
   *  an in-flight delivery must be routed the way it was accepted. */
  channel: string | null;
  /** The schedule's CURRENT addresses (migration 044). Deliberately live rather
   *  than claimed — see ListRetryableReportDeliveries' query comment. */
  recipients: string[];
}

export async function runReportScheduleSweep(now: Date = new Date()): Promise<void> {
  const tenantIds = await ListRestaurantIds();
  for (const resId of tenantIds) {
    // One tenant's failure must not end the sweep for everyone after it.
    try { await sweepTenant(resId, now); }
    catch (err) { logger.warn({ err, resId }, "report_sweep_tenant_failed"); }
  }
}

async function sweepTenant(resId: string, now: Date): Promise<void> {
  // Both of these run OUTSIDE every transaction, on purpose. Each recovers from a
  // missing column / an undeployed control plane by returning a default, and a
  // caught error inside withTenant's transaction (:1474) would leave that
  // transaction aborted — every following statement returning 25P02 — rather than
  // recovered. On the raw pool they are autocommit, so the recovery is real.
  const status = await GetRestaurantAccountStatus(resId);
  // An explicit product decision, made visibly: a suspended tenant stops
  // receiving reports rather than accruing a backlog of them.
  if (status !== "active") { return; }
  const tz = await GetTenantTimezone(resId);

  // PASS A — collect raw rows only. An empty outlet_id is correct HERE AND ONLY
  // HERE: these three readers are res_id-scoped by design (see the group header
  // in database_supabase.ts) and RLS keys solely on app.res_id.
  let schedules: DueReportSchedule[] = [];
  let retryable: RetryableReportDelivery[] = [];
  await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
    await ReapExhaustedReportDeliveries(resId);
    schedules = await ListDueReportSchedules(resId);
    retryable = await ListRetryableReportDeliveries(resId);
  });

  // PASS B — one transaction per schedule, bound to that schedule's real outlet.
  // NEVER nested inside pass A: see rule 2 in the file header.
  const pending: PendingDelivery[] = retryable.map((r) => ({
    delivery_id: r.id,
    schedule_id: r.schedule_id,
    outlet_id: r.outlet_id,
    recipients: r.recipients ?? [],
    occurrence_key: r.occurrence_key,
    period_from: r.period_from,
    period_to: r.period_to,
    timezone: r.timezone,
    attempts: r.attempts,
    name: r.name,
    report_key: r.report_key,
    format: r.format,
    channel: r.channel,
  }));

  for (const schedule of schedules) {
    try { pending.push(...await claimDueOccurrences(resId, schedule, tz, now)); }
    catch (err) { logger.warn({ err, resId, scheduleId: schedule.id }, "report_claim_failed"); }
  }

  for (const p of pending) {
    try { await runOccurrence(resId, p); }
    catch (err) { logger.warn({ err, resId, deliveryId: p.delivery_id }, "report_occurrence_failed"); }
  }
}

/**
 * TX1 — decide and claim, inside a transaction bound to the schedule's outlet.
 *
 * The claim must commit before anything else happens to the row: a crash between
 * deciding and claiming loses nothing, a crash between rendering and claiming
 * would lose the only thing that stops a second replica repeating the work.
 */
async function claimDueOccurrences(
  resId: string,
  schedule: DueReportSchedule,
  tz: string,
  now: Date,
): Promise<PendingDelivery[]> {
  const claimed: PendingDelivery[] = [];
  await withTenant(
    { res_id: resId, outlet_id: schedule.outlet_id, employeeId: "", role: "" },
    async () => {
      for (const occ of dueOccurrences(schedule, tz, now, CATCHUP_MS())) {
        const deliveryId = await ClaimReportOccurrence(resId, {
          schedule_id: schedule.id,
          outlet_id: schedule.outlet_id,
          occurrence_key: occ.occurrence_key,
          fire_at: occ.fire_at,
          period_from: occ.period_from,
          period_to: occ.period_to,
          timezone: tz,
          claimed_by: WORKER_ID,
          status: occ.status,
          channel: schedule.channel,
          next_attempt_at: new Date(now.getTime() + LEASE_MS()),
        });
        // null => another tick or another replica owns it. Do nothing, say nothing.
        if (!deliveryId) { continue; }
        if (occ.status === "abandoned") {
          logger.warn(
            { resId, scheduleId: schedule.id, occurrenceKey: occ.occurrence_key },
            "report_occurrence_abandoned",
          );
          continue;
        }
        claimed.push({
          delivery_id: deliveryId,
          schedule_id: schedule.id,
          outlet_id: schedule.outlet_id,
          occurrence_key: occ.occurrence_key,
          period_from: occ.period_from,
          period_to: occ.period_to,
          timezone: tz,
          attempts: 0,
          name: schedule.name,
          report_key: schedule.report_key,
          format: schedule.format,
          channel: schedule.channel,
          recipients: schedule.recipients ?? [],
        });
      }
    },
  );
  return claimed;
}

/**
 * TX2 (take the attempt), TX3 (render), TX4 (deliver + record) — three separate
 * transactions, each bound to the schedule's outlet and none nested.
 *
 * Separate because withTenant holds a pooled client for the whole callback, and
 * because an aborted render must cost one attempt rather than un-claiming the
 * occurrence.
 */
async function runOccurrence(resId: string, p: PendingDelivery): Promise<void> {
  const ctx = { res_id: resId, outlet_id: p.outlet_id, employeeId: "", role: "" };

  // TX2 — commits BEFORE any work is done, because a guard that has not committed
  // guards nothing.
  const attempts = await withTenant(ctx, () =>
    TakeReportDeliveryAttempt(resId, p.delivery_id, p.attempts, new Date(Date.now() + LEASE_MS()), WORKER_ID));
  if (attempts === null) { return; }   // another worker holds this attempt

  try {
    // 'inbox' and 'email' are the channels with a sender behind them — migration
    // 044 widened 026's CHECK and landed mailer.ts in the same change, keeping
    // 026's rule that nothing is storable before something implements it.
    // Anything else is a recorded failure the owner can see rather than a report
    // that silently goes to the bell instead of wherever it was addressed.
    // INSIDE the try on purpose — an attempt has already been taken, so throwing
    // before TX2 would leave the row at 'claimed' with attempts untouched,
    // retried every tick forever and never reaped
    // (ReapExhaustedReportDeliveries needs attempts >= REPORT_MAX_ATTEMPTS).
    if (p.channel !== "inbox" && p.channel !== "email") {
      throw new Error(`Unsupported report channel: ${String(p.channel)}`);
    }

    const artifact = await withTenant(ctx, async () => {
      // isAllOutlets flips getSettledBills / GetExpenses / GetDiscountsReport from
      // `outlet_id = $2` to a whole-restaurant read, so a per-outlet schedule
      // would silently start reporting every branch. The sweep never sets it —
      // this catches a future caller that reaches runOccurrence from inside an
      // all-outlets HTTP request, where withTenant's re-entrancy guard would hand
      // us that request's context instead of ours.
      if (isAllOutlets()) { throw new Error("Scheduled reports must run on a single outlet"); }
      const payload = await runReportFor(p.report_key, resId, p.period_from, p.period_to);
      const rendered = renderReport(
        p.report_key as ReportKey,
        p.format as ReportFormat,
        payload,
        { periodFrom: p.period_from, periodTo: p.period_to },
        ARTIFACT_MAX_BYTES(),
      );
      await MarkReportDeliveryRendered(resId, p.delivery_id, attempts, rendered);
      return rendered;
    });

    // artifact_bytes stores the POST-cut size, so this log is the only place the
    // original size survives — without it "the file looks short" has no evidence.
    if (artifact.truncated) {
      logger.warn(
        { resId, deliveryId: p.delivery_id, bytes: artifact.bytes, bytesBeforeTruncation: artifact.bytes_before_truncation },
        "report_artifact_truncated",
      );
    }

    const period = p.period_from === p.period_to ? p.period_from : `${p.period_from} to ${p.period_to}`;
    const title = `${reportLabel(p.report_key, p.name)} ready — ${period}`;

    // THE SEND HAPPENS BEFORE THE ROW IS MARKED DELIVERED, and it happens
    // OUTSIDE withTenant.
    //
    // Outside, because withTenant holds a pooled database client for the whole
    // callback and an SMTP round trip is a network call to somebody else's
    // server. Holding a connection from a pool of fifteen open across it is how
    // this project produced a full standstill once already; mailer.ts bounds the
    // call, but a bounded twenty seconds of a pooled client is still twenty
    // seconds nobody else can have.
    //
    // Before, because a row marked 'delivered' for mail that never left is the
    // same defect as a print job that acked paper nobody printed — which has
    // also already shipped here. A throw lands in the catch below, records a
    // real failure with a real reason, and the occurrence is retried.
    let deliveredTo: string[] = [];
    if (p.channel === "email") {
      const to = normalizeRecipients(p.recipients);
      if (to.length === 0) {
        // Migration 044's CHECK normally makes this unreachable. It stays because
        // the CHECK guards the SCHEDULE and this reads a list that may have been
        // edited since, and because a delivery that renders a restaurant's
        // takings and then has nowhere to send them must fail loudly.
        throw new Error("This email schedule has no valid recipient address.");
      }
      const sent = await sendMail({
        to,
        subject: title,
        text:
          `${reportLabel(p.report_key, p.name)}\n`
          + `Period: ${period}\n\n`
          + `The report is attached as ${artifact.filename}.\n`
          + `It is also available in the dashboard under Accounting → Scheduled reports.\n`,
        attachments: [{
          filename: artifact.filename,
          content: artifact.body,
          contentType: artifact.mime,
        }],
      }).catch((err: unknown) => {
        // Named so the failure row says something an owner can act on. An
        // unconfigured deployment is not a transient fault and saying "connection
        // refused" would send them hunting for a network problem that is not
        // there.
        if (isMailNotConfiguredError(err)) {
          throw new Error(
            "Email delivery is not configured on this server, so this report could not be sent."
            + " Ask your administrator to set up the mail settings, or switch this schedule to the in-app inbox.",
          );
        }
        throw err;
      });
      deliveredTo = sent.accepted.length > 0 ? sent.accepted : to;
    }

    // TX4 — the CAS and the notification commit together or not at all.
    await withTenant(ctx, () => MarkReportDelivered(resId, {
      deliveryId: p.delivery_id,
      attempts,
      scheduleId: p.schedule_id,
      occurrenceKey: p.occurrence_key,
      channel: p.channel === "email" ? "email" : "inbox",
      deliveredTo,
      title,
      // NO FIGURES, on either channel. GET /notifications is readable by every
      // authenticated employee — see MarkReportDelivered's docstring. The
      // ADDRESSES are named on the email path because the owner reading the bell
      // is entitled to know where their takings went, and they are the only
      // person who can notice that one of them is wrong.
      body: p.channel === "email"
        ? `Emailed to ${deliveredTo.join(", ")} as ${artifact.filename}.`
        : `Open Accounting → Scheduled reports to download ${artifact.filename}.`,
    }));
  } catch (err) {
    await recordFailure(resId, p, attempts, err);
    return;
  }

  // TX4 HAS COMMITTED — the report was delivered and the bell is in the tenant's
  // inbox. Everything below is bookkeeping on the schedule CARD, and a failure
  // here must never be reported as a delivery failure: inside the try above it
  // would stamp last_status='failed' on an occurrence whose own row reads
  // 'delivered', push consecutive_failures toward the auto-disable at
  // REPORT_SCHEDULE_FAILURE_LIMIT, and on the last attempt raise a "could not be
  // delivered" bell for a report the owner has already received.
  try {
    await withTenant(ctx, () => TouchReportScheduleOutcome(resId, p.schedule_id, {
      occurrence_key: p.occurrence_key,
      status: "delivered",
      error: null,
    }));
  } catch (err) {
    logger.warn({ err, resId, deliveryId: p.delivery_id, scheduleId: p.schedule_id }, "report_outcome_touch_failed");
  }
}

async function runReportFor(
  reportKey: string,
  resId: string,
  from: string,
  to: string,
): Promise<SalesReport | GstReport | ProfitAndLoss> {
  // Positional (restaurantId, fromIso?, toIso?) on all three, and all three scope
  // through normalizeReportRange in the tenant's zone. Report families that do not
  // (GetPayroll's YYYY-MM period, GetBalanceSheet's single as-of date, the
  // analytics readers' UTC/interval windows) are excluded by migration 026's
  // report_key CHECK rather than mis-scoped here.
  switch (reportKey) {
    case "sales": return GetSalesReport(resId, from, to);
    case "gst":   return GetGstReport(resId, from, to);
    case "pnl":   return GetProfitAndLoss(resId, from, to);
    default: throw new Error(`Unsupported report_key: ${reportKey}`);
  }
}

async function recordFailure(resId: string, p: PendingDelivery, attempts: number, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const backoffMs = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000;
  const final = attempts >= REPORT_MAX_ATTEMPTS;
  const ctx = { res_id: resId, outlet_id: p.outlet_id, employeeId: "", role: "" };

  try {
    await withTenant(ctx, () =>
      RecordReportDeliveryFailure(resId, p.delivery_id, attempts, new Date(Date.now() + backoffMs), message));
  } catch (writeErr) {
    logger.error({ err: writeErr, resId, deliveryId: p.delivery_id }, "report_failure_record_failed");
  }
  logger.warn({ resId, deliveryId: p.delivery_id, attempts, err: message }, "report_delivery_failed");
  if (!final) { return; }

  // Only the LAST failure reaches the owner. Pinging the bell on every transient
  // retry is how a person learns to ignore the bell.
  try {
    await withTenant(ctx, async () => {
      const outcome = await TouchReportScheduleOutcome(resId, p.schedule_id, {
        occurrence_key: p.occurrence_key,
        status: "failed",
        error: message,
      });
      // AddNotification throws (unlike sendMessage). Inside TX4 that is what we
      // want; here it must not roll back the outcome record, so it is separate and
      // wrapped by the caller's catch.
      await AddNotification(resId, {
        type: "report",
        title: `${reportLabel(p.report_key, p.name)} could not be delivered`,
        body: outcome.auto_disabled
          ? `${p.name} has been switched off after repeated failures. Re-enable it in Accounting → Scheduled reports.`
          : `${p.name} failed for ${p.period_from}. See Accounting → Scheduled reports.`,
        meta: { module: "Accounting", schedule_id: p.schedule_id, occurrence_key: p.occurrence_key },
      });
    });
  } catch (notifyErr) {
    logger.warn({ err: notifyErr, resId, scheduleId: p.schedule_id }, "report_failure_notify_failed");
  }
}

/**
 * The dedup key a manual "run now" claims: the tenant-local MINUTE it was
 * requested in, prefixed so it can never be mistaken for — or collide with — a
 * scheduled occurrence, whose keys are bare 'YYYY-MM-DD' day keys.
 *
 * A null key was the original design and it deduplicated nothing: the unique
 * index is PARTIAL (`where occurrence_key is not null`, 026:165-167), so a null
 * can never conflict, every click inserted a row, and twenty clicks meant twenty
 * full report renders and twenty identical bell notifications for one period.
 *
 * Bucketed to the minute, not to the day, because "run it again" a minute later
 * is a legitimate thing to want after fixing the data the report reads. In the
 * TENANT's zone rather than UTC so the bucket a click falls in is the one the
 * person clicking is living in.
 */
export function manualOccurrenceKey(now: Date, tz: string): string {
  const parts = zonedClockParts(now, tz);
  // zonedClockParts returns null only for an unparseable instant. Falling back to
  // the UTC ISO minute keeps the key non-null — a manual run that silently lost
  // its dedup key is the defect this function exists to remove.
  const stamp = parts
    ? `${parts.key}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`
    : now.toISOString().slice(0, 16);
  return `manual:${stamp}`;
}

/**
 * "Run now": claim an EXTRA occurrence under a `manual:`-prefixed key, so it
 * neither collides with nor consumes the scheduled one, and let the next sweep
 * tick run it. Returns null when this minute's manual run is already claimed —
 * which is what the route's 409 reports.
 *
 * Deliberately does NOT render inline. This route is served on the request's own
 * tenant connection, whose bound outlet is the CALLER's, and withTenant is
 * re-entrant — so an inline render would silently report the caller's outlet even
 * when the schedule belongs to another. Queueing it means there is exactly one
 * code path that ever produces a report, and it is the one bound to the
 * schedule's own outlet.
 */
export async function queueReportScheduleRun(
  resId: string,
  schedule: { id: string; outlet_id: string; frequency: string; channel: string },
  tz: string,
  now: Date = new Date(),
): Promise<string | null> {
  const period = periodFor(schedule.frequency, dayKeyOf(now, tz));
  return ClaimReportOccurrence(resId, {
    schedule_id: schedule.id,
    outlet_id: schedule.outlet_id,
    occurrence_key: manualOccurrenceKey(now, tz),
    fire_at: now,
    period_from: period.from,
    period_to: period.to,
    timezone: tz,
    claimed_by: WORKER_ID,
    status: "claimed",
    channel: schedule.channel,
    // Eligible immediately, so the next tick picks it up rather than waiting out
    // a lease the caller is not holding.
    next_attempt_at: now,
  });
}
