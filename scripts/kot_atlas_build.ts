/**
 * Turning two .ttf files into the committed glyph table — the pure half of
 * scripts/build_kot_glyph_atlas.ts, which is the command-line wrapper round it.
 *
 * SPLIT IN TWO SO THE DRIFT TEST CAN IMPORT IT. jest-tests/kot_raster.test.ts
 * rebuilds the atlas in memory and fails if the committed kot_glyph_atlas.ts
 * differs by a single dot, which is what stops the table and the script that
 * makes it from ever parting company. ts-jest compiles a test to CommonJS,
 * where `import.meta.url` is not allowed — so the font directory is a PARAMETER
 * here, and only the wrapper resolves it from its own location.
 *
 * DEV TIME ONLY. Nothing under the running server may import this file or
 * scripts/kot_ttf.ts; the same test reads the source tree and enforces it.
 */
import { join } from "node:path";
import { obliqueFont, parseTtf, rasterizeGlyph, type ParsedFont } from "./kot_ttf.js";

/**
 * THE FACE: DejaVu Sans Condensed 2.37, regular and bold, from
 * scripts/kot_fonts. Chosen by measurement, not by eye.
 *
 * The client's photographed reference docket is Microsoft Tahoma at 27 dots
 * per em. Tahoma cannot ship. Every permissively licensed humanist sans we
 * could obtain was scored the way the investigation identified Tahoma: the ink
 * width of the photo's 11 measured lines, bold and regular, divided by the
 * face's own width for the same text. A face with the photo's proportions
 * gives the same size on every line, so the spread (coefficient of variation)
 * is the score:
 *
 *   Tahoma (the photo's face, reference only)    3.53%
 *   Wine Tahoma (LGPL, not shipped)              3.59%
 *   DejaVu Sans Condensed                        3.95%   fitted 26.8 dots/em
 *   Atkinson Hyperlegible 4.44, Noto Sans SemiCondensed 4.51, Open Sans 4.73,
 *   IBM Plex Sans Condensed 5.02, Noto Sans 5.05, Liberation Sans (2.0.1)
 *   5.56, Fira Sans 6.66, PT Sans 7.46, Lato 7.72
 *
 * At its fitted size DejaVu Sans Condensed also lands the photo's capital and
 * x-heights (19.6 and 14.7 dots) exactly, and its bold is as wide relative to
 * its regular as Tahoma's is, which is why the whole docket, not just one
 * line, reads like the ticket the client approved.
 *
 * LICENCE: the Bitstream Vera Fonts licence (DejaVu's own changes are public
 * domain): use, copy, modify and redistribute, including inside a sold
 * product, on condition that the notice travels with every copy. It does; see
 * atlasToModule. scripts/kot_fonts/LICENSE is the full text.
 */
export const KOT_FONT_FILES = {
  r: "DejaVuSansCondensed.ttf",
  b: "DejaVuSansCondensed-Bold.ttf",
} as const;

/**
 * The "[Note]" slant: x moves right by this much per dot of height, which is
 * the synthetic oblique the photo's note line shows (about 12 degrees).
 * `KOT_NOTE_SCALE` in escpos.ts is the other half: how much smaller it is.
 */
export const KOT_NOTE_SHEAR = 0.21;

/** A face's style: regular, bold, or the regular face slanted for a note. */
export type KotAtlasStyle = "r" | "b" | "o";

/**
 * The only faces that exist: a size in printer dots per em, and the styles it
 * is baked in.
 *
 * BODY SIZES, regular and bold (a dish name is bold, everything else is not):
 *   80mm (576 dots)  small 23, standard 27, large 33
 *   58mm (384 dots)  small 21, standard 23, large 27
 * BANNER SIZES, bold only: REPRINT and CANCELLED at 1.4x the body, rounded,
 * and never set in any other weight (escpos.ts kotRunFace):
 *   80mm  32, 38, 46          58mm  29, 32, 38
 * NOTE SIZES, oblique only: a "[Note]" line at 0.87x the body, rounded:
 *   80mm  20, 23, 29          58mm  18, 20, 23
 * A size that is more than one of these (23 is a body size AND the standard
 * note) is baked once, in every style any of them needs.
 *
 * They are `KOT_BODY_PPEM` / `kotAtlasFaces()` in escpos.ts, spelled out here
 * because this script must be runnable before the atlas it generates exists,
 * and kot_raster.test.ts asserts this list IS kotAtlasFaces(), so a new size
 * cannot ship without its faces and a dropped size cannot leave its faces
 * behind as dead weight in the server's bundle.
 */
export const KOT_ATLAS_FACES: readonly { ppem: number; styles: readonly KotAtlasStyle[] }[] = [
  { ppem: 18, styles: ["o"] },
  { ppem: 20, styles: ["o"] },
  { ppem: 21, styles: ["r", "b"] },
  { ppem: 23, styles: ["r", "b", "o"] },
  { ppem: 27, styles: ["r", "b"] },
  { ppem: 29, styles: ["b", "o"] },
  { ppem: 32, styles: ["b"] },
  { ppem: 33, styles: ["r", "b"] },
  { ppem: 38, styles: ["b"] },
  { ppem: 46, styles: ["b"] },
];

/** ASCII only: everything else is folded to '?' by asciiSafe before it is set. */
export const FIRST_CHAR = 32;
export const LAST_CHAR = 126;

export interface BuiltGlyph {
  /** Advance in 1/16 dot — sixteenths, so a pen position never rounds twice. */
  a: number;
  /** Ink box offset from the pen, and its height above the baseline. */
  l: number;
  t: number;
  w: number;
  h: number;
  /** base64 of a row-major 1bpp bitmap, MSB first, stride = ceil(w / 8). */
  d: string;
}
export interface BuiltFace {
  ppem: number;
  weight: number;
  /** 0 for upright type; KOT_NOTE_SHEAR for the note face. */
  slant: number;
  /** Tallest ink above, and deepest below, the baseline anywhere in the face. */
  top: number;
  bottom: number;
  g: Record<number, BuiltGlyph>;
}
export type BuiltAtlas = Record<string, BuiltFace>;

function buildFace(font: ParsedFont, ppem: number, weight: number, slant: number): BuiltFace {
  const g: Record<number, BuiltGlyph> = {};
  let top = 0;
  let bottom = 0;
  for (let c = FIRST_CHAR; c <= LAST_CHAR; c++) {
    const gid = font.cmap.get(c) ?? 0;
    // Sixteenths of a dot. A whole-dot advance would round every glyph
    // independently and a 40-character line would drift several dots wide.
    const a = Math.round((font.adv[gid] ?? 0) * ppem * 16 / font.unitsPerEm);
    const bm = rasterizeGlyph(font, gid, ppem);
    g[c] = { a, l: bm.left, t: bm.top, w: bm.w, h: bm.h, d: bm.bits.toString("base64") };
    if (bm.h > 0) {
      if (bm.top > top) { top = bm.top; }
      if (bm.h - bm.top > bottom) { bottom = bm.h - bm.top; }
    }
  }
  return { ppem, weight, slant, top, bottom, g };
}

/** The whole atlas, keyed "<ppem>r" / "<ppem>b" / "<ppem>o". */
export function buildKotGlyphAtlas(fontDir: string): BuiltAtlas {
  const regular = parseTtf(join(fontDir, KOT_FONT_FILES.r));
  const fonts: Record<KotAtlasStyle, { font: ParsedFont; weight: number; slant: number }> = {
    r: { font: regular, weight: 400, slant: 0 },
    b: { font: parseTtf(join(fontDir, KOT_FONT_FILES.b)), weight: 700, slant: 0 },
    o: { font: obliqueFont(regular, KOT_NOTE_SHEAR), weight: 400, slant: KOT_NOTE_SHEAR },
  };
  const atlas: BuiltAtlas = {};
  for (const { ppem, styles } of [...KOT_ATLAS_FACES].sort((x, y) => x.ppem - y.ppem)) {
    for (const key of (["r", "b", "o"] as const).filter((s) => styles.includes(s))) {
      const { font, weight, slant } = fonts[key];
      atlas[`${ppem}${key}`] = buildFace(font, ppem, weight, slant);
    }
  }
  return atlas;
}

/**
 * The Bitstream Vera Fonts notice, verbatim from scripts/kot_fonts/LICENSE. The
 * licence requires it in "all copies of one or more of the Font Software
 * typefaces", and a table of rendered glyphs is close enough to a copy that it
 * carries the notice rather than argue the point.
 */
const BITSTREAM_VERA_NOTICE: readonly string[] = [
  "Fonts are (c) Bitstream (see below). DejaVu changes are in public domain.",
  "",
  "Bitstream Vera Fonts Copyright",
  "",
  "Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is",
  "a trademark of Bitstream, Inc.",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of the fonts accompanying this license (\"Fonts\") and associated",
  "documentation files (the \"Font Software\"), to reproduce and distribute the",
  "Font Software, including without limitation the rights to use, copy, merge,",
  "publish, distribute, and/or sell copies of the Font Software, and to permit",
  "persons to whom the Font Software is furnished to do so, subject to the",
  "following conditions:",
  "",
  "The above copyright and trademark notices and this permission notice shall",
  "be included in all copies of one or more of the Font Software typefaces.",
  "",
  "The Font Software may be modified, altered, or added to, and in particular",
  "the designs of glyphs or characters in the Fonts may be modified and",
  "additional glyphs or characters may be added to the Fonts, only if the fonts",
  "are renamed to names not containing either the words \"Bitstream\" or the word",
  "\"Vera\".",
  "",
  "This License becomes null and void to the extent applicable to Fonts or Font",
  "Software that has been modified and is distributed under the \"Bitstream",
  "Vera\" names.",
  "",
  "The Font Software may be sold as part of a larger software package but no",
  "copy of one or more of the Font Software typefaces may be sold by itself.",
  "",
  "THE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS",
  "OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,",
  "TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL BITSTREAM OR THE GNOME",
  "FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING",
  "ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES,",
  "WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF",
  "THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE",
  "FONT SOFTWARE.",
  "",
  "Except as contained in this notice, the names of Gnome, the Gnome",
  "Foundation, and Bitstream Inc., shall not be used in advertising or",
  "otherwise to promote the sale, use or other dealings in this Font Software",
  "without prior written authorization from the Gnome Foundation or Bitstream",
  "Inc., respectively. For further information, contact: fonts at gnome dot",
  "org.",
];

/** The generated module, as text. Deterministic: same atlas, same string. */
export function atlasToModule(atlas: BuiltAtlas): string {
  const out: string[] = [];
  out.push("// GENERATED by scripts/build_kot_glyph_atlas.ts — DO NOT EDIT BY HAND.");
  out.push("//");
  out.push("// DejaVu Sans Condensed 2.37, pre-rendered to 1-bit printer dots: the");
  out.push("// permissively licensed face whose proportions come closest to the Tahoma of");
  out.push("// the client's reference docket (scripts/kot_atlas_build.ts has the fit). This");
  out.push("// table is the ONLY thing the KOT raster renderer knows about type: no font");
  out.push("// file and no font parser is reachable from the running server, so a docket's");
  out.push("// bytes are identical on a developer's Windows box, in CI and on the Debian VPS.");
  out.push("//");
  out.push("// Faces are keyed \"<dots per em><r|b|o>\": regular, bold, and the regular face");
  out.push("// slanted by `slant` (x per dot of height) for a \"[Note]\" line. Per glyph: `a`");
  out.push("// is the advance in SIXTEENTHS of a dot, `l`/`t` the ink box's offset from the");
  out.push("// pen and its height above the baseline, `w`/`h` its size, and `d` a base64");
  out.push("// row-major 1bpp bitmap (MSB first, stride = ceil(w / 8)). A blank glyph");
  out.push("// (space) has w = h = 0.");
  out.push("//");
  out.push("// The outlines are the DejaVu fonts', which are the Bitstream Vera fonts with");
  out.push("// public-domain changes. Their licence asks for this notice on every copy:");
  out.push("//");
  for (const l of BITSTREAM_VERA_NOTICE) { out.push(l ? `//   ${l}` : "//"); }
  out.push("");
  out.push("export interface KotGlyph { a: number; l: number; t: number; w: number; h: number; d: string }");
  out.push("export interface KotFace {");
  out.push("  ppem: number;");
  out.push("  weight: number;");
  out.push("  /** 0 for upright type; x moved per dot of height for the slanted note face. */");
  out.push("  slant: number;");
  out.push("  /** Tallest ink above, and deepest below, the baseline anywhere in the face. */");
  out.push("  top: number;");
  out.push("  bottom: number;");
  out.push("  g: Record<number, KotGlyph>;");
  out.push("}");
  out.push("");
  out.push("export const KOT_ATLAS: Record<string, KotFace> = {");
  for (const [key, face] of Object.entries(atlas)) {
    out.push(`  ${JSON.stringify(key)}: { ppem: ${face.ppem}, weight: ${face.weight}, slant: ${face.slant}, top: ${face.top}, bottom: ${face.bottom}, g: {`);
    for (const [code, glyph] of Object.entries(face.g)) {
      out.push(`    ${code}: { a: ${glyph.a}, l: ${glyph.l}, t: ${glyph.t}, w: ${glyph.w}, h: ${glyph.h}, d: ${JSON.stringify(glyph.d)} },`);
    }
    out.push("  } },");
  }
  out.push("};");
  return out.join("\n") + "\n";
}
