/**
 * THE BILL LOGO, RENDERED ONCE — for the paper AND for the previews of it.
 *
 * 5.1: "Ensure the restaurant's logo, address, and GSTIN number are clearly
 * visible on both the print preview and the final printed customer bill."
 *
 * WHY THIS FILE EXISTS. The thermal renderer has printed a logo for a long time:
 * the tenant's SVG bill logo when one is stored (settings.bill_logo_svg, set from
 * the owner app), the branding PNG otherwise, fitted to the roll and thresholded
 * to one bit. The previews did not show THAT logo. The web preview drew the PNG
 * only — so a tenant whose logo is the SVG saw "Loading Logo ..." on the preview
 * (and on the browser-printed slip) while the roll carried a logo — and the app's
 * preview drew no logo at all.
 *
 * So the raster is built here, once, and handed out in two encodings of the SAME
 * pixels: GS v 0 bytes for the printer, and a PNG of exactly those bits for a
 * preview. A preview that shows the colour original of a logo whose pale half
 * the threshold drops is a preview of a different document.
 *
 * Pure apart from sharp: no database, no request. The route layer
 * (routes/_shared.ts) resolves WHICH source bytes a tenant has and calls in.
 */

/** Printer dots across the printable width of each roll. */
export const BILL_LOGO_DOTS = { "58mm": 384, "80mm": 576 } as const;

/**
 * The tallest a logo may print. A GS v 0 image is one raster block, and a very
 * tall logo can overflow a cheap printer's image buffer — the same cap the
 * renderer has always applied.
 */
export const BILL_LOGO_MAX_HEIGHT = 240;

/**
 * The widest a logo prints, as a share of the roll.
 *
 * The client's own bill carries its wordmark at a little over half the paper,
 * with white either side — a logo fitted edge to edge reads as a banner and
 * pushes the restaurant name a long way down the slip. Two thirds keeps a
 * wordmark comfortably legible on the 58mm roll too (256 dots).
 */
export const BILL_LOGO_WIDTH_SHARE = 2 / 3;

/** Dots across for a stored paper width; anything unrecognised is the 80mm roll. */
export function billLogoDots(paperWidth: unknown): number {
  return paperWidth === "58mm" ? BILL_LOGO_DOTS["58mm"] : BILL_LOGO_DOTS["80mm"];
}

/** The monochrome logo as the printer will lay it down, in both encodings. */
export interface BillLogoRaster {
  /** GS v 0 m xL xH yL yH d… — prepend to a receipt, centred. */
  escpos: Buffer;
  /** The same bits as a 1-bit-looking greyscale PNG, for a preview. */
  png: Buffer;
  width: number;
  height: number;
}

type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => any;

/**
 * The largest SVG bill logo accepted, in characters.
 *
 * The old cap was 100,000 and it TRUNCATED rather than refused: a traced logo
 * over the cap lost its closing </svg>, the "is this an SVG" check then failed,
 * and the logo was silently stored as nothing. Refusing with a sentence is the
 * behaviour an owner can act on. Half a megabyte holds any real wordmark; the
 * value travels in the settings document, so it is not unbounded either.
 */
export const BILL_LOGO_SVG_MAX_CHARS = 500_000;

/** A usable SVG bill logo, or why it is not one. */
export type BillLogoSvgResult =
  | { ok: true; svg: string }
  | { ok: false; reason: "not_svg" | "too_large" };

/**
 * THE SVG AN OWNER UPLOADS, MADE STORABLE — or refused, never silently emptied.
 *
 * THE BUG THIS REPLACES. The old check demanded the text START with "<svg".
 * Almost every design tool writes something first: Illustrator, Inkscape and
 * CorelDRAW all begin with an XML declaration ("<?xml version=…?>"), usually a
 * generator comment, often a DOCTYPE. So the logo an owner actually has was
 * judged "not an SVG", sanitized to "", stored as NULL — and the settings save
 * still answered 200, so the app said "Bill logo saved." and then showed an
 * empty card. Not one tenant in production has ever managed to store one.
 *
 * WHAT IT DOES NOW. Keeps exactly the <svg>…</svg> element — first opening tag
 * to last closing tag, so nested <svg> survive — and drops everything around
 * it. That removes the XML declaration, comments and DOCTYPE, which is also
 * the safe thing to do with a DOCTYPE: it is where entity declarations live.
 * Then the same script/handler/javascript: stripping as before, plus unquoted
 * handlers (onload=alert(1)), which the quoted-only patterns missed.
 */
export function cleanBillLogoSvg(input: unknown): BillLogoSvgResult {
  if (typeof input !== "string") { return { ok: false, reason: "not_svg" }; }
  const text = input.replace(/^\uFEFF/, "").trim();
  if (text.length > BILL_LOGO_SVG_MAX_CHARS) { return { ok: false, reason: "too_large" }; }
  const open = text.search(/<svg[\s>]/i);
  // The LAST closing tag, found on the text itself (a lower-cased copy can be a
  // different length, and its indexes would not be this string's).
  let close = -1;
  let closeLen = 0;
  for (const m of text.matchAll(/<\/svg\s*>/gi)) { close = m.index ?? -1; closeLen = m[0].length; }
  if (open < 0 || close < open) { return { ok: false, reason: "not_svg" }; }
  const svg = text
    .slice(open, close + closeLen)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>"']+/gi, "")
    .replace(/javascript:/gi, "");
  return { ok: true, svg };
}

/** How much of a raster is ink, 0..1. A logo that thresholds to nothing prints nothing. */
export function billLogoInkShare(raster: BillLogoRaster): number {
  const bits = raster.escpos.subarray(8);
  let ink = 0;
  for (const byte of bits) { let b = byte; while (b) { ink += b & 1; b >>= 1; } }
  return raster.width * raster.height > 0 ? ink / (raster.width * raster.height) : 0;
}

async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const mod: any = await import("sharp");
    return (mod.default ?? mod) as SharpFactory;
  } catch {
    return null;
  }
}

/**
 * Fit [raw] (SVG or any raster sharp reads) inside the roll and threshold it.
 *
 * Returns null when sharp is unavailable or the bytes are not an image — a
 * failure here must cost the bill its logo, never the bill.
 */
export async function rasterizeBillLogo(
  raw: Buffer,
  targetWidth: number = BILL_LOGO_DOTS["80mm"],
  sharpImpl?: SharpFactory,
): Promise<BillLogoRaster | null> {
  const sharp = sharpImpl ?? (await loadSharp());
  // A STRING IS NOT IMAGE BYTES. sharp reads a string as a file path on this
  // host, which is how a stored logo REFERENCE ("logos/x.png") once reached here
  // in place of the image and every bill silently lost its logo. Refused by
  // type, so that failure cannot come back through a different caller.
  if (!sharp || !Buffer.isBuffer(raw) || raw.length === 0) { return null; }
  try {
    // A VECTOR IS DRAWN AT THE SIZE IT WILL PRINT. sharp rasterizes an SVG at
    // 72 dpi from its own width/height, and `withoutEnlargement` below (right
    // for a PNG — never blow a small bitmap up into a blurry one) then kept that
    // size: an SVG saved as width="120" printed as a 120-dot smudge. So an SVG
    // is rendered at the density that makes it as wide as the space it gets.
    const maxWidth = Math.round(targetWidth * BILL_LOGO_WIDTH_SHARE);
    let density: number | undefined;
    try {
      const meta = await sharp(raw).metadata();
      if (meta?.format === "svg" && meta.width && meta.height) {
        const scale = Math.min(maxWidth / meta.width, BILL_LOGO_MAX_HEIGHT / meta.height);
        if (scale > 1) { density = Math.min(2400, Math.ceil(72 * scale)); }
      }
    } catch {/* not readable here either; the render below returns null */}
    // Flatten first: a transparent PNG would otherwise threshold its empty
    // background to black and print a solid slab.
    const { data, info } = await (density ? sharp(raw, { density }) : sharp(raw))
      .flatten({ background: "#ffffff" })
      .resize({ width: maxWidth, height: BILL_LOGO_MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      .threshold(128)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width: number = info.width;
    const height: number = info.height;
    const channels: number = info.channels ?? 1;
    if (!width || !height) { return null; }

    const widthBytes = Math.ceil(width / 8);
    const bits = Buffer.alloc(widthBytes * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Thresholded: 0 = ink, 255 = paper.
        if (data[(y * width + x) * channels] === 0) {
          bits[y * widthBytes + (x >> 3)] |= 1 << (7 - (x & 7));
        }
      }
    }
    // GS v 0 m xL xH yL yH d
    const header = Buffer.from([
      0x1d, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    ]);

    // Encoded from the thresholded buffer itself, not from a second pass over
    // the source, so the preview cannot be a pixel different from the paper.
    const png: Buffer = await (sharp as any)(data, { raw: { width, height, channels } })
      .png()
      .toBuffer();

    return { escpos: Buffer.concat([header, bits]), png, width, height };
  } catch {
    return null;
  }
}
