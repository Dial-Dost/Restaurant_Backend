/**
 * A TrueType outline reader and scanline rasterizer — DEV TIME ONLY.
 *
 * NOTHING AT RUNTIME MAY IMPORT THIS FILE. It is the other half of
 * scripts/build_kot_glyph_atlas.ts: between them they turn two .ttf files into
 * kot_glyph_atlas.ts, a committed table of 1-bit glyph bitmaps, and that table
 * is the only thing the KOT renderer ever sees. The server parses no font, the
 * Docker image carries no font (scripts/kot_fonts is .dockerignore'd), and the
 * bytes a kitchen printer receives are therefore identical on a Windows laptop,
 * in CI and on the Debian VPS — which is what makes a sha256 golden on a docket
 * a meaningful assertion instead of a machine-specific one.
 * jest-tests/kot_raster.test.ts enforces the no-runtime-import rule by reading
 * the source tree.
 *
 * Pure JS: no native dependency, no fontconfig, no OS font lookup. The only
 * floating point is IEEE-754 +-*\/ and Math.floor/ceil/round, all of which are
 * exactly specified, so the same .ttf produces the same bitmap everywhere.
 *
 * Scope is deliberately the minimum the docket's face (DejaVu Sans Condensed,
 * and before it Liberation Sans) needs for ASCII 32..126: `glyf`/`loca`/`hmtx`/
 * `cmap` format 4, simple and composite glyphs. It is not a general font
 * library and should not grow into one.
 */
import { readFileSync } from "node:fs";

/** One rasterized glyph, in printer dots. */
export interface GlyphBitmap {
  /** Ink box width/height. Both 0 for a blank glyph (space). */
  w: number;
  h: number;
  /** Ink box offset from the pen: left bearing, and height above the baseline. */
  left: number;
  top: number;
  /** Row-major 1bpp, MSB first, stride = ceil(w / 8). */
  bits: Buffer;
}

export interface ParsedFont {
  unitsPerEm: number;
  numGlyphs: number;
  /** Advance width per glyph id, in font units. */
  adv: Uint16Array;
  /** Character code -> glyph id, for ASCII 32..126 only. */
  cmap: Map<number, number>;
  glyphContours: (gid: number) => ContourPoint[][];
}

interface ContourPoint { x: number; y: number; on: boolean }

/** A cursor over the font file. Every TrueType number is big-endian. */
class Reader {
  constructor(private readonly b: Buffer, public p = 0) {}
  u8(): number { return this.b[this.p++] ?? 0; }
  i8(): number { const v = this.b.readInt8(this.p); this.p += 1; return v; }
  u16(): number { const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  i16(): number { const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  u32(): number { const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  /** The 2.14 fixed-point scale used by composite glyph transforms. */
  f2dot14(): number { return this.i16() / 16384; }
}

export function parseTtf(path: string): ParsedFont {
  const b = readFileSync(path);
  const r = new Reader(b);
  r.u32();                                   // sfnt version
  const numTables = r.u16();
  r.u16(); r.u16(); r.u16();                 // searchRange, entrySelector, rangeShift
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const tag = b.toString("latin1", r.p, r.p + 4);
    r.p += 4;
    r.u32();                                 // checksum
    tables.set(tag, { off: r.u32(), len: r.u32() });
  }
  const at = (tag: string): number => {
    const t = tables.get(tag);
    if (!t) { throw new Error(`${path}: missing '${tag}' table`); }
    return t.off;
  };

  const head = at("head");
  const unitsPerEm = b.readUInt16BE(head + 18);
  const indexToLocFormat = b.readInt16BE(head + 50);
  const numGlyphs = b.readUInt16BE(at("maxp") + 4);
  const numberOfHMetrics = b.readUInt16BE(at("hhea") + 34);

  // hmtx: the last numberOfHMetrics entry's advance repeats for every glyph
  // after it (monospaced tails), which is the format's own rule, not a guess.
  const adv = new Uint16Array(numGlyphs);
  {
    const o = at("hmtx");
    let last = 0;
    for (let i = 0; i < numGlyphs; i++) {
      if (i < numberOfHMetrics) { last = b.readUInt16BE(o + i * 4); }
      adv[i] = last;
    }
  }

  // loca: glyph offsets into glyf, short (x2) or long depending on head.
  const loca = new Uint32Array(numGlyphs + 1);
  {
    const o = at("loca");
    for (let i = 0; i <= numGlyphs; i++) {
      loca[i] = indexToLocFormat === 0 ? b.readUInt16BE(o + i * 2) * 2 : b.readUInt32BE(o + i * 4);
    }
  }

  // cmap: the Windows BMP subtable (3,1) format 4, which every modern Latin font
  // carries. Only ASCII is resolved — everything else is folded to '?' by
  // asciiSafe long before it reaches a glyph (see escpos.ts).
  const cmap = new Map<number, number>();
  {
    const o = at("cmap");
    const n = b.readUInt16BE(o + 2);
    let sub = -1;
    for (let i = 0; i < n; i++) {
      const pid = b.readUInt16BE(o + 4 + i * 8);
      const eid = b.readUInt16BE(o + 6 + i * 8);
      const off = b.readUInt32BE(o + 8 + i * 8);
      if (pid === 3 && (eid === 1 || eid === 10)) { sub = o + off; break; }
      if (sub < 0 && pid === 0) { sub = o + off; }
    }
    if (sub < 0) { throw new Error(`${path}: no usable cmap subtable`); }
    const fmt = b.readUInt16BE(sub);
    if (fmt !== 4) { throw new Error(`${path}: cmap format ${fmt} is not supported`); }
    const segCount = b.readUInt16BE(sub + 6) / 2;
    const endP = sub + 14;
    const startP = endP + segCount * 2 + 2;   // + the reservedPad
    const deltaP = startP + segCount * 2;
    const rangeP = deltaP + segCount * 2;
    for (let c = 32; c <= 126; c++) {
      let gid = 0;
      for (let s = 0; s < segCount; s++) {
        const end = b.readUInt16BE(endP + s * 2);
        if (end < c) { continue; }
        const start = b.readUInt16BE(startP + s * 2);
        if (start > c) { break; }
        const delta = b.readInt16BE(deltaP + s * 2);
        const rangeOffset = b.readUInt16BE(rangeP + s * 2);
        if (rangeOffset === 0) { gid = (c + delta) & 0xffff; }
        else {
          const g = b.readUInt16BE(rangeP + s * 2 + rangeOffset + 2 * (c - start));
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        break;
      }
      cmap.set(c, gid);
    }
  }

  const glyfOff = at("glyf");

  function glyphContours(gid: number, depth = 0): ContourPoint[][] {
    if (depth > 5) { return []; }             // a self-referential composite
    const from = loca[gid] ?? 0;
    const to = loca[gid + 1] ?? 0;
    if (to <= from) { return []; }            // no outline: space, and .notdef
    const g = new Reader(b, glyfOff + from);
    const nc = g.i16();
    g.p += 8;                                 // xMin yMin xMax yMax
    if (nc >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < nc; i++) { ends.push(g.u16()); }
      const nPts = nc === 0 ? 0 : (ends[nc - 1] ?? 0) + 1;
      // Skip the hinting instructions. Read the length into a variable FIRST:
      // `g.p += g.u16()` reads g.p before u16() advances it, and quietly loses
      // the two length bytes.
      const instructionLength = g.u16();
      g.p += instructionLength;
      const flags = new Uint8Array(nPts);
      for (let i = 0; i < nPts;) {
        const f = g.u8();
        flags[i++] = f;
        if (f & 8) { let rep = g.u8(); while (rep-- > 0 && i < nPts) { flags[i++] = f; } }
      }
      // Coordinates are stored as deltas, each either a byte (with a sign flag)
      // or a short, or omitted entirely to mean "same as the previous point".
      const xs = new Int32Array(nPts);
      const ys = new Int32Array(nPts);
      let v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i] ?? 0;
        if (f & 2) { const d = g.u8(); v += (f & 16) ? d : -d; }
        else if (!(f & 16)) { v += g.i16(); }
        xs[i] = v;
      }
      v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i] ?? 0;
        if (f & 4) { const d = g.u8(); v += (f & 32) ? d : -d; }
        else if (!(f & 32)) { v += g.i16(); }
        ys[i] = v;
      }
      const out: ContourPoint[][] = [];
      let s = 0;
      for (let ci = 0; ci < nc; ci++) {
        const e = ends[ci] ?? -1;
        const pts: ContourPoint[] = [];
        for (let i = s; i <= e; i++) { pts.push({ x: xs[i] ?? 0, y: ys[i] ?? 0, on: !!((flags[i] ?? 0) & 1) }); }
        if (pts.length) { out.push(pts); }
        s = e + 1;
      }
      return out;
    }
    // Composite: a list of transformed component glyphs (é = e + acute). Point
    // matching (ARGS_ARE_XY_VALUES clear) is not implemented — no ASCII glyph
    // in either face this has read uses it, and a silent wrong offset is worse
    // than none.
    const out: ContourPoint[][] = [];
    for (;;) {
      const flags = g.u16();
      const componentGid = g.u16();
      let dx: number;
      let dy: number;
      if (flags & 1) { dx = g.i16(); dy = g.i16(); } else { dx = g.i8(); dy = g.i8(); }
      if (!(flags & 2)) { dx = 0; dy = 0; }
      let a = 1;
      let bb = 0;
      let cc = 0;
      let d = 1;
      if (flags & 8) { a = d = g.f2dot14(); }
      else if (flags & 0x40) { a = g.f2dot14(); d = g.f2dot14(); }
      else if (flags & 0x80) { a = g.f2dot14(); bb = g.f2dot14(); cc = g.f2dot14(); d = g.f2dot14(); }
      for (const c of glyphContours(componentGid, depth + 1)) {
        out.push(c.map((p) => ({ x: a * p.x + cc * p.y + dx, y: bb * p.x + d * p.y + dy, on: p.on })));
      }
      if (!(flags & 0x20)) { break; }         // MORE_COMPONENTS
    }
    return out;
  }

  return { unitsPerEm, numGlyphs, adv, cmap, glyphContours };
}

/**
 * The same font, SLANTED: every outline point moves right by `shear` times its
 * height above the baseline (x' = x + shear * y), before anything is scaled.
 *
 * THIS IS HOW THE REFERENCE DOCKET'S "[Note]" LINE WAS SET. The client's
 * photographed ticket prints its note in a smaller oblique — Tahoma has no
 * italic, so the POS that printed it slanted the upright letters — and a
 * sheared copy of the docket's own regular face reproduces exactly that, with
 * no second font file to license, commit or keep in step. The advance widths
 * are the upright ones on purpose: slanting a letter does not move the next.
 *
 * Pure arithmetic on the parsed points (IEEE-754 * and +), so the bitmaps are
 * as deterministic as the upright ones.
 */
export function obliqueFont(font: ParsedFont, shear: number): ParsedFont {
  return {
    ...font,
    glyphContours: (gid: number) =>
      font.glyphContours(gid).map((c) => c.map((p) => ({ x: p.x + shear * p.y, y: p.y, on: p.on }))),
  };
}

/** Quadratic subdivision steps. FIXED, never adaptive — adaptive is where two
 *  machines start disagreeing about a curve. */
const QUAD_SEGMENTS = 8;
/** Supersampling grid, and the coverage out of SS*SS at which a dot inks. */
export const SUPERSAMPLE = 4;
export const INK_THRESHOLD = 7;

type Edge = [number, number, number, number];

/** Flatten one contour (font units, y up) into device-space edges (y down). */
function contourEdges(pts: ContourPoint[], scale: number, ox: number, oy: number, edges: Edge[]): void {
  if (pts.length < 2) { return; }
  const toDevice = (p: { x: number; y: number }) => ({ x: p.x * scale - ox, y: oy - p.y * scale });
  // A contour may begin off-curve; then the implied start is the midpoint
  // between the last and first points.
  let startIdx = pts.findIndex((p) => p.on);
  let start: { x: number; y: number };
  if (startIdx < 0) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    start = toDevice({ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 });
    startIdx = 0;
  } else {
    start = toDevice(pts[startIdx]!);
  }
  let cur = start;
  const n = pts.length;
  const lineTo = (to: { x: number; y: number }) => {
    if (cur.x !== to.x || cur.y !== to.y) { edges.push([cur.x, cur.y, to.x, to.y]); }
    cur = to;
  };
  const quadTo = (c: { x: number; y: number }, to: { x: number; y: number }) => {
    const x0 = cur.x;
    const y0 = cur.y;
    for (let i = 1; i <= QUAD_SEGMENTS; i++) {
      const t = i / QUAD_SEGMENTS;
      const mt = 1 - t;
      const x = mt * mt * x0 + 2 * mt * t * c.x + t * t * to.x;
      const y = mt * mt * y0 + 2 * mt * t * c.y + t * t * to.y;
      edges.push([cur.x, cur.y, x, y]);
      cur = { x, y };
    }
  };
  let i = 1;
  while (i <= n) {
    const p = pts[(startIdx + i) % n]!;
    if (p.on) { lineTo(toDevice(p)); i += 1; continue; }
    const q = pts[(startIdx + i + 1) % n]!;
    const ctrl = toDevice(p);
    // Two off-curve points in a row imply an on-curve point between them.
    if (q.on) { quadTo(ctrl, toDevice(q)); i += 2; }
    else { quadTo(ctrl, toDevice({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })); i += 1; }
  }
  if (cur.x !== start.x || cur.y !== start.y) { edges.push([cur.x, cur.y, start.x, start.y]); }
}

/**
 * Rasterize one glyph at `ppem` dots per em, non-zero winding, 4x4 supersampled.
 *
 * THE BOX IS TRIMMED TO THE INK, not left at the outline's bounding box. The
 * outline box is up to a dot loose on each side, and that slack lets a
 * neighbouring glyph's ink sit inside this glyph's box — which wastes atlas
 * bytes and, more importantly, breaks the exact bitmap match the test-side
 * docket reader relies on (jest-tests/kot_raster_read.ts).
 */
export function rasterizeGlyph(font: ParsedFont, gid: number, ppem: number): GlyphBitmap {
  const blank: GlyphBitmap = { w: 0, h: 0, left: 0, top: 0, bits: Buffer.alloc(0) };
  const scale = ppem / font.unitsPerEm;
  const contours = font.glyphContours(gid);
  if (!contours.length) { return blank; }
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      const x = p.x * scale;
      const y = p.y * scale;
      if (x < xMin) { xMin = x; }
      if (x > xMax) { xMax = x; }
      if (y < yMin) { yMin = y; }
      if (y > yMax) { yMax = y; }
    }
  }
  const left = Math.floor(xMin);
  const top = Math.ceil(yMax);
  const w = Math.ceil(xMax) - left + 1;
  const h = top - Math.floor(yMin) + 1;
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) { return blank; }
  const edges: Edge[] = [];
  for (const c of contours) { contourEdges(c, scale, left, top, edges); }

  const coverage = new Uint8Array(w * h);
  const subWidth = w * SUPERSAMPLE;
  for (let sy = 0; sy < h * SUPERSAMPLE; sy++) {
    const y = (sy + 0.5) / SUPERSAMPLE;
    const crossings: [number, number][] = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        crossings.push([x0 + (y - y0) / (y1 - y0) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
    }
    if (!crossings.length) { continue; }
    crossings.sort((a, c) => a[0] - c[0]);
    let winding = 0;
    let spanStart = 0;
    const row = (sy / SUPERSAMPLE) | 0;
    for (const [x, dir] of crossings) {
      const prev = winding;
      winding += dir;
      if (prev === 0 && winding !== 0) { spanStart = x; }
      else if (prev !== 0 && winding === 0) {
        let lo = Math.ceil(spanStart * SUPERSAMPLE - 0.5);
        let hi = Math.ceil(x * SUPERSAMPLE - 0.5) - 1;
        if (lo < 0) { lo = 0; }
        if (hi > subWidth - 1) { hi = subWidth - 1; }
        for (let sx = lo; sx <= hi; sx++) { coverage[row * w + ((sx / SUPERSAMPLE) | 0)]! += 1; }
      }
    }
  }

  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((coverage[y * w + x] ?? 0) >= INK_THRESHOLD) {
        if (x < x0) { x0 = x; }
        if (x > x1) { x1 = x; }
        if (y < y0) { y0 = y; }
        if (y > y1) { y1 = y; }
      }
    }
  }
  if (x1 < 0) { return blank; }               // an outline too faint to ink
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const stride = (tw + 7) >> 3;
  const bits = Buffer.alloc(stride * th, 0);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if ((coverage[(y + y0) * w + (x + x0)] ?? 0) >= INK_THRESHOLD) {
        bits[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  return { w: tw, h: th, left: left + x0, top: top - y0, bits };
}
