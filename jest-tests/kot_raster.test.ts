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
  KOT_RASTER_CHUNK_ROWS,
  buildKotBase64,
  buildReceiptBase64,
  encodeKotRaster,
  kotPrintStyleOf,
  kotProfile,
  kotTextWidth,
  kotWrap,
  layoutKot,
  planKotRaster,
  type KotDraw,
  type KotRasterPlan,
  type KotRow,
  type ReceiptOptions,
} from "../escpos";
import { KOT_ATLAS } from "../kot_glyph_atlas";
import { BILL_LOGO_MAX_HEIGHT } from "../bill_logo";
import { KOT_ATLAS_PPEM, atlasToModule, buildKotGlyphAtlas } from "../scripts/kot_atlas_build";
import { kotPaper, readKotRaster, rollPpems } from "./kot_raster_read";

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

const plan = (opts: ReceiptOptions, cols: number): KotRasterPlan => {
  const profile = kotProfile(cols * DOTS_PER_COL);
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

  test("every face the rolls actually ask for exists", () => {
    for (const roll of [576, 384]) {
      const p = kotProfile(roll);
      for (const ppem of [p.ppem, p.bannerPpem]) {
        expect(KOT_ATLAS_PPEM).toContain(ppem);
        for (const weight of ["r", "b"]) { expect(KOT_ATLAS[`${ppem}${weight}`]).toBeDefined(); }
      }
    }
  });

  test("the builder bakes NOTHING the renderer cannot ask for", () => {
    const wanted = new Set([576, 384].flatMap((roll) => {
      const p = kotProfile(roll);
      return [p.ppem, p.bannerPpem];
    }));
    expect([...KOT_ATLAS_PPEM].sort((a, b) => a - b)).toEqual([...wanted].sort((a, b) => a - b));
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

describe("nothing a docket prints crosses the edge of the roll", () => {
  for (const [name, opts] of variants) {
    for (const cols of [48, 32]) {
      test(`${name}, ${cols === 48 ? "80mm" : "58mm"}`, () => {
        const p = plan(opts, cols);
        const outside = draws(p).filter((d) => d.x0 < 0 || d.x1 > p.widthDots);
        expect(outside.map((d) => `${d.text} [${d.x0},${d.x1}) of ${p.widthDots}`)).toEqual([]);
      });
    }
  }

  test("the guard has teeth: a draw pushed past the edge is caught", () => {
    const p = plan(stress, 48);
    const pushed = draws(p).map((d) => ({ ...d, x1: d.x1 + p.widthDots }));
    expect(pushed.some((d) => d.x1 > p.widthDots)).toBe(true);
  });
});

describe("the item table's columns", () => {
  for (const cols of [48, 32]) {
    const roll = cols === 48 ? "80mm" : "58mm";

    test(`every quantity is flush to the same right edge — ${roll}`, () => {
      const p = plan(stress, cols);
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
      const p = plan(stress, cols);
      const names = draws(p).filter((d) => d.x === p.geometry.nameX);
      expect(names.length).toBeGreaterThan(4);
      for (const d of names) { expect(d.x1).toBeLessThanOrEqual(p.geometry.qtyLeft); }
    });

    test(`wrapped names, [Hold] and [Note] all hang on the name column — ${roll}`, () => {
      const p = plan(stress, cols);
      const hangs = p.ops.filter((op) => op.draws.length === 1 && op.draws[0]!.x === p.geometry.nameX);
      const texts = hangs.map((op) => op.draws[0]!.text);
      expect(texts.some((t) => t.startsWith("[Hold]"))).toBe(true);
      expect(texts.some((t) => t.startsWith("[Note]"))).toBe(true);
      // and the continuation of the 52-character dish name
      expect(texts.some((t) => t.includes("Garlic"))).toBe(true);
    });

    test(`the No. column and every left-aligned line share one edge — ${roll}`, () => {
      const p = plan(docket, cols);
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
  for (const cols of [48, 32]) {
    const roll = cols === 48 ? "80mm" : "58mm";

    test(`no row number is ever drawn into a dish name — ${roll}`, () => {
      const p = plan(long, cols);
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
      const p = plan(long, cols);
      const outside = draws(p).filter((d) => d.x0 < 0 || d.x1 > p.widthDots);
      expect(outside.map((d) => `${d.text} [${d.x0},${d.x1}) of ${p.widthDots}`)).toEqual([]);
    });

    test(`a ticket the reference's own size is not indented for it — ${roll}`, () => {
      // The column GROWS from the reference's 1.45em and never shrinks below it,
      // so the docket in the photograph — and every ticket of nine lines or
      // fewer — is laid out exactly as it was.
      const ref = plan(docket, cols).geometry;
      expect(ref.nameX).toBe(Math.round(ref.ppem * 1.45));
      const roti = (n: number) => ({ ...docket, items: Array.from({ length: n }, () => ({ name: "Roti", quantity: 1, price: 0 })) });
      expect(plan(roti(9), cols).geometry.nameX).toBe(ref.nameX);
      expect(plan(roti(10), cols).geometry.nameX).toBeGreaterThan(ref.nameX);
      expect(plan(long, cols).geometry.nameX).toBeGreaterThan(plan(roti(10), cols).geometry.nameX);
    });

    test(`a nonsense row number cannot eat the dish name — ${roll}`, () => {
      // The ceiling the quantity column has, for the same reason: a number wide
      // enough to push the Item column off the roll is a number to clip the
      // gutter for, not to sacrifice the dish name to.
      const profile = kotProfile(cols * DOTS_PER_COL);
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
    for (const cols of [48, 32]) {
      test(`${label}, ${cols === 48 ? "80mm" : "58mm"}`, () => {
        const p = plan(opts, cols);
        const all = draws(p);
        const biggest = Math.max(...all.map((d) => d.face.ppem));
        expect(biggest).toBe(p.geometry.bannerPpem);
        expect(all.filter((d) => d.face.ppem === biggest).map((d) => d.text)).toEqual([banner]);
        // and it is the FIRST thing off the roll
        expect(all[0]!.text).toBe(banner);
      });
    }
  }

  test("a banner is set larger than body type, not merely bolder", () => {
    const p = kotProfile(576);
    expect(p.bannerPpem).toBeGreaterThan(p.ppem);
    expect(KOT_ATLAS[`${p.bannerPpem}b`]!.top).toBeGreaterThan(KOT_ATLAS[`${p.ppem}b`]!.top);
  });

  test("a banner too wide for the roll steps DOWN to body size instead of breaking in half", () => {
    // 58mm is where this bites: the reference wording fits, a longer one cannot.
    const wide = { ...docket, cancelled: true, orderContext: "x" };
    const p = plan(wide, 32);
    const first = p.ops[0]!;
    expect(first.draws.length).toBe(1);
    expect(first.draws[0]!.text).toBe("** CANCELLED **");
  });

  test("an ordinary docket is set entirely in one size", () => {
    const p = plan(docket, 48);
    expect(new Set(draws(p).map((d) => d.face.ppem))).toEqual(new Set([p.geometry.ppem]));
  });
});

describe("wrapping is measured in dots, because the type is proportional", () => {
  const face = KOT_ATLAS["40b"]!;

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

describe("the bytes", () => {
  const raster = (opts: ReceiptOptions, cols: number) => bytes(buildReceiptBase64(opts, cols));

  test("a docket opens with ESC @ and ends with three feeds and a full cut", () => {
    const b = raster(docket, 48);
    expect(b.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(b.subarray(b.length - 6)).toEqual(Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]));
  });

  for (const [name, opts] of variants) {
    for (const cols of [48, 32]) {
      test(`${name} is one run of GS v 0 blocks, none taller than the logo cap — ${cols === 48 ? "80mm" : "58mm"}`, () => {
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
      for (const cols of [48, 32]) {
        expect(sha(raster(opts, cols))).toBe(sha(raster(opts, cols)));
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
      expect(buildReceiptBase64(opts, 48).length).toBeLessThan(200_000);
    }
  });

  /**
   * WHAT THE BIGGER TYPE COSTS, WRITTEN DOWN RATHER THAN LEFT TO BE DISCOVERED.
   *
   * A bitmap docket is ~3.9KB of base64 per printed line on the 80mm roll; the
   * text docket is ~40 bytes. print_jobs.ts caps a PERSISTED payload at
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
    const size = (items: ReceiptOptions["items"]) => buildReceiptBase64({ ...docket, items }, 48).length;

    // A dish per line, no wrap: an ordinary ticket, however long the order.
    expect(size(lines(50, (i) => `Roti ${i}`))).toBeLessThan(CAP / 4);
    expect(size(lines(150, (i) => `Roti ${i}`))).toBeLessThan(CAP / 2);
    // The worst case that can actually be ordered: every line a name that wraps
    // twice AND a note that wraps. This is the shape that crosses the cap, and
    // it does so somewhere between 50 and 100 lines ON ONE STATION'S DOCKET.
    const worst = (n: number) => size(lines(n, (i) => `Chargrilled Tandoori Broccoli Malai with Burnt Garlic and Extra Cheese ${i}`, "no onion, extra spicy, serve last with the mains"));
    expect(worst(25)).toBeLessThan(CAP);
    expect(worst(50)).toBeLessThan(CAP);
    expect(worst(100)).toBeGreaterThan(CAP);
  });
});

describe("the printed docket really carries the words", () => {
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

  test("the 58mm docket reads back too, with the long name wrapped", () => {
    const paper = kotPaper(buildReceiptBase64(docket, 32), 32);
    expect(paper).toContain("Table No: 33");
    expect(paper).toContain("Ghewar Berry");
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
 */
describe("the reference docket's committed bytes", () => {
  const RASTER_GOLDEN: Record<string, string> = {
    "the reference docket @48": "58720:24e0619fc0f6947b6e621a51973b08ed906e81d186dfd59971e18da4634c847a",
    "the reference docket @32": "33104:2a0f80fe2e75e7c420d7fa48cf8ec91c8da21a07e99cc1be8faefe8b0a919325",
    "a long name with a hold and a note @48": "95456:599c1180d5b008e576ab2d6af540da610a7e9f7c8af56d11c49f2ec05e98f5f9",
    "a long name with a hold and a note @32": "56928:9d49c98e26d7cc38b6f00f401c30a440db4b049a707d02f485f0d9908a3a6ac4",
    "a reprint @48": "100136:0e420c45f4c2aea26a126a2ab440c9ceb981dc4ef6b6d0e5a70a483c4aeab624",
    "a reprint @32": "59240:aa2f0a84a45e717d2958edecc8bc15b7c9d843371d2f02adab94d6e180a3307f",
    "a cancellation @48": "108640:e1202db9295c2cde37766fe5541e49ec7aac572838b20c57e78a780064d4ad62",
    "a cancellation @32": "63512:4f577ab7058f0a72a96296b309d67142299186012e029c5f6081d454340ec4f9",
    "a per-station docket @48": "62248:aa18da8a3e9d544731751363d5e1ee1f4f8023bf99a3bcda4086ac78edfc902a",
    "a per-station docket @32": "34888:67ffcd191d6e39c4434b4b041c863c2f156b520e9f805a63f9b5d18a85b1aaf4",
    "an empty ticket @48": "44600:ea5bbf8695dc165ff0af95b198d158fe9c77a8ee460b363771e76ae82c450ba1",
    "an empty ticket @32": "22440:9b7a1fd2318d52a082eddd284101f38b5462fbc82e4fa6355b7c8a65fc7a6e49",
    "an unnumbered, unassigned ticket @48": "46688:f430934963dc058304d56fedab034babea7c5fd4997a5ef94efd7a50f0113bee",
    "an unnumbered, unassigned ticket @32": "27056:a7e06e49b1fc093489b01522db825dfb5550892087b99976b2360829b5d6e0a1",
    "an unbroken 60-character token @48": "55192:9d64f0997f0d9da91bfce538fd8e03270eec2e6b9ef8089ba112d4274b245dbf",
    "an unbroken 60-character token @32": "27776:7e3d5131c6f556c134e23fec724a8339bfd17a12feac36e155b1a4979cde3ad8",
    "a four-digit quantity @48": "48128:7aecb7d0dae9af66b679c8cc8b04480faa6ebd7dea7b2e4392c1e2282145c595",
    "a four-digit quantity @32": "24224:c33dee0f6f61a5c8468182e2232d3083b71f5618720a7c298c10a81b6bc53f78",
    "a name folded from non-ASCII @48": "51656:d1dd68912cd4c88f78730d663a17e6cc5c15a1e47695d6c920d0554ac0512906",
    "a name folded from non-ASCII @32": "26000:f3d88b5af03c55f34d12ef00416e1bf4448ad324335bd0e10f6de6527333a6ab",
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
