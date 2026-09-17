/**
 * READ THE PRINTED TEXT BACK OFF A RASTER DOCKET — a test helper, never runtime.
 *
 * The reference KOT reaches a printer as a bitmap, so the ordinary
 * "decode the base64 and look for the words" assertion has nothing to look at.
 * This walks the bitmap and matches it against kot_glyph_atlas.ts glyph for
 * glyph. Because the atlas IS the bitmap the encoder laid down, that is a
 * lossless inverse and not OCR guesswork: a glyph matches only when every one
 * of its ink dots is still un-consumed ink on the page, matched ink is then
 * erased, and a band that decodes with nothing left over has been read exactly.
 *
 * WHY IT IS WORTH ITS WEIGHT. It lets the docket assertions in
 * kot_auto_print / kot_cancellation / kot_table_change keep asking the question
 * they always asked — "does the paper the kitchen gets say this?" — against the
 * document that actually ships, instead of being retargeted at a model of it.
 * A layout assertion proves the renderer was asked for the right words; this
 * proves the right words came out.
 *
 * It costs roughly a tenth of a second per docket, so it is used where a real
 * docket is under test, not in a loop over variants.
 */
import { KOT_ATLAS, type KotFace, type KotGlyph } from "../kot_glyph_atlas.js";
import { kotProfile } from "../escpos.js";

interface Canvas { w: number; h: number; stride: number; bits: Buffer }

/** Every GS v 0 block in the stream, stacked into one page. */
export function kotCanvas(escBase64: string, widthDots: number): Canvas {
  const b = Buffer.from(escBase64, "base64");
  const bands: { stride: number; h: number; data: Buffer }[] = [];
  for (let i = 0; i < b.length;) {
    if (b[i] === 0x1d && b[i + 1] === 0x76 && b[i + 2] === 0x30) {
      const stride = (b[i + 4] ?? 0) | ((b[i + 5] ?? 0) << 8);
      const h = (b[i + 6] ?? 0) | ((b[i + 7] ?? 0) << 8);
      bands.push({ stride, h, data: b.subarray(i + 8, i + 8 + stride * h) });
      i += 8 + stride * h;
      continue;
    }
    i += 1;
  }
  if (!bands.length) { throw new Error("no GS v 0 raster in this stream — is it the classic text docket?"); }
  const stride = bands[0]!.stride;
  return {
    w: widthDots,
    h: bands.reduce((s, x) => s + x.h, 0),
    stride,
    bits: Buffer.concat(bands.map((x) => x.data)),
  };
}

const dot = (cv: Canvas, x: number, y: number): number =>
  (x < 0 || y < 0 || x >= cv.w || y >= cv.h) ? 0 : ((cv.bits[y * cv.stride + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;

interface Candidate { code: number; g: KotGlyph; px: Buffer; gstride: number; top0: number }

const CANDIDATES = new Map<KotFace, Candidate[]>();
function candidatesOf(face: KotFace): Candidate[] {
  let list = CANDIDATES.get(face);
  if (list) { return list; }
  list = [];
  for (const [key, g] of Object.entries(face.g)) {
    const code = Number(key);
    if (code <= 32 || !g.w) { continue; }
    const px = Buffer.from(g.d, "base64");
    const gstride = (g.w + 7) >> 3;
    // Offset from the baseline of the topmost ink in the glyph's LEFTMOST
    // column — the column the scanner anchors on, so this prunes ~190
    // candidates to a handful before any pixel comparison.
    let first = 0;
    for (let y = 0; y < g.h; y++) { if ((px[y * gstride] ?? 0) & 0x80) { first = y; break; } }
    list.push({ code, g, px, gstride, top0: first - g.t });
  }
  CANDIDATES.set(face, list);
  return list;
}

/**
 * How many dots a glyph may share with the glyph before it.
 *
 * TYPE TOUCHES. At a docket's sizes, bold, two neighbouring letters can land
 * on the same dot — the arm of an "r" and the arm of the "y" after it did, in
 * "Berry", on the reference docket itself — and a slanted note leans one
 * letter's top over the next one's foot. That is how a proportional face
 * rasterises at a small size, not a smear: erasing the "r" takes the shared
 * dot with it, and a reader that then
 * demanded every one of the "y"'s dots still be un-read would leave the whole
 * "y" as leftover ink. So a glyph may reuse up to this many dots that an
 * earlier glyph on the line already accounted for. More than that is not two
 * letters touching, it is two things drawn over each other, and the band then
 * fails to read clean — which is what `leftover` is for.
 */
const SHARED_DOTS_MAX = 2;

/**
 * -1 when the glyph does not sit here; otherwise the ink dots it accounts for
 * that nothing before it did. With `read` given, a dot an earlier glyph already
 * accounted for may be reused, up to SHARED_DOTS_MAX of them.
 */
function glyphFits(cv: Canvas, c: Candidate, x: number, baseline: number, read?: Canvas): number {
  let ink = 0;
  let shared = 0;
  for (let gy = 0; gy < c.g.h; gy++) {
    const y = baseline - c.g.t + gy;
    for (let gx = 0; gx < c.g.w; gx++) {
      if (!((c.px[gy * c.gstride + (gx >> 3)] ?? 0) & (0x80 >> (gx & 7)))) { continue; }
      if (dot(cv, x + c.g.l + gx, y)) { ink += 1; continue; }
      if (read && dot(read, x + c.g.l + gx, y) && shared < SHARED_DOTS_MAX) { shared += 1; continue; }
      return -1;
    }
  }
  return ink;
}

/** Erase a glyph's ink from `cv` and, when given, record it as read in `read`. */
function erase(cv: Canvas, c: Candidate, x: number, baseline: number, read?: Canvas): void {
  for (let gy = 0; gy < c.g.h; gy++) {
    for (let gx = 0; gx < c.g.w; gx++) {
      if (!((c.px[gy * c.gstride + (gx >> 3)] ?? 0) & (0x80 >> (gx & 7)))) { continue; }
      const cx = x + c.g.l + gx;
      const cy = baseline - c.g.t + gy;
      if (cx < 0 || cy < 0 || cx >= cv.w || cy >= cv.h) { continue; }
      cv.bits[cy * cv.stride + (cx >> 3)]! &= ~(0x80 >> (cx & 7));
      if (read) { read.bits[cy * read.stride + (cx >> 3)]! |= 0x80 >> (cx & 7); }
    }
  }
}

export interface KotLine {
  text: string;
  /** Ink dots the decode could not account for. 0 means the band was read exactly. */
  leftover: number;
  top: number;
  bottom: number;
}

function decodeBand(cv: Canvas, top: number, bottom: number, faces: KotFace[]): KotLine {
  let anchor = -1;
  for (let x = 0; x < cv.w && anchor < 0; x++) {
    for (let y = top; y <= bottom; y++) { if (dot(cv, x, y)) { anchor = x; break; } }
  }
  if (anchor < 0) { return { text: "", leftover: 0, top, bottom }; }
  let anchorTop = top;
  for (let y = top; y <= bottom; y++) { if (dot(cv, anchor, y)) { anchorTop = y; break; } }

  // Candidate baselines: those at which SOME glyph's leftmost column could
  // start where the first ink actually starts.
  const baselines: number[] = [];
  for (let base = top; base <= bottom + 1; base++) {
    for (const face of faces) {
      const hit = candidatesOf(face).some((c) => c.top0 === anchorTop - base && glyphFits(cv, c, anchor - c.g.l, base) > 0);
      if (hit) { baselines.push(base); break; }
    }
  }

  let best: KotLine | null = null;
  for (const base of baselines) {
    const work: Canvas = { w: cv.w, h: cv.h, stride: cv.stride, bits: Buffer.from(cv.bits) };
    // Every dot a glyph on this line has already accounted for — see SHARED_DOTS_MAX.
    const read: Canvas = { w: cv.w, h: cv.h, stride: cv.stride, bits: Buffer.alloc(cv.bits.length, 0) };
    const nextInk = (from: number): number => {
      for (let x = Math.max(0, from); x < work.w; x++) {
        for (let y = top; y <= bottom; y++) { if (dot(work, x, y)) { return x; } }
      }
      return -1;
    };
    const spaceW = faces[0]!.g[32]?.a ?? 16;
    let pen16 = anchor * 16;
    let out = "";
    for (let guard = 0; guard < 600; guard++) {
      const at = nextInk(pen16 >> 4);
      if (at < 0) { break; }
      // WHERE THE NEXT GLYPH'S LEFT EDGE CAN BE. Normally at `at`, the first
      // un-read ink. But when this glyph touches the one before it (see
      // SHARED_DOTS_MAX) its leftmost column can be made entirely of the shared
      // dots, which the neighbour's erase already took — so its left edge may sit
      // up to SHARED_DOTS_MAX columns before `at`. Each candidate edge carries the
      // top of its column counting dots already read on this line, which is what
      // the per-glyph prefilter below matches on.
      const edges: { x: number; top: number | null }[] = [];
      for (let d = 0; d <= SHARED_DOTS_MAX; d++) {
        const x = at - d;
        let colTop: number | null = null;
        for (let y = top; y <= bottom; y++) {
          if (dot(work, x, y) || dot(read, x, y)) { colTop = y; break; }
        }
        edges.push({ x, top: colTop });
      }
      // The plain top of `at` itself, un-read ink only — the common case.
      let atTop = top;
      for (let y = top; y <= bottom; y++) { if (dot(work, at, y)) { atTop = y; break; } }
      let pick: { c: Candidate; ink: number; x: number } | null = null;
      const consider = (c: Candidate, edge: number) => {
        const ink = glyphFits(work, c, edge - c.g.l, base, read);
        // The widest glyph that fits wins a tie: "l" fits inside "h", and a
        // reader that preferred the smaller one would spell "hi" as "li". The
        // most ink wins outright, which is what stops a regular "y" that fits
        // inside a bold one from being read in its place.
        if (ink > 0 && (!pick || ink > pick.ink || (ink === pick.ink && c.g.a > pick.c.g.a))) {
          pick = { c, ink, x: edge - c.g.l };
        }
      };
      for (const face of faces) {
        for (const c of candidatesOf(face)) {
          if (c.top0 === atTop - base) { consider(c, at); }
          for (const e of edges) { if (e.top !== null && c.top0 === e.top - base) { consider(c, e.x); } }
        }
      }
      if (!pick) { for (const face of faces) { for (const c of candidatesOf(face)) { consider(c, at); } } }
      if (!pick) { pen16 = (at + 1) * 16; continue; }
      const chosen: { c: Candidate; ink: number; x: number } = pick;
      if (out && chosen.x * 16 - pen16 >= spaceW * 0.6) { out += " "; }
      out += String.fromCharCode(chosen.c.code);
      erase(work, chosen.c, chosen.x, base, read);
      pen16 = chosen.x * 16 + chosen.c.g.a;
    }
    let leftover = 0;
    for (let y = top; y <= bottom; y++) { for (let x = 0; x < work.w; x++) { leftover += dot(work, x, y); } }
    if (!best || leftover < best.leftover) { best = { text: out.replace(/\s+/g, " ").trim(), leftover, top, bottom }; }
    if (leftover === 0) { break; }
  }
  return best ?? { text: "", leftover: -1, top, bottom };
}

/**
 * The docket as printed lines. A dashed rule reads back as "<RULE>", the same
 * marker the bill's raster rules use in escpos.test.ts.
 */
export function readKotRaster(escBase64: string, widthDots: number, ppems: readonly number[]): KotLine[] {
  const cv = kotCanvas(escBase64, widthDots);
  const faces: KotFace[] = [];
  for (const ppem of ppems) {
    // Regular, bold, and the slanted note face — whichever of them this size
    // was baked in.
    for (const style of ["r", "b", "o"] as const) {
      const face = KOT_ATLAS[`${ppem}${style}`];
      if (face) { faces.push(face); }
    }
  }
  const inked: boolean[] = [];
  for (let y = 0; y < cv.h; y++) {
    let any = false;
    for (let x = 0; x < cv.w && !any; x++) { any = dot(cv, x, y) === 1; }
    inked.push(any);
  }
  const lines: KotLine[] = [];
  for (let y = 0; y < cv.h;) {
    if (!inked[y]) { y += 1; continue; }
    let end = y;
    while (end + 1 < cv.h && inked[end + 1]) { end += 1; }
    // A dashed rule is a short band of many equal runs — recognised by shape,
    // not by asking the renderer what one looks like.
    const runs: number[] = [];
    let run = 0;
    for (let x = 0; x < cv.w; x++) {
      if (dot(cv, x, Math.floor((y + end) / 2))) { run += 1; }
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) { runs.push(run); }
    if (end - y + 1 <= 6 && runs.length > 8) { lines.push({ text: "<RULE>", leftover: 0, top: y, bottom: end }); }
    else { lines.push(decodeBand(cv, y, end, faces)); }
    y = end + 1;
  }
  return lines;
}

/** The atlas key a face was baked under — "27b", "23o" — for assertions about which type a draw used. */
export const kotFaceKey = (face: KotFace): string =>
  `${face.ppem}${face.slant ? "o" : face.weight >= 700 ? "b" : "r"}`;

/** Roll width in dots for a docket built at `cols` columns (48 = 80mm, 32 = 58mm). */
export const rollDots = (cols: number): number => cols * 12;
/**
 * The faces a docket of that roll can be set in — body, banner and note — at
 * the restaurant's text size (absent = 'standard', as on the paper). Taken from
 * kotProfile rather than restated, so a size change cannot leave this reader
 * looking for type the docket no longer uses.
 */
export const rollPpems = (cols: number, textSize?: string): number[] => {
  const p = kotProfile(rollDots(cols), textSize);
  return [p.ppem, p.bannerPpem, p.notePpem];
};

/**
 * WHAT THE KITCHEN'S PAPER SAYS, whichever docket the restaurant prints.
 *
 * Drop-in for the `paper()` helper the dispatch suites already had: a classic
 * text docket decodes as it always did, a reference docket is read off its
 * bitmap. One helper, so a suite cannot quietly stop testing the document that
 * actually ships.
 */
export function kotPaper(escBase64: string, cols = 48, textSize?: string): string {
  const raw = Buffer.from(escBase64, "base64");
  const isRaster = raw.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  if (!isRaster) { return raw.toString("latin1"); }
  return readKotRaster(escBase64, rollDots(cols), rollPpems(cols, textSize)).map((l) => l.text).join("\n");
}
