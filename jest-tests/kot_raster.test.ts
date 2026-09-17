/**
 * HOW THE KITCHEN DOCKET IS DRAWN — the raster encoder, the glyph atlas it
 * draws from, and the wiring that decides which of the two dockets a
 * restaurant gets.
 *
 * WHAT IS NOT ASSERTED HERE: what the docket says. That is layoutKot's job and
 * kot_layout.test.ts's. What is asserted here is everything a picture can go
 * wrong at and a text assertion cannot see — ink past the paper edge, a
 * quantity that drifted off its column, a banner that is no longer the biggest
 * thing on the ticket, a glyph table that stopped matching the script that
 * built it, and bytes that are not the same twice running.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect } from "@jest/globals";
import {
  DOTS_PER_COL,
  KOT_BANNER_SCALE,
  KOT_BODY_PPEM,
  KOT_NOTE_SCALE,
  KOT_RASTER_CHUNK_ROWS,
  KOT_RULE_TEXT,
  buildKotBase64,
  buildReceiptBase64,
  encodeKotRaster,
  kotAtlasFaces,
  kotPrintStyleOf,
  kotProfile,
  kotTextSizeOf,
  kotTextWidth,
  kotWrap,
  kotWrapUnits,
  layoutKot,
  planKotRaster,
  type KotDraw,
  type KotRasterPlan,
  type KotRow,
  type KotTextSize,
  type ReceiptOptions,
} from "../escpos";
import { KOT_ATLAS } from "../kot_glyph_atlas";
import { BILL_LOGO_MAX_HEIGHT } from "../bill_logo";
import { KOT_ATLAS_FACES, KOT_FONT_FILES, KOT_NOTE_SHEAR, atlasToModule, buildKotGlyphAtlas } from "../scripts/kot_atlas_build";
import { KOT_TEXT_SIZES } from "../kot_print_style";
import { kotFaceKey, kotPaper, readKotRaster, rollPpems } from "./kot_raster_read";

const REPO = join(__dirname, "..");

const docket: ReceiptOptions = {
  restaurantName: "Gaia - Global Vegetarian",
  table: "33",
  covers: 4,
  currency: "₹",
  total: 0,
  kind: "kot",
  kotNo: 21,
  printedAt: "08/09/26 14:13",
  orderContext: "Running Table",
  serviceMode: "Dine In",
  section: "DOME SECTION",
  assignedTo: "yado",
  captain: "TIYASHA",
  items: [
    { name: "Subz Tehri", quantity: 1, price: 0 },
    { name: "Ghewar Berry Mousse", quantity: 1, price: 0 },
    { name: "Gaia Rose Cookies", quantity: 1, price: 0, note: "Hold Dessert" },
  ],
};

/** The docket every column guard has to survive: long names, a big quantity,
 *  a hold, a long note, an order note and a variation. */
const stress: ReceiptOptions = {
  ...docket,
  kotNo: 214,
  orderNote: "allergy: peanuts, no onions in anything",
  items: [
    { name: "Chargrilled Tandoori Broccoli Malai with Burnt Garlic", quantity: 12, price: 0 },
    { name: "Ghewar Berry Mousse", quantity: 2, price: 0, held: true },
    { name: "Gaia Rose Cookies", quantity: 1, price: 0, note: "Hold Dessert, serve with the mains" },
    { name: "Paneer Tikka", quantity: 120, price: 0, variation: "Half" },
  ],
};

/** A banquet ticket: past item 99 the row number needs a third digit, and every
 *  seventh line is a name that wraps, so the columns are under load together.
 *  Kept out of `variants` on purpose — a 120-line raster is half a megabyte of
 *  base64 and would drown the payload-cost test, which measures that separately. */
const long: ReceiptOptions = {
  ...docket,
  kotNo: 907,
  items: Array.from({ length: 120 }, (_, i) => ({
    name: i % 7 === 0 ? "Chargrilled Tandoori Broccoli Malai with Burnt Garlic" : "Roti",
    quantity: i % 11 === 0 ? 12 : 1,
    price: 0,
  })),
};

const variants: [string, ReceiptOptions][] = [
  ["the reference docket", docket],
  ["a long name with a hold and a note", stress],
  ["a reprint", { ...stress, reprint: true }],
  ["a cancellation", { ...stress, cancelled: true }],
  ["a per-station docket", { ...docket, station: "Tandoor" }],
  ["an empty ticket", { ...docket, items: [] }],
  ["an unnumbered, unassigned ticket", { ...docket, kotNo: null, assignedTo: null, captain: null, section: null }],
  ["an unbroken 60-character token", { ...docket, items: [{ name: "Supercalifragilisticexpialidociousandthensomemoretoo", quantity: 1, price: 0 }] }],
  ["a four-digit quantity", { ...docket, items: [{ name: "Roti", quantity: 1200, price: 0 }] }],
  ["a name folded from non-ASCII", { ...docket, items: [{ name: "Café Niçoise ₹250 — Thé", quantity: 1, price: 0 }] }],
];

/** Every text size a restaurant can choose, smallest first. */
const SIZES: readonly KotTextSize[] = ["small", "standard", "large"];
/** Every roll, as the column count the callers pass. */
const ROLLS: readonly number[] = [48, 32];
const rollName = (cols: number) => (cols === 48 ? "80mm" : "58mm");

const plan = (opts: ReceiptOptions, cols: number, size?: KotTextSize): KotRasterPlan => {
  const profile = kotProfile(cols * DOTS_PER_COL, size ?? opts.kotTextSize);
  return planKotRaster(layoutKot(opts, profile), KOT_ATLAS, profile.ppem, profile.widthDots);
};
const bytes = (b64: string) => Buffer.from(b64, "base64");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const draws = (p: KotRasterPlan): KotDraw[] => p.ops.flatMap((op) => op.draws);

describe("the glyph atlas cannot drift from the script that builds it", () => {
  const rebuilt = buildKotGlyphAtlas(join(REPO, "scripts", "kot_fonts"));

  test("the committed table is exactly what the builder produces, dot for dot", () => {
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(JSON.parse(JSON.stringify(KOT_ATLAS)));
  });

  test("and so is the committed module's text, so nobody has hand-edited it", () => {
    const committed = readFileSync(join(REPO, "kot_glyph_atlas.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(atlasToModule(rebuilt).replace(/\r\n/g, "\n")).toBe(committed);
  });

  test("every face any roll at any size actually asks for exists", () => {
    for (const roll of [576, 384]) {
      for (const size of SIZES) {
        const p = kotProfile(roll, size);
        for (const weight of ["r", "b"]) { expect(KOT_ATLAS[`${p.ppem}${weight}`]).toBeDefined(); }
        // A banner is only ever set bold, a note only slanted (kotRunFace).
        expect(KOT_ATLAS[`${p.bannerPpem}b`]).toBeDefined();
        expect(KOT_ATLAS[`${p.notePpem}o`]).toBeDefined();
      }
    }
  });

  test("the builder bakes exactly the faces the renderer can ask for — nothing missing, nothing dead", () => {
    // The unused 30/40/42/56 faces of the first cut are the case this catches:
    // half the table was type no docket could be set in any more.
    const baked = KOT_ATLAS_FACES.flatMap((f) => f.styles.map((w) => `${f.ppem}${w}`));
    expect([...baked].sort()).toEqual([...kotAtlasFaces()].sort());
    expect(Object.keys(KOT_ATLAS).sort()).toEqual([...kotAtlasFaces()].sort());
  });

  test("and every face a real docket is drawn in is on that list", () => {
    // kotAtlasFaces() is a claim about planKotRaster; this checks the claim
    // against what planKotRaster actually does, banners and bold names included.
    const used = new Set<string>();
    for (const [, opts] of variants) {
      for (const cols of ROLLS) {
        for (const size of SIZES) {
          for (const d of draws(plan({ ...opts, reprint: true }, cols, size))) {
            used.add(kotFaceKey(d.face));
          }
        }
      }
    }
    expect([...used].filter((k) => !kotAtlasFaces().includes(k))).toEqual([]);
  });

  test("the module stays a reasonable size for a table that ships in the server", () => {
    // 16 faces of ASCII: ~172KB of source (11 faces and ~120KB before the
    // slanted note faces and the licence notice). A size added without thought
    // (or a stray style) shows up here before it shows up in a cold start.
    const bytes = readFileSync(join(REPO, "kot_glyph_atlas.ts")).length;
    expect(bytes).toBeLessThan(190_000);
  });

  test("THE FACE IS DEJAVU SANS CONDENSED, and only the files it is built from are committed", () => {
    // Never Tahoma: it is the photograph's face and may not ship. The fit that
    // chose DejaVu is in scripts/kot_atlas_build.ts.
    expect(KOT_FONT_FILES).toEqual({ r: "DejaVuSansCondensed.ttf", b: "DejaVuSansCondensed-Bold.ttf" });
    const dir = readdirSync(join(REPO, "scripts", "kot_fonts")).sort();
    expect(dir).toEqual(["AUTHORS", "DejaVuSansCondensed-Bold.ttf", "DejaVuSansCondensed.ttf", "LICENSE", "SOURCE.txt"]);
    expect(dir.filter((f) => /tahoma|liberation/i.test(f))).toEqual([]);
    expect(readFileSync(join(REPO, "scripts", "kot_fonts", "LICENSE"), "utf8")).toContain("Bitstream Vera Fonts Copyright");
  });

  test("the licence notice travels with the table that ships", () => {
    // The Bitstream Vera licence's one condition: the notice goes with every copy.
    const module = readFileSync(join(REPO, "kot_glyph_atlas.ts"), "utf8");
    expect(module).toContain("DejaVu Sans Condensed");
    expect(module).toContain("Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved.");
    expect(module).toContain("The above copyright and trademark notices and this permission notice shall");
  });

  test("only the note faces are slanted, and they really lean", () => {
    for (const [key, face] of Object.entries(KOT_ATLAS)) {
      expect({ key, slant: face.slant }).toEqual({ key, slant: key.endsWith("o") ? KOT_NOTE_SHEAR : 0 });
      expect({ key, weight: face.weight }).toEqual({ key, weight: key.endsWith("b") ? 700 : 400 });
    }
    // An "l" is one vertical stroke upright. Slanted, its top row starts to the
    // right of its bottom row, by about slant x height.
    const firstInk = (face: string, row: "top" | "bottom") => {
      const g = KOT_ATLAS[face]!.g[108]!;
      const px = Buffer.from(g.d, "base64");
      const stride = (g.w + 7) >> 3;
      const y = row === "top" ? 0 : g.h - 1;
      for (let x = 0; x < g.w; x++) { if ((px[y * stride + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) { return x; } }
      return -1;
    };
    expect(firstInk("23r", "top")).toBe(firstInk("23r", "bottom"));
    const lean = firstInk("23o", "top") - firstInk("23o", "bottom");
    const h = KOT_ATLAS["23o"]!.g[108]!.h;
    expect(Math.abs(lean - KOT_NOTE_SHEAR * h)).toBeLessThanOrEqual(1.5);
  });

  test("it is ASCII 32..126 and nothing else — the fold happens before the type", () => {
    for (const face of Object.values(KOT_ATLAS)) {
      const codes = Object.keys(face.g).map(Number).sort((a, b) => a - b);
      expect(codes[0]).toBe(32);
      expect(codes[codes.length - 1]).toBe(126);
      expect(codes.length).toBe(95);
    }
  });
});

/**
 * THE TEXT SIZE — "Restaurant".kot_text_size.
 *
 * The client, having printed the first reference docket: "The font sizes must
 * be smaller in the KOT." Standard is their reference photograph (27 dots per
 * em on 80mm in the docket's face), with a step either side of it an owner can
 * pick in Settings.
 */
describe("the text size a restaurant chose", () => {
  test("the sizes are exactly the agreed table", () => {
    expect(KOT_BODY_PPEM).toEqual({
      "80mm": { small: 23, standard: 27, large: 33 },
      "58mm": { small: 21, standard: 23, large: 27 },
    });
  });

  test("STANDARD ON 80mm IS THE CLIENT'S REFERENCE PHOTOGRAPH — 27 dots per em — and it is the default", () => {
    expect(kotProfile(576)).toEqual({ widthDots: 576, textSize: "standard", ppem: 27, bannerPpem: 38, notePpem: 23 });
    expect(kotProfile(576, "standard")).toEqual(kotProfile(576));
    expect(kotProfile(384)).toEqual({ widthDots: 384, textSize: "standard", ppem: 23, bannerPpem: 32, notePpem: 20 });
  });

  test("every roll and size resolves to its row of the table, and the banner is 1.4x bold, rounded", () => {
    for (const cols of ROLLS) {
      for (const size of SIZES) {
        const p = kotProfile(cols * DOTS_PER_COL, size);
        expect(p.ppem).toBe(KOT_BODY_PPEM[rollName(cols)][size]);
        expect(p.bannerPpem).toBe(Math.round(p.ppem * KOT_BANNER_SCALE));
        expect(p.notePpem).toBe(Math.round(p.ppem * KOT_NOTE_SCALE));
        expect(p.textSize).toBe(size);
      }
    }
    // The rounding, spelled out. Banners: 21→29, 23→32, 27→38, 33→46.
    expect([21, 23, 27, 33].map((b) => Math.round(b * KOT_BANNER_SCALE))).toEqual([29, 32, 38, 46]);
    // Notes: 21→18, 23→20, 27→23, 33→29.
    expect([21, 23, 27, 33].map((b) => Math.round(b * KOT_NOTE_SCALE))).toEqual([18, 20, 23, 29]);
  });

  test("anything that is not a size is standard — a NULL column, a missing one, a typo", () => {
    for (const raw of [undefined, null, "", "  ", "medium", "SMALLER", 7, {}]) {
      expect(kotTextSizeOf(raw)).toBe("standard");
      expect(kotProfile(576, raw).ppem).toBe(27);
    }
    expect(kotTextSizeOf(" Small ")).toBe("small");
    expect(kotTextSizeOf("LARGE")).toBe("large");
  });

  test("the renderer knows exactly the sizes the settings layer does", () => {
    expect([...SIZES]).toEqual([...KOT_TEXT_SIZES]);
    for (const size of KOT_TEXT_SIZES) { expect(kotTextSizeOf(size)).toBe(size); }
  });

  test("small < standard < large, on both rolls, in the type AND on the paper", () => {
    for (const cols of ROLLS) {
      const [s, m, l] = SIZES.map((size) => plan(docket, cols, size));
      expect(s!.geometry.ppem).toBeLessThan(m!.geometry.ppem);
      expect(m!.geometry.ppem).toBeLessThan(l!.geometry.ppem);
      expect(s!.heightDots).toBeLessThan(m!.heightDots);
      expect(m!.heightDots).toBeLessThan(l!.heightDots);
    }
  });

  test("the size changes how big the words are, never which words are on the paper", () => {
    for (const cols of ROLLS) {
      const rows = SIZES.map((size) => layoutKot(stress, kotProfile(cols * DOTS_PER_COL, size)));
      expect(rows[0]).toEqual(rows[1]);
      expect(rows[2]).toEqual(rows[1]);
    }
  });

  test("the setting reaches the paper: each size prints a different docket, the default is standard's", () => {
    const at = (size?: KotTextSize) => buildReceiptBase64({ ...docket, ...(size ? { kotTextSize: size } : {}) }, 48);
    expect(new Set(SIZES.map((s) => at(s))).size).toBe(3);
    expect(at()).toBe(at("standard"));
  });

  test("THE CLASSIC TEXT DOCKET IGNORES IT, byte for byte", () => {
    // It is set in the printer's own font, and a restaurant on it is there
    // because its printer cannot draw ours.
    for (const cols of ROLLS) {
      const classic = { ...stress, kotPrintStyle: "classic" as const };
      for (const size of SIZES) {
        expect(buildReceiptBase64({ ...classic, kotTextSize: size }, cols)).toBe(buildReceiptBase64(classic, cols));
      }
    }
  });

  test("a BILL ignores it too", () => {
    const bill: ReceiptOptions = { ...docket, kind: "bill", items: [{ name: "Tea", quantity: 1, price: 50 }], total: 50 };
    for (const size of SIZES) {
      expect(buildReceiptBase64({ ...bill, kotTextSize: size }, 48)).toBe(buildReceiptBase64(bill, 48));
    }
  });

  test("every station's ticket of a split is set in the same size", () => {
    const split: ReceiptOptions = {
      ...docket,
      kotTextSize: "small",
      items: [
        { name: "Subz Tehri", quantity: 1, price: 0, station: "Tandoor" },
        { name: "Virgin Mojito", quantity: 2, price: 0, station: "BAR" },
      ],
    };
    for (const t of buildKotBase64(split, 48)) {
      const lines = readKotRaster(t.escBase64, 576, rollPpems(48, "small"));
      expect(lines.filter((l) => l.leftover !== 0)).toEqual([]);
      expect(lines.map((l) => l.text)).toContain("Table No: 33");
    }
  });
});

describe("nothing a docket prints crosses the edge of the roll", () => {
  for (const [name, opts] of variants) {
    for (const cols of ROLLS) {
      for (const size of SIZES) {
        test(`${name}, ${rollName(cols)}, ${size}`, () => {
          const p = plan(opts, cols, size);
          const outside = draws(p).filter((d) => d.x0 < 0 || d.x1 > p.widthDots);
          expect(outside.map((d) => `${d.text} [${d.x0},${d.x1}) of ${p.widthDots}`)).toEqual([]);
        });
      }
    }
  }

  test("the guard has teeth: a draw pushed past the edge is caught", () => {
    const p = plan(stress, 48);
    const pushed = draws(p).map((d) => ({ ...d, x1: d.x1 + p.widthDots }));
    expect(pushed.some((d) => d.x1 > p.widthDots)).toBe(true);
  });
});

describe("the item table's columns", () => {
  for (const [cols, size] of ROLLS.flatMap((c) => SIZES.map((s) => [c, s] as const))) {
    const roll = `${rollName(cols)}, ${size}`;

    test(`every quantity is flush to the same right edge — ${roll}`, () => {
      const p = plan(stress, cols, size);
      // A quantity is the only thing drawn to the right of the name column, and
      // it is right-ALIGNED: its pen moves, its right edge never does.
      const rights = p.ops
        .filter((op) => op.draws.length > 1)
        .map((op) => op.draws.find((d) => d.x > p.geometry.qtyLeft - p.geometry.ppem))
        .filter((d): d is KotDraw => d !== undefined)
        .map((d) => d.x + kotTextWidth(d.face, d.text));
      expect(rights.length).toBeGreaterThan(3);
      expect(new Set(rights)).toEqual(new Set([p.geometry.qtyRight]));
    });

    test(`a dish name never runs into the quantity column — ${roll}`, () => {
      const p = plan(stress, cols, size);
      const names = draws(p).filter((d) => d.x === p.geometry.nameX);
      expect(names.length).toBeGreaterThan(4);
      for (const d of names) { expect(d.x1).toBeLessThanOrEqual(p.geometry.qtyLeft); }
    });

    test(`wrapped names, [Hold] and [Note] all hang on the name column — ${roll}`, () => {
      const p = plan(stress, cols, size);
      const hangs = p.ops.filter((op) => op.draws.length === 1 && op.draws[0]!.x === p.geometry.nameX);
      const texts = hangs.map((op) => op.draws[0]!.text);
      // The hold line is the marker and nothing else.
      expect(texts.filter((t) => t.startsWith("[Hold]"))).toEqual(["[Hold]"]);
      expect(texts.some((t) => t.startsWith("[Note]"))).toBe(true);
      // and the continuation of the 52-character dish name
      expect(texts.some((t) => t.includes("Garlic"))).toBe(true);
    });

    test(`the No. column and every left-aligned line share one edge — ${roll}`, () => {
      const p = plan(docket, cols, size);
      const left = draws(p).filter((d) => d.x === p.geometry.numX).map((d) => d.text);
      expect(left).toContain("Assign to: yado");
      expect(left).toContain("No.Item");
      expect(left).toContain("1");
      expect(left).toContain("Total Qty");
    });
  }
});

/**
 * THE BANQUET TICKET, WHERE THE ROW NUMBER GROWS A THIRD DIGIT.
 *
 * A fixed No. column fits "99" and no more. From item 100 the third digit is
 * drawn straight over the first letter of the dish name — no error, no
 * clipping, just two glyphs merged into one shape — and a hundred-line ticket
 * is exactly the one nobody proof-reads before the pass cooks from it. So the
 * No. column is measured from the widest row number on the docket, the same way
 * the quantity column is measured from the widest quantity.
 */
describe("a docket long enough to need three-digit row numbers", () => {
  for (const [cols, size] of ROLLS.flatMap((c) => SIZES.map((s) => [c, s] as const))) {
    const roll = `${rollName(cols)}, ${size}`;

    test(`no row number is ever drawn into a dish name — ${roll}`, () => {
      const p = plan(long, cols, size);
      const numbered = p.ops
        .map((op) => ({
          num: op.draws.find((d) => d.x === p.geometry.numX),
          name: op.draws.find((d) => d.x === p.geometry.nameX),
        }))
        .filter((r): r is { num: KotDraw; name: KotDraw } => r.num !== undefined && r.name !== undefined);
      expect(numbered.length).toBeGreaterThan(100);
      // The case this guards actually occurs on this docket.
      expect(numbered.some((r) => r.num.text.length === 3)).toBe(true);
      // Against the EARLIEST ink any name line starts at, not just the one
      // beside it, so a wrapped continuation, a [Hold] and a [Note] are covered
      // by the same assertion.
      const nameInk = Math.min(...draws(p).filter((d) => d.x === p.geometry.nameX).map((d) => d.x0));
      const over = numbered.filter((r) => r.num.x1 > nameInk);
      expect(over.map((r) => `"${r.num.text}" ends ${r.num.x1}, names start ${nameInk}`)).toEqual([]);
    });

    test(`and nothing on it crosses the edge of the roll — ${roll}`, () => {
      const p = plan(long, cols, size);
      const outside = draws(p).filter((d) => d.x0 < 0 || d.x1 > p.widthDots);
      expect(outside.map((d) => `${d.text} [${d.x0},${d.x1}) of ${p.widthDots}`)).toEqual([]);
    });

    test(`a ticket the reference's own size is not indented for it — ${roll}`, () => {
      // The column GROWS from the reference's 1.45em and never shrinks below it,
      // so the docket in the photograph — and every ticket of nine lines or
      // fewer — is laid out exactly as it was.
      const ref = plan(docket, cols, size).geometry;
      expect(ref.nameX).toBe(Math.round(ref.ppem * 1.45));
      const roti = (n: number) => ({ ...docket, items: Array.from({ length: n }, () => ({ name: "Roti", quantity: 1, price: 0 })) });
      expect(plan(roti(9), cols, size).geometry.nameX).toBe(ref.nameX);
      expect(plan(roti(10), cols, size).geometry.nameX).toBeGreaterThan(ref.nameX);
      expect(plan(long, cols, size).geometry.nameX).toBeGreaterThan(plan(roti(10), cols, size).geometry.nameX);
    });

    test(`a nonsense row number cannot eat the dish name — ${roll}`, () => {
      // The ceiling the quantity column has, for the same reason: a number wide
      // enough to push the Item column off the roll is a number to clip the
      // gutter for, not to sacrifice the dish name to.
      const profile = kotProfile(cols * DOTS_PER_COL, size);
      const rows: KotRow[] = [{
        k: "cols",
        cells: [
          { text: "12345678901234567890", at: "num", bold: false },
          { text: "Roti", at: "name", bold: true },
          { text: "1", at: "qty", bold: false },
        ],
      }];
      const p = planKotRaster(rows, KOT_ATLAS, profile.ppem, profile.widthDots);
      expect(p.geometry.nameX).toBeLessThanOrEqual(Math.floor(p.widthDots / 3));
      expect(draws(p).filter((d) => d.x0 < 0 || d.x1 > p.widthDots)).toEqual([]);
    });
  }
});

describe("the banner is the largest face on the paper", () => {
  for (const [label, opts, banner] of [
    ["a reprint", { ...docket, reprint: true }, "** REPRINT **"],
    ["a cancellation", { ...docket, cancelled: true }, "** CANCELLED **"],
  ] as [string, ReceiptOptions, string][]) {
    for (const [cols, size] of ROLLS.flatMap((c) => SIZES.map((s) => [c, s] as const))) {
      test(`${label}, ${rollName(cols)}, ${size}`, () => {
        const p = plan(opts, cols, size);
        const all = draws(p);
        const biggest = Math.max(...all.map((d) => d.face.ppem));
        expect(biggest).toBe(p.geometry.bannerPpem);
        expect(all.filter((d) => d.face.ppem === biggest).map((d) => d.text)).toEqual([banner]);
        // …and it is bold at every size.
        expect(all.filter((d) => d.face.ppem === biggest).map((d) => d.face.weight)).toEqual([700]);
        // and it is the FIRST thing off the roll
        expect(all[0]!.text).toBe(banner);
      });
    }
  }

  test("a banner is set larger than body type, not merely bolder — at every size", () => {
    for (const roll of [576, 384]) {
      for (const size of SIZES) {
        const p = kotProfile(roll, size);
        expect(p.bannerPpem).toBeGreaterThan(p.ppem);
        expect(KOT_ATLAS[`${p.bannerPpem}b`]!.top).toBeGreaterThan(KOT_ATLAS[`${p.ppem}b`]!.top);
      }
    }
  });

  test("a banner row that arrives un-bold is still set bold, never thrown on", () => {
    // The atlas carries banner sizes in bold only. A row asking for a regular
    // banner must not become a docket that fails to print.
    const profile = kotProfile(576);
    const rows: KotRow[] = [{ k: "line", align: "center", bold: false, size: "banner", text: "** REPRINT **" }];
    const p = planKotRaster(rows, KOT_ATLAS, profile.ppem, profile.widthDots);
    expect(draws(p).map((d) => [d.face.ppem, d.face.weight])).toEqual([[profile.bannerPpem, 700]]);
  });

  test("a banner too wide for the roll steps DOWN to body size instead of breaking in half", () => {
    // The reference wording fits at every size on both rolls — one run, banner
    // size, first on the paper…
    for (const [cols, size] of ROLLS.flatMap((c) => SIZES.map((s) => [c, s] as const))) {
      const p = plan({ ...docket, cancelled: true }, cols, size);
      const first = p.ops[0]!;
      expect(first.draws.map((d) => [d.text, d.face.ppem])).toEqual([["** CANCELLED **", p.geometry.bannerPpem]]);
    }
    // …and a banner that cannot fit at banner size is set at body size, still
    // bold, rather than wrapped into two ragged halves.
    const profile = kotProfile(384, "large");
    const text = "** CANCELLED - SEE MANAGER **";
    const rows: KotRow[] = [{ k: "line", align: "center", bold: true, size: "banner", text }];
    const p = planKotRaster(rows, KOT_ATLAS, profile.ppem, profile.widthDots);
    expect(kotTextWidth(KOT_ATLAS[`${profile.bannerPpem}b`]!, text)).toBeGreaterThan(384);
    expect(draws(p).map((d) => [d.face.ppem, d.face.weight])[0]).toEqual([profile.ppem, 700]);
  });

  test("an ordinary docket is set in body type, except its note", () => {
    for (const size of SIZES) {
      const p = plan(docket, 48, size);
      const notes = draws(p).filter((d) => d.text.startsWith("[Note]"));
      expect(notes.map((d) => kotFaceKey(d.face))).toEqual([`${p.geometry.notePpem}o`]);
      const rest = draws(p).filter((d) => !d.text.startsWith("[Note]"));
      expect(new Set(rest.map((d) => d.face.ppem))).toEqual(new Set([p.geometry.ppem]));
    }
  });
});

/**
 * THE TYPE IS THE PHOTOGRAPH'S — measured, not eyeballed.
 *
 * Client, item 5: "The font style should be similar to the reference photos
 * ... the font looks elongated and stretched vertically ... reduce the font
 * size as well." These are the numbers the investigation took off their photo
 * (ink widths in photo pixels, 2.19 px per printer dot, the paper's own scale
 * measured from its 48-hyphen rules), and the standard 80mm docket has to land
 * on them: same width line for line, same capital and x-height, same pitch.
 */
describe("the standard docket's type measures like the client's photograph", () => {
  const PX_PER_DOT = 2.19;
  const PHOTO: [string, boolean, number][] = [
    ["KOT", true, 112], ["Dine In: DOME SECTION", true, 699], ["Table No: 33", true, 363],
    ["Ghewar Berry Mousse", true, 661], ["Gaia Rose Cookies", true, 553],
    ["Running Table", false, 349], ["08/09/26 14:13", false, 408], ["KOT - 21", false, 221],
    ["Persons - 4", false, 286], ["No.Item", false, 216], ["Qty", false, 85],
  ];
  const profile = kotProfile(576, "standard");
  const ratios = PHOTO.map(([text, bold, px]) => {
    const p = planKotRaster([{ k: "line", align: "left", bold, size: "body", text }], KOT_ATLAS, profile.ppem, 576);
    const d = p.ops[0]!.draws[0]!;
    return px / PX_PER_DOT / (d.x1 - d.x0);
  });
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const cv = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length) / mean;

  test("every measured line is the photo's width — on average within 2%", () => {
    // 0.995 today. At 28 dots per em (2.0.1's number) this face prints ~4% wide.
    expect(Math.abs(mean - 1)).toBeLessThan(0.02);
  });

  test("and the widths agree with each other — the face has the photo's proportions", () => {
    // 3.8% today; Liberation Sans, the 2.0.1 face, spreads 5.5% on the same lines.
    expect(cv).toBeLessThan(0.045);
  });

  test("capitals, lowercase and line pitch are the photo's 20 / 15 / 33 dots", () => {
    expect(KOT_ATLAS[`${profile.ppem}b`]!.g[72]!.h).toBe(20);     // "H" — photo 19.6
    expect(KOT_ATLAS[`${profile.ppem}r`]!.g[120]!.h).toBe(15);    // "x" — photo 14.7
    const p = plan(docket, 48, "standard");
    expect(new Set(p.ops.map((op) => op.height))).toEqual(new Set([33]));
  });

  test("nothing is stretched: every glyph is drawn at its own proportions, one dot per dot", () => {
    // The 2.0.0 complaint was ESC ! double height. The raster is sent at GS v 0
    // mode 0 (see "the bytes"), and no face is taller than it is set: a capital
    // is 0.74em tall, as the outline says, at every size.
    for (const key of kotAtlasFaces().filter((k) => !k.endsWith("o"))) {
      const face = KOT_ATLAS[key]!;
      expect({ key, ratio: +(face.g[72]!.h / face.ppem).toFixed(1) }).toEqual({ key, ratio: 0.7 });
    }
  });
});

describe("a note is smaller and slanted; a hold is not", () => {
  const withBoth: ReceiptOptions = {
    ...docket,
    items: [{ name: "Gulab Jamun", quantity: 3, price: 0, held: true, note: "fire with dessert" }],
  };
  for (const [cols, size] of ROLLS.flatMap((c) => SIZES.map((s) => [c, s] as const))) {
    test(`${rollName(cols)}, ${size}`, () => {
      const p = plan(withBoth, cols, size);
      const hold = draws(p).filter((d) => d.text === "[Hold]");
      const note = draws(p).filter((d) => d.text.startsWith("[Note]"));
      expect(hold.map((d) => kotFaceKey(d.face))).toEqual([`${p.geometry.ppem}r`]);
      expect(note.map((d) => kotFaceKey(d.face))).toEqual([`${p.geometry.notePpem}o`]);
      expect(note[0]!.face.slant).toBe(KOT_NOTE_SHEAR);
      expect(hold[0]!.face.slant).toBe(0);
      expect(p.geometry.notePpem).toBeLessThan(p.geometry.ppem);
      // Both hang on the name column, on the body pitch.
      expect([hold[0]!.x, note[0]!.x]).toEqual([p.geometry.nameX, p.geometry.nameX]);
    });
  }

  test("a long note wraps short of the column by its own lean, and reads back whole", () => {
    const long = "no onion no garlic, extra spicy, serve with the mains and keep the raita on the side please";
    // An unbroken run of a tall, narrow letter is hard-broken right up to the
    // column edge, which is where a lean that was not allowed for shows: "f"
    // ends 2 dots inside the column with the allowance and 3 outside without.
    for (const note of [long, "f".repeat(300), "l".repeat(300)]) {
      for (const [cols, size] of ROLLS.flatMap((c) => SIZES.map((s) => [c, s] as const))) {
        const p = plan({ ...docket, items: [{ name: "Roti", quantity: 1, price: 0, note }] }, cols, size);
        const lines = draws(p).filter((d) => d.face.slant > 0);
        expect(lines.length).toBeGreaterThan(1);
        const edge = p.geometry.nameX + p.geometry.nameMax;
        const over = lines.filter((d) => d.x1 > edge).map((d) => `${note.slice(0, 8)} ${rollName(cols)} ${size}: ink to ${d.x1}, column ends ${edge}`);
        expect(over).toEqual([]);
      }
    }
    const paper = kotPaper(buildReceiptBase64({ ...docket, items: [{ name: "Roti", quantity: 1, price: 0, note: long }] }, 48), 48);
    expect(paper.replace(/\n/g, " ")).toContain(`[Note] ${long}`);
  });
});

/**
 * THE RULES ARE THE PHOTOGRAPH'S: a line of hyphens, 48 across the 80mm roll.
 */
describe("a rule is a line of hyphens", () => {
  for (const cols of ROLLS) {
    for (const size of SIZES) {
      test(`one hyphen per column, on a full line — ${rollName(cols)}, ${size}`, () => {
        const p = plan(stress, cols, size);
        const rules = p.ops.filter((op) => op.kind === "rule");
        expect(rules.length).toBe(5);
        const textPitch = p.ops.find((op) => op.kind === "text" && op.draws[0]?.face.ppem === p.geometry.ppem)!.height;
        for (const op of rules) {
          expect(op.height).toBe(textPitch);
          expect(op.draws.map((d) => [d.text, d.cell, kotFaceKey(d.face)])).toEqual([
            [KOT_RULE_TEXT.repeat(cols), DOTS_PER_COL, `${p.geometry.ppem}r`],
          ]);
          expect(op.draws[0]!.x0).toBeGreaterThanOrEqual(0);
          expect(op.draws[0]!.x1).toBeLessThanOrEqual(p.widthDots);
        }
      });
    }
    test(`the paper shows ${cols} separate, equal dashes on every rule — ${rollName(cols)}`, () => {
      const b = bytes(buildReceiptBase64(docket, cols));
      const p = plan(docket, cols);
      const stride = (p.widthDots + 7) >> 3;
      // Stack the GS v 0 blocks back into one page.
      const rows: Buffer[] = [];
      for (let i = 2; b[i] === 0x1d && b[i + 1] === 0x76;) {
        const h = (b[i + 6] ?? 0) | ((b[i + 7] ?? 0) << 8);
        for (let r = 0; r < h; r++) { rows.push(b.subarray(i + 8 + r * stride, i + 8 + (r + 1) * stride)); }
        i += 8 + stride * h;
      }
      let y = 0;
      let checked = 0;
      for (const op of p.ops) {
        if (op.kind === "rule") {
          const inked = rows.slice(y, y + op.height).filter((r) => r.some((v) => v !== 0));
          // A hyphen is a short, flat stroke — two or three dots, never a band.
          expect(inked.length).toBeGreaterThanOrEqual(1);
          expect(inked.length).toBeLessThanOrEqual(3);
          for (const row of inked) {
            const runs: number[] = [];
            let run = 0;
            for (let x = 0; x < p.widthDots; x++) {
              if ((row[x >> 3] ?? 0) & (0x80 >> (x & 7))) { run += 1; } else if (run) { runs.push(run); run = 0; }
            }
            if (run) { runs.push(run); }
            expect(runs.length).toBe(cols);
            expect(new Set(runs).size).toBe(1);
          }
          checked += 1;
        }
        y += op.height;
      }
      expect(checked).toBe(4);
    });
  }
});

describe("wrapping is measured in dots, because the type is proportional", () => {
  // The standard 80mm dish-name face — the one a docket wraps most often in.
  const face = KOT_ATLAS["27b"]!;

  test("a word that fits stays on its line; one that does not moves down whole", () => {
    const lines = kotWrap(face, "Ghewar Berry Mousse", 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) { expect(kotTextWidth(face, l)).toBeLessThanOrEqual(200); }
    expect(lines.join(" ")).toBe("Ghewar Berry Mousse");
  });

  test("a single token wider than the column is HARD broken rather than allowed to run off", () => {
    const lines = kotWrap(face, "Supercalifragilisticexpialidocious", 120);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) { expect(kotTextWidth(face, l)).toBeLessThanOrEqual(120); }
    expect(lines.join("")).toBe("Supercalifragilisticexpialidocious");
  });

  test("character count is NOT the measure — 'lllllllll' and 'WWWWWWWWW' wrap differently", () => {
    expect(kotWrap(face, "lllllllll", 100).length).not.toBe(kotWrap(face, "WWWWWWWWW", 100).length);
  });

  test("empty text is one empty line, never zero lines", () => {
    expect(kotWrap(face, "", 200)).toEqual([""]);
  });
});

describe("a next-party table's name is one word on the docket", () => {
  // "12 #2" has a space in it. Broken there, the table-move slip read
  // "... WAS 105" then "#2 ***" — the first line naming the ROOT's docket, the
  // one the pass must NOT pull — and a 58mm "Table No:" line lost its "#2".
  const face = KOT_ATLAS["27b"]!;

  test("'#<n>' is measured and moved with the word before it", () => {
    expect(kotWrapUnits("*** TABLE CHANGED - WAS 105 #2 ***")).toEqual(["***", "TABLE", "CHANGED", "-", "WAS", "105 #2", "***"]);
    expect(kotWrapUnits("Table No: Patio 4 #13")).toEqual(["Table", "No:", "Patio", "4 #13"]);
    // Only a whole "#<digits>" token, and never onto nothing.
    expect(kotWrapUnits("#2 first")).toEqual(["#2", "first"]);
    expect(kotWrapUnits("12 #x 12 #")).toEqual(["12", "#x", "12", "#"]);
    expect(kotWrapUnits("  a \t b  ")).toEqual(["a", "b"]);
  });

  test("where the root fits and '<root> #<n>' does not, the whole name moves down", () => {
    const head = "*** TABLE CHANGED - WAS 105";
    const width = kotTextWidth(face, head) + 2;
    expect(kotTextWidth(face, `${head} #2`)).toBeGreaterThan(width);
    const lines = kotWrap(face, `${head} #2 ***`, width);
    expect(lines[0]).toBe("*** TABLE CHANGED - WAS");
    expect(lines[1]!.startsWith("105 #2")).toBe(true);
    for (const l of lines) { expect(kotTextWidth(face, l)).toBeLessThanOrEqual(width); }
  });

  test("a name wider than the whole column still breaks rather than running off the roll", () => {
    const lines = kotWrap(face, "SmokeTableA305017 #2", 120);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) { expect(kotTextWidth(face, l)).toBeLessThanOrEqual(120); }
    expect(lines.join("")).toBe("SmokeTableA305017 #2");
  });

  // The root's LAST word and the party number, which must share a line.
  const tail = (name: string) => name.toUpperCase().split(" ").slice(-2).join(" ");
  for (const cols of ROLLS) {
    for (const size of SIZES) {
      test(`the table-move slip keeps the old seat's name whole — ${rollName(cols)}, ${size}`, () => {
        for (const prev of ["105 #2", "Chaturya #2", "12 #2", "T1 #3", "Terrace Garden 12 #2"]) {
          const opts: ReceiptOptions = {
            ...docket, table: "15", kotTextSize: size,
            // kot_move.ts's context line, verbatim in shape.
            orderContext: `*** TABLE CHANGED - WAS ${prev.toUpperCase()} ***`,
          };
          const lines = kotPaper(buildReceiptBase64(opts, cols), cols, size).split("\n");
          const top = lines.slice(0, lines.indexOf("KOT"));
          expect({ prev, top, whole: top.some((l) => l.includes(tail(prev))) }).toMatchObject({ whole: true });
          expect({ prev, top, orphan: top.some((l) => /^#\d/.test(l)) }).toMatchObject({ orphan: false });
        }
      });

      test(`'Table No:' never loses the party number — ${rollName(cols)}, ${size}`, () => {
        for (const table of ["12 #2", "Patio 4 #13", "SmokeTableA305017 #2"]) {
          const lines = kotPaper(buildReceiptBase64({ ...docket, table, kotTextSize: size }, cols), cols, size).split("\n");
          const at = lines.findIndex((l) => l.startsWith("Table No:"));
          expect(at).toBeGreaterThan(-1);
          const said = [lines[at]!, lines[at + 1] ?? ""].join("\n");
          const unit = table.split(" ").slice(-2).join(" ");
          expect({ table, said, whole: said.split("\n").some((l) => l.includes(unit)) }).toMatchObject({ whole: true });
          expect({ table, said, orphan: /\n#\d/.test(said) }).toMatchObject({ orphan: false });
        }
      });
    }
  }
});

describe("the bytes", () => {
  const raster = (opts: ReceiptOptions, cols: number) => bytes(buildReceiptBase64(opts, cols));

  test("a docket opens with ESC @ and ends with three feeds and a full cut", () => {
    const b = raster(docket, 48);
    expect(b.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(b.subarray(b.length - 6)).toEqual(Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]));
  });

  for (const [name, opts] of [
    ...variants,
    ["the reference docket at small", { ...docket, kotTextSize: "small" }],
    ["the reference docket at large", { ...docket, kotTextSize: "large" }],
    ["a long name with a hold and a note at large", { ...stress, kotTextSize: "large" }],
  ] as [string, ReceiptOptions][]) {
    for (const cols of ROLLS) {
      test(`${name} is one run of GS v 0 blocks, none taller than the logo cap — ${rollName(cols)}`, () => {
        const b = raster(opts, cols);
        const p = plan(opts, cols);
        const stride = (p.widthDots + 7) >> 3;
        let i = 2;             // past ESC @
        let rows = 0;
        const heights: number[] = [];
        while (b[i] === 0x1d && b[i + 1] === 0x76 && b[i + 2] === 0x30) {
          expect(b[i + 3]).toBe(0x00);                                  // mode 0, normal
          expect((b[i + 4] ?? 0) | ((b[i + 5] ?? 0) << 8)).toBe(stride);
          const h = (b[i + 6] ?? 0) | ((b[i + 7] ?? 0) << 8);
          heights.push(h);
          rows += h;
          i += 8 + stride * h;
        }
        expect(heights.length).toBeGreaterThan(0);
        expect(Math.max(...heights)).toBeLessThanOrEqual(KOT_RASTER_CHUNK_ROWS);
        // Only the LAST block may be short: a gap between blocks is a gap on the paper.
        for (const h of heights.slice(0, -1)) { expect(h).toBe(KOT_RASTER_CHUNK_ROWS); }
        expect(rows).toBe(p.heightDots);
        expect(b.subarray(i)).toEqual(Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]));
      });
    }
  }

  test("the chunk cap is the one the bill logo has always used", () => {
    expect(KOT_RASTER_CHUNK_ROWS).toBe(BILL_LOGO_MAX_HEIGHT);
  });

  test("a docket is deterministic — render it twice, same sha256", () => {
    for (const [, opts] of variants) {
      for (const cols of ROLLS) {
        for (const size of SIZES) {
          const at = { ...opts, kotTextSize: size };
          expect(sha(raster(at, cols))).toBe(sha(raster(at, cols)));
        }
      }
    }
  });

  test("the encoder is a function of its rows, not of the clock or the machine", () => {
    const profile = kotProfile(576);
    const rows = layoutKot(docket, profile);
    const a = encodeKotRaster(rows, KOT_ATLAS, profile.ppem, profile.widthDots);
    const b = encodeKotRaster(rows, KOT_ATLAS, profile.ppem, profile.widthDots);
    expect(sha(a)).toBe(sha(b));
  });

  test("a docket is well under the print-job payload cap", () => {
    for (const [, opts] of variants) {
      for (const size of SIZES) {
        expect(buildReceiptBase64({ ...opts, kotTextSize: size }, 48).length).toBeLessThan(200_000);
      }
    }
  });

  /**
   * WHAT THE BIGGER TYPE COSTS, WRITTEN DOWN RATHER THAN LEFT TO BE DISCOVERED.
   *
   * A bitmap docket is ~3.3KB of base64 per printed line on the 80mm roll at
   * the standard size (~2.8KB small, ~4.0KB large); the text docket is ~40
   * bytes. print_jobs.ts caps a PERSISTED payload at
   * PRINT_JOB_MAX_B64_CHARS (2,000,000 by default, an env int). Over the cap a
   * job is still emitted live — it prints — but it is not stored, so it cannot
   * be replayed to a till that was offline when it was fired.
   *
   * These numbers are measured, not guessed, and the point of pinning them is
   * that a change which doubles a docket's height shows up HERE, as an obvious
   * arithmetic failure, rather than six months later as a banquet ticket that
   * did not survive a reconnect.
   */
  test("the payload cost per line is known, and so is where it crosses the cap", () => {
    const CAP = 2_000_000; // print_jobs.ts PRINT_JOB_MAX_B64_CHARS default
    const lines = (n: number, name: (i: number) => string, note?: string) =>
      Array.from({ length: n }, (_, i) => ({ name: name(i), quantity: 1, price: 0, ...(note ? { note } : {}) }));
    const size = (items: ReceiptOptions["items"], kotTextSize: KotTextSize = "standard") =>
      buildReceiptBase64({ ...docket, kotTextSize, items }, 48).length;

    // A dish per line, no wrap: an ordinary ticket, however long the order —
    // even at the largest size.
    for (const s of SIZES) {
      expect(size(lines(50, (i) => `Roti ${i}`), s)).toBeLessThan(CAP / 4);
      expect(size(lines(150, (i) => `Roti ${i}`), s)).toBeLessThan(CAP / 2);
    }
    // The worst case that can actually be ordered: every line a name that wraps
    // twice AND a note that wraps. This is the shape that crosses the cap ON ONE
    // STATION'S DOCKET — somewhere between 100 and 150 lines at the standard
    // size, and between 50 and 100 at 'large', the heaviest setting.
    const worst = (n: number, s: KotTextSize) => size(lines(n, (i) => `Chargrilled Tandoori Broccoli Malai with Burnt Garlic and Extra Cheese ${i}`, "no onion, extra spicy, serve last with the mains"), s);
    expect(worst(25, "large")).toBeLessThan(CAP);
    expect(worst(50, "large")).toBeLessThan(CAP);
    expect(worst(100, "large")).toBeGreaterThan(CAP);
    expect(worst(100, "standard")).toBeLessThan(CAP);
    expect(worst(150, "standard")).toBeGreaterThan(CAP);
  });
});

describe("the printed docket really carries the words", () => {
  const REFERENCE_PAPER = [
    "Running Table",
    "KOT",
    "08/09/26 14:13",
    "KOT - 21",
    "Dine In: DOME SECTION",
    "Table No: 33",
    "Persons - 4",
    "<RULE>",
    "Assign to: yado",
    "Captain: TIYASHA",
    "<RULE>",
    "No.Item Qty",
    "1 Subz Tehri 1",
    "2 Ghewar Berry Mousse 1",
    "3 Gaia Rose Cookies 1",
    "[Note] Hold Dessert",
    "<RULE>",
    "Total Qty 3",
    "<RULE>",
  ];

  test("the reference docket reads back, line for line, at every size that fits it unwrapped", () => {
    // Every size on 80mm, and small/standard on 58mm (large on 58mm wraps
    // "Ghewar Berry Mousse", which is the next test's business).
    for (const [cols, size] of [[48, "small"], [48, "standard"], [48, "large"], [32, "small"], [32, "standard"]] as [number, KotTextSize][]) {
      const lines = readKotRaster(buildReceiptBase64({ ...docket, kotTextSize: size }, cols), cols * 12, rollPpems(cols, size));
      expect({ cols, size, paper: lines.map((l) => l.text) }).toEqual({ cols, size, paper: REFERENCE_PAPER });
      expect(lines.filter((l) => l.leftover !== 0)).toEqual([]);
    }
  });

  test("a held dish reads back as the marker alone, under its name", () => {
    const b64 = buildReceiptBase64({ ...stress, kotTextSize: "standard" }, 48);
    const paper = readKotRaster(b64, 576, rollPpems(48)).map((l) => l.text);
    const dish = paper.indexOf("2 Ghewar Berry Mousse 2");
    expect(dish).toBeGreaterThan(-1);
    expect(paper[dish + 1]).toBe("[Hold]");
    expect(paper.join("\n")).not.toMatch(/do not cook/i);
    expect(paper).toContain("Hold Qty 2");
  });

  test("the reference docket reads back, line for line, off its own bitmap", () => {
    const lines = readKotRaster(buildReceiptBase64(docket, 48), 576, rollPpems(48));
    expect(lines.map((l) => l.text)).toEqual([
      "Running Table",
      "KOT",
      "08/09/26 14:13",
      "KOT - 21",
      "Dine In: DOME SECTION",
      "Table No: 33",
      "Persons - 4",
      "<RULE>",
      "Assign to: yado",
      "Captain: TIYASHA",
      "<RULE>",
      "No.Item Qty",
      "1 Subz Tehri 1",
      "2 Ghewar Berry Mousse 1",
      "3 Gaia Rose Cookies 1",
      "[Note] Hold Dessert",
      "<RULE>",
      "Total Qty 3",
      "<RULE>",
    ]);
    // Every ink dot was accounted for by a glyph: nothing was drawn that the
    // atlas cannot explain, and nothing was smeared over anything else.
    expect(lines.filter((l) => l.leftover !== 0)).toEqual([]);
  });

  test("a rupee sign and an accented letter print as readable ASCII", () => {
    const b64 = buildReceiptBase64({ ...docket, items: [{ name: "Café ₹250 Thé", quantity: 1, price: 0 }] }, 48);
    expect(kotPaper(b64, 48)).toContain("Cafe Rs250 The");
  });

  test("a character with no ASCII at all prints a VISIBLE '?', not a silent gap", () => {
    const b64 = buildReceiptBase64({ ...docket, items: [{ name: "पनीर Tikka", quantity: 1, price: 0 }] }, 48);
    const paper = kotPaper(b64, 48);
    expect(paper).toMatch(/\?+ Tikka/);
    // …and the question marks are ink, not absence: the row is wider than the
    // word that survived.
    const p = plan({ ...docket, items: [{ name: "पनीर Tikka", quantity: 1, price: 0 }] }, 48);
    const name = draws(p).find((d) => d.text.includes("Tikka"))!;
    expect(name.x1 - name.x0).toBeGreaterThan(kotTextWidth(name.face, "Tikka"));
  });

  test("the 58mm docket at 'large' reads back too, with the long name wrapped under itself", () => {
    const paper = kotPaper(buildReceiptBase64({ ...docket, kotTextSize: "large" }, 32), 32, "large");
    expect(paper).toContain("Table No: 33");
    expect(paper).toContain("2 Ghewar Berry 1\nMousse\n3 Gaia Rose Cookies 1");
    expect(paper).toContain("Total Qty 3");
  });
});

describe("which docket a restaurant gets", () => {
  test("unset, null and an unknown value all mean the reference docket", () => {
    for (const style of [undefined, null, "", "  ", "reference", "REFERENCE", "something-else"]) {
      expect(kotPrintStyleOf(style)).toBe("reference");
    }
    expect(kotPrintStyleOf("classic")).toBe("classic");
    expect(kotPrintStyleOf(" Classic ")).toBe("classic");
  });

  test("the DEFAULT docket is the raster one — no setting needed", () => {
    const b = bytes(buildReceiptBase64(docket, 48));
    expect(b.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(true);
    expect(b.toString("latin1")).not.toContain("Table No: 33");
  });

  test("'classic' prints the text docket, and nothing raster", () => {
    const b = bytes(buildReceiptBase64({ ...docket, kotPrintStyle: "classic" }, 48));
    expect(b.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(false);
    expect(b.toString("latin1")).toContain("Table No: 33");
  });

  test("a BILL ignores the setting completely — it is not this document", () => {
    const bill: ReceiptOptions = { ...docket, kind: "bill", items: [{ name: "Tea", quantity: 1, price: 50 }], total: 50 };
    expect(buildReceiptBase64({ ...bill, kotPrintStyle: "classic" }, 48)).toBe(buildReceiptBase64(bill, 48));
    expect(buildReceiptBase64({ ...bill, kotPrintStyle: "reference" }, 48)).toBe(buildReceiptBase64(bill, 48));
  });

  test("every station's ticket of a split obeys the same setting", () => {
    const split: ReceiptOptions = {
      ...docket,
      items: [
        { name: "Subz Tehri", quantity: 1, price: 0, station: "Tandoor" },
        { name: "Virgin Mojito", quantity: 2, price: 0, station: "BAR" },
      ],
    };
    const reference = buildKotBase64(split, 48);
    expect(reference.map((t) => t.station)).toEqual(["Tandoor", "BAR"]);
    for (const t of reference) { expect(bytes(t.escBase64).includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(true); }
    for (const t of buildKotBase64({ ...split, kotPrintStyle: "classic" }, 48)) {
      expect(bytes(t.escBase64).includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(false);
    }
  });

  test("a split's implicit General bucket names no station on the paper", () => {
    const tickets = buildKotBase64(docket, 48);
    expect(tickets.map((t) => t.station)).toEqual(["General"]);
    expect(kotPaper(tickets[0]!.escBase64, 48)).not.toContain("GENERAL");
  });
});

/**
 * THE FONT MUST NOT BE REACHABLE FROM THE RUNNING SERVER.
 *
 * The whole argument for a committed glyph table — deterministic bytes, no font
 * in the image, nothing parsed on the hot path — is only true while no runtime
 * module imports the parser or opens a .ttf. That is a property of the source
 * tree, so it is asserted by reading the source tree.
 */
describe("the TrueType half is dev-time only", () => {
  const skip = new Set(["node_modules", "build", "dist", ".git", "scripts", "jest-tests", "test", "Python_servers", "C_Sharp_temp_printer_server", "deploy"]);
  const runtimeFiles: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) { continue; }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); }
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) { runtimeFiles.push(full); }
    }
  })(REPO);

  test("the walk actually found the renderer, so an empty list cannot pass this suite", () => {
    expect(runtimeFiles.length).toBeGreaterThan(20);
    expect(runtimeFiles.some((f) => f.endsWith("escpos.ts"))).toBe(true);
  });

  test("no runtime module imports the font parser or the atlas builder", () => {
    // An IMPORT, not a mention: this file and the generated table both explain
    // where they came from in prose, and prose is not a dependency.
    const imports = /(?:from|require\()\s*["'][^"']*(?:kot_ttf|kot_atlas_build|build_kot_glyph_atlas)/;
    const offenders = runtimeFiles.filter((f) => imports.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("no runtime module names a font file", () => {
    const fontPath = /["'][^"']*(?:\.ttf|kot_fonts)/;
    const offenders = runtimeFiles.filter((f) => fontPath.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the glyph table is imported by the renderer and by nothing else", () => {
    const importers = runtimeFiles.filter((f) => /from\s+["'][^"']*kot_glyph_atlas/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.slice(REPO.length + 1).replace(/\\/g, "/"))).toEqual(["escpos.ts"]);
  });

  test("the fonts are kept out of the Docker image", () => {
    expect(readFileSync(join(REPO, ".dockerignore"), "utf8")).toContain("scripts/kot_fonts");
  });
});

/**
 * THE DOCKET'S BYTES, PINNED.
 *
 * Re-pin these DELIBERATELY, and only with a rendered picture in hand: this is
 * the document the kitchen cooks from, and a silent change to it is a silent
 * change to what comes out of the pass.
 *
 * Last re-pinned for 2.0.2's face (DejaVu Sans Condensed, the permissive face
 * closest to the photograph's Tahoma; was Liberation Sans), its sizes (standard
 * 27 dots per em on 80mm; was 28), the smaller slanted "[Note]", the 0.2em
 * leading and the 48-hyphen rules on a full line — with the before/after
 * renders compared side by side against the client's photo. Before that: the
 * text-size setting (was 40) and the hold line saying only "[Hold]". Every
 * variant is the STANDARD size — what a restaurant that never opens the
 * setting prints — and the reference docket is pinned at all three.
 */
describe("the reference docket's committed bytes", () => {
  const SIZE_GOLDEN: Record<string, string> = {
    "small @48": "41072:d8ffcc0106b53bb21b66cbb7d6d8a555898a398d013adff93dfaa0a34a27041b",
    "standard @48": "45176:9dd48d3a74af71f0c34ec44dc37982f163d62642be3c3bd259ba85f09313574b",
    "large @48": "57496:722c4149aa1b4f977973ea249c419f1677b79b54f42a8514b137a171b2dc708e",
    "small @32": "23744:a79ad70b4ef52347eb76cc61287f1e12de8d8fbc9099179b6cad1da95ac7990c",
    "standard @32": "27392:81e38f677c1d80787eed1dde58ba0776f774e7591a65a8020b1086f3dc920554",
    "large @32": "31712:b6de143712e09c536c2d42d3e38a2b0cc89729167a00787522c1f516ac9c8ad3",
  };

  test("the reference docket at every size, both rolls", () => {
    const actual: Record<string, string> = {};
    for (const size of SIZES) {
      for (const cols of ROLLS) {
        const b = bytes(buildReceiptBase64({ ...docket, kotTextSize: size }, cols));
        actual[`${size} @${cols}`] = `${b.length}:${sha(b)}`;
      }
    }
    expect(actual).toEqual(SIZE_GOLDEN);
  });

  test("the unset size and 'standard' are the same bytes", () => {
    for (const cols of ROLLS) {
      expect(buildReceiptBase64(docket, cols)).toBe(buildReceiptBase64({ ...docket, kotTextSize: "standard" }, cols));
    }
  });

  const RASTER_GOLDEN: Record<string, string> = {
    "the reference docket @48": "45176:9dd48d3a74af71f0c34ec44dc37982f163d62642be3c3bd259ba85f09313574b",
    "the reference docket @32": "27392:81e38f677c1d80787eed1dde58ba0776f774e7591a65a8020b1086f3dc920554",
    "a long name with a hold and a note @48": "61816:7a170d4eabc88f66d0d27db3d79203bbf8340438c3fb1dd2c10962214a2d60ae",
    "a long name with a hold and a note @32": "41800:d871056022e5868627a79381c2a1d6e1a9563d6691a79e5c1cca07258e3e54dd",
    "a reprint @48": "65056:95f2e9f799c78938eb7f002a83f7b5f600b39cfc8b58285f148edb4b8f324f1d",
    "a reprint @32": "43672:562be581e04212dfb09bb8a38e82746f230a595c53b4580c0b8796d1b0334833",
    "a cancellation @48": "69816:d670d782dc74e5f75b6431c59a45e9bf03add8d9d6b6171af0dd9797c9fd17cb",
    "a cancellation @32": "48000:eb2f343257341372b14c55180553874979a371022695032871cb69b16911bba7",
    "a per-station docket @48": "47552:ce780e8017e54574f36c44b6df625581f22a6a5ead86cfcb9956388ddc6305c9",
    "a per-station docket @32": "28832:f7ce016417ce6081ac7e0421b3c58ae0a35508224eaf466f94622c36ffb7c357",
    "an empty ticket @48": "35672:00bd718209137908f44299e5aa3b79ccebd157908c7570ddd8c072c1ea0d37cc",
    "an empty ticket @32": "21624:bacf92698f3ab6b184a421a497ae0562e0ffc853b496687c83bd7620084eaa9e",
    "an unnumbered, unassigned ticket @48": "35672:971192e956d2bf1a6af568668a687156e5c8ad7e104004e099ad1f2583f327b3",
    "an unnumbered, unassigned ticket @32": "21624:754b860b9613001eba9b9a7127c6c175ccd956bb828fa3ac59c34e2d2a143be5",
    "an unbroken 60-character token @48": "40424:51ca1276535f39a2d90aa123041c4f8635b07e229d17836cf1d3e5dcd760b0d1",
    "an unbroken 60-character token @32": "25952:a51398a5936f1778de88efb2792f458a3f11276bd51df7f3e62db0fb41794004",
    "a four-digit quantity @48": "38048:9ab0dcbd197beadb43d200e00bd1099ea5e70987eeb52898168e8fc359559170",
    "a four-digit quantity @32": "23064:572419a0d6d8f6335c1dd6d21e17e2f067a37658a66e2de961efc52b8d1391f2",
    "a name folded from non-ASCII @48": "38048:fac1690051cdf98046c86251612e39ee1d1496054843889c7c852a2681608419",
    "a name folded from non-ASCII @32": "23064:4a46236f6e64825103e6922e7c2ba466f5bdcc995a4c3cd06ffc8594dfb976fa",
  };

  test("every variant, both rolls", () => {
    const actual: Record<string, string> = {};
    for (const [name, opts] of variants) {
      for (const cols of [48, 32]) {
        const b = bytes(buildReceiptBase64(opts, cols));
        actual[`${name} @${cols}`] = `${b.length}:${sha(b)}`;
      }
    }
    expect(actual).toEqual(RASTER_GOLDEN);
  });
});
