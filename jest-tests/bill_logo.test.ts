// 5.1 — THE BILL LOGO IS ONE RASTER, SHOWN TWICE.
//
// "Ensure the restaurant's logo, address, and GSTIN number are clearly visible
// on both the print preview and the final printed customer bill."
//
// The roll has long carried a logo (the SVG bill logo, else the branding PNG),
// but the previews drew a different one — the web the PNG only, the app none.
// bill_logo.ts now builds the monochrome raster once and hands out the printer
// bytes AND a PNG of the same bits. These tests pin that the two agree, that the
// logo fits the roll it is for, and that the preview route serves that PNG.

import { describe, test, expect } from "@jest/globals";
import sharp from "sharp";
import { BILL_LOGO_DOTS, BILL_LOGO_MAX_HEIGHT, BILL_LOGO_WIDTH_SHARE, billLogoDots, rasterizeBillLogo } from "../bill_logo";

function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  for (const base of [process.cwd(), path.join(__dirname, "..")]) {
    const full = path.join(base, relative);
    if (fs.existsSync(full)) { return fs.readFileSync(full, "utf8"); }
  }
  throw new Error(`readSource could not find ${relative} from ${process.cwd()}`);
}

/** A wide "wordmark": black left half, white right half. */
async function wordmark(width = 1000, height = 250): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <rect width="${width / 2}" height="${height}" fill="#000000"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("the raster fits the roll it is printed on", () => {
  test("80mm: never wider than 576 dots or taller than the buffer cap", async () => {
    const r = await rasterizeBillLogo(await wordmark(), BILL_LOGO_DOTS["80mm"]);
    expect(r).not.toBeNull();
    expect(r!.width).toBeLessThanOrEqual(576);
    expect(r!.height).toBeLessThanOrEqual(BILL_LOGO_MAX_HEIGHT);
  });

  test("58mm: fitted to 384 dots", async () => {
    const r = await rasterizeBillLogo(await wordmark(), BILL_LOGO_DOTS["58mm"]);
    expect(r!.width).toBeLessThanOrEqual(384);
  });

  test("the paper width setting picks the dots; anything else is the 80mm roll", () => {
    expect(billLogoDots("58mm")).toBe(384);
    expect(billLogoDots("80mm")).toBe(576);
    expect(billLogoDots(undefined)).toBe(576);
  });

  test("the logo prints at no more than two thirds of the roll, as on the client's bill", async () => {
    const wide = await rasterizeBillLogo(await wordmark(), BILL_LOGO_DOTS["80mm"]);
    expect(wide!.width).toBeLessThanOrEqual(Math.round(576 * BILL_LOGO_WIDTH_SHARE));
    expect(wide!.width).toBeGreaterThan(576 / 2);
    const narrow = await rasterizeBillLogo(await wordmark(), BILL_LOGO_DOTS["58mm"]);
    expect(narrow!.width).toBeLessThanOrEqual(Math.round(384 * BILL_LOGO_WIDTH_SHARE));
  });

  test("a stored logo REFERENCE is not image bytes — a string is refused, never read as a file path", async () => {
    // The original bug: "Restaurant".logo holds "logos/Gaia_logo.png", and that
    // string reached sharp, which reads a string as a path on the API host.
    await expect(rasterizeBillLogo("logos/Gaia_logo.png" as unknown as Buffer, 576)).resolves.toBeNull();
  });

  test("a small logo is not blown up into a blurry one", async () => {
    const r = await rasterizeBillLogo(await wordmark(200, 50), 576);
    expect(r!.width).toBe(200);
    expect(r!.height).toBe(50);
  });
});

describe("the printer bytes and the preview PNG are the same pixels", () => {
  test("GS v 0 header carries the raster's own width (in bytes) and height", async () => {
    const r = (await rasterizeBillLogo(await wordmark(), 576))!;
    const esc = r.escpos;
    expect([...esc.subarray(0, 4)]).toEqual([0x1d, 0x76, 0x30, 0x00]);
    const widthBytes = esc[4] | (esc[5] << 8);
    const height = esc[6] | (esc[7] << 8);
    expect(widthBytes).toBe(Math.ceil(r.width / 8));
    expect(height).toBe(r.height);
    expect(esc.length).toBe(8 + widthBytes * height);
  });

  test("the PNG decodes to the raster's size, and ink sits where the printer puts it", async () => {
    const r = (await rasterizeBillLogo(await wordmark(), 576))!;
    const { data, info } = await sharp(r.png).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(r.width);
    expect(info.height).toBe(r.height);
    const midRow = Math.floor(r.height / 2);
    const px = (x: number) => data[(midRow * info.width + x) * info.channels];
    const bit = (x: number) => (r.escpos[8 + midRow * Math.ceil(r.width / 8) + (x >> 3)] >> (7 - (x & 7))) & 1;
    // Left quarter is ink on both; right quarter is paper on both.
    const left = Math.floor(r.width / 4);
    const right = Math.floor((3 * r.width) / 4);
    expect(px(left)).toBe(0);
    expect(bit(left)).toBe(1);
    expect(px(right)).toBe(255);
    expect(bit(right)).toBe(0);
  });

  test("a transparent background prints as paper, not as a black slab", async () => {
    const transparent = await sharp({
      create: { width: 300, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const r = (await rasterizeBillLogo(transparent, 576))!;
    const inked = r.escpos.subarray(8).some((b) => b !== 0);
    expect(inked).toBe(false);
  });

  test("bytes that are not an image cost the logo, never throw into the bill", async () => {
    await expect(rasterizeBillLogo(Buffer.from("not an image"), 576)).resolves.toBeNull();
    await expect(rasterizeBillLogo(Buffer.alloc(0), 576)).resolves.toBeNull();
  });
});

describe("the branding logo is resolved from its stored reference", () => {
  const db = readSource("database_supabase.ts");
  const at = db.indexOf("export async function GetRestaurantLogoRaw");
  const body = db.slice(at, db.indexOf("\n}", at));

  test("GetRestaurantLogoRaw downloads the referenced image instead of returning the column", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain("logoToBuffer(ref)");
    expect(body).not.toMatch(/return row\.logo;/);
  });

  test("the lookup has a deadline and a failure is remembered briefly", () => {
    expect(body).toMatch(/Promise\.race\(\[logoToBuffer\(ref\)/);
    expect(body).toContain("LOGO_MISS_TTL_MS");
    expect(body).toContain("LOGO_CACHE_MAX");
  });

  test("the logo fetch is bounded in time and in size on every path", () => {
    const f = db.indexOf("async function logoToBuffer");
    const fn = db.slice(f, db.indexOf("\n}", f));
    expect(fn).toContain("AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS)");
    expect(fn.match(/LOGO_MAX_BYTES/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("one source for the paper and the previews", () => {
  const shared = readSource("routes/_shared.ts");
  const settings = readSource("routes/settings.ts");

  test("the thermal logo is built from the shared raster", () => {
    const at = shared.indexOf("export async function buildLogoEscPos");
    const body = shared.slice(at, shared.indexOf("\n}", at));
    expect(body).toMatch(/buildBillLogoRaster\(restaurantId, targetWidth\)/);
    expect(body).not.toMatch(/sharp/);
  });

  test("GET /restaurant/logo/bill serves the PNG of that raster, at the tenant's roll width", () => {
    const at = settings.indexOf("app.get('/restaurant/logo/bill'");
    expect(at).toBeGreaterThan(-1);
    const body = settings.slice(at, settings.indexOf("\n});", at));
    expect(body).toMatch(/buildBillLogoRaster\(restaurantId, billLogoDots\(settings\?\.bill_paper_width\)\)/);
    expect(body).toMatch(/raster\.png\.toString\('base64'\)/);
    expect(body).toMatch(/status\(404\)/);
  });
});
