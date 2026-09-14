// "EVEN AFTER SETTING THE LOGO USING AN SVG IT WOULDN'T SET IT / UPDATE IT."
//
// ============================================================================
// WHAT WAS HAPPENING
// ============================================================================
// sanitizeBillLogoSvg demanded that the text START with "<svg". Illustrator,
// Inkscape and CorelDRAW all write an XML declaration first, usually a
// generator comment, often a DOCTYPE. So the SVG an owner actually has was
// sanitized to "", SetRestaurantSettings stored NULL (and wiped any logo that
// was there), and POST /restaurant/settings still answered 200 — the app said
// "Bill logo saved." over an empty card. Production had ZERO stored SVG logos.
// A traced logo over 100 KB failed the same way: the cap truncated it before
// the "</svg>" check, which it then failed.
//
// This file pins: the files design tools really produce are accepted; an
// unusable upload is REFUSED with a sentence rather than silently emptied; and
// an SVG prints at the size it is given, not at its 72-dpi intrinsic size.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import sharp from "sharp";
import {
  BILL_LOGO_DOTS, BILL_LOGO_SVG_MAX_CHARS, BILL_LOGO_WIDTH_SHARE,
  billLogoInkShare, cleanBillLogoSvg, rasterizeBillLogo,
} from "../bill_logo";

const BODY = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect x="0" y="0" width="60" height="40" fill="#000"/></svg>`;

const EXPORTS: Record<string, string> = {
  illustrator: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n${BODY}\n`,
  inkscape: `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${BODY}`,
  bom: `﻿${BODY}`,
  figma: BODY,
  uppercaseClose: BODY.replace("</svg>", "</SVG >"),
};

describe("the SVG files design tools actually write are accepted", () => {
  test.each(Object.keys(EXPORTS))("%s export", (name) => {
    const r = cleanBillLogoSvg(EXPORTS[name]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.svg.startsWith("<svg")).toBe(true);
      expect(r.svg).toMatch(/<\/svg\s*>$/i);
      // The declaration, comment and DOCTYPE are gone — nothing before <svg.
      expect(r.svg).not.toContain("<?xml");
      expect(r.svg).not.toContain("<!DOCTYPE");
    }
  });

  test("THE BUG, stated as the old rule: none of the prolog exports started with <svg", () => {
    // The removed check was /^<svg[\s>]/ on the trimmed text.
    expect(/^<svg[\s>]/i.test(EXPORTS.illustrator!.trim())).toBe(false);
    expect(/^<svg[\s>]/i.test(EXPORTS.inkscape!.trim())).toBe(false);
  });

  test("a nested <svg> keeps its outer element whole", () => {
    const nested = `<?xml version="1.0"?><svg width="10" height="10"><svg x="1"><rect width="1" height="1"/></svg></svg>`;
    const r = cleanBillLogoSvg(nested);
    expect(r.ok && r.svg).toBe(`<svg width="10" height="10"><svg x="1"><rect width="1" height="1"/></svg></svg>`);
  });

  test("a logo over the old 100 KB cap is kept whole, not truncated into nothing", () => {
    const big = `<?xml version="1.0"?>` + BODY.replace("</svg>", `${`<path d="M0 0 L1 1"/>`.repeat(8000)}</svg>`);
    expect(big.length).toBeGreaterThan(100_000);
    expect(big.length).toBeLessThan(BILL_LOGO_SVG_MAX_CHARS);
    expect(cleanBillLogoSvg(big).ok).toBe(true);
  });
});

describe("what is refused, and why", () => {
  test("not an SVG", () => {
    expect(cleanBillLogoSvg("hello")).toEqual({ ok: false, reason: "not_svg" });
    expect(cleanBillLogoSvg("<svg width='1'>")).toEqual({ ok: false, reason: "not_svg" });
    expect(cleanBillLogoSvg(42)).toEqual({ ok: false, reason: "not_svg" });
  });

  test("too large is its own reason, so the owner is told the right thing", () => {
    const huge = BODY.replace("</svg>", `${"x".repeat(BILL_LOGO_SVG_MAX_CHARS)}</svg>`);
    expect(cleanBillLogoSvg(huge)).toEqual({ ok: false, reason: "too_large" });
  });

  test("script, quoted and unquoted handlers, and javascript: URLs are stripped", () => {
    const evil = `<svg onload="alert(1)" onclick='x()' onmouseover=steal() width="1" height="1"><script>alert(2)</script><a href="javascript:alert(3)"/></svg>`;
    const r = cleanBillLogoSvg(evil);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.svg).not.toMatch(/onload|onclick|onmouseover|<script|javascript:/i);
    }
  });
});

describe("an SVG prints at the size it is given", () => {
  test("a 120x40 SVG is drawn to the logo's full width, not as a 120-dot smudge", async () => {
    const r = await rasterizeBillLogo(Buffer.from(BODY), BILL_LOGO_DOTS["80mm"]);
    expect(r).not.toBeNull();
    const target = Math.round(576 * BILL_LOGO_WIDTH_SHARE);
    expect(r!.width).toBeGreaterThanOrEqual(target - 1);
    expect(r!.width).toBeLessThanOrEqual(target);
    // Left half of the SVG is black: ink is roughly half.
    expect(billLogoInkShare(r!)).toBeGreaterThan(0.4);
    expect(billLogoInkShare(r!)).toBeLessThan(0.6);
  });

  test("a small PNG is still never blown up", async () => {
    const png = await sharp({ create: { width: 100, height: 30, channels: 3, background: "#000000" } }).png().toBuffer();
    const r = await rasterizeBillLogo(png, 576);
    expect(r!.width).toBe(100);
  });

  test("a white logo thresholds to blank paper, and the ink share says so", async () => {
    const white = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#ffffff"/></svg>`;
    const r = await rasterizeBillLogo(Buffer.from(white), 576);
    expect(r).not.toBeNull();
    expect(billLogoInkShare(r!)).toBe(0);
  });
});

// ============================================================================
// THE ROUTE: refused out loud, and a good logo reaches the data layer
// ============================================================================

const mockSaved: Record<string, unknown>[] = [];

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    GetRestaurantSettings: () => Promise.resolve({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" }),
    SetRestaurantSettings: (_id: string, opts: Record<string, unknown>) => { mockSaved.push(opts); return Promise.resolve({ currency: "₹", auto_push_orders: true }); },
    AddAuditLogEntry: () => Promise.resolve(undefined),
  };
});

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
const registered: { method: string; path: string; handlers: Handler[] }[] = [];
const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => { registered.push({ method, path, handlers }); return fakeApp; };
const fakeApp = { get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), delete: record("DELETE"), use: (): unknown => fakeApp };
const AUTH = {
  res_id: "11111111-1111-4111-8111-111111111111", outlet_id: "22222222-2222-4222-8222-222222222222",
  employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f", employeeUsername: "owner", role: "admin", actions: ["*"],
};

async function postSettings(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const route = registered.find((r) => r.method === "POST" && r.path === "/restaurant/settings");
  if (!route) { throw new Error("POST /restaurant/settings not registered"); }
  const out: { status: number; body: any } = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(p: unknown) { if (!ended) { out.body = p; ended = true; } return res; },
    send(p: unknown) { if (!ended) { out.body = p; ended = true; } return res; },
    setHeader() { return res; }, end() { ended = true; return res; },
  };
  const req = { params: {}, body, query: {}, headers: {}, auth: AUTH };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const settings = await import("../routes/settings");
    settings.registerSettingsRoutes(fakeApp as never);
  }
  mockSaved.length = 0;
});

describe("POST /restaurant/settings with an SVG bill logo", () => {
  test("an Illustrator export is SAVED — the file the owner actually has", async () => {
    const r = await postSettings({ bill_logo_svg: EXPORTS.illustrator });
    expect(r.status).toBe(200);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]!.bill_logo_svg).toBe(EXPORTS.illustrator);
  });

  test("not an SVG: 400 with a sentence, and nothing is written (the old path stored NULL over the logo)", async () => {
    const r = await postSettings({ bill_logo_svg: "<html>nope</html>" });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatch(/not an SVG/i);
    expect(mockSaved).toHaveLength(0);
  });

  test("a white logo: 400 saying it would print blank", async () => {
    const r = await postSettings({ bill_logo_svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#fff"/></svg>` });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatch(/blank/i);
    expect(mockSaved).toHaveLength(0);
  });

  test("too large: 400 naming the size", async () => {
    const r = await postSettings({ bill_logo_svg: BODY.replace("</svg>", `${"x".repeat(BILL_LOGO_SVG_MAX_CHARS)}</svg>`) });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatch(/too large/i);
  });

  test("an empty string still CLEARS the logo", async () => {
    const r = await postSettings({ bill_logo_svg: "" });
    expect(r.status).toBe(200);
    expect(mockSaved[0]!.bill_logo_svg).toBe("");
  });
});
