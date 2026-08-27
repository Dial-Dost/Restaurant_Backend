/**
 * Promotional POSTERS shown alongside the guest menu: types, validation, the
 * scheduling predicate and the guest-payload projection.
 *
 * PURE module — no database, no network, no imports. Same discipline as
 * brand_theme.ts and billing_math.ts: everything here is decided by value, so a
 * jest suite can assert "an expired poster is never served" and "a 12 MB PNG is
 * refused" without a pg pool, a Supabase bucket or a live clock.
 *
 * ABSENT = TODAY, BIT-FOR-BIT ------------------------------------------------
 * A restaurant with no posters (the overwhelming majority, forever) must get the
 * guest payload it gets today, byte for byte. So `posters` is OMITTED from
 * /qr/:slug/menu when nothing is visible rather than sent as `[]` — an empty
 * array is still a new key every guest client would have to reason about. This
 * mirrors the brand_config rule that an absent key reproduces the shipped design
 * exactly.
 *
 * SCHEDULING IS DAY-GRAINED, IN THE RESTAURANT'S ZONE ------------------------
 * The owner's ask is "a Sunday brunch poster stops showing on Monday". That is a
 * CALENDAR question, not an instant question, and the calendar that matters is
 * the one on the restaurant's wall — a Kolkata brunch poster must die at 00:00
 * IST, not at 00:00 UTC (05:30 IST, i.e. mid-service the next morning). So the
 * window is stored as two YYYY-MM-DD keys and compared against the key for "now"
 * as seen in the restaurant's timezone, produced by the same dateKeyInZone
 * helper every report range already uses. Two consequences worth stating:
 *   - the comparison is a plain string compare, because ISO date keys sort
 *     lexicographically exactly as they sort chronologically. No Date objects,
 *     no DST arithmetic, nothing to get wrong at a spring-forward boundary.
 *   - a tenant that changes its timezone changes which day its posters are on,
 *     immediately and correctly, with no stored value to migrate.
 * Time-of-day windows ("11:00-15:00 only") are deliberately NOT supported: the
 * ask was per-day, and an hour-grained window would need the guest page to poll
 * so it could expire mid-session — nothing here justifies that.
 */

/** Where a poster renders. Both guest surfaces implement BOTH slots, so the
 *  owner's choice means the same thing on /order and on the queue page. */
export type PosterPlacement = "top" | "menu";
export const POSTER_PLACEMENTS: PosterPlacement[] = ["top", "menu"];

/** Editor labels, served with the list so the two editors (web + Flutter) are
 *  BUILT from this table instead of hardcoding copy that can drift apart. */
export const POSTER_PLACEMENT_META: { value: PosterPlacement; label: string; hint: string }[] = [
  { value: "top", label: "Banner", hint: "Full-width strip under the header, the moment the guest lands. Guests can dismiss it." },
  { value: "menu", label: "With the menu", hint: "A card above the dishes — seen while the guest is actually browsing." },
];

/**
 * The image rules, and why each number is what it is.
 *
 * UPLOAD cap (3 MB of decoded bytes) bounds what a single request can make the
 * process allocate. It is NOT the number that protects the guest: the accepted
 * image is re-encoded before it is ever stored (see POSTER_MAX_DIMENSION), so
 * what a phone downloads is a fraction of this.
 *
 * DIMENSION cap (1600px on the long edge) is what actually protects the guest
 * page. A poster renders at most ~420 CSS px wide on a phone; 1600 covers a 3x
 * display with room to spare, and re-encoding to it turns a 12 MB 6000px camera
 * export into a couple of hundred KB. Capping by REJECTION alone would have been
 * the lazy read of "cap dimensions" — it just moves the problem onto an owner
 * who has no image editor on their phone.
 *
 * COUNT caps: POSTER_MAX_VISIBLE bounds what one guest page can be handed
 * however the library is configured (six full-width images is already more than
 * any menu should carry); POSTER_MAX_STORED bounds the library itself so the
 * editor's list stays a list.
 */
export const POSTER_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const POSTER_MAX_DIMENSION = 1600;
export const POSTER_MAX_VISIBLE = 6;
export const POSTER_MAX_STORED = 24;
export const POSTER_TITLE_MAX = 80;

/**
 * Accepted upload types. The list is short on purpose: these are the three the
 * storage helper can name an extension for (storage_bucket_supabase.ts derives
 * the object's extension from the content type and falls back to `.jpg` for
 * ANYTHING it does not recognise) — so accepting, say, image/gif would store a
 * GIF's bytes under a .jpg name and hand guests a broken image. SVG is excluded
 * for a second reason: it is a script-bearing document, and these URLs are
 * served from a public bucket straight into a customer's browser.
 */
export const POSTER_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PosterContentType = (typeof POSTER_CONTENT_TYPES)[number];

/** A poster as the EDITORS see it (the full row, expired ones included). */
export interface PosterRecord {
  id: string;
  image_url: string;
  title: string;
  placement: PosterPlacement;
  sort_order: number;
  /** Inclusive window, as calendar keys in the restaurant's timezone. */
  start_on: string | null;
  end_on: string | null;
  active: boolean;
  /** Intrinsic size of the stored (already downscaled) image, 0 when unknown —
   *  the guest pages reserve the box from this so a poster loading over a phone
   *  connection does not shove the menu down the page. */
  width: number;
  height: number;
  created_at: string;
}

/** A poster as a GUEST sees it. Deliberately narrower than PosterRecord: the
 *  schedule, the active flag and the sort key are operator data with no business
 *  on a public page. */
export interface GuestPoster {
  id: string;
  image_url: string;
  title: string;
  placement: PosterPlacement;
  width: number;
  height: number;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD calendar key — the only date shape this module accepts. */
export function isPosterDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY_RE.test(value);
}

export function isPosterPlacement(value: unknown): value is PosterPlacement {
  return value === "top" || value === "menu";
}

/**
 * Is this poster showing on `todayKey` (a YYYY-MM-DD in the restaurant's zone)?
 *
 * Both bounds are INCLUSIVE, which is the only reading that matches how an owner
 * describes the thing: "Friday to Sunday" means the poster is up on Sunday and
 * gone on Monday. An absent bound is open-ended.
 *
 * A malformed `todayKey` (only reachable if a caller hands us something that is
 * not a date key) fails CLOSED on the scheduled posters — an unscheduled poster
 * still shows, a scheduled one does not, because the alternative is showing a
 * Christmas banner in July when a clock helper misbehaves.
 */
export function posterIsVisible(
  poster: Pick<PosterRecord, "active" | "start_on" | "end_on">,
  todayKey: string,
): boolean {
  if (!poster.active) {return false;}
  if (!isPosterDateKey(poster.start_on) && !isPosterDateKey(poster.end_on)) {return true;}
  if (!isPosterDateKey(todayKey)) {return false;}
  if (isPosterDateKey(poster.start_on) && poster.start_on > todayKey) {return false;}
  if (isPosterDateKey(poster.end_on) && poster.end_on < todayKey) {return false;}
  return true;
}

/**
 * The guest projection: what is live today, in display order, capped, narrowed.
 *
 * Ordering is (sort_order, created_at, id). The id tiebreak is not decoration —
 * two posters saved in the same second with the same sort_order would otherwise
 * be free to swap places between two requests, and a banner that reshuffles on
 * every menu refresh reads as a broken page.
 */
export function visiblePosters(rows: PosterRecord[], todayKey: string): GuestPoster[] {
  return rows
    .filter((p) => posterIsVisible(p, todayKey))
    .sort((a, b) =>
      a.sort_order - b.sort_order
      || a.created_at.localeCompare(b.created_at)
      || a.id.localeCompare(b.id))
    .slice(0, POSTER_MAX_VISIBLE)
    .map((p) => ({
      id: p.id,
      image_url: p.image_url,
      title: p.title,
      placement: p.placement,
      width: p.width,
      height: p.height,
    }));
}

export type PosterUploadCheck =
  | { ok: true; content_type: PosterContentType; bytes: number }
  | { ok: false; error: string };

/**
 * Byte length of a base64 payload WITHOUT decoding it.
 *
 * Decoding first and measuring after is the obvious version and the wrong one:
 * it makes the process allocate the very 40 MB buffer the cap exists to refuse,
 * once per request, before it can say no. base64 is 4 characters per 3 bytes
 * with at most two '=' of padding, so the size is arithmetic.
 */
export function base64ByteLength(base64: string): number {
  const body = base64.includes(",") ? (base64.split(",").pop() ?? base64) : base64;
  const clean = body.replace(/\s/g, "");
  if (clean.length === 0) {return 0;}
  let padding = 0;
  if (clean.endsWith("==")) {padding = 2;}
  else if (clean.endsWith("=")) {padding = 1;}
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Normalize a declared content type: case, stray parameters (`image/png;
 * charset=binary` is what some pickers send) and the image/jpg spelling that is
 * not a real media type but IS what a file picker's extension produces (the
 * existing logo upload maps the same way).
 * Returns null for anything not on the allowlist.
 */
export function normalizePosterContentType(raw: unknown): PosterContentType | null {
  if (typeof raw !== "string") {return null;}
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  const mapped = base === "image/jpg" ? "image/jpeg" : base;
  return (POSTER_CONTENT_TYPES as readonly string[]).includes(mapped)
    ? (mapped as PosterContentType)
    : null;
}

/**
 * The gate every poster upload passes before a single byte is decoded, buffered
 * or handed to an image library.
 *
 * This is a NECESSARY check, not a sufficient one: a content-type header is a
 * claim by the client, so the route re-derives the real format from the bytes
 * when it re-encodes. What this buys is that the expensive, attackable work only
 * ever runs on a payload that is already the right size and claims a type we
 * serve.
 */
export function validatePosterUpload(input: { image_base64?: unknown; content_type?: unknown }): PosterUploadCheck {
  const b64 = typeof input.image_base64 === "string" ? input.image_base64 : "";
  if (!b64) {return { ok: false, error: "An image is required." };}
  const contentType = normalizePosterContentType(input.content_type);
  if (!contentType) {
    return { ok: false, error: "Posters must be a PNG, JPEG or WebP image." };
  }
  const bytes = base64ByteLength(b64);
  if (bytes === 0) {return { ok: false, error: "That image looks empty." };}
  if (bytes > POSTER_MAX_UPLOAD_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const cap = String(POSTER_MAX_UPLOAD_BYTES / (1024 * 1024));
    return { ok: false, error: `That image is ${mb} MB. Posters must be under ${cap} MB.` };
  }
  return { ok: true, content_type: contentType, bytes };
}

/** A create/update patch after sanitizing. Only keys the caller actually sent
 *  and that survived validation appear, so the writer can merge-on-omit the way
 *  SetBranding does (an omitted key keeps its stored value). */
export interface PosterPatch {
  image_url?: string;
  title?: string;
  placement?: PosterPlacement;
  sort_order?: number;
  start_on?: string | null;
  end_on?: string | null;
  active?: boolean;
}

/**
 * Sanitize an editor payload.
 *
 * CLEARING vs OMITTING, the same contract brand_config uses: a date key sent as
 * null (or as anything that is not a date key) CLEARS that bound, because
 * "remove the end date" has to be expressible; a date key not sent at all keeps
 * whatever is stored. Without that split, an owner could set an end date and
 * never take it off.
 */
export function sanitizePosterPatch(raw: unknown): PosterPatch {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: PosterPatch = {};
  if (typeof input.image_url === "string" && input.image_url.trim()) {
    out.image_url = input.image_url.trim();
  }
  if ("title" in input) {
    out.title = typeof input.title === "string" ? input.title.trim().slice(0, POSTER_TITLE_MAX) : "";
  }
  if (isPosterPlacement(input.placement)) {out.placement = input.placement;}
  if (input.sort_order !== undefined) {
    const n = Number(input.sort_order);
    // Clamped rather than rejected: sort_order is a display detail, and a
    // nonsense value should not fail an otherwise good save.
    out.sort_order = Number.isFinite(n) ? Math.min(999, Math.max(0, Math.round(n))) : 0;
  }
  if ("start_on" in input) {out.start_on = isPosterDateKey(input.start_on) ? input.start_on : null;}
  if ("end_on" in input) {out.end_on = isPosterDateKey(input.end_on) ? input.end_on : null;}
  if (typeof input.active === "boolean") {out.active = input.active;}
  return out;
}

/**
 * Reject a window that can never show anything (end before start). Returned as a
 * message rather than silently swapped: an owner who typed the dates backwards
 * wants to be told, not to have their poster quietly run on dates they did not
 * choose.
 */
export function posterWindowError(start: string | null | undefined, end: string | null | undefined): string | null {
  if (isPosterDateKey(start) && isPosterDateKey(end) && end < start) {
    return "The end date is before the start date.";
  }
  return null;
}
