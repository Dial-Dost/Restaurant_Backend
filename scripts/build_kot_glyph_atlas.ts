/**
 * Builds kot_glyph_atlas.ts — the committed glyph table the raster KOT prints
 * from. DEV TIME ONLY, run by hand:
 *
 *     npx tsx scripts/build_kot_glyph_atlas.ts
 *
 * WHY A COMMITTED TABLE AND NOT A FONT AT RUNTIME. The kitchen docket has to be
 * set in a proportional face (the client's reference docket is Tahoma; ESC/POS
 * built-in fonts are monospaced and cannot match it), and a printer takes a
 * proportional face only as a raster. The three ways to get that raster are:
 * parse a .ttf in the server (a font file in the image, a parser on the hot
 * path), ask the OS or sharp to draw text (fontconfig in the image, and bytes
 * that differ between a Windows laptop and Debian), or pre-render every glyph
 * once and commit the result. Only the third gives byte-identical dockets
 * everywhere, which is what lets escpos.test.ts pin a docket's sha256 at all.
 *
 * So this script and scripts/kot_ttf.ts read the .ttf files under
 * scripts/kot_fonts, which .dockerignore keeps out of the image, and the
 * runtime imports nothing but the generated table.
 *
 * THE FONT is DejaVu Sans Condensed 2.37 under the Bitstream Vera licence
 * (DejaVu's changes are public domain): of the faces we may ship, the one whose
 * proportions measure closest to the reference docket's Tahoma. The fit, and
 * why not Tahoma itself, is in scripts/kot_atlas_build.ts; the licence travels
 * with the files in scripts/kot_fonts/LICENSE and with the table in its header.
 * It replaced Liberation Sans (Arial metrics) in 2.0.2.
 *
 * RE-RUN IT WHEN, and only when, the face, the sizes or the rasterizer change.
 * jest-tests/kot_raster.test.ts rebuilds the atlas in memory and fails if the
 * committed module differs, so the table can never drift away from this script.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { atlasToModule, buildKotGlyphAtlas } from "./kot_atlas_build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const started = Date.now();
const atlas = buildKotGlyphAtlas(join(HERE, "kot_fonts"));
const module = atlasToModule(atlas);
const outFile = join(HERE, "..", "kot_glyph_atlas.ts");
writeFileSync(outFile, module, "utf8");
const glyphs = Object.values(atlas).reduce((n, f) => n + Object.keys(f.g).length, 0);
console.log(`faces ${Object.keys(atlas).length}  glyphs ${glyphs}  bytes ${module.length}`);
console.log(`sha256 ${createHash("sha256").update(module).digest("hex")}`);
console.log(`wrote  ${outFile} in ${Date.now() - started}ms`);
