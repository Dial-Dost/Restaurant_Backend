// REPORT EMAIL — THE WIRING (client item 9).
//
// This project's most repeated defect is correct server code with no caller:
// a migration nothing writes to, a renderer field nobody passed, a capability
// no client parsed. Item 9 is a chain of seven hops from a click to an inbox,
// and every hop is tested on its own elsewhere. This file pins the HOPS, so a
// refactor that leaves every unit green but drops one link fails here:
//
//   Send now / test / Run now  →  insert  →  kickReportDelivery
//     →  outside the request's connection  →  runOccurrence  →  runBundle
//     →  renderReportBundle (the screen's readers)  →  stored files
//     →  'sending'  →  sendReportMessage (one address)  →  its outcome
//     →  MarkReportDelivered
//   boot  →  InitReportEmailSchema (always)  →  the sweep (only if permitted)
//   ?day_close=  →  misQuery  →  misContext  →  misWindowInstants + every
//     day bucket (serviceDayKey with the shift)
//
// Source guards, because the chain crosses a network and a database.

import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIS_REPORT_KEYS } from "../report_catalogue";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const DB = read("database_supabase.ts");
const SWEEP = read("report_schedules.ts");
const BUNDLE = read("report_bundle.ts");
const ROUTES = read("routes/report_email.ts");
const ACCOUNTING = read("routes/accounting.ts");
const MIS = read("routes/reports_mis.ts");
const INDEX = read("index.ts");

/** The text of one top-level function (up to the next top-level declaration). */
function fn(src: string, name: string): string {
  const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\s*[(<]`, "m");
  const m = re.exec(src);
  if (!m) {throw new Error(`no function ${name}`);}
  const rest = src.slice(m.index + 1);
  const next = /^(?:export )?(?:async )?function |^(?:export )?(?:const|let|interface|type|class) /m.exec(rest);
  return src.slice(m.index, next ? m.index + 1 + next.index : src.length);
}

/** One route's handler source. */
function route(src: string, method: string, path: string): string {
  const start = src.indexOf(`app.${method}("${path}",`);
  if (start < 0) {throw new Error(`no ${method} ${path}`);}
  const next = src.indexOf("\napp.", start + 5);
  return src.slice(start, next > 0 ? next : src.length);
}

describe("a click reaches an inbox", () => {
  test("Send now inserts, then kicks — and never sends inline", () => {
    const send = route(ROUTES, "post", "/reports/email/send");
    expect(send.indexOf("await InsertAdhocReportDelivery(")).toBeGreaterThan(-1);
    expect(send.indexOf("void kickReportDelivery(auth.res_id, id);")).toBeGreaterThan(send.indexOf("await InsertAdhocReportDelivery("));
    expect(send).not.toMatch(/sendMail|sendReportMessage|runOccurrence/);
    expect(send).toContain("res.status(replayed ? 200 : 202)");
  });

  test("the test email and Run now kick the same worker", () => {
    expect(route(ROUTES, "post", "/reports/email/test")).toContain("void kickReportDelivery(auth.res_id, id);");
    expect(route(ACCOUNTING, "post", "/reports/schedules/:id/run-now")).toContain("void kickReportDelivery(req.auth.res_id, deliveryId);");
  });

  test("the kick leaves the request's connection, finds the row, and runs the one worker", () => {
    const kick = fn(SWEEP, "kickReportDelivery");
    expect(kick).toContain("return runOutsideTenantContext(() => new Promise<void>((resolve) => {");
    expect(kick).toContain("GetRunnableReportDelivery(resId, deliveryId)");
    expect(kick).toContain("await runOccurrence(resId, pendingOf(row), send);");
    expect(fn(DB, "runOutsideTenantContext")).toContain("return tenantStorage.exit(fn);");
  });

  test("the worker: no transport, no attempt; a bundle unless it is the 2.0.1 inbox shape", () => {
    const run = fn(SWEEP, "runOccurrence");
    const guard = run.indexOf("if (p.channel === \"email\" && !mailTransportStatus(send?.env).available) { return; }");
    const take = run.indexOf("TakeReportDeliveryAttempt(");
    expect(guard).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(guard);
    expect(run).toContain("outcome = await runBundle(resId, p, attempts, send);");
    expect(run).toContain("await runLegacyInbox(resId, p, attempts);");
  });

  test("the bundle: the screen's readers, the stored files, 'sending', one address per message, its outcome, delivered", () => {
    const b = fn(SWEEP, "runBundle");
    const order = [
      "LoadReportDeliveryFiles(resId, p.delivery_id)",
      "await renderReportBundle({",
      "StoreReportDeliveryFiles(resId, p.delivery_id, attempts, bundle.files, meta)",
      "MarkReportDeliverySending(resId, p.delivery_id, attempts, transport.kind, proposed)",
      "const meta = readMessageMeta(sending.message_meta) ?? proposed;",
      "ReportEmailBookStatus(resId)",
      "CountRecentReportEmails(resId)",
      "const one = await sendReportMessage({",
      "await record(addr, \"delivered\")",
      "await AddPlatformReportEmails(1)",
      "MarkReportDelivered(resId, {\n    deliveryId: p.delivery_id,\n    attempts,\n    scheduleId: p.schedule_id ?? \"\",\n    occurrenceKey: p.occurrence_key,\n    channel: \"email\",",
    ];
    let at = -1;
    for (const step of order) {
      const i = b.indexOf(step, at + 1);
      expect({ step, found: i > at }).toEqual({ step, found: true });
      at = i;
    }
    expect(b).toContain("messageId: stableMessageId(p.delivery_id, addr, transport.fromAddress),");
    // The body is built from the STORED inputs, never from a fresh clock or a
    // fresh render's headline (a retry is the same message).
    expect(b).toContain("headline: meta.headline,");
    expect(b).toContain("const generatedAt = new Date(meta.generated_at);");
    expect(b).toContain("idempotencyKey: `rd-${p.delivery_id}-${addressTag(addr)}`,");
  });

  test("the bundle renders through the SAME readers the routes use, for every MIS key", () => {
    const keys = [...BUNDLE.matchAll(/^ {2}([a-z_]+): \{ read: (Get\w+Report), rows: /gm)].map((m) => [m[1], m[2]]);
    expect(keys.map(([k]) => k)).toEqual([...MIS_REPORT_KEYS]);
    for (const [key, reader] of keys) {
      // The route registers the same reader for the same report.
      expect(MIS).toMatch(new RegExp(`misHandler\\("${key}", ${reader}, `));
    }
    const listed = /const MIS_REPORT_KEYS = \[([\s\S]*?)\] as const;/.exec(MIS)?.[1] ?? "";
    expect([...listed.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...MIS_REPORT_KEYS]);
    // Each read is its own transaction, bounded, bound to the delivery's scope.
    expect(fn(BUNDLE, "readInTenant")).toContain("allOutlets: req.scope === \"all\"");
    expect(fn(BUNDLE, "readInTenant")).toContain("await SetLocalStatementTimeout(STATEMENT_TIMEOUT_MS);");
    // A CSV attachment is the route's own renderer.
    expect(fn(BUNDLE, "loadReport")).toContain("csv: renderMisCsv(p.columns, rows, p.totals ?? null)");
    expect(fn(BUNDLE, "loadReport")).toContain("csv: renderSalesCsv(p)");
  });
});

describe("the sweep is guarded, and armed only where it may run", () => {
  test("permitted, migrated, leased — in that order, before any tenant", () => {
    const s = fn(SWEEP, "runReportScheduleSweep");
    const steps = ["schedulerPermitted()", "reportEmailSchemaReady()", "AcquireReportSweepLease(WORKER_ID, HOST, mail.available, SWEEP_LEASE_MIN())", "ListRestaurantIds()"];
    let at = -1;
    for (const step of steps) {
      const i = s.indexOf(step);
      expect({ step, after: i > at }).toEqual({ step, after: true });
      at = i;
    }
    expect(fn(SWEEP, "schedulerPermitted")).toContain("REPORT_SCHEDULER_ALLOW_NON_PROD");
  });

  test("without 058 NOTHING scheduled runs, and Run now says so rather than queue", () => {
    const s = fn(SWEEP, "runReportScheduleSweep");
    const gate = s.indexOf("if (!(await reportEmailSchemaReady())) {");
    expect(gate).toBeGreaterThan(-1);
    expect(s.slice(gate, s.indexOf("\n  }", gate))).toMatch(/\n    return;$/);
    expect(s.indexOf("ListRestaurantIds()")).toBeGreaterThan(gate);
    const run = route(ACCOUNTING, "post", "/reports/schedules/:id/run-now");
    const refuse = run.indexOf("if (!(await reportEmailSchemaReady())) {");
    expect(refuse).toBeGreaterThan(-1);
    expect(run.indexOf("queueReportScheduleRun(")).toBeGreaterThan(refuse);
    expect(run).toContain("code: \"schema_pending\"");
  });

  test("the reaper's rows reach the owner, the way a failed last attempt does", () => {
    const t = fn(SWEEP, "sweepTenant");
    expect(t).toContain("reaped = await ReapExhaustedReportDeliveries(resId, catchupMin);");
    expect(t).toContain("await announceFinalFailure(resId, p, r.error);");
    expect(t).toContain("retryable = await ListRetryableReportDeliveries(resId, 50, catchupMin);");
    expect(fn(SWEEP, "recordFailure")).toContain("await announceFinalFailure(resId, p, message);");
  });

  test("no email claim without a transport — the bell instead, once a day", () => {
    const t = fn(SWEEP, "sweepTenant");
    expect(t).toContain("if (schedule.channel === \"email\" && !tick.mailAvailable) {\n        await notifyMailOffIfDue(resId, schedule, tz, now);\n        continue;\n      }");
    expect(t).toContain(".filter((p) => tick.mailAvailable || p.channel !== \"email\")");
    expect(fn(SWEEP, "notifyMailOffIfDue")).toContain("NotifyReportOnce(resId, {");
    expect(t).toContain("PurgeReportDeliveryFileBodies(resId, RETENTION_DAYS())");
  });

  test("boot: the schema step is unconditional; the timer is armed only when permitted; orphans are resumed", () => {
    const init = INDEX.indexOf("const reportEmail = await InitReportEmailSchema();");
    const listen = INDEX.indexOf("httpServer.listen(");
    expect(init).toBeGreaterThan(-1);
    expect(init).toBeLessThan(listen);
    // At the bootstrap body's own indent (one tab): not inside any `if (process.env.…)` block.
    expect(INDEX).toContain("\n\ttry {\n\t\tconst reportEmail = await InitReportEmailSchema();");
    expect(INDEX).toContain("const sweepPermit = schedulerPermitted();\n\tif (sweepPermit.ok) {");
    expect(INDEX).toContain("markReportSweepArmed();");
    expect(INDEX).toContain("void recoverOrphanReportSends()");
    expect(INDEX).toContain("registerReportEmailRoutes(app);");
    expect(INDEX.indexOf("registerReportEmailRoutes(app);")).toBeGreaterThan(INDEX.indexOf("registerAccountingRoutes(app);"));
  });
});

describe("a trading day reaches every read", () => {
  test("?day_close= is forwarded raw, advertised, and named in the CSV", () => {
    expect(fn(MIS, "misQuery")).toContain("day_close: req.query.day_close,");
    expect(fn(MIS, "misFilename")).toContain("tradingDayFileSuffix(parseDayClose(meta.window.day_close))");
    expect(MIS).toContain('trading_day: { param: "day_close", applies_to: [...MIS_REPORT_KEYS], excludes: ["slot", "time_from", "time_to"] },');
  });

  test("every MIS window becomes instants through misWindowInstants — slotWindowInstants has no other caller", () => {
    const callers = [...DB.matchAll(/slotWindowInstants\(/g)].map((m) => m.index ?? 0);
    const owners = callers.map((i) => {
      const before = DB.slice(0, i);
      return /(?:^|\n)(?:export )?(?:async )?function (\w+)[^\n]*$/.exec(before.slice(before.lastIndexOf("\nfunction ") >= before.lastIndexOf("\nexport function ") ? before.lastIndexOf("\nfunction ") : before.lastIndexOf("\nexport function ")))?.[1];
    });
    expect(owners.filter((o) => o !== "slotWindowInstants" && o !== "misWindowInstants")).toEqual([]);
    expect(fn(DB, "misContext")).toContain("...misWindowInstants(resolved, tz, slot, shift),");
    expect(fn(DB, "reportEmailWindowIn")).toContain("const instants = misWindowInstants(w, tz, null, shift);");
  });

  test("every day bucket passes the shift: serviceDayKey always gets four arguments", () => {
    const calls = [...DB.matchAll(/serviceDayKey\(([^;]*?)\)(?=[\s,:;)])/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const args of calls) {
      expect({ args, count: args.split(",").length }).toEqual({ args, count: 4 });
    }
    expect(fn(DB, "tradingDayKeyOf")).toContain("serviceDayKey(clock.key, clock.hour * 60 + clock.minute, null, shift)");
    expect(fn(DB, "GetSalesReport")).toContain("const day = shift ? tradingDayKeyOf(b.settled_at, context.timezone, shift) : dayKeyOf(b.settled_at, context.timezone);");
    expect(fn(DB, "GetSalesReport")).toContain("const bounds = shift ? tradingRangeInstants(range.fromDate, range.toDate, context.timezone, shift) : range;");
  });

  test("the bundle hands the close to every reader it calls", () => {
    const load = fn(BUNDLE, "loadReport");
    expect(load).toContain("GetSalesReport(req.resId, req.from, req.to, { dayShiftMin: shift })");
    expect(load).toContain("const base: MisReportQuery = { from: req.from, to: req.to, ...(req.dayClose ? { day_close: req.dayClose } : {}) };");
    expect(fn(BUNDLE, "loadHeadline")).toContain("...(req.dayClose ? { day_close: req.dayClose } : {})");
  });

  test("a scheduled occurrence stores the window it will read, from the same resolver", () => {
    const claim = fn(SWEEP, "claimDueOccurrences");
    expect(claim).toContain("const w = reportEmailWindowIn(tz, { from: occ.period_from, to: occ.period_to, day_close: occ.day_close }, 62, now);");
    expect(claim).toContain("window_start_at: w.window_start_at,");
    expect(fn(SWEEP, "occurrencePeriod")).toContain("const k = tradingBusinessDate(fireDayKey, close);");
  });
});

describe("no address leaves the delivery row", () => {
  test("the bell is built from counts only, and the logs carry a tag", () => {
    const b = fn(SWEEP, "runBundle");
    expect(b).toContain("title: sentBellTitle({ from: p.period_from, to: p.period_to, kind: p.kind, accepted, reportKeys: keys }),");
    expect(b).toContain("body: sentBellBody({ refused, skipped, maybeDuplicate }),");
    for (const m of b.matchAll(/logger\.\w+\(\{([^}]*)\}/g)) {
      expect(m[1]).not.toMatch(/(?<!addressTag\()\baddr\b(?!:)|\bto\b|recipients/);
    }
    expect(fn(SWEEP, "recordFailure")).toContain("err: scrubAddresses(message)");
  });

  test("the pino redaction list names the address fields", () => {
    const obs = read("observability.ts");
    for (const path of ["\"recipients\"", "\"accepted\"", "\"rejected\"", "\"envelope\"", "\"*.to\""]) {
      expect(obs).toContain(path);
    }
  });
});
