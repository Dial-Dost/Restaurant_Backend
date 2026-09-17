// REPORT TIME SLOTS — THE WIRING.
//
// The slot contract is pure (report_window.ts, pinned in report_window.test.ts)
// and the money under a slot is driven through the real readers
// (test/money/mis_time_slot_agreement.test.ts). What is left can only go wrong
// as WIRING, silently, and it is this project's most repeated defect — correct
// code with no caller:
//
//   * A WINDOW PREDICATE WITHOUT THE SLOT. Every MIS read binds `>= $3 and < $4`
//     on its own clock. One that does not also carry misTimeSql counts every
//     hour between the slot's outer bounds, and Σ Settlement stops equalling the
//     Sales Summary under Lunch while every all-day test stays green.
//   * THE SLOT ON THE WRONG CLOCK. misTimeSql("b.closed_at") appended to an
//     order-placement predicate is a filter on a column the statement does not
//     bound — plausible numbers, wrong question.
//   * A NEW MIS READER that binds the window and was never taught the slot. The
//     enumeration below fails for it on purpose, so whoever adds it reads this.
//   * THE HTTP SURFACE NOT PASSING IT ON: misQuery dropping ?slot=, the
//     catalogue not advertising it, the CSV name not carrying it.
//
// Source guards, because database_supabase.ts cannot run its SQL under jest.

import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const DB_SRC = readFileSync(join(ROOT, "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");
const ROUTES_SRC = readFileSync(join(ROOT, "routes", "reports_mis.ts"), "utf8").replace(/\r\n/g, "\n");

/** Top-level function bodies of a source file, by name. Same splitter as bill_round_off_wiring. */
function functionChunks(src: string): Map<string, string> {
  const re = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*[(<]/gm;
  const starts: { name: string; at: number }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) { starts.push({ name: m[1]!, at: m.index }); }
  const out = new Map<string, string>();
  starts.forEach((s, i) => {
    const nextFn = starts[i + 1]?.at ?? src.length;
    const tail = src.slice(s.at + 1, nextFn);
    const decl = /^(?:export )?(?:interface|type|const|let|class) /m.exec(tail);
    out.set(s.name, src.slice(s.at, decl ? s.at + 1 + decl.index : nextFn));
  });
  return out;
}

const CHUNKS = functionChunks(DB_SRC);
const body = (name: string): string => {
  const chunk = CHUNKS.get(name);
  if (!chunk) {throw new Error(`no top-level function ${name} in database_supabase.ts`);}
  return chunk;
};

/** Does this function run on a MIS context — resolving one, or being handed one? */
const onMisContext = (chunk: string): boolean => /misContext\(restaurantId, q\)|\(mc: MisContext\b/.test(chunk);

/** A window predicate: `<column> >= $3`, where the column is a name or a coalesce(). */
const WINDOW_LOWER = /((?:coalesce\([^)]*\)|[a-z_]+\.[a-z_]+|[a-z_]+)) >= \$3\b/g;

const THE_FIFTEEN = [
  "GetItemWiseReport", "GetDiscountReport", "GetVoidKotReport", "GetBillEditReport",
  "GetSalesSummaryReport", "GetOrderSummaryReport", "GetExecutiveSummaryReport",
  "GetCoverSizeSummaryReport", "GetSettlementSummaryReport", "GetNcSummaryReport",
  "GetServiceChargeDenyReport", "GetGroupSummaryReport", "GetVariationSummaryReport",
  "GetTipSummaryReport", "GetCounterSummaryReport",
];

describe("every MIS window predicate carries the time slot, on its own clock", () => {
  // A fresh, non-global copy for the yes/no question: a /g regex's .test() is stateful.
  const bindsWindow = (chunk: string): boolean => new RegExp(WINDOW_LOWER.source).test(chunk) || chunk.includes("misSettledPredicate(mc)");
  const withWindow = [...CHUNKS.entries()].filter(([, chunk]) => onMisContext(chunk) && bindsWindow(chunk));

  test("THE ENUMERATION: the functions that bind a MIS window are exactly these", () => {
    expect(withWindow.map(([name]) => name).sort()).toEqual([
      "GetBillEditReport", "GetDiscountReport", "GetItemWiseReport", "GetNcSummaryReport",
      "GetOrderSummaryReport", "GetSalesSummaryReport", "GetServiceChargeDenyReport",
      "GetTipSummaryReport", "GetVoidKotReport",
      "fetchMisBillCounters", "fetchMisBills", "fetchMisNonChargeables", "fetchMisOrderLines",
    ]);
  });

  test.each([
    ["fetchMisNonChargeables", "created_at"],
    ["GetItemWiseReport", "o.created_at"],
    ["GetVoidKotReport", "o.created_at"],
    ["GetBillEditReport", "l.created_at"],
    ["fetchMisOrderLines", "o.created_at"],
    ["GetNcSummaryReport", "n.created_at"],
    ["GetServiceChargeDenyReport", "w.waived_at"],
    ["GetTipSummaryReport", "tn.settled_at"],
  ])("%s: `%s < $4` is followed by misTimeSql on that same column", (name, col) => {
    const chunk = body(name);
    const lowers = [...chunk.matchAll(WINDOW_LOWER)].map((m) => m[1]);
    expect(lowers.length).toBeGreaterThan(0);
    for (const lower of lowers) {expect(lower).toBe(col);}
    const pairs = [...chunk.matchAll(/([a-z_.]+) < \$4\$\{misTimeSql\("([^"]+)", mc\)\}/g)];
    expect(pairs.length).toBe(lowers.length);
    for (const [, bound, sliced] of pairs) {
      expect(bound).toBe(col);
      expect(sliced).toBe(col);
    }
  });

  test("the settlement clock has ONE predicate, and it cannot be had without saying which slot", () => {
    expect(DB_SRC).not.toMatch(/MIS_SETTLED_PREDICATE/);
    const fn = body("misSettledPredicate");
    expect(fn).toContain('coalesce(b.closed_at, b.admin_approved_at) < $4${mc ? misTimeSql("coalesce(b.closed_at, b.admin_approved_at)", mc) : ""}');
    // Every caller passes its context — except the Overview headline, which is
    // whole-day by definition and passes null, visibly.
    const calls = [...DB_SRC.matchAll(/misSettledPredicate\(([^)]*)\)/g)].map((m) => m[1]);
    const nulls = [...CHUNKS.entries()].filter(([, c]) => c.includes("misSettledPredicate(null)")).map(([n]) => n);
    expect(nulls).toEqual(["GetOverviewHeadline"]);
    for (const arg of calls) {expect(["mc", "null", "mc: Pick<MisContext, \"window\" | \"tz\"> | null"]).toContain(arg);}
    for (const name of ["fetchMisBills", "GetDiscountReport", "GetSalesSummaryReport", "GetOrderSummaryReport", "fetchMisBillCounters"]) {
      expect(body(name)).toContain("misSettledPredicate(mc)");
    }
  });

  // A cash session is a SPAN, so misTimeSql (a test on one instant's wall clock)
  // cannot cut it, and the hull alone holds every shift between the first day's
  // slot start and the last day's slot end: a dinner shift sits inside Lunch's
  // hull on any multi-day window. The overlap is therefore tested per day.
  test("the cash-session overlap is tested against the slot's hours ON EACH DAY, not the hull, and says so", () => {
    const fn = body("fetchMisCounterSessions");
    expect(fn).not.toContain("misTimeSql(");
    expect(fn).toContain("const days = mc.window.slot ? slotDayInstants(mc.window, mc.tz, mc.window.slot) : null;");
    // The hull stays (the whole test with no slot) and the EXISTS is added under one.
    expect(fn).toContain("and opened_at < $3 and (closed_at is null or closed_at >= $2)${days ? `");
    expect(fn).toContain("and exists (select 1 from unnest($4::timestamptz[], $5::timestamptz[]) as d(lo, hi)");
    expect(fn).toContain("where opened_at < d.hi and (closed_at is null or closed_at >= d.lo))` : \"\"}");
    expect(fn).toContain("[mc.context.res_id, mc.window.fromIso, mc.window.toIso, days.lo, days.hi]");
    expect(fn).toMatch(/UNDER A TIME SLOT a shift counts only when it overlaps the slot's hours ON\s+\/\/ AT LEAST ONE DAY/);
    // The days are slotDayBounds, converted exactly as the hull is.
    const days = body("slotDayInstants");
    expect(days).toContain("for (const b of slotDayBounds(w, slot))");
    expect(days).toContain("slotWallInstant(b.fromKey, b.fromMin, tz)");
    expect(days).toContain("slotWallInstant(b.toKey, b.toMin, tz)");
    expect(body("slotWindowInstants")).toContain("slotWallInstant(b.fromKey, b.fromMin, tz), toIso: slotWallInstant(b.toKey, b.toMin, tz)");
    expect(DB_SRC).toContain("counter_summary: \"Opened, Closed, Cash sessions and Cash variance describe whole shifts that overlap the slot's hours on at least one day of the range; a shift is not cut by the slot.\",");
  });

  test("misTimeSql inlines only checked values, parenthesised against :: precedence", () => {
    const fn = body("misTimeSql");
    expect(fn).toContain("if (!slot) {return \"\";}");
    expect(fn).toContain("!MIS_SQL_ZONE.test(mc.tz)");
    expect(fn).toContain("Number.isInteger(slot.start)");
    expect(fn).toContain("const clock = `((${col}) at time zone '${mc.tz}')::time`;");
    expect(fn).toContain("formatClock(slot.start)");
    expect(fn).toContain("slot.crosses_midnight ? ` and (${from} or ${to})` : ` and ${from} and ${to}`");
  });
});

describe("the slot is resolved once and reaches every report", () => {
  test.each(THE_FIFTEEN)("%s resolves its context (and so its slot) and ships misMeta", (name) => {
    const chunk = body(name);
    expect(chunk).toContain("await misContext(restaurantId, q)");
    expect(chunk).toMatch(/await misMeta\(mc, "[a-z_]+", /);
  });

  test("misContext resolves the slot, cuts the instants by it and appends its clamps", () => {
    const fn = body("misContext");
    expect(fn).toContain("resolveTimeSlot(q, presets)");
    // Through the one converter that also knows the trading day (see below).
    expect(fn).toContain("...misWindowInstants(resolved, tz, slot, shift)");
    expect(fn).toContain("const allClamps = [...clamped, ...dayClamps];");
    expect(fn).toContain("[...resolved.clamped, ...allClamps]");
    // The presets are read only when something names one.
    expect(fn).toContain('timeSlotNeedsPresets(q) || misBucketMode(q) === "session"');
    expect(fn).toContain("loadReportTimeSlots(context.res_id)");
  });

  test("misMeta ships meta.time_slot and the slot's note", () => {
    const fn = body("misMeta");
    expect(fn).toContain("time_slot: timeSlotMeta(mc.window.slot)");
    expect(fn).toContain("timeSlotNote(mc.window.slot, MIS_SLOT_SUBJECT[report]");
    for (const key of ["item_wise", "discount", "void_kot", "bill_edit", "sales_summary", "order_summary", "executive_summary", "cover_size_summary", "settlement_summary", "nc_summary", "service_charge_deny", "group_summary", "variation_summary", "tip_summary", "counter_summary"]) {
      expect(DB_SRC).toMatch(new RegExp(`\\n  ${key}: "[a-z ]+ [A-Z]+",`));
    }
  });

  test("the Executive Summary's previous period is cut by the same slot", () => {
    const fn = body("GetExecutiveSummaryReport");
    expect(fn).toContain("misWindowInstants(prev, mc.tz, mc.window.slot, mc.window.day_shift_min)");
    expect(fn).toContain("slot: mc.window.slot,");
    expect(fn).not.toContain(" windowInstants(prev, mc.tz)");
    expect(fn).not.toContain("slotWindowInstants(prev");
  });

  test("the Sales Summary buckets on the service day, with the explicit order", () => {
    const fn = body("GetSalesSummaryReport");
    expect(fn).toContain("composeMisBills(await fetchMisBills(mc), scPct, mc.tz, mc.window.slot, mc.window.day_shift_min)");
    expect(fn).toContain("misNcByBucket(ncRows, mc, bucket)");
    expect(fn).toContain("misNcCompletedSeries(misSeries(bills, bucket, mc.presets), ncByBucket, timeBucketOrder(bucket, mc.presets))");
    expect(body("misNcByBucket")).toContain("serviceDayKey(clock.key, minute, mc.window.slot, mc.window.day_shift_min)");
    expect(body("composeMisBills")).toContain("serviceDayKey(clock.key, clock.hour * 60 + clock.minute, slot, dayShift)");
  });

  test("the preset column is created at runtime with the other settings columns", () => {
    expect(body("ensureBrandingColumns")).toContain('alter table "Restaurant" add column if not exists report_time_slots jsonb default null');
    // The save issues its DDL before, never inside, its transaction.
    const save = body("SetReportTimeSlots");
    expect(save.indexOf("await ensureBrandingColumns()")).toBeLessThan(save.indexOf("withTransaction("));
    expect(save).toContain("loadReportTimeSlots(context.res_id, client)");
  });
});

describe("the HTTP surface passes it on", () => {
  test("misQuery forwards slot, time_from and time_to raw", () => {
    const fn = functionChunks(ROUTES_SRC).get("misQuery") ?? "";
    expect(fn).toContain("slot: req.query.slot,");
    expect(fn).toContain("time_from: req.query.time_from,");
    expect(fn).toContain("time_to: req.query.time_to,");
  });

  test("the CSV name carries the slot suffix (and, client item 9, the trading-day one after it)", () => {
    const fn = functionChunks(ROUTES_SRC).get("misFilename") ?? "";
    expect(fn).toContain("${timeSlotFileSuffix(meta.time_slot)}${close}.csv");
    expect(fn).toContain("const close = meta.window.day_close ? tradingDayFileSuffix(parseDayClose(meta.window.day_close)) : \"\";");
  });

  test("the catalogue advertises the slot for every report it lists, and the four cuts", () => {
    const listed = [...ROUTES_SRC.matchAll(/\{ key: "([a-z_]+)", title: /g)].map((m) => m[1]);
    expect(listed).toHaveLength(15);
    const keys = /const MIS_REPORT_KEYS = \[([\s\S]*?)\] as const;/.exec(ROUTES_SRC)?.[1] ?? "";
    expect([...keys.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual(listed);
    expect(ROUTES_SRC).toContain('time_slot: { params: ["slot", "time_from", "time_to"], presets_path: "/reports/mis/time-slots", applies_to: [...MIS_REPORT_KEYS] },');
    expect(ROUTES_SRC).toContain('time_wise: { param: "bucket", values: [...TIME_BUCKET_MODES], applies_to: ["sales_summary"] },');
  });

  test("GET is a read on ACCOUNTING_PERM; PUT is a settings write on PERM_SETTINGS", () => {
    expect(ROUTES_SRC).toContain('app.get("/reports/mis/time-slots", validateAction(ACCOUNTING_PERM), ');
    expect(ROUTES_SRC).toContain('app.put("/reports/mis/time-slots", validateAction(PERM_SETTINGS), ');
    // Above the `:id` drill-downs, like the fifteen.
    expect(ROUTES_SRC.indexOf('"/reports/mis/time-slots"')).toBeLessThan(ROUTES_SRC.indexOf('"/reports/mis/bill/:id"'));
  });
});
