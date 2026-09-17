// Scheduled report delivery — the background sweep, and the worker every report
// email runs through (a schedule's occurrence, its Run now, and Send now).
//
// Orchestration only: every database statement lives in database_supabase.ts
// behind a named export (runQuery is module-private there, deliberately), every
// byte of a 2.0.1 inbox CSV comes from report_render.ts, every bundle file from
// report_bundle.ts, and every word of an email from report_email_content.ts.
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
//
// AND FOUR MORE since item 9 (report email automation):
//
//  3) NO CONNECTION IS HELD WHILE MAIL IS SENT. Every message goes out between
//     transactions; each address's outcome is committed on its own, straight
//     after its send, so a crash loses at most the one in flight.
//  4) 'sending' IS COMMITTED BEFORE THE FIRST MESSAGE. A process that dies
//     mid-send leaves a visible row; the retry sends only to the addresses not
//     yet recorded, with the same Message-ID, and the history says a duplicate
//     is possible. For SMTP "at least once" is the honest guarantee.
//  5) NOTHING IS CLAIMED FOR EMAIL WITHOUT A TRANSPORT, and a process without
//     one never takes an attempt on an email row: an unconfigured box (a
//     laptop pointed at the cloud database) must not burn the owner's retries.
//  6) ONE SWEEPER. Each tick takes the single-row lease first; the sweep runs
//     only in production (or where REPORT_SCHEDULER_ALLOW_NON_PROD says so), and
//     only once migration 058 is in place.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
  reportEmailSchemaReady,
  reportEmailWindowIn,
  runOutsideTenantContext,
  AcquireReportSweepLease,
  ClaimReportPurgeDay,
  PurgeReportDeliveryFileBodies,
  StoreReportDeliveryFiles,
  LoadReportDeliveryFiles,
  MarkReportDeliverySending,
  RecordReportRecipientOutcome,
  ReportEmailBookStatus,
  CountRecentReportEmails,
  PeekPlatformReportEmails,
  AddPlatformReportEmails,
  GetRunnableReportDelivery,
  ListOrphanAdhocDeliveries,
  NotifyReportOnce,
  GetReportEmailIdentity,
  normalizeEmailKey,
  type DueReportSchedule,
  type RetryableReportDelivery,
  type RenderedReportFile,
  type SalesReport,
  type GstReport,
  type ProfitAndLoss,
} from "./database_supabase.js";
import { renderReport, REPORT_LABELS, type ReportKey, type ReportFormat } from "./report_render.js";
import {
  addressTag,
  isMailNotConfiguredError,
  mailTransportStatus,
  readMailTransport,
  scrubAddresses,
  sendReportMessage,
  stableMessageId,
  normalizeRecipients,
  type SendOptions,
} from "./mailer.js";
import { renderReportBundle, type BundleIdentity } from "./report_bundle.js";
import { buildReportEmail, buildTestEmail, dayLabel, sentBellBody, sentBellTitle, type ReportHeadline } from "./report_email_content.js";
import { REPORT_KEYS as CATALOGUE_KEYS, reportListPhrase } from "./report_catalogue.js";
import { formatClock, tradingBusinessDate } from "./report_window.js";
import { logger } from "./observability.js";

// Diagnostic, and since item 9 the LEASE holder: ReportDeliveries.claimed_by
// names the process that touched a row last (no guard reads it), and
// "ReportSweepLease".holder names the one process allowed to sweep. The
// at-most-once guards are still the partial unique index and the attempts
// compare-and-swap, both of which work across replicas that know nothing
// about each other.
const WORKER_ID = randomUUID();
const HOST = hostname();

/** This process's lease identity, for GET /reports/email/config. */
export function reportWorkerId(): string {
  return WORKER_ID;
}

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
/** Every attachment of one email together, before encoding. */
export const ATTACH_MAX_BYTES = (): number => envInt("REPORT_EMAIL_MAX_ATTACH_BYTES", 5_242_880);
/** Messages one restaurant's reports may be accepted for in 24 hours. */
export const TENANT_DAILY_CAP = (): number => envInt("REPORT_EMAIL_TENANT_DAILY_CAP", 200);
/** …and the whole platform, per server day. */
export const PLATFORM_DAILY_CAP = (): number => envInt("REPORT_EMAIL_PLATFORM_DAILY_CAP", 2000);
/** Days a stored attachment body is kept before the nightly purge. */
const RETENTION_DAYS = (): number => envInt("REPORT_ARTIFACT_RETENTION_DAYS", 90);
/** How long one sweep holds the leader lease (renewed every tick). */
const SWEEP_LEASE_MIN = (): number => envInt("REPORT_SWEEP_LEASE_MIN", 4);
/** How far back the boot scan looks for a Send now a dead process left behind. */
const ORPHAN_MAX_AGE_MIN = 60;

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

/**
 * May THIS process run the scheduled sweep at all?
 *
 * REPORT_SCHEDULER=true arms it (index.ts), and production is where it may run.
 * The laptop development stack points at the CLOUD database; a sweep there would
 * claim production's occurrences and — with no mail transport — burn their
 * attempts and switch the owner's schedules off. REPORT_SCHEDULER_ALLOW_NON_PROD
 * is the deliberate override for a local database.
 */
export function schedulerPermitted(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason: string | null } {
  if (String(env.REPORT_SCHEDULER ?? "").trim() !== "true") {
    return { ok: false, reason: "REPORT_SCHEDULER is not set to true on this server." };
  }
  const prod = String(env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  if (!prod && String(env.REPORT_SCHEDULER_ALLOW_NON_PROD ?? "").trim() !== "true") {
    return { ok: false, reason: "The scheduled sweep only runs with NODE_ENV=production (set REPORT_SCHEDULER_ALLOW_NON_PROD=true for a local database)." };
  }
  return { ok: true, reason: null };
}

export interface ScheduleShape {
  frequency: string;
  hour_local: number;
  minute_local: number;
  weekday: number | null;
  day_of_month: number | null;
  created_at: Date;
  /** Migration 057. Absent reads as 'calendar', what every older row is. */
  window_mode?: string;
}

export interface DueOccurrence {
  occurrence_key: string;
  fire_at: Date;
  period_from: string;
  period_to: string;
  /** "HH:mm" when the occurrence reports a trading day, null for calendar days. */
  day_close: string | null;
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
 * The period one occurrence covers, for either kind of day.
 *
 * A TRADING-DAY schedule sends at its day's close and reports the 24 hours
 * that just ended (report_window.ts): 02:00 on the 18th reports business date
 * the 17th, 23:30 on the 17th reports the 17th. Everything else is periodFor.
 */
export function occurrencePeriod(
  s: Pick<ScheduleShape, "frequency" | "hour_local" | "minute_local" | "window_mode">,
  fireDayKey: string,
): { from: string; to: string; day_close: string | null } {
  if (s.window_mode === "trading_day" && s.frequency === "daily") {
    const close = s.hour_local * 60 + s.minute_local;
    const k = tradingBusinessDate(fireDayKey, close);
    // A 00:00 close is the calendar day, and says so by carrying no close.
    return { from: k, to: k, day_close: close === 0 ? null : formatClock(close) };
  }
  return { ...periodFor(s.frequency, fireDayKey), day_close: null };
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
    const period = occurrencePeriod(schedule, key);
    out.push({
      occurrence_key: key,
      fire_at: fireAt,
      period_from: period.from,
      period_to: period.to,
      day_close: period.day_close,
      status: now.getTime() - fireAt.getTime() > catchupMs ? "abandoned" : "claimed",
    });
  }
  return out;
}

/**
 * When a schedule next fires, and what that run will cover — for the card's
 * "Next: Thu 18 Sep 02:00 — covers Wed 17 Sep 02:00 → Thu 18 Sep 02:00". Pure;
 * scans at most 62 days forward, which covers every monthly day 1-28.
 */
export function nextOccurrence(
  schedule: ScheduleShape,
  tz: string,
  now: Date,
): { fire_at: Date; period_from: string; period_to: string; day_close: string | null; window_start_at: string; window_end_at: string } | null {
  const today = dayKeyOf(now, tz);
  for (let i = 0; i <= 62; i += 1) {
    const key = addDaysToKey(today, i);
    if (!occursOn(schedule, key)) { continue; }
    const fireAt = fireInstant(key, schedule.hour_local, schedule.minute_local, tz);
    if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= now.getTime()) { continue; }
    const period = occurrencePeriod(schedule, key);
    const w = reportEmailWindowIn(tz, { from: period.from, to: period.to, day_close: period.day_close }, 62, fireAt);
    return { fire_at: fireAt, period_from: period.from, period_to: period.to, day_close: period.day_close, window_start_at: w.window_start_at, window_end_at: w.window_end_at };
  }
  return null;
}

/** One occurrence this process is about to work on. `attempts` is the CAS token:
 *  the value the row is expected to still hold when the attempt is taken. */
export interface PendingDelivery {
  delivery_id: string;
  /** Null for a Send now. */
  schedule_id: string | null;
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
  /** The schedule's CURRENT addresses (migration 044), or a Send now's own. */
  recipients: string[];
  /** Migration 058's view of the row; a 2.0.1-shaped row reads as its defaults. */
  kind: "scheduled" | "manual" | "adhoc";
  status: string;
  report_keys: string[];
  formats: string[];
  outlet_scope: string;
  day_close: string | null;
  window_start_at: string | null;
  window_end_at: string | null;
}

function pendingOf(r: RetryableReportDelivery): PendingDelivery {
  return {
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
    kind: r.kind,
    status: r.status,
    report_keys: r.report_keys,
    formats: r.formats,
    outlet_scope: r.outlet_scope,
    day_close: r.day_close,
    window_start_at: r.window_start_at,
    window_end_at: r.window_end_at,
  };
}

/**
 * Is this the 2.0.1 inbox occurrence — one accounting report, as the CSV
 * artifact migration 026 stores on the row, for one outlet on calendar days?
 * That path is kept byte for byte (its download route and every installed app
 * read it); everything else is a bundle.
 */
function isLegacyInbox(p: PendingDelivery): boolean {
  return p.channel === "inbox"
    && p.report_keys.length === 1
    && ["sales", "pnl", "gst"].includes(p.report_keys[0])
    && p.formats.length === 1 && p.formats[0] === "csv"
    && p.day_close === null
    && p.outlet_scope !== "all"
    && p.kind !== "adhoc";
}

// In-process state for the config endpoint's "last sweep" and for saying
// something once rather than every tick.
let lastSweepAt: Date | null = null;
let sweepArmedHere = false;
const saidOnce = new Set<string>();
function sayOnce(key: string, say: () => void): void {
  if (saidOnce.has(key)) { return; }
  saidOnce.add(key);
  say();
}

/** Called by index.ts when it arms the timer. */
export function markReportSweepArmed(): void {
  sweepArmedHere = true;
}

export function reportSweepState(): { armed_here: boolean; last_sweep_at: Date | null } {
  return { armed_here: sweepArmedHere, last_sweep_at: lastSweepAt };
}

export async function runReportScheduleSweep(now: Date = new Date()): Promise<void> {
  const permitted = schedulerPermitted();
  if (!permitted.ok) {
    sayOnce(`perm:${permitted.reason ?? ""}`, () => { logger.warn({ reason: permitted.reason }, "report_sweep_not_permitted"); });
    return;
  }
  // The lease, the per-address log and the files all live in 058. A sweep on a
  // database without them would run the one path it can no longer promise, so
  // it waits — loudly, once — for the migration.
  if (!(await reportEmailSchemaReady())) {
    sayOnce("schema", () => { logger.error("Scheduled report sweep is WAITING — migrations 056-058 are not applied on this database."); });
    return;
  }
  const mail = mailTransportStatus();
  // ONE SWEEPER. Anyone else skips this tick without touching a tenant.
  const leader = await AcquireReportSweepLease(WORKER_ID, HOST, mail.available, SWEEP_LEASE_MIN());
  if (!leader) { return; }
  lastSweepAt = now;
  const purge = await ClaimReportPurgeDay().catch(() => false);

  const tenantIds = await ListRestaurantIds();
  for (const [i, resId] of tenantIds.entries()) {
    // A long sweep RENEWS the lease between tenants, so no other process
    // starts a second sweep under it — and stops if it has lost it.
    if (i > 0 && !(await AcquireReportSweepLease(WORKER_ID, HOST, mail.available, SWEEP_LEASE_MIN()).catch(() => false))) {
      logger.warn({ resId }, "report_sweep_lease_lost");
      return;
    }
    // One tenant's failure must not end the sweep for everyone after it.
    try { await sweepTenant(resId, now, { mailAvailable: mail.available, purge }); }
    catch (err) { logger.warn({ err, resId }, "report_sweep_tenant_failed"); }
  }
}

async function sweepTenant(resId: string, now: Date, tick: { mailAvailable: boolean; purge: boolean }): Promise<void> {
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
  // HERE: these readers are res_id-scoped by design (see the group header in
  // database_supabase.ts) and RLS keys solely on app.res_id.
  let schedules: DueReportSchedule[] = [];
  let retryable: RetryableReportDelivery[] = [];
  await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
    await ReapExhaustedReportDeliveries(resId);
    schedules = await ListDueReportSchedules(resId);
    retryable = await ListRetryableReportDeliveries(resId);
    if (tick.purge) {
      const purged = await PurgeReportDeliveryFileBodies(resId, RETENTION_DAYS());
      if (purged > 0) { logger.info({ resId, purged }, "report_file_bodies_purged"); }
    }
  });

  // PASS B — one transaction per schedule, bound to that schedule's real outlet.
  // NEVER nested inside pass A: see rule 2 in the file header.
  //
  // An email row is not even attempted by a process that cannot send mail
  // (rule 5): it stays where it is for a process that can.
  const pending: PendingDelivery[] = retryable
    .map(pendingOf)
    .filter((p) => tick.mailAvailable || p.channel !== "email");

  for (const schedule of schedules) {
    try {
      if (schedule.channel === "email" && !tick.mailAvailable) {
        await notifyMailOffIfDue(resId, schedule, tz, now);
        continue;
      }
      pending.push(...await claimDueOccurrences(resId, schedule, tz, now));
    } catch (err) { logger.warn({ err, resId, scheduleId: schedule.id }, "report_claim_failed"); }
  }

  for (const p of pending) {
    try { await runOccurrence(resId, p); }
    catch (err) { logger.warn({ err: scrubAddresses((err as Error | null)?.message ?? err), resId, deliveryId: p.delivery_id }, "report_occurrence_failed"); }
  }
}

/**
 * An email schedule is due and this server cannot send mail: NOTHING is
 * claimed (the occurrence stays unclaimed, so it runs the moment mail works,
 * inside the catch-up window), and the owner is told — once a day, not once a
 * tick.
 */
async function notifyMailOffIfDue(resId: string, schedule: DueReportSchedule, tz: string, now: Date): Promise<void> {
  const due = dueOccurrences(schedule, tz, now, CATCHUP_MS()).filter((o) => o.status === "claimed");
  if (due.length === 0) { return; }
  await withTenant({ res_id: resId, outlet_id: schedule.outlet_id, employeeId: "", role: "" }, () =>
    NotifyReportOnce(resId, {
      kind: "mail_not_configured",
      day: dayKeyOf(now, tz),
      title: "Scheduled email reports are waiting",
      body: "Email is not set up on this server, so scheduled reports are not being sent. Ask your administrator to set up the mail settings; the reports go out once it works.",
    }));
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
        const w = reportEmailWindowIn(tz, { from: occ.period_from, to: occ.period_to, day_close: occ.day_close }, 62, now);
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
          bundle: {
            kind: "scheduled",
            report_keys: schedule.report_keys,
            formats: schedule.formats,
            outlet_scope: schedule.outlet_scope,
            day_close: occ.day_close,
            window_start_at: w.window_start_at,
            window_end_at: w.window_end_at,
          },
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
          kind: "scheduled",
          status: "claimed",
          report_keys: schedule.report_keys,
          formats: schedule.formats,
          outlet_scope: schedule.outlet_scope,
          day_close: occ.day_close,
          window_start_at: w.window_start_at,
          window_end_at: w.window_end_at,
        });
      }
    },
  );
  return claimed;
}

/** A failure no retry can fix — recorded as the last attempt. */
class FinalDeliveryError extends Error {
  readonly permanent = true;
}

const isPermanent = (err: unknown): boolean => (err as { permanent?: unknown } | null)?.permanent === true;

/**
 * TX2 (take the attempt), TX3 (render), TX4 (deliver + record) — separate
 * transactions, each bound to the delivery's outlet and none nested.
 *
 * Separate because withTenant holds a pooled client for the whole callback, and
 * because an aborted render must cost one attempt rather than un-claiming the
 * occurrence.
 */
export async function runOccurrence(resId: string, p: PendingDelivery, send?: SendOptions): Promise<void> {
  const ctx = { res_id: resId, outlet_id: p.outlet_id, employeeId: "", role: "" };

  // Rule 5: no transport, no attempt — the row keeps its retries for a process
  // that can send.
  if (p.channel === "email" && !mailTransportStatus(send?.env).available) { return; }

  // TX2 — commits BEFORE any work is done, because a guard that has not committed
  // guards nothing.
  const attempts = await withTenant(ctx, () =>
    TakeReportDeliveryAttempt(resId, p.delivery_id, p.attempts, new Date(Date.now() + LEASE_MS()), WORKER_ID));
  if (attempts === null) { return; }   // another worker holds this attempt

  let outcome: { accepted: number; refused: number; skipped: number; maybeDuplicate: boolean } | null = null;
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
    if (isLegacyInbox(p)) {
      await runLegacyInbox(resId, p, attempts);
    } else {
      outcome = await runBundle(resId, p, attempts, send);
    }
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
  if (!p.schedule_id) { return; }
  const scheduleId = p.schedule_id;
  try {
    await withTenant(ctx, () => TouchReportScheduleOutcome(resId, scheduleId, {
      occurrence_key: p.occurrence_key,
      status: "delivered",
      error: outcome && (outcome.refused > 0 || outcome.skipped > 0)
        ? `Sent to ${String(outcome.accepted)}; ${String(outcome.refused)} refused, ${String(outcome.skipped)} skipped.`
        : null,
    }));
  } catch (err) {
    logger.warn({ err, resId, deliveryId: p.delivery_id, scheduleId }, "report_outcome_touch_failed");
  }
}

/** The 2.0.1 path: one accounting CSV on the row, announced in the bell. Unchanged. */
async function runLegacyInbox(resId: string, p: PendingDelivery, attempts: number): Promise<void> {
  const ctx = { res_id: resId, outlet_id: p.outlet_id, employeeId: "", role: "" };
  const artifact = await withTenant(ctx, async () => {
    // isAllOutlets flips getSettledBills / GetExpenses / GetDiscountsReport from
    // `outlet_id = $2` to a whole-restaurant read, so a per-outlet schedule
    // would silently start reporting every branch. The sweep never sets it —
    // this catches a future caller that reaches runOccurrence from inside an
    // all-outlets HTTP request, where withTenant's re-entrancy guard would hand
    // us that request's context instead of ours.
    if (isAllOutlets()) { throw new Error("Scheduled reports must run on a single outlet"); }
    const payload = await runReportFor(p.report_keys[0] ?? p.report_key, resId, p.period_from, p.period_to);
    const rendered = renderReport(
      (p.report_keys[0] ?? p.report_key) as ReportKey,
      "csv" as ReportFormat,
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
  const title = `${reportLabel(p.report_keys[0] ?? p.report_key, p.name)} ready — ${period}`;

  // TX4 — the CAS and the notification commit together or not at all.
  // NO FIGURES: GET /notifications is readable by every authenticated employee —
  // see MarkReportDelivered's docstring.
  await withTenant(ctx, () => DeliverReportToInbox(resId, {
    deliveryId: p.delivery_id,
    attempts,
    scheduleId: p.schedule_id ?? "",
    occurrenceKey: p.occurrence_key,
    title,
    body: `Open Accounting → Scheduled reports to download ${artifact.filename}.`,
  }));
}

/**
 * A bundle: render (or reuse what an earlier attempt stored), then deliver —
 * to the bell, or address by address.
 */
async function runBundle(
  resId: string,
  p: PendingDelivery,
  attempts: number,
  send?: SendOptions,
): Promise<{ accepted: number; refused: number; skipped: number; maybeDuplicate: boolean }> {
  const ctx = { res_id: resId, outlet_id: p.outlet_id, employeeId: "", role: "" };
  const keys = p.report_keys.filter((k) => CATALOGUE_KEYS.includes(k));
  const isTest = p.kind === "adhoc" && keys.length === 0;
  if (!isTest && keys.length === 0) {
    throw new FinalDeliveryError("This delivery names no report that can be emailed.");
  }
  const windowStart = p.window_start_at ?? new Date(`${p.period_from}T00:00:00Z`).toISOString();
  const windowEnd = p.window_end_at ?? new Date(`${p.period_to}T00:00:00Z`).toISOString();

  // TX3 — REUSE WHAT WAS ALREADY BUILT. A retry after a failed send re-sends
  // the SAME bytes (and the same Message-ID), not a re-render that may have
  // moved; only a delivery with nothing stored renders.
  let files: RenderedReportFile[] = [];
  let headline: ReportHeadline | null = null;
  let identity: BundleIdentity | null = null;
  const reports: { key: string; rows: number; truncated: boolean; filename: string; format: string }[] = [];
  if (!isTest) {
    files = await withTenant(ctx, () => LoadReportDeliveryFiles(resId, p.delivery_id));
    if (files.length === 0) {
      const bundle = await renderReportBundle({
        resId,
        outletId: p.outlet_id,
        scope: p.outlet_scope === "all" ? "all" : "outlet",
        keys,
        formats: p.formats.filter((f): f is "xlsx" | "csv" => f === "xlsx" || f === "csv"),
        from: p.period_from,
        to: p.period_to,
        dayClose: p.day_close,
        windowStartAt: windowStart,
        windowEndAt: windowEnd,
        maxBytes: ATTACH_MAX_BYTES(),
      }).catch((err: unknown) => {
        if (isPermanent(err)) { throw new FinalDeliveryError((err as Error).message); }
        throw err;
      });
      await withTenant(ctx, () => StoreReportDeliveryFiles(resId, p.delivery_id, attempts, bundle.files));
      files = bundle.files;
      headline = bundle.headline;
      identity = bundle.identity;
    }
    for (const f of files) {
      reports.push({ key: f.report_key, rows: f.rows, truncated: f.truncated, filename: f.filename, format: f.format });
    }
  }
  if (!identity) {
    identity = await withTenant(ctx, async () => {
      const i = await GetReportEmailIdentity(resId, p.outlet_id);
      return { restaurantName: i.restaurant_name, outletName: i.outlet_name, currency: i.currency, timezone: i.timezone };
    });
  }

  if (p.channel === "inbox") {
    await withTenant(ctx, () => MarkReportDelivered(resId, {
      deliveryId: p.delivery_id,
      attempts,
      scheduleId: p.schedule_id ?? "",
      occurrenceKey: p.occurrence_key,
      channel: "inbox",
      module: "Reports",
      title: `${reportListPhrase(keys)} ready — ${p.period_from === p.period_to ? dayLabel(p.period_from) : `${p.period_from} to ${p.period_to}`}`,
      body: "Open Reports → Email reports to download the files.",
    }));
    return { accepted: 0, refused: 0, skipped: 0, maybeDuplicate: false };
  }

  // THE EMAIL. 'sending' commits first (rule 4); what is already decided per
  // address comes back with it and is not sent again.
  const transport = readMailTransport(send?.env);
  const sending = await withTenant(ctx, () => MarkReportDeliverySending(resId, p.delivery_id, attempts, transport.kind));
  if (!sending) { throw new Error("Report delivery was superseded by another attempt"); }
  const decided = new Set([...sending.delivered_to, ...sending.rejected_to, ...sending.skipped_to].map(normalizeEmailKey));
  // The SEND-TIME check: an address removed from (or paused in) the book since
  // the schedule was saved gets nothing.
  const book = await withTenant(ctx, () => ReportEmailBookStatus(resId));

  let accepted = sending.delivered_to.length;
  let refused = sending.rejected_to.length;
  let skipped = sending.skipped_to.length;
  const record = (addr: string, what: "delivered" | "rejected" | "skipped") =>
    withTenant(ctx, () => RecordReportRecipientOutcome(resId, p.delivery_id, attempts, addr, what));

  const generatedAt = new Date();
  for (const addr of normalizeRecipients(p.recipients)) {
    const key = normalizeEmailKey(addr);
    if (decided.has(key)) { continue; }
    decided.add(key);
    if (book.get(key) !== "active") {
      await record(addr, "skipped");
      skipped += 1;
      logger.info({ resId, deliveryId: p.delivery_id, addr: addressTag(addr) }, "report_recipient_skipped_not_in_book");
      continue;
    }
    // THE DAILY CAPS, durable and checked before EVERY message: the restaurant's
    // 24-hour count from its own delivery log, the platform's from the lease row.
    const tenantSent = await withTenant(ctx, () => CountRecentReportEmails(resId));
    const platformSent = await PeekPlatformReportEmails();
    if (tenantSent >= TENANT_DAILY_CAP() || platformSent >= PLATFORM_DAILY_CAP()) {
      await record(addr, "skipped");
      skipped += 1;
      logger.warn({ resId, deliveryId: p.delivery_id, tenantSent, platformSent }, "report_email_daily_cap_reached");
      continue;
    }

    const content = isTest
      ? buildTestEmail({ restaurantName: identity.restaurantName, recipient: addr, generatedAt, timezone: identity.timezone })
      : buildReportEmail({
        restaurantName: identity.restaurantName,
        outletName: identity.outletName,
        scope: p.outlet_scope === "all" ? "all" : "outlet",
        scheduleName: p.schedule_id ? p.name : null,
        kind: p.kind,
        reportKeys: keys,
        from: p.period_from,
        to: p.period_to,
        dayClose: p.day_close,
        windowStartAt: windowStart,
        windowEndAt: windowEnd,
        timezone: identity.timezone,
        currency: identity.currency,
        headline,
        files: reports.map((r) => ({ report_key: r.key, filename: r.filename, format: r.format, rows: r.rows, truncated: r.truncated })),
        recipient: addr,
        generatedAt,
      });

    // RULE 3: no transaction is open here. The send is bounded by mailer.ts.
    const one = await sendReportMessage({
      to: [addr],
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments: files.map((f) => ({ filename: f.filename, content: f.body, contentType: f.mime })),
      messageId: stableMessageId(p.delivery_id, addr, transport.fromAddress),
      idempotencyKey: `rd-${p.delivery_id}-${addressTag(addr)}`,
      fromName: `${identity.restaurantName} via ${String(process.env.MAIL_FROM_NAME ?? "").trim() || "Experio Reports"}`,
      replyTo: String(process.env.MAIL_REPLY_TO ?? "").trim() || undefined,
    }, send).catch((err: unknown) => {
      // Named so the failure row says something an owner can act on. An
      // unconfigured deployment is not a transient fault and saying "connection
      // refused" would send them hunting for a network problem that is not
      // there.
      if (isMailNotConfiguredError(err)) {
        throw new Error(
          "Email delivery is not configured on this server, so this report could not be sent."
          + " Ask your administrator to set up the mail settings.",
        );
      }
      throw err;
    });
    if (one.status === "accepted") {
      await record(addr, "delivered");
      await AddPlatformReportEmails(1).catch((err: unknown) => { logger.warn({ err }, "report_platform_count_failed"); });
      accepted += 1;
    } else {
      await record(addr, "rejected");
      refused += 1;
      logger.warn({ resId, deliveryId: p.delivery_id, addr: addressTag(addr), detail: one.detail }, "report_recipient_refused");
    }
  }

  if (accepted === 0) {
    throw new FinalDeliveryError(
      `No address accepted this report: ${String(refused)} refused by the mail service, ${String(skipped)} skipped`
      + " (no longer in the address book, or the daily email limit was reached).",
    );
  }

  const maybeDuplicate = p.status === "sending";
  // TX4 — the CAS and the bell commit together. The bell names how MANY, never
  // who, and never a figure (see MarkReportDelivered).
  await withTenant(ctx, () => MarkReportDelivered(resId, {
    deliveryId: p.delivery_id,
    attempts,
    scheduleId: p.schedule_id ?? "",
    occurrenceKey: p.occurrence_key,
    channel: "email",
    module: "Reports",
    title: sentBellTitle({ from: p.period_from, to: p.period_to, kind: p.kind, accepted, reportKeys: keys }),
    body: sentBellBody({ refused, skipped, maybeDuplicate }),
  }));
  return { accepted, refused, skipped, maybeDuplicate };
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
  // The ROW keeps the provider's own words, behind the reports permission; the
  // LOG gets them with every address taken out.
  const message = err instanceof Error ? err.message : String(err);
  const permanent = isPermanent(err);
  const backoffMs = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000;
  const final = permanent || attempts >= REPORT_MAX_ATTEMPTS;
  const ctx = { res_id: resId, outlet_id: p.outlet_id, employeeId: "", role: "" };

  try {
    await withTenant(ctx, () =>
      RecordReportDeliveryFailure(resId, p.delivery_id, attempts, new Date(Date.now() + backoffMs), message, { final: permanent }));
  } catch (writeErr) {
    logger.error({ err: writeErr, resId, deliveryId: p.delivery_id }, "report_failure_record_failed");
  }
  logger.warn({ resId, deliveryId: p.delivery_id, attempts, final, err: scrubAddresses(message) }, "report_delivery_failed");
  if (!final) { return; }

  // Only the LAST failure reaches the owner. Pinging the bell on every transient
  // retry is how a person learns to ignore the bell.
  const scheduleId = p.schedule_id;
  const what = p.report_keys.length > 1 || p.kind === "adhoc" ? reportListPhrase(p.report_keys) || "Test email" : reportLabel(p.report_key, p.name);
  try {
    await withTenant(ctx, async () => {
      const outcome = scheduleId
        ? await TouchReportScheduleOutcome(resId, scheduleId, {
          occurrence_key: p.occurrence_key,
          status: "failed",
          error: scrubAddresses(message),
        })
        : { auto_disabled: false };
      // AddNotification throws (unlike sendMessage). Inside TX4 that is what we
      // want; here it must not roll back the outcome record, so it is separate and
      // wrapped by the caller's catch.
      const legacy = isLegacyInbox(p);
      await AddNotification(resId, {
        type: "report",
        title: `${what} could not be delivered`,
        body: outcome.auto_disabled
          ? `${p.name} has been switched off after repeated failures. Re-enable it in ${legacy ? "Accounting → Scheduled reports" : "Reports → Email reports"}.`
          : scheduleId
            ? `${p.name} failed for ${p.period_from}. See ${legacy ? "Accounting → Scheduled reports" : "Reports → Email reports"}.`
            : `The reports for ${p.period_from === p.period_to ? p.period_from : `${p.period_from} to ${p.period_to}`} could not be emailed. See Reports → Email reports.`,
        meta: { module: legacy ? "Accounting" : "Reports", schedule_id: scheduleId, occurrence_key: p.occurrence_key, delivery_id: p.delivery_id },
      });
    });
  } catch (notifyErr) {
    logger.warn({ err: notifyErr, resId, scheduleId }, "report_failure_notify_failed");
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
 * neither collides with nor consumes the scheduled one. Returns null when this
 * minute's manual run is already claimed — which is what the route's 409
 * reports.
 *
 * Deliberately does NOT render inline. This route is served on the request's own
 * tenant connection, whose bound outlet is the CALLER's, and withTenant is
 * re-entrant — so an inline render would silently report the caller's outlet even
 * when the schedule belongs to another. Since item 9 the route KICKS the worker
 * outside the request's context (kickReportDelivery) instead of waiting for the
 * sweep — the same one code path, bound to the schedule's own outlet.
 *
 * `businessDate` (a daily schedule only) asks for that date instead of the one
 * the schedule would report now — how an owner re-sends a Missed night.
 */
export async function queueReportScheduleRun(
  resId: string,
  schedule: {
    id: string; outlet_id: string; frequency: string; channel: string;
    hour_local?: number; minute_local?: number; window_mode?: string;
    report_keys?: string[]; formats?: string[]; outlet_scope?: string;
  },
  tz: string,
  now: Date = new Date(),
  opts: { businessDate?: string | null; requestedBy?: string | null } = {},
): Promise<string | null> {
  const shape = {
    frequency: schedule.frequency,
    hour_local: schedule.hour_local ?? 0,
    minute_local: schedule.minute_local ?? 0,
    window_mode: schedule.window_mode,
  };
  let period = occurrencePeriod(shape, dayKeyOf(now, tz));
  if (opts.businessDate && schedule.frequency === "daily" && DAY_KEY_RE.test(opts.businessDate)) {
    period = { ...period, from: opts.businessDate, to: opts.businessDate };
  }
  const w = reportEmailWindowIn(tz, { from: period.from, to: period.to, day_close: period.day_close }, 62, now);
  return ClaimReportOccurrence(resId, {
    schedule_id: schedule.id,
    outlet_id: schedule.outlet_id,
    occurrence_key: manualOccurrenceKey(now, tz),
    fire_at: now,
    period_from: w.from,
    period_to: w.to,
    timezone: tz,
    claimed_by: WORKER_ID,
    status: "claimed",
    channel: schedule.channel,
    // Eligible immediately, so the kick (or the next tick) picks it up rather
    // than waiting out a lease the caller is not holding.
    next_attempt_at: now,
    bundle: {
      kind: "manual",
      report_keys: schedule.report_keys ?? [],
      formats: schedule.formats ?? ["csv"],
      outlet_scope: schedule.outlet_scope ?? "outlet",
      day_close: period.day_close,
      window_start_at: w.window_start_at,
      window_end_at: w.window_end_at,
      requested_by: opts.requestedBy ?? null,
    },
  });
}

// Deliveries this process is already working on because a route kicked them.
const kicked = new Set<string>();

/**
 * Work ONE delivery now, in the background, OUTSIDE the calling request.
 *
 * `runOutsideTenantContext` drops the request's AsyncLocalStorage: every
 * withTenant below checks out its own short client, bound to the DELIVERY's
 * outlet, and the request's connection is released the moment its response is
 * sent — it never waits on a mail server. Independent of REPORT_SCHEDULER:
 * Send now works on a server whose sweep is off. The attempts CAS makes a
 * kick racing the sweep (or another replica) harmless.
 */
export function kickReportDelivery(resId: string, deliveryId: string, send?: SendOptions): Promise<void> {
  if (kicked.has(deliveryId)) { return Promise.resolve(); }
  kicked.add(deliveryId);
  return runOutsideTenantContext(() => new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        try {
          const row = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () =>
            GetRunnableReportDelivery(resId, deliveryId));
          if (row) { await runOccurrence(resId, pendingOf(row), send); }
        } catch (err) {
          logger.warn({ err: scrubAddresses((err as Error | null)?.message ?? err), resId, deliveryId }, "report_kick_failed");
        } finally {
          kicked.delete(deliveryId);
          resolve();
        }
      })();
    });
  }));
}

/**
 * At boot: a Send now whose process died before it finished is picked up
 * again — recent ones only (an hour), so a server that was down all night does
 * not mail yesterday's on-demand requests into the morning. Production only,
 * like the sweep, and only where mail can be sent.
 */
export async function recoverOrphanReportSends(): Promise<number> {
  const prod = String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  if (!prod && String(process.env.REPORT_SCHEDULER_ALLOW_NON_PROD ?? "").trim() !== "true") { return 0; }
  if (!mailTransportStatus().available || !(await reportEmailSchemaReady())) { return 0; }
  let n = 0;
  for (const resId of await ListRestaurantIds()) {
    try {
      const rows = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () =>
        ListOrphanAdhocDeliveries(resId, ORPHAN_MAX_AGE_MIN));
      for (const r of rows) { void kickReportDelivery(resId, r.id); n += 1; }
    } catch (err) {
      logger.warn({ err, resId }, "report_orphan_scan_failed");
    }
  }
  return n;
}
