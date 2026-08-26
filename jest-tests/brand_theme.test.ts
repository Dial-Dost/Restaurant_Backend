import { describe, test, expect } from "@jest/globals";
import {
  BRAND_CONTRAST_MIN,
  BRAND_PALETTE_DEFAULTS,
  BRAND_SCHEMES,
  BRAND_SCHEME_IDS,
  BRAND_SCHEME_ROLES,
  brandFieldMeta,
  contrastRatio,
  resolveBrandConfig,
  resolveBrandPalette,
  resolveBrandPaletteDetailed,
  sanitizeBrandConfigInput,
} from "../brand_theme";

// The shipped dark design, as literals. If any of these move, every untouched
// tenant's LIVE guest page changes — that is a production incident, not a
// refactor. (secondary/accent are the ramp stops derived from #ea580c.)
const LEGACY_DEFAULT_PALETTE = {
  primary: "#ea580c",
  secondary: "#ef6015",
  accent: "#fdac81",
  background: "#08080A",
  surface: "#1A1A1F",
  text: "#ECEAE6",
  success: "#8FB27C",
  warning: "#E4C48C",
  error: "#E0A79B",
};

describe("brand palette resolution", () => {
  test("absent config resolves to the legacy default palette bit-for-bit", () => {
    expect(resolveBrandPalette(null, null, null)).toEqual(LEGACY_DEFAULT_PALETTE);
    expect(resolveBrandPalette(undefined, null, null)).toEqual(LEGACY_DEFAULT_PALETTE);
    expect(resolveBrandPalette({}, null, null)).toEqual(LEGACY_DEFAULT_PALETTE);
    // …and the resolver never needs to clamp its own defaults.
    expect(resolveBrandPaletteDetailed(null, null, null).contrast).toEqual([]);
  });

  test("scheme 'classic' and 'custom' pin nothing — identical to absent", () => {
    expect(resolveBrandPalette({ scheme: "classic" }, null, null)).toEqual(LEGACY_DEFAULT_PALETTE);
    expect(resolveBrandPalette({ scheme: "custom" }, null, null)).toEqual(LEGACY_DEFAULT_PALETTE);
  });

  test("stale revived keys without palette_rev stay dormant, even under a scheme", () => {
    // A tenant with a grey background from the pre-dark editor: ignored.
    expect(resolveBrandPalette({ color_bg: "#808080", color_text: "#000000" }, null, null))
      .toEqual(LEGACY_DEFAULT_PALETTE);
    // …and picking a preset must not revive it over the preset's own shell.
    const p = resolveBrandPalette({ scheme: "airy", color_bg: "#808080" }, null, null);
    expect(p.background).toBe(BRAND_SCHEME_ROLES.airy!.background);
  });

  test("a named scheme swaps the shell but never the accent trio", () => {
    const p = resolveBrandPalette({ scheme: "airy", color_primary: "#2563EB" }, null, null);
    expect(p.background).toBe(BRAND_SCHEME_ROLES.airy!.background);
    expect(p.surface).toBe(BRAND_SCHEME_ROLES.airy!.surface);
    expect(p.text).toBe(BRAND_SCHEME_ROLES.airy!.text);
    expect(p.success).toBe(BRAND_SCHEME_ROLES.airy!.success);
    expect(p.warning).toBe(BRAND_SCHEME_ROLES.airy!.warning);
    expect(p.error).toBe(BRAND_SCHEME_ROLES.airy!.error);
    // The brand accent survives the scheme change untouched.
    expect(p.primary).toBe("#2563EB");
    const noScheme = resolveBrandPalette({ color_primary: "#2563EB" }, null, null);
    expect(p.secondary).toBe(noScheme.secondary);
    expect(p.accent).toBe(noScheme.accent);
  });

  test("an explicit (opted-in) colour beats the scheme; semantic keys apply ungated", () => {
    const p = resolveBrandPalette(
      { scheme: "airy", color_bg: "#FFF8F0", palette_rev: 2, color_success: "#106B24" },
      null, null,
    );
    expect(p.background).toBe("#FFF8F0");
    expect(p.success).toBe("#106B24");
    // Roles the tenant left alone still come from the scheme.
    expect(p.surface).toBe(BRAND_SCHEME_ROLES.airy!.surface);
  });

  test("every named scheme clears WCAG AA for text on both grounds, by construction", () => {
    for (const [id, roles] of Object.entries(BRAND_SCHEME_ROLES)) {
      expect(contrastRatio(roles.text, roles.background)).toBeGreaterThanOrEqual(BRAND_CONTRAST_MIN);
      expect(contrastRatio(roles.text, roles.surface)).toBeGreaterThanOrEqual(BRAND_CONTRAST_MIN);
      expect(resolveBrandPaletteDetailed({ scheme: id }, null, null).contrast).toEqual([]);
    }
  });
});

describe("contrast clamp", () => {
  test("near-white text on a light scheme is clamped dark enough to read", () => {
    const d = resolveBrandPaletteDetailed({ scheme: "airy", color_text: "#F0EFEA", palette_rev: 2 }, null, null);
    expect(d.contrast).toHaveLength(1);
    expect(d.contrast[0]).toMatchObject({ role: "text", requested: "#F0EFEA", minimum: BRAND_CONTRAST_MIN });
    expect(d.contrast[0]!.applied).toBe(d.palette.text);
    expect(contrastRatio(d.palette.text, d.palette.background)).toBeGreaterThanOrEqual(BRAND_CONTRAST_MIN);
    expect(contrastRatio(d.palette.text, d.palette.surface)).toBeGreaterThanOrEqual(BRAND_CONTRAST_MIN);
  });

  test("dark-on-dark is clamped lighter (direction follows the background)", () => {
    const d = resolveBrandPaletteDetailed({ color_text: "#101014", palette_rev: 2 }, null, null);
    expect(d.contrast).toHaveLength(1);
    expect(contrastRatio(d.palette.text, "#08080A")).toBeGreaterThanOrEqual(BRAND_CONTRAST_MIN);
  });

  test("a readable explicit text colour is served untouched", () => {
    const d = resolveBrandPaletteDetailed({ color_text: "#FFFFFF", palette_rev: 2 }, null, null);
    expect(d.contrast).toEqual([]);
    expect(d.palette.text).toBe("#FFFFFF");
  });

  test("the clamp is deterministic", () => {
    const a = resolveBrandPaletteDetailed({ scheme: "airy", color_text: "#F0EFEA", palette_rev: 2 }, null, null);
    const b = resolveBrandPaletteDetailed({ scheme: "airy", color_text: "#F0EFEA", palette_rev: 2 }, null, null);
    expect(a.palette).toEqual(b.palette);
    expect(a.contrast).toEqual(b.contrast);
  });
});

describe("sanitizeBrandConfigInput (new keys)", () => {
  test("valid scheme / font_scale / card_shape survive; junk is dropped", () => {
    expect(sanitizeBrandConfigInput({ scheme: "copper", font_scale: "large", card_shape: "sharp" }))
      .toEqual({ scheme: "copper", font_scale: "large", card_shape: "sharp" });
    expect(sanitizeBrandConfigInput({ scheme: "neon", font_scale: "xl", card_shape: "round", font: "Comic Sans" }))
      .toEqual({});
    expect(sanitizeBrandConfigInput({ scheme: 7, font_scale: null, card_shape: undefined })).toEqual({});
  });

  test("every advertised scheme id is accepted on write", () => {
    for (const id of BRAND_SCHEME_IDS) {
      expect(sanitizeBrandConfigInput({ scheme: id })).toEqual({ scheme: id });
    }
  });
});

describe("resolveBrandConfig + field meta", () => {
  test("untouched tenant resolves the shipped defaults for the new knobs", () => {
    const c = resolveBrandConfig(null, null, null);
    expect(c.scheme).toBe("classic");
    expect(c.font_scale).toBe("medium");
    expect(c.card_shape).toBe("rounded");
    expect(c.button_shape).toBe("rounded");
    expect(c.surface_style).toBe("frosted");
  });

  test("resolution is a fixed point: saving back what you loaded changes nothing", () => {
    for (const stored of [
      null,
      { scheme: "airy" },
      { scheme: "contrast", color_primary: "#2563EB", font_scale: "large" },
      { color_bg: "#101014", color_text: "#F1E9DF", palette_rev: 2, card_shape: "sharp" },
    ]) {
      const once = resolveBrandConfig(stored, null, null);
      const twice = resolveBrandConfig(sanitizeBrandConfigInput(once), null, null);
      // palette_rev is stamped by the WRITE path, not resolution — compare the
      // resolved values, which is what the guest pages actually consume.
      const { palette_rev: _a, ...vOnce } = once;
      const { palette_rev: _b, ...vTwice } = twice;
      expect(vTwice).toEqual(vOnce);
    }
  });

  test("field meta advertises the new knobs and the scheme catalogue", () => {
    const meta = brandFieldMeta();
    for (const key of ["scheme", "font_scale", "card_shape"]) {
      expect(meta.brand_fields.live).toContain(key);
      expect(meta.brand_field_defaults[key]).toBeTruthy();
    }
    expect(meta.brand_field_options.scheme).toEqual(BRAND_SCHEME_IDS);
    expect(meta.brand_field_options.font_scale).toEqual(["small", "medium", "large"]);
    expect(meta.brand_field_options.card_shape).toEqual(["rounded", "sharp"]);
    expect(meta.brand_schemes.map((s) => s.id)).toEqual(BRAND_SCHEME_IDS);
    for (const s of meta.brand_schemes) {
      // Preview swatches are complete so the pickers never render a hole.
      for (const v of Object.values(s.preview)) {expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);}
    }
    // The scheme catalogue previews mirror the shipped defaults for classic.
    expect(BRAND_SCHEMES.find((s) => s.id === "classic")!.preview).toEqual(BRAND_PALETTE_DEFAULTS);
  });
});
