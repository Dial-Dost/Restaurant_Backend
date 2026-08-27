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
  | "span_capped";

export interface ReportWindowQuery {
  /** YYYY-MM-DD (or any ISO instant) — the FIRST day of the window, inclusive. */
  from?: unknown;
  /** YYYY-MM-DD (or any ISO instant) — the LAST day of the window, inclusive. */
  to?: unknown;
  /** Legacy rolling span: the last N calendar days ending today. */
  days?: unknown;
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
