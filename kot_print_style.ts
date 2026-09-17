/**
 * WHICH KITCHEN DOCKET A RESTAURANT PRINTS — and why that is a SETTING rather
 * than a constant.
 *
 * THE FAILURE THIS COLUMN EXISTS FOR
 * ----------------------------------
 * The reference docket is drawn as a RASTER IMAGE (the client's ticket is a
 * proportional Arial-metric face, and the printer's built-in fonts are
 * monospaced, so there is no way to match it with text). A raster reaches the
 * paper as `GS v 0`. Nearly every thermal printer implements it — but not all of
 * them, and a printer that does not implement it does not complain: it swallows
 * the block and feeds blank paper. A kitchen printer answering a KOT with a
 * blank ticket is SILENT ORDER LOSS. Food is never cooked, nothing on any screen
 * says so, and the first person to find out is the guest.
 *
 * No printer model is on record for this estate ("PrintDevices" is empty), so
 * that risk cannot be checked in advance. It can only be made RECOVERABLE — by
 * an owner, in Settings, in ten seconds, without waiting for a deploy. That is
 * this column:
 *
 *   'reference' (and NULL, and anything unrecognised) — the reference docket.
 *   'classic'                                        — the ESC/POS text docket
 *                                                      this product has always
 *                                                      printed.
 *
 * The 'classic' encoder is therefore NOT dead code and must not be deleted: it
 * is the answer to "our kitchen printer prints blank tickets", and it is the
 * only answer that works on a printer we have never seen.
 *
 * WHY THIS IS ITS OWN MODULE, WITH NO IMPORTS
 * -------------------------------------------
 * Three layers need the same vocabulary and none of them may depend on the
 * others: database_supabase.ts (reads and writes the column), kot_print.ts
 * (resolves it once per docket and hands it to the renderer) and routes/*.ts
 * (validates what an owner sent). kot_print.ts already imports
 * database_supabase.ts, so putting the vocabulary in either of those would make
 * an import cycle out of a two-word string union. escpos.ts keeps its zero
 * imports deliberately (see the note above SplitBillPart there), so it spells
 * the union inline rather than importing it from here — the two are checked
 * against each other by a source guard in jest-tests/kot_print_style.test.ts,
 * because a renderer that silently stops understanding "classic" is exactly the
 * blank ticket this whole file is about.
 *
 * READS ARE FORGIVING, WRITES ARE STRICT, and that asymmetry is deliberate —
 * see normalizeKotPrintStyle and parseKotPrintStyle below.
 */

/** The docket a restaurant prints. Two values, for ever; see the header. */
export type KotPrintStyle = "reference" | "classic";

/**
 * What a restaurant that has never made a choice gets.
 *
 * The reference docket, because it is what the client asked for and what every
 * restaurant that is not having printer trouble should be printing. A tenant
 * only ever moves off it deliberately.
 */
export const KOT_PRINT_STYLE_DEFAULT: KotPrintStyle = "reference";

/** Every accepted value, in the order a picker should offer them. */
export const KOT_PRINT_STYLES: readonly KotPrintStyle[] = ["reference", "classic"];

/**
 * READ a stored (or transmitted) value. Anything that is not exactly a known
 * style becomes the default.
 *
 * FORGIVING ON PURPOSE. This runs on the path that puts paper on the pass, and
 * every unusable input there means the same thing — "this restaurant has not
 * chosen" — whether it is a NULL column, a column that does not exist yet
 * (42703), a value written by a future version, or a typo somebody put in the
 * database by hand. A docket that refused to print because a settings string was
 * unreadable would be a worse outage than any layout question.
 *
 * Case and surrounding whitespace are ignored, so a value typed into psql as
 * "Classic " still selects the classic docket rather than silently reverting the
 * kitchen to the raster one it could not print.
 */
export function normalizeKotPrintStyle(raw: unknown): KotPrintStyle {
  const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (KOT_PRINT_STYLES as readonly string[]).includes(token)
    ? (token as KotPrintStyle)
    : KOT_PRINT_STYLE_DEFAULT;
}

/**
 * WRITE a value an owner sent. `null` means "this is not a choice I can store".
 *
 * STRICT ON PURPOSE, and the mirror image of the read above. An unrecognised
 * value arriving on a SAVE is not "no choice has been made", it is a client
 * sending something wrong — and quietly coercing it to the default would tell an
 * owner who had just clicked "Classic text docket" that their save succeeded
 * while leaving the kitchen on the docket it cannot print. The route turns this
 * null into a 400 with a sentence naming the accepted values, the same way an
 * unknown timezone is refused rather than coerced to Asia/Kolkata.
 *
 * An ABSENT key (undefined/null) also returns null, which every caller here
 * reads as "not in this request" and leaves the stored value alone: a client
 * that has never heard of this setting cannot move a kitchen off the docket it
 * is printing by omitting a key.
 */
export function parseKotPrintStyle(raw: unknown): KotPrintStyle | null {
  if (raw === undefined || raw === null) { return null; }
  if (typeof raw !== "string") { return null; }
  const token = raw.trim().toLowerCase();
  return (KOT_PRINT_STYLES as readonly string[]).includes(token) ? (token as KotPrintStyle) : null;
}

/* ===========================================================================
 * HOW BIG THE REFERENCE DOCKET'S TYPE IS ("Restaurant".kot_text_size)
 *
 * The client, after living with the reference docket: "The font sizes must be
 * smaller in the KOT." The first cut set body type at 40 dots per em on the
 * 80mm roll, because they had asked for BIGGER type twice before that — so the
 * honest reading is that different kitchens want different things, and the
 * answer is a per-restaurant choice rather than a third constant.
 *
 *   'small'     — a size down from the client's reference ticket.
 *   'standard'  — the client's reference ticket's type size (27 dots per em on
 *                 80mm). What NULL, a missing column and anything unrecognised
 *                 read as.
 *   'large'     — a size up, for a pass read from further away.
 *
 * THE SIZES THEMSELVES LIVE IN escpos.ts (kotProfile), next to the atlas that
 * has to contain every one of them; this module only knows the three words.
 *
 * IT APPLIES TO THE REFERENCE DOCKET ONLY. The classic text docket is set in the
 * printer's own built-in font at its normal size, which has no sizes worth
 * offering (integer multiples of a 12x24 cell, and any multiple that is not the
 * same both ways stretches the letters), so a restaurant on 'classic' prints
 * the same docket whatever this says. The settings screens say so.
 *
 * Same rules as the style above, for the same reasons: READS forgive anything
 * and answer the default (this runs on the path that puts paper on the pass),
 * WRITES refuse anything that is not one of the three words (a save that
 * reported success while storing nothing is a save nobody re-checks).
 * =========================================================================== */

/** How large the reference docket's type is. Three values; see above. */
export type KotTextSize = "small" | "standard" | "large";

/**
 * What a restaurant that has never chosen gets: the client's reference ticket.
 *
 * NOT 'small', even though "smaller" is what the client asked for. 'standard'
 * is defined AS their reference photograph, which is already a step down from
 * the docket they were complaining about; an owner who wants smaller still can
 * say so in Settings.
 */
export const KOT_TEXT_SIZE_DEFAULT: KotTextSize = "standard";

/** Every accepted value, smallest first — the order a picker offers them in. */
export const KOT_TEXT_SIZES: readonly KotTextSize[] = ["small", "standard", "large"];

/**
 * READ a stored (or transmitted) size. Anything that is not exactly a known size
 * becomes the default — a NULL, a column that does not exist yet (42703), a value
 * from a future version, a typo made in psql. Case and whitespace are ignored.
 */
export function normalizeKotTextSize(raw: unknown): KotTextSize {
  const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (KOT_TEXT_SIZES as readonly string[]).includes(token)
    ? (token as KotTextSize)
    : KOT_TEXT_SIZE_DEFAULT;
}

/**
 * WRITE a size an owner sent. `null` means "not a size I can store" — and an
 * absent key means the same, which every caller reads as "not in this request".
 * The route turns a non-null refusal into a 400 naming the three sizes.
 */
export function parseKotTextSize(raw: unknown): KotTextSize | null {
  if (raw === undefined || raw === null) { return null; }
  if (typeof raw !== "string") { return null; }
  const token = raw.trim().toLowerCase();
  return (KOT_TEXT_SIZES as readonly string[]).includes(token) ? (token as KotTextSize) : null;
}
