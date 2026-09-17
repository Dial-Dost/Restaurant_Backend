/**
 * THE date-window contract. One place decides what "1–15 August" and what
 * "the last 7 days" mean, for accounting and analytics alike.
 *
 * PURE module — no imports, no database, no clock of its own (`now` is injected).
 * Same discipline as billing_math.ts / posters.ts: every rule below is decided by
 * value, so a jest suite can prove inclusivity, the timezone boundary and every
 * clamp without a pg pool. `database_supabase.ts` imports from here (and
 * re-exports addDaysToKey), so there is exactly one definition of a day key.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reporting surface had grown two incompatible notions of a window:
 *   - accounting took explicit `from`/`to` (whole calendar days),
 *   - analytics took a ROLLING `days` count ending "now".
 * A rolling count cannot express "1–15 August" at all, so the owner's calendar
 * picker had nothing to talk to on half the screens. Worse, the two disagreed
 * about which rows a "30 day" window even holds. This module makes both shapes
 * resolve to the SAME pair of inclusive calendar day keys before any SQL runs.
 *
 * THE CONTRACT
 * ------------
 *  1. `from` and `to` are YYYY-MM-DD CALENDAR DAYS IN THE RESTAURANT'S OWN IANA
 *     ZONE. "1 Aug" means 1 Aug where the restaurant is, not where the server is.
 *  2. BOTH ENDPOINTS ARE INCLUSIVE. An owner who picks 1–15 August is asking for
 *     fifteen days of trade including the 15th. Consumers turn `to` into an
 *     EXCLUSIVE upper bound by taking local midnight of `to` + 1 day — which is
 *     what dayRangeOf(to).toIso already does. Getting this wrong is not a subtle
 *     bug: an exclusive `to` drops the last day's takings, and the owner sees it
 *     as "the numbers are short".
 *  3. PRECEDENCE. `from`/`to` WIN over `days`. Either one alone is enough to make
 *     the request a range; `days` then only supplies the span for the missing
 *     end. With neither, `days` (or the endpoint's default) gives the last N
 *     calendar days ENDING TODAY — byte-for-byte what the shipped clients get
 *     today, which is why they keep working across this deploy.
 *  4. CLAMPS ARE RULES, NOT ACCIDENTS. Every adjustment is named in `clamped` and
 *     travels in the response, so a screen can say "showing the most recent 365
 *     days" instead of quietly lying. See resolveReportWindow for each rule and
 *     why it is that way round.
 */

/** Every way a request's window can be adjusted. Named, and reported. */
export type WindowClamp =
  /** `from` was not a date this module could read; ignored. */
  | "from_unparseable"
  /** `to` was not a date this module could read; ignored. */
  | "to_unparseable"
  /** `days` was not a number; the endpoint default was used. */
  | "days_unparseable"
  /** `days` fell outside the endpoint's own min/max and was pulled in. */
  | "days_clamped"
  /** from > to: the pair was swapped rather than yielding an empty report. */
  | "reversed"
  /** `from` was after today; pulled back to today. */
  | "future_from"
  /** `to` was after today; pulled back to today. */
  | "future_to"
  /** The span exceeded the endpoint's cap; `from` moved forward to fit. */
  | "span_capped"
  /** `slot` named no preset this restaurant has; the report is ALL DAY. */
  | "slot_unknown"
  /** `time_from` / `time_to` was not a readable HH:mm; the report is ALL DAY. */
  | "time_unparseable"
  /** The custom times start and end at the same minute; the report is ALL DAY. */
  | "time_empty"
  /** `day_close` was not a readable HH:mm; the report is on CALENDAR days. */
  | "day_close_unparseable"
  /** `day_close` came with a time slot. The two are not combined (v1): the
   *  slot is kept and the days are calendar days. */
  | "day_close_with_slot";

export interface ReportWindowQuery {
  /** YYYY-MM-DD (or any ISO instant) — the FIRST day of the window, inclusive. */
  from?: unknown;
  /** YYYY-MM-DD (or any ISO instant) — the LAST day of the window, inclusive. */
  to?: unknown;
  /** Legacy rolling span: the last N calendar days ending today. */
  days?: unknown;
  /** A preset time slot id ("lunch"), or "all". See resolveTimeSlot. */
  slot?: unknown;
  /** HH:mm — a CUSTOM slot's start, inclusive. Wins over `slot`. */
  time_from?: unknown;
  /** HH:mm (or "24:00") — a CUSTOM slot's end, exclusive. Wins over `slot`. */
  time_to?: unknown;
}

export interface ReportWindowLimits {
  /** Span used when the caller supplies no `days` and no complete range. */
  defaultDays: number;
  /** Floor for the `days` SHORTHAND only — never applied to an explicit range. */
  minDays?: number;
  /** Hard cap on the resolved span. This is what stops a whole-table scan. */
  maxDays?: number;
  /** Injected clock, so the tests are not a hostage to the day they run on. */
  now?: Date;
}

export interface ResolvedReportWindow {
  /** First day of the window, INCLUSIVE, in the restaurant's zone. */
  from: string;
  /** Last day of the window, INCLUSIVE, in the restaurant's zone. */
  to: string;
  /** Inclusive day count: to − from + 1. Never zero. */
  days: number;
  /** Which shape the caller actually asked in — useful for logs and for the UI. */
  source: "range" | "days";
  /** Adjustments applied, in the order they were applied. Usually empty. */
  clamped: WindowClamp[];
}

/**
 * The widest span any reporting endpoint will serve: two years.
 *
 * Not arbitrary. An Indian owner's real long window is a financial year
 * (1 Apr – 31 Mar, 365/366 days) and the comparison they ask for next is the
 * SAME window a year earlier — so anything shorter than ~731 days would refuse a
 * request that is genuinely routine. Beyond that a "range" is not a range: it is
 * a full scan of "Bills" wearing a date filter, which is exactly what a picker
 * that lets you drag for a year makes trivially easy to fire by accident.
 */
export const MAX_REPORT_DAYS = 731;

/** Fallback span when nothing is asked for. Matches what the reports shipped with. */
export const DEFAULT_REPORT_DAYS = 30;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is this exactly a YYYY-MM-DD calendar key? */
export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY.test(value);
}

/**
 * Calendar date (YYYY-MM-DD) of an instant AS SEEN IN `tz`.
 *
 * Intl is the whole implementation on purpose: it carries the IANA database,
 * including historical and DST offsets, so this is correct for zones whose offset
 * is not a whole hour (Kolkata +5:30, Kathmandu +5:45, Chatham +12:45) without a
 * table of our own to go stale.
 */
export function dateKeyInZone(value: Date | string, tz: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {return "";}
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Add whole days to a YYYY-MM-DD calendar key (no DST arithmetic — pure calendar). */
export function addDaysToKey(dateKey: string, days: number): string {
  const m = DATE_KEY.exec(dateKey);
  if (!m) {return dateKey;}
  const anchor = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return anchor.toISOString().slice(0, 10);
}

/**
 * INCLUSIVE day count between two calendar keys: countDays("2026-08-01",
 * "2026-08-15") is 15, not 14. Pure calendar arithmetic on UTC-anchored keys, so
 * a DST transition inside the range cannot shorten or lengthen the count — the
 * keys already name days, and a day is a day whatever its wall-clock length.
 */
function keyToUtcMs(dateKey: string): number | null {
  const m = DATE_KEY.exec(dateKey);
  if (!m) {return null;}
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function countDays(fromKey: string, toKey: string): number {
  const a = keyToUtcMs(fromKey), b = keyToUtcMs(toKey);
  if (a === null || b === null) {return 0;}
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Read one query value as text.
 *
 * Express hands `?from=a&from=b` over as an ARRAY and a bracketed key as an
 * object, so the first scalar is taken and anything that is not a string or a
 * number becomes "" — i.e. "not supplied". Stringifying the object case would
 * produce "[object Object]", which would then be reported as an unreadable DATE
 * rather than as the malformed query it is.
 */
function queryText(value: unknown): string {
  const v: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof v === "string") {return v.trim();}
  if (typeof v === "number" && Number.isFinite(v)) {return String(v);}
  return "";
}

/**
 * Read one end of the window. Returns a day key, `null` for "not supplied", or
 * `false` for "supplied but unreadable" — three outcomes the caller must tell
 * apart, because only the third is worth reporting as a clamp.
 *
 * A full ISO instant is accepted and converted THROUGH the restaurant's zone
 * rather than sliced: the accounting routes have always taken that shape, and
 * slicing "2026-08-01T20:00:00Z" to "2026-08-01" would name the wrong day for a
 * Kolkata restaurant, where that instant is already the 2nd.
 */
function readDayEnd(raw: unknown, tz: string): string | null | false {
  const s = queryText(raw);
  if (!s) {return null;}
  if (DATE_KEY.test(s)) {return s;}
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {return false;}
  const key = dateKeyInZone(d, tz);
  return key || false;
}

/**
 * Resolve a request's window to two INCLUSIVE calendar day keys in `tz`.
 *
 * The order of the steps below is the contract, and it is deliberate:
 *
 *   1. SWAP BEFORE CLAMPING TO TODAY. An owner who drags a calendar right-to-left
 *      sends from > to and means the same fortnight. Swapping first means a pair
 *      like (2027-01-01, 2026-08-01) becomes 1 Aug → today rather than collapsing
 *      to a single empty day, which is what clamping first would have produced.
 *   2. NO FUTURE. There is no trade after today, so a `to` past today is pulled
 *      back to today. An unclamped future window is not "empty because nothing
 *      happened" — it renders as zeros, which reads to an owner exactly like data
 *      loss. Same for `from`; a wholly-future range therefore lands on today.
 *   3. FILL THE MISSING END. A missing `to` is today, so `?from=2026-08-01` reads
 *      as "since 1 August". A missing `from` walks `days` back from `to`, so
 *      `?to=2026-08-15&days=7` is 9–15 August — the rolling window the clients
 *      already speak, simply anchored somewhere other than today.
 *   4. CAP LAST, BY MOVING `from`. When a span is too wide the RECENT end is what
 *      the owner is looking at, so `to` is kept and `from` slides forward.
 *
 * `minDays` is applied ONLY to the `days` shorthand. An explicit one-day range is
 * honoured as one day: the owner clicked that day, and silently widening it to
 * the endpoint's floor would answer a question nobody asked.
 */
export function resolveReportWindow(
  query: ReportWindowQuery,
  tz: string,
  limits: ReportWindowLimits,
): ResolvedReportWindow {
  const clamped: WindowClamp[] = [];
  const maxDays = Math.max(1, Math.round(limits.maxDays ?? MAX_REPORT_DAYS));
  const minDays = Math.max(1, Math.round(limits.minDays ?? 1));
  const now = limits.now ?? new Date();
  // A tenant zone this module cannot read would otherwise poison every key. It
  // never should be: callers pass context.timezone, already sanitised.
  const today = dateKeyInZone(now, tz) || dateKeyInZone(now, "UTC");

  // --- the `days` shorthand ---------------------------------------------------
  let days = Math.round(limits.defaultDays) || DEFAULT_REPORT_DAYS;
  const daysRaw = queryText(query.days);
  if (daysRaw !== "") {
    const n = Number(daysRaw);
    if (!Number.isFinite(n)) {
      clamped.push("days_unparseable");
    } else {
      const rounded = Math.round(n);
      const pulled = Math.min(maxDays, Math.max(minDays, rounded));
      if (pulled !== rounded) {clamped.push("days_clamped");}
      days = pulled;
    }
  }

  // --- the explicit range -----------------------------------------------------
  let fromKey = readDayEnd(query.from, tz);
  let toKey = readDayEnd(query.to, tz);
  if (fromKey === false) { clamped.push("from_unparseable"); fromKey = null; }
  if (toKey === false) { clamped.push("to_unparseable"); toKey = null; }

  const source: "range" | "days" = fromKey !== null || toKey !== null ? "range" : "days";

  // 1. reversed pair
  if (fromKey !== null && toKey !== null && fromKey > toKey) {
    const swap = fromKey; fromKey = toKey; toKey = swap;
    clamped.push("reversed");
  }
  // 2. nothing in the future
  if (toKey !== null && toKey > today) { toKey = today; clamped.push("future_to"); }
  if (fromKey !== null && fromKey > today) { fromKey = today; clamped.push("future_from"); }
  // 3. fill whichever end was not given
  toKey ??= today;
  fromKey ??= addDaysToKey(toKey, -(days - 1));
  // Belt and braces: steps 1-3 should make this unreachable (a wholly-future
  // range lands on today at BOTH ends). It stays because the alternative to an
  // ordered pair here is a negative span propagating into SQL as `>= x and < y`
  // with y before x — a silently empty report rather than a loud failure.
  if (fromKey > toKey) {fromKey = toKey;}
  // 4. cap the span, keeping the recent end
  let span = countDays(fromKey, toKey);
  if (span > maxDays) {
    fromKey = addDaysToKey(toKey, -(maxDays - 1));
    span = maxDays;
    clamped.push("span_capped");
  }

  return { from: fromKey, to: toKey, days: span, source, clamped };
}

// ============================================================================
// TIME SLOTS — a part of each day, laid over the days above
// ============================================================================
//
// "Structure the reports section wise — select time for hour-wise reports or
// session-wise reports ... preset time slots for 2 sessions: lunch 12pm to 5pm
// and dinner 6pm to 12am."
//
// THE CONTRACT, in the order a report applies it:
//
//  1. A SLOT IS A FILTER ON THE CLOCK THE REPORT ALREADY USES. Settlement for the
//     bill reports, order placement for the item reports, the moment of the act
//     for comps, waivers, tips and edits. Nothing here picks a clock; it only
//     says which minutes of each day count. That is what keeps Sales = Σ Order
//     = Σ Settlement = Σ Counter true under any slot: every figure in a clock
//     family is cut by the same minutes.
//  2. HALF-OPEN, [start, end). A bill settled at exactly 17:00:00 is not Lunch
//     (12:00-17:00) and would be Dinner if Dinner started at 17:00. A closed end
//     double-counts that bill; an open start loses it.
//  3. A SLOT THAT CROSSES MIDNIGHT BELONGS TO THE DAY IT STARTS ON. 22:00-02:00
//     over 1-15 August is the union over D = 1..15 of [D 22:00, D+1 02:00), so
//     16 Aug 01:30 is in (the 15th's late night) and 1 Aug 01:30 is out (the
//     31st's). A pure clock filter over calendar days would hand Friday's
//     late-night report Thursday's tail and drop Friday's own.
//  4. ALL DAY IS NO SLOT. No param, `slot=all`, and 00:00-24:00 all resolve to
//     `null`, and a null slot changes nothing — not the SQL, not the payload's
//     numbers, not the notes, not the filename. Every report shipped before this
//     existed is therefore exactly what it was.
//  5. CUSTOM WINS OVER A PRESET, the way from/to win over days. A custom or
//     preset slot that cannot be honoured falls back to ALL DAY with the reason
//     NAMED in `clamped`, never to a guess.
//
// "24:00" is local midnight at the END of the day. It is accepted as an end
// (Dinner 18:00-24:00 does NOT cross midnight), and an end of "00:00" means the
// same thing, so 22:00-00:00 is 22:00-24:00 rather than an empty slot.
//
// NAMED time_slot, not "session" and not "section": TableSessions/CashSessions
// and table sections already own those words in this codebase. The owner's
// screen may still say "Session".

/** A preset as stored in "Restaurant".report_time_slots and as the wire carries it. */
export interface TimeSlotPreset {
  /** A slug, [a-z0-9_-]{1,32}. What `?slot=` names. */
  id: string;
  /** 1-24 characters, as the owner typed it. */
  label: string;
  /** HH:mm, 00:00-23:59. Inclusive. */
  start: string;
  /** HH:mm, 00:01-24:00. Exclusive. */
  end: string;
}

/** A slot a report actually applies, in MINUTES past local midnight. */
export interface TimeSlot {
  /** The preset id, or null for custom times. */
  id: string | null;
  label: string;
  /** 0..1439, INCLUSIVE. */
  start: number;
  /** 1..1440, EXCLUSIVE. 1440 is midnight at the end of the day. */
  end: number;
  /** end < start: the slot runs past midnight into the next calendar day. */
  crosses_midnight: boolean;
  source: "preset" | "custom";
}

/** meta.time_slot — the slot a payload was cut by, or null for all day. */
export interface TimeSlotMeta {
  id: string | null;
  label: string;
  start: string;
  end: string;
  crosses_midnight: boolean;
  source: "preset" | "custom";
}

/** One preset on the wire (GET/PUT /reports/mis/time-slots). */
export interface TimeSlotPresetWire extends TimeSlotPreset {
  crosses_midnight: boolean;
}

export const MAX_TIME_SLOTS = 8;
export const MAX_TIME_SLOT_LABEL = 24;
/** The `slot` value that means the whole day. Reserved: no preset may take it. */
export const ALL_DAY_SLOT_ID = "all";
/** meta.time_slot.label for custom times. */
export const CUSTOM_TIME_SLOT_LABEL = "Custom";
/** The session breakdown's row for money no preset claims. */
export const OUTSIDE_SESSIONS_LABEL = "Outside sessions";

/**
 * The client's two sessions, exactly as asked: lunch 12pm-5pm, dinner 6pm-12am.
 *
 * They do NOT cover the day. 00:00-12:00 and 17:00-18:00 belong to neither, and
 * production has real money there (bills settled 00:00-01:59 and at 17:xx), so
 * the session breakdown always carries an Outside sessions row rather than
 * letting that money vanish between two presets. An owner who wants Dinner to
 * run to 02:00 can say so; the default answers the question that was asked.
 */
export const DEFAULT_TIME_SLOTS: readonly TimeSlotPreset[] = Object.freeze([
  Object.freeze({ id: "lunch", label: "Lunch", start: "12:00", end: "17:00" }),
  Object.freeze({ id: "dinner", label: "Dinner", start: "18:00", end: "24:00" }),
]);

const CLOCK = /^(\d{1,2}):(\d{2})$/;
const SLOT_ID = /^[a-z0-9_-]{1,32}$/;

/**
 * Minutes past local midnight of an "HH:mm", or null when it is not one.
 *
 * "24:00" is 1440 only when `allow24` — it is a legal END and never a start.
 * A one-digit hour ("9:30") is read, because a hand-typed query string is not a
 * reason to answer a different question; everything written back out is HH:mm.
 */
export function parseClockMinutes(value: unknown, opts: { allow24?: boolean } = {}): number | null {
  const m = CLOCK.exec(queryText(value));
  if (!m) {return null;}
  const h = Number(m[1]), mi = Number(m[2]);
  if (mi > 59) {return null;}
  if (h === 24 && mi === 0) {return opts.allow24 ? 1440 : null;}
  if (h > 23) {return null;}
  return h * 60 + mi;
}

/** "HH:mm" of a minute count. 1440 is "24:00". */
export function formatClock(minutes: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The slot a pair of minutes describes, or null when it is the whole day.
 *
 * An END of 0 is read as 1440 — "until midnight" — so an owner typing 00:00 for
 * "midnight" can never produce an empty slot or a day-long crossing one.
 */
function slotOf(id: string | null, label: string, start: number, endRaw: number, source: TimeSlot["source"]): TimeSlot | null {
  const end = endRaw === 0 ? 1440 : endRaw;
  if (start === 0 && end === 1440) {return null;}
  return { id, label, start, end, crosses_midnight: end < start, source };
}

/** A stored preset's minutes. Null for a preset that is not one (never saved: validated). */
function presetMinutes(p: TimeSlotPreset): { start: number; end: number } | null {
  const start = parseClockMinutes(p.start);
  const endRaw = parseClockMinutes(p.end, { allow24: true });
  if (start === null || endRaw === null) {return null;}
  const end = endRaw === 0 ? 1440 : endRaw;
  return start === end ? null : { start, end };
}

/** Does this minute of the day fall inside [start, end) on the 24-hour circle? */
export function slotContains(slot: Pick<TimeSlot, "start" | "end">, minute: number): boolean {
  return slot.end < slot.start
    ? minute >= slot.start || minute < slot.end
    : minute >= slot.start && minute < slot.end;
}

/**
 * Does resolving this query need the restaurant's presets at all?
 *
 * Only a preset id does. Custom times, `slot=all` and no slot resolve without a
 * read, which keeps every report that is not cut by a preset at exactly the
 * queries it issued before slots existed.
 */
export function timeSlotNeedsPresets(query: ReportWindowQuery): boolean {
  if (queryText(query.time_from) !== "" || queryText(query.time_to) !== "") {return false;}
  const id = queryText(query.slot).toLowerCase();
  return id !== "" && id !== ALL_DAY_SLOT_ID;
}

/**
 * Resolve a request's time slot against the restaurant's presets.
 *
 * PRECEDENCE mirrors the date window's: custom `time_from`/`time_to` win over
 * `slot`, and either custom end alone is enough — a missing start is 00:00 and a
 * missing end is 24:00, so `?time_from=18:00` reads as "from 18:00". Every
 * refusal falls back to ALL DAY with the reason in `clamped`; a report that
 * silently answered a narrower (or a different) question than the one asked
 * would be worse than one that answered the whole day and said why.
 */
export function resolveTimeSlot(
  query: ReportWindowQuery,
  presets: readonly TimeSlotPreset[],
): { slot: TimeSlot | null; clamped: WindowClamp[] } {
  const fromText = queryText(query.time_from), toText = queryText(query.time_to);
  if (fromText !== "" || toText !== "") {
    const start = fromText === "" ? 0 : parseClockMinutes(fromText);
    const end = toText === "" ? 1440 : parseClockMinutes(toText, { allow24: true });
    if (start === null || end === null) {return { slot: null, clamped: ["time_unparseable"] };}
    if (start === (end === 0 ? 1440 : end)) {return { slot: null, clamped: ["time_empty"] };}
    return { slot: slotOf(null, CUSTOM_TIME_SLOT_LABEL, start, end, "custom"), clamped: [] };
  }
  const id = queryText(query.slot).toLowerCase();
  if (id === "" || id === ALL_DAY_SLOT_ID) {return { slot: null, clamped: [] };}
  const preset = presets.find((p) => p.id === id);
  const minutes = preset ? presetMinutes(preset) : null;
  if (!preset || !minutes) {return { slot: null, clamped: ["slot_unknown"] };}
  return { slot: slotOf(preset.id, preset.label, minutes.start, minutes.end, "preset"), clamped: [] };
}

/**
 * The OUTER wall-clock bounds of a slot over a window of days.
 *
 * [from at start, (to or to+1) at end). The +1 applies when the slot ends at or
 * after midnight — Dinner 18:00-24:00 ends at the start of the next day, and
 * 22:00-02:00 on the last day ends at 02:00 of the day after it. Together with
 * the per-row time-of-day predicate this is EXACTLY the per-day union of rule 3:
 * the outer bounds drop the first day's pre-slot tail and the last day's
 * post-slot head, and the time predicate removes the gaps in between. The outer
 * bounds are also what keeps the existing range index doing the work.
 */
export function slotBounds(
  w: { from: string; to: string },
  slot: Pick<TimeSlot, "start" | "end" | "crosses_midnight">,
): { fromKey: string; fromMin: number; toKey: string; toMin: number } {
  const nextDay = slot.crosses_midnight || slot.end === 1440;
  return {
    fromKey: w.from,
    fromMin: slot.start,
    toKey: nextDay ? addDaysToKey(w.to, 1) : w.to,
    toMin: slot.end % 1440,
  };
}

/**
 * The slot on EACH day of a window, in day order: the members of rule 3's
 * per-day union, whose outer hull slotBounds is.
 *
 * The hull plus a time-of-day predicate is exact for an INSTANT, because an
 * instant has one wall clock. It is not exact for a SPAN. A cash session is
 * opened at one moment and closed at another, and a dinner shift on 1 August
 * (18:00-23:30) lies inside Lunch's hull over 1-3 August (the 1st 12:00 to the
 * 3rd 17:00) without ever meeting Lunch. Asking whether a span meets the slot
 * needs each day's interval, so this returns them.
 *
 * Each day is slotBounds of that day alone. So the first interval starts where
 * the hull starts and the last ends where the hull ends, by construction rather
 * than through a second copy of the midnight rule. A reversed or unreadable
 * window has no days. A window wider than MAX_REPORT_DAYS is refused out loud: a
 * resolved window never is one, and a quietly shortened list would drop shifts.
 */
export function slotDayBounds(
  w: { from: string; to: string },
  slot: Pick<TimeSlot, "start" | "end" | "crosses_midnight">,
): { fromKey: string; fromMin: number; toKey: string; toMin: number }[] {
  const days = countDays(w.from, w.to);
  if (days > MAX_REPORT_DAYS) {
    throw new RangeError(`slotDayBounds: ${String(days)} days is wider than a report window can be (${String(MAX_REPORT_DAYS)})`);
  }
  const out: { fromKey: string; fromMin: number; toKey: string; toMin: number }[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = addDaysToKey(w.from, i);
    out.push(slotBounds({ from: day, to: day }, slot));
  }
  return out;
}

/**
 * The business day an instant counts on under a slot: the day the slot STARTED.
 *
 * Only a crossing slot moves anything, and only its after-midnight part:
 * 01:30 on the 16th under 22:00-02:00 is the 15th's. With no slot, or a slot
 * that stays inside one day, the calendar day is the answer — which is why the
 * day series of every all-day report is unchanged.
 */
export function serviceDayKey(calendarDay: string, minute: number, slot: TimeSlot | null, dayShiftMin = 0): string {
  // A TRADING DAY moves the boundary of EVERY day, not just a slot's tail — see
  // the trading-day section below. The two are never combined (misContext
  // refuses the pair), so a shift is answered first and alone.
  if (dayShiftMin > 0 && minute < dayShiftMin) {return addDaysToKey(calendarDay, -1);}
  if (dayShiftMin < 0 && minute >= 1440 + dayShiftMin) {return addDaysToKey(calendarDay, 1);}
  if (slot && slot.crosses_midnight && minute < slot.end) {return addDaysToKey(calendarDay, -1);}
  return calendarDay;
}

/** The first preset whose hours hold this minute, or null (Outside sessions). */
export function sessionOf(presets: readonly TimeSlotPreset[], minute: number): TimeSlotPreset | null {
  for (const p of presets) {
    const m = presetMinutes(p);
    if (m && slotContains(m, minute)) {return p;}
  }
  return null;
}

// --- The time-wise cut ---------------------------------------------------------

/**
 * How the Sales Summary's series is cut.
 *
 *   day          one row per business day (the default, and what it always was)
 *   hour         one row per DATE x HOUR, keyed YYYY-MM-DDTHH (what it always was)
 *   hour_of_day  one row per HOUR OF THE DAY across the whole window, keyed
 *                "13:00-14:00" — "how busy is 1pm this month"
 *   session      one row per preset, in preset order, then Outside sessions
 */
export type TimeBucketMode = "day" | "hour" | "hour_of_day" | "session";

export const TIME_BUCKET_MODES: readonly TimeBucketMode[] = Object.freeze(["day", "hour", "hour_of_day", "session"] as TimeBucketMode[]);

/** Read `?bucket=`. Anything unrecognised is the default day cut. */
export function timeBucketMode(raw: unknown): TimeBucketMode {
  const v = queryText(raw).toLowerCase();
  return (TIME_BUCKET_MODES as readonly string[]).includes(v) ? (v as TimeBucketMode) : "day";
}

/** "13:00-14:00". The last hour is "23:00-24:00", never "23:00-00:00". */
export function hourOfDayLabel(hour: number): string {
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  return `${formatClock(h * 60)}-${formatClock((h + 1) * 60)}`;
}

/** "Lunch (12:00-17:00)" — a session row names its hours, so two same-named presets stay apart. */
export function sessionBucketLabel(p: TimeSlotPreset): string {
  const m = presetMinutes(p);
  return m ? `${p.label} (${formatClock(m.start)}-${formatClock(m.end)})` : p.label;
}

/**
 * The bucket one instant lands in.
 *
 * `serviceDay` is serviceDayKey's answer and `calendarDay` the plain local date.
 * The DAY cut uses the service day, so a crossing slot's night stays with the
 * evening it began. The DATE x HOUR cut keeps the calendar date: "2026-08-16T01"
 * is literally that hour, and it sorts where it happened.
 */
export function timeBucketKey(
  mode: TimeBucketMode,
  at: { serviceDay: string; calendarDay: string; minute: number },
  presets: readonly TimeSlotPreset[],
): string {
  switch (mode) {
    case "hour": return `${at.calendarDay}T${String(Math.floor(at.minute / 60)).padStart(2, "0")}`;
    case "hour_of_day": return hourOfDayLabel(Math.floor(at.minute / 60));
    case "session": {
      const p = sessionOf(presets, at.minute);
      return p ? sessionBucketLabel(p) : OUTSIDE_SESSIONS_LABEL;
    }
    default: return at.serviceDay;
  }
}

/** The rows a mode shows even when nothing happened in them: every preset, for `session`. */
export function fixedTimeBuckets(mode: TimeBucketMode, presets: readonly TimeSlotPreset[]): string[] {
  return mode === "session" ? presets.map(sessionBucketLabel) : [];
}

/**
 * The order a series is read in, stated rather than left to string sorting.
 *
 * Day, date x hour and hour-of-day keys are zero-padded, so their text order IS
 * time order. Session rows are not: they follow the owner's preset order, and
 * Outside sessions comes last, whatever the labels spell.
 */
export function timeBucketOrder(mode: TimeBucketMode, presets: readonly TimeSlotPreset[]): (a: string, z: string) => number {
  if (mode !== "session") {return (a, z) => a.localeCompare(z);}
  const rank = new Map<string, number>(presets.map((p, i) => [sessionBucketLabel(p), i]));
  const rankOf = (key: string): number => rank.get(key) ?? (key === OUTSIDE_SESSIONS_LABEL ? presets.length : presets.length + 1);
  return (a, z) => rankOf(a) - rankOf(z) || a.localeCompare(z);
}

// --- Presets: validation, storage, the wire -------------------------------------

/** A refused preset save. `message` is ONE plain sentence the owner can act on. */
export class TimeSlotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeSlotConfigError";
  }
}

export type TimeSlotValidation =
  | { ok: true; slots: TimeSlotPreset[] }
  | { ok: false; error: string };

/** A slug from a label: "Late Night" -> "late-night". Empty when nothing survives. */
function slugOf(text: string, max: number): string {
  return text.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");
}

/** Control characters become spaces; runs of whitespace become one. */
function cleanLabel(value: unknown): string {
  if (typeof value !== "string") {return "";}
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Validate a whole preset list, as an owner saves it.
 *
 * REFUSED OUT LOUD, one sentence, first problem first. The rules:
 *   * at most MAX_TIME_SLOTS; an EMPTY list is valid (the route reads it as
 *     "back to the defaults");
 *   * a label of 1-24 characters (whitespace collapsed);
 *   * HH:mm times, start 00:00-23:59, end 00:01-24:00 ("00:00" as an end is
 *     24:00), and a start that is not its own end;
 *   * ids are unique slugs; an entry without one gets one from its label, and
 *     "all" is never an id because `slot=all` already means the whole day;
 *   * NO OVERLAP on the 24-hour circle. Each minute of the day can belong to at
 *     most one session, or the session breakdown would count a bill twice and
 *     stop adding up to its own total.
 */
export function validateTimeSlotPresets(raw: unknown): TimeSlotValidation {
  if (!Array.isArray(raw)) {return { ok: false, error: "Send the time slots as a list." };}
  if (raw.length > MAX_TIME_SLOTS) {
    return { ok: false, error: `You can save at most ${String(MAX_TIME_SLOTS)} time slots.` };
  }

  interface Draft { id: string | null; label: string; start: number; end: number }
  const drafts: Draft[] = [];
  for (const entry of raw as unknown[]) {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = cleanLabel(e.label);
    if (label.length === 0 || [...label].length > MAX_TIME_SLOT_LABEL) {
      return { ok: false, error: `Every time slot needs a name of 1 to ${String(MAX_TIME_SLOT_LABEL)} characters.` };
    }
    const start = parseClockMinutes(e.start);
    if (start === null) {return { ok: false, error: `"${label}" needs a start time between 00:00 and 23:59, written as HH:mm.` };}
    const endRaw = parseClockMinutes(e.end, { allow24: true });
    if (endRaw === null) {return { ok: false, error: `"${label}" needs an end time between 00:01 and 24:00, written as HH:mm.` };}
    const end = endRaw === 0 ? 1440 : endRaw;
    if (start === end) {return { ok: false, error: `"${label}" starts and ends at the same time.` };}
    let id: string | null = null;
    if (typeof e.id === "string" && e.id.trim() !== "") {
      id = e.id.trim().toLowerCase();
      if (!SLOT_ID.test(id)) {
        return { ok: false, error: `"${label}" has an id that is not 1 to 32 lowercase letters, digits, - or _.` };
      }
      if (id === ALL_DAY_SLOT_ID) {return { ok: false, error: `"${label}" cannot use the id "all", which already means the whole day.` };}
    }
    drafts.push({ id, label, start, end });
  }

  const taken = new Set<string>([ALL_DAY_SLOT_ID]);
  for (const d of drafts) {
    if (d.id === null) {continue;}
    if (taken.has(d.id)) {return { ok: false, error: `Two time slots use the id "${d.id}".` };}
    taken.add(d.id);
  }
  drafts.forEach((d, i) => {
    if (d.id !== null) {return;}
    const base = slugOf(d.label, 32) || `slot-${String(i + 1)}`;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) {
      const suffix = `-${String(n)}`;
      candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    d.id = candidate;
    taken.add(candidate);
  });

  // The circle, unrolled: a crossing slot is two plain intervals.
  const pieces = (d: Draft): [number, number][] => (d.end < d.start ? [[d.start, 1440], [0, d.end]] : [[d.start, d.end]]);
  const hours = (d: Draft): string => `${formatClock(d.start)}-${formatClock(d.end)}`;
  for (let i = 0; i < drafts.length; i += 1) {
    for (let j = i + 1; j < drafts.length; j += 1) {
      const a = drafts[i], z = drafts[j];
      const clash = pieces(a).some(([as, ae]) => pieces(z).some(([zs, ze]) => as < ze && zs < ae));
      if (clash) {
        return {
          ok: false,
          error: `"${a.label}" (${hours(a)}) overlaps "${z.label}" (${hours(z)}); a time of day can belong to only one time slot.`,
        };
      }
    }
  }

  return {
    ok: true,
    slots: drafts.map((d) => ({ id: d.id ?? "", label: d.label, start: formatClock(d.start), end: formatClock(d.end) })),
  };
}

/**
 * The presets a stored "Restaurant".report_time_slots value holds, or null for
 * "use the defaults" — NULL, an empty list, or a value that no longer validates.
 *
 * Read defensively and re-validated on the way out: the column is jsonb that a
 * human can edit, and a malformed preset must cost the owner their custom
 * sessions (visibly: is_default comes back true), never the report.
 */
export function parseStoredTimeSlots(raw: unknown): TimeSlotPreset[] | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const list = Array.isArray(value)
    ? value
    : (value && typeof value === "object" ? (value as { slots?: unknown }).slots : undefined);
  const checked = validateTimeSlotPresets(list);
  return checked.ok && checked.slots.length > 0 ? checked.slots : null;
}

/** What is written to the column. An empty list stores NULL: the defaults. */
export function timeSlotsForStorage(slots: readonly TimeSlotPreset[]): { version: 1; slots: TimeSlotPreset[] } | null {
  return slots.length === 0 ? null : { version: 1, slots: slots.map((s) => ({ ...s })) };
}

/** A preset as GET/PUT /reports/mis/time-slots return it. */
export function timeSlotPresetWire(p: TimeSlotPreset): TimeSlotPresetWire {
  const m = presetMinutes(p);
  return { id: p.id, label: p.label, start: p.start, end: p.end, crosses_midnight: m ? m.end < m.start : false };
}

/** meta.time_slot. */
export function timeSlotMeta(slot: TimeSlot | null): TimeSlotMeta | null {
  if (!slot) {return null;}
  return {
    id: slot.id,
    label: slot.label,
    start: formatClock(slot.start),
    end: formatClock(slot.end),
    crosses_midnight: slot.crosses_midnight,
    source: slot.source,
  };
}

/**
 * The export filename suffix: `_<label slug>-HHMM-HHMM`, or "" for all day.
 *
 * Only when a slot is set, so every all-day filename is the one it always was. A
 * sheet saved from Lunch and one saved from the whole day must not overwrite
 * each other in a Downloads folder, and must not be mistaken for each other on a
 * desk. The web and the app build the same suffix from meta.time_slot.
 */
export function timeSlotFileSuffix(slot: Pick<TimeSlotMeta, "label" | "start" | "end"> | null | undefined): string {
  if (!slot) {return "";}
  const slug = slugOf(slot.label, 32) || "slot";
  return `_${slug}-${slot.start.replace(":", "")}-${slot.end.replace(":", "")}`;
}

/**
 * The sentence every report adds to its notes when a slot is set.
 *
 * `subject` names WHAT the report's clock stamps ("bills SETTLED", "orders
 * PLACED"), because a slot is only meaningful next to the clock it cuts — a
 * 17:50 order settled at 19:30 is Dinner on the Sales Summary and outside every
 * session on Item Wise, and the owner has to be told which question each tab
 * answered.
 */
export function timeSlotNote(slot: TimeSlot, subject: string): string {
  const start = formatClock(slot.start), end = formatClock(slot.end);
  const name = slot.source === "preset" ? `${slot.label} (${start}-${end})` : `${start}-${end}`;
  return `Time slot ${name}: only ${subject} from ${start} up to ${end} restaurant time on each day of the range are counted, and any figure here on another clock is cut by the same hours on that clock.`
    + (slot.crosses_midnight ? " This slot crosses midnight: its hours after midnight belong to the day it started on." : "");
}

// ============================================================================
// TRADING DAYS — a day that closes at the owner's hour, not at midnight
// ============================================================================
//
// "Send the reports at the end of each day, at a time I choose." A restaurant
// whose service runs past midnight does not end its day at 00:00: in the 60
// days before this was written, 81% of one tenant's money and 20% of another's
// was settled between 00:00 and 04:00. A calendar-day email sent at 02:00 would
// hand that night's after-midnight bills to TOMORROW's report and carry the
// previous night's tail into today's — and disagree with the drawer counted at
// close.
//
// THE CONTRACT, in the order a report applies it:
//
//  1. A TRADING DAY IS 24 HOURS ENDING AT THE CLOSE. The owner picks the minute
//     their day closes (the send time of a daily email). A close at or before
//     12:00 belongs to the NEXT calendar morning — close 02:00 means business
//     date K runs [K 02:00, K+1 02:00). A close after 12:00 belongs to the same
//     evening — close 23:30 means K runs [K-1 23:30, K 23:30). The shift is
//     `close <= 12:00 ? close : close - 24:00` minutes, and business date K
//     covers [K 00:00 + shift, K+1 00:00 + shift).
//  2. HALF-OPEN, like every other window here: a bill settled at exactly 02:00
//     under a 02:00 close belongs to the day that STARTS then.
//  3. CONSECUTIVE TRADING DAYS TILE. Day K ends at the instant day K+1 starts,
//     so seven daily emails add up to the seven-day read of the same close, and
//     none of them holds a bill twice.
//  4. A CLOSE OF 00:00 IS THE CALENDAR DAY. The shift is 0 and every figure,
//     note and filename is exactly what it was.
//  5. NOT COMBINED WITH A TIME SLOT (v1). A slot says which hours of each day
//     count; a trading day moves where each day starts. Asking both is refused
//     with the clamp NAMED (`day_close_with_slot`) and the slot is kept.
//  6. BUCKETED THROUGH serviceDayKey, like a crossing slot: a bill at 01:30
//     under a 02:00 close is the previous business day's. The printed bill
//     keeps its calendar date — the notes say so.
//
// GST and P&L are statutory, month-based documents and stay on calendar days;
// the schedule layer refuses to put them on a trading day.

/** The largest shift either way: a close at 12:00 is +720, at 12:01 it is -719. */
export const TRADING_DAY_MAX_SHIFT = 720;

/**
 * The close a `?day_close=` names, in minutes past midnight (0..1439), or null
 * when it is not a readable HH:mm. "24:00" is midnight, i.e. 0.
 */
export function parseDayClose(value: unknown): number | null {
  const m = parseClockMinutes(value, { allow24: true });
  if (m === null) {return null;}
  return m === 1440 ? 0 : m;
}

/** The day shift a close implies: see rule 1. */
export function dayShiftForClose(closeMin: number): number {
  const c = Math.max(0, Math.min(1439, Math.round(closeMin)));
  return c <= TRADING_DAY_MAX_SHIFT ? c : c - 1440;
}

/** The close a shift came from — the inverse of dayShiftForClose. */
export function dayCloseOfShift(shift: number): number {
  const s = Math.round(shift);
  return s >= 0 ? s % 1440 : 1440 + s;
}

/** A wall-clock (day, minute) with the minute kept inside 0..1439. */
function shiftedWall(dayKey: string, shift: number): { key: string; min: number } {
  return shift >= 0 ? { key: dayKey, min: shift } : { key: addDaysToKey(dayKey, -1), min: 1440 + shift };
}

/**
 * The wall-clock bounds of business dates `from`..`to` (inclusive) under a
 * shift: [from 00:00 + shift, to+1 00:00 + shift). A zero shift is exactly the
 * calendar window's [from 00:00, to+1 00:00).
 */
export function tradingDayBounds(
  w: { from: string; to: string },
  shift: number,
): { fromKey: string; fromMin: number; toKey: string; toMin: number } {
  const lo = shiftedWall(w.from, shift);
  const hi = shiftedWall(addDaysToKey(w.to, 1), shift);
  return { fromKey: lo.key, fromMin: lo.min, toKey: hi.key, toMin: hi.min };
}

/**
 * The business date a daily run SENT on `sendDayKey` at the close reports:
 * the day before for a morning close (02:00 on the 18th reports the 17th),
 * the same day for an evening one (23:30 on the 17th reports the 17th).
 */
export function tradingBusinessDate(sendDayKey: string, closeMin: number): string {
  return dayShiftForClose(closeMin) >= 0 ? addDaysToKey(sendDayKey, -1) : sendDayKey;
}

/** The sentence every report adds to its notes on a trading day. */
export function tradingDayNote(closeMin: number): string {
  const shift = dayShiftForClose(closeMin);
  const close = formatClock(dayCloseOfShift(shift));
  if (shift === 0) {return "";}
  return shift > 0
    ? `Trading day closing at ${close}: each date runs for 24 hours up to ${close} restaurant time on the next calendar day, so bills settled after midnight and before ${close} count on the previous trading day. The printed bill keeps its calendar date.`
    : `Trading day closing at ${close}: each date runs for 24 hours up to ${close} restaurant time on that date, so bills settled from ${close} onwards count on the next trading day. The printed bill keeps its calendar date.`;
}

/** `_close-0200` for a trading day, "" for calendar days — so the two files never overwrite each other. */
export function tradingDayFileSuffix(closeMin: number | null | undefined): string {
  if (closeMin === null || closeMin === undefined || dayShiftForClose(closeMin) === 0) {return "";}
  return `_close-${formatClock(dayCloseOfShift(dayShiftForClose(closeMin))).replace(":", "")}`;
}
