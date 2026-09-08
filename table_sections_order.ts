/**
 * The ordering rules for floor sections (zones) — every decision the feature
 * makes, as pure functions, deliberately kept OUT of SQL.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The obvious implementation of "reorder sections" is one clever statement: a
 * window function that ranks the roster against the caller's list and renumbers
 * it in place. It fits on a screen, and it is untestable without a live
 * database — which in this repo means untested, because the suite must never be
 * "skipped because a database wasn't reachable" (see jest-tests/*_fixtures.ts).
 *
 * So the interesting half lives here instead. [planSectionOrder] decides the
 * final order, in TypeScript, from two plain string lists; the database is left
 * holding one dumb `update ... from unnest($ids) with ordinality` that carries
 * no policy of its own. The rule that matters most — NO SECTION CAN VANISH —
 * becomes a property of a function that can be asserted directly, rather than a
 * claim about a join.
 *
 * THE TRAP THIS FEATURE IS BUILT AROUND
 * -------------------------------------
 * A section exists in TWO places and the two do not agree:
 *
 *   1. a row in the "Table_sections" roster (migration 023), or
 *   2. IMPLICITLY, as a "Tables".section text value on a table whose name has
 *      no roster row at all — the state every zone was in before 023, and the
 *      state a zone can still reach if the best-effort roster insert after
 *      `PATCH /table/:name {section}` loses its race or its privileges.
 *
 * An implicit section has nowhere to store a position. A naive reorder writes
 * positions to the roster and reads the ordered list back FROM the roster,
 * which silently drops every section that only ever existed as a string. To the
 * owner that is not "an edge case in the ordering model", it is "reordering
 * deleted my Bar section" — the tables are still on the floor, unlabelled, and
 * the zone is gone.
 *
 * The answer is in two halves, and both are needed:
 *
 *   * WRITE: ReorderTableSections materialises a roster row for every implicit
 *     section before it assigns anything (the same INSERT ... SELECT migration
 *     023 seeded with), so by the time positions are handed out every section
 *     that exists has somewhere to keep one.
 *   * READ: the roster is never the sole source. GET /table-sections still
 *     unions "Tables".section with the roster exactly as it always has, and
 *     [compareTableSections] gives a section with no position (`sort_order`
 *     null) a defined, sane place — the alphabetical tail — rather than
 *     dropping it. A section that somehow escapes materialisation therefore
 *     still renders; it is merely unpositioned.
 *
 * [planSectionOrder] is where that is proved: its output is a PERMUTATION of
 * the sections it was given. Not a filter of them, not a join against the
 * request. Names the caller never mentioned come back anyway.
 */

/** How many sections one reorder request may carry. A floor plan is a list a
 *  human reads; 200 zones in one outlet is a client bug or an attempt to make
 *  the server sort an unbounded array, and both deserve a 400 rather than work. */
export const SECTION_ORDER_MAX = 200;

/**
 * The identity of a section name, matching how the database resolves one.
 *
 * Every statement that touches a zone keys on `lower(btrim(name))` — the unique
 * index in 023, GetTableSections' GROUP BY, RenameTableSection's WHERE — so
 * this is `trim().toLowerCase()` and nothing more. In particular it does NOT
 * collapse inner whitespace, even though normalizeTableSection does on the way
 * IN: "AC  Hall" and "AC Hall" are one zone to the writer and two to the
 * database, and this function has to agree with the database, not with the
 * writer. (Every name written through the API since 020 is already collapsed,
 * so the two only diverge on hand-edited rows.)
 */
export function sectionOrderKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A section as the ordering cares about it: what it is called and where it
 *  sits. `sort_order` null = never positioned. */
export interface OrderableSection {
  section: string;
  sort_order: number | null;
}

/**
 * The one total order, used for every list this feature produces.
 *
 *   1. positioned sections before unpositioned ones,
 *   2. positioned sections by their position ascending,
 *   3. everything else — and any tie — alphabetically, case-insensitively.
 *
 * Step 3 is not a rounding-off; it is the ENTIRE behaviour of an outlet that
 * has never reordered (every row null, so 1 and 2 never fire) and it is why
 * shipping this feature changes nothing on screen until somebody drags
 * something. It uses localeCompare with `sensitivity: "base"`, which is
 * character-for-character what GET /table-sections already sorted with on
 * 1.8.5, so the untouched case is not merely "still alphabetical" but the same
 * alphabetical.
 *
 * The final tiebreak on the raw key makes the order TOTAL: two sections whose
 * names compare equal under a base-sensitivity collation ("Patio" and "patio",
 * which the union should have folded into one but which a hand-edited row could
 * still produce) must not swap places between two renders of the same data.
 */
export function compareTableSections(a: OrderableSection, b: OrderableSection): number {
  // A non-finite position is treated as no position at all: NaN sorts
  // unpredictably against everything, and one bad row must not be able to make
  // the list order differ between two renders of the same data.
  const ap = a.sort_order !== null && Number.isFinite(a.sort_order) ? a.sort_order : null;
  const bp = b.sort_order !== null && Number.isFinite(b.sort_order) ? b.sort_order : null;
  if ((ap === null) !== (bp === null)) {return ap === null ? 1 : -1;}
  if (ap !== null && bp !== null && ap !== bp) {return ap - bp;}
  const byName = a.section.localeCompare(b.section, undefined, { sensitivity: "base" });
  if (byName !== 0) {return byName;}
  const ak = sectionOrderKey(a.section);
  const bk = sectionOrderKey(b.section);
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/** Thrown for a malformed reorder request. The route turns it into a 400 with
 *  this message; nothing here ever throws for a request that is merely stale. */
export class SectionOrderRequestError extends Error {}

/**
 * Read `{ sections: [...] }` (or `{ order: [...] }`) off a request body.
 *
 * Strict about SHAPE and forgiving about CONTENT, because the two failures are
 * not alike. A body that isn't a list of strings is a client that is broken
 * right now and must be told so. A list naming a section that no longer exists
 * is a client that is merely a few seconds STALE — someone on another device
 * renamed or dissolved a zone while this drag was in flight — and refusing that
 * would make the feature fail exactly when two people are using it. Unknown
 * names are dropped by [planSectionOrder] and the rest of the order still lands.
 *
 * Blank entries are dropped rather than rejected (a trailing "" from a client's
 * list widget is not worth a 400), duplicates collapse to their FIRST
 * occurrence (a drag that somehow emitted a name twice meant the first slot),
 * and an empty result is refused: "put these in no particular order" is not a
 * request, it is a bug that would quietly renumber the whole outlet.
 */
export function readSectionOrderRequest(body: unknown): string[] {
  const raw = (body ?? {}) as Record<string, unknown>;
  const list = raw.sections ?? raw.order;
  if (!Array.isArray(list)) {
    throw new SectionOrderRequestError('Send the section names in the order you want them, as {"sections": ["Terrace", "Bar"]}');
  }
  if (list.length > SECTION_ORDER_MAX) {
    throw new SectionOrderRequestError(`Too many sections in one request (limit ${String(SECTION_ORDER_MAX)})`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new SectionOrderRequestError("Every entry in sections must be a section name");
    }
    const name = entry.trim();
    if (!name) {continue;}
    const key = sectionOrderKey(name);
    if (seen.has(key)) {continue;}
    seen.add(key);
    out.push(name);
  }
  if (out.length === 0) {
    throw new SectionOrderRequestError("Send at least one section name");
  }
  return out;
}

/**
 * The whole ordering decision: what the outlet's section list should read as
 * after this request.
 *
 * `requested` is what the client dragged into place. `existing` is EVERY
 * section the outlet has at this instant — roster rows plus any that were only
 * ever "Tables".section labels, already materialised by the caller. The result
 * is the order to renumber 1..N.
 *
 * THE INVARIANT, and the reason this function is separate from the SQL:
 *
 *     the result is a PERMUTATION of `existing`, keyed by sectionOrderKey.
 *
 * Every section that exists comes back, exactly once, whatever the request said
 * — so no ordering write can drop a zone off the floor. Three consequences fall
 * out of that one line:
 *
 *   * A STALE client (its list predates a section someone else just created)
 *     cannot delete that section by omission. It is appended, alphabetically,
 *     after everything the client did name.
 *   * A section named in the request that no longer exists is ignored, not
 *     invented. There is no row to carry its position.
 *   * The remainder is appended in the SAME alphabetical order the whole list
 *     had before this feature existed, so the part of the floor nobody has
 *     touched keeps the arrangement people already know.
 *
 * Every section ends up positioned once an outlet reorders at all — the null
 * bucket is emptied for that outlet — which is exactly why a section created
 * LATER (null again) sorts to the end rather than into the middle.
 */
export function planSectionOrder(requested: readonly string[], existing: readonly string[]): string[] {
  // Keyed by identity, first spelling wins — the same de-duplication the union
  // in GET /table-sections performs, so a roster "patio" and a table's "Patio"
  // are one entry here too and cannot be handed two different positions.
  const byKey = new Map<string, string>();
  for (const name of existing) {
    const label = name.trim();
    if (!label) {continue;}
    const key = sectionOrderKey(label);
    if (!byKey.has(key)) {byKey.set(key, label);}
  }

  const placed: string[] = [];
  const taken = new Set<string>();
  for (const name of requested) {
    const key = sectionOrderKey(name);
    if (taken.has(key)) {continue;}
    const label = byKey.get(key);
    // Named but gone: renamed or dissolved between this client's last read and
    // this write. Nothing to position — and nothing to create.
    if (label === undefined) {continue;}
    taken.add(key);
    placed.push(label);
  }

  const rest = [...byKey.entries()]
    .filter(([key]) => !taken.has(key))
    .map(([, label]) => label)
    .sort((a, b) => compareTableSections({ section: a, sort_order: null }, { section: b, sort_order: null }));

  return [...placed, ...rest];
}
