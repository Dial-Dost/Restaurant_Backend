/**
 * Rich customer-page branding (brand_config): types, validation and the
 * palette/scheme resolution the guest surfaces theme themselves from.
 *
 * PURE module — no database, no network, no imports. Extracted from
 * database_supabase.ts (which re-exports everything here, so existing import
 * sites keep working) so the palette rules can be unit-tested the way
 * billing_math.ts is: the resolution invariants below are load-bearing for
 * every live guest page, and a jest test must be able to import them without
 * dragging in the pg pool.
 *
 * LIVE vs LEGACY -----------------------------------------------------------
 * The customer-facing surfaces (QR order page, feedback + valet) are a committed
 * premium DARK design: a near-black #08080A shell, animated accent orbs and
 * frosted-glass panels, themed entirely from a 6-stop accent RAMP derived from
 * one brand colour. That design can honour an accent, a body font, the hero wash
 * and the control/panel shape — it CANNOT honour an arbitrary page background,
 * body-text colour or card colour without destroying its own contrast and glass
 * material, and it no longer needs an independent secondary colour (the ramp
 * derives accMid/accDeep from the accent).
 *
 * So brand_config keys are split into two sets, both still accepted on write and
 * never dropped from storage:
 *   LIVE   — actually drives the guest UI (see BRAND_LIVE_FIELDS)
 *   LEGACY — kept for back-compat / future use, drives nothing (BRAND_LEGACY_FIELDS)
 * Both lists are returned by GET /restaurant/settings as `brand_fields` so the
 * editors can stop rendering dead controls without hardcoding the split.
 */

// Curated font allowlist the customer-facing pages may use — a small, safe set
// the UIs render as a dropdown. Anything outside this list is dropped on write
// (the page then uses its default/system font). Kept as a plain string[] so it
// can be returned verbatim to the clients as `brand_fonts`.
export const BRAND_FONTS: string[] = [
  "Inter",
  "Poppins",
  "Playfair Display",
  "Montserrat",
  "Lato",
  "Nunito",
  "Oswald",
  "Roboto Slab",
  "DM Sans",
  "Merriweather",
];

// A tenant's customer-page customization. Every key is optional at the storage
// layer (only provided, valid keys are persisted); the read layer applies sane
// defaults (see resolveBrandConfig).
export interface BrandConfig {
  // --- LIVE (drives the dark guest design) ---------------------------------
  /** Body font for the guest surfaces (BRAND_FONTS allowlist). */
  font?: string;
  /** The brand PRIMARY — the single hex the 6-stop accent ramp is derived from. */
  color_primary?: string;
  /** Secondary/supporting accent (chips, secondary buttons). Defaults to the ramp's mid stop. */
  color_secondary?: string;
  /** Highlight/tertiary accent (badges, price emphasis). Defaults to the ramp's high stop. */
  color_accent?: string;
  /** Page shell background. Defaults to the shipped near-black #08080A. */
  color_bg?: string;
  /** Panel/card surface base colour (the alpha comes from surface_style). Defaults #1A1A1F. */
  color_card?: string;
  /** Body ink. Defaults to the shipped warm off-white #ECEAE6. */
  color_text?: string;
  /** Positive/confirmation colour. Defaults to the shipped green #8FB27C. */
  color_success?: string;
  /** Caution colour. Defaults to the shipped amber #E4C48C. */
  color_warning?: string;
  /** Error/destructive colour. Defaults to the shipped soft red #E0A79B. */
  color_error?: string;
  /** Hero/header wash: accent gradient (default) or a flat accent block. */
  header_style?: "gradient" | "solid";
  /** Radius of controls/buttons/chips (--rCtrl): rounded 13px | pill 999px | square 4px. */
  button_shape?: "rounded" | "pill" | "square";
  /** Panel material of every card/sheet (--panelBg/--blur/--pbA). */
  surface_style?: "frosted" | "solid" | "tinted";
  /**
   * Named preset scheme (see BRAND_SCHEMES). A scheme is a curated bundle of
   * SHELL roles (background/surface/text + the three semantic states) that sits
   * BETWEEN the tenant's explicit colour keys and the shipped defaults:
   * explicit key → scheme value → derived/default. The accent trio
   * (primary/secondary/accent) is deliberately NOT part of any scheme — it is
   * the tenant's brand identity and survives every scheme change untouched.
   * "classic" and "custom" carry no roles at all: "classic" IS the shipped
   * design, and "custom" tells the editors to show the individual pickers.
   * Absent = "classic", so every existing tenant resolves bit-for-bit as before.
   */
  scheme?: string;
  /** Guest-page text size: small 0.92× | medium 1× (default) | large 1.1×. */
  font_scale?: "small" | "medium" | "large";
  /** Card/panel radius (--rCard): rounded 22px (the shipped look) | sharp 6px. */
  card_shape?: "rounded" | "sharp";
  /**
   * Palette opt-in marker. See BRAND_PALETTE_REV: color_secondary / color_bg /
   * color_card / color_text were accepted-but-DEAD for a long time, so tenants
   * carry stale values that were never rendered. Those four are only APPLIED once
   * this is >= BRAND_PALETTE_REV, which is stamped automatically the first time a
   * caller writes a palette key under the new contract. Set by the server, not
   * something an editor needs to think about.
   */
  palette_rev?: number;

  // --- Gradient controls -----------------------------------------------------
  // Each gradient is a pair of hex stops plus an optional angle (degrees). A
  // gradient is ACTIVE only when BOTH stops are present — a lone stop or a lone
  // angle paints nothing, so a half-cleared tenant can never render a broken
  // wash. All nine keys are NEW (nothing stale can exist under them), so they
  // apply the moment they are set and need no palette_rev gate; ABSENT keys
  // reproduce the shipped derived output bit-for-bit.
  /** Hero/header wash: explicit stops replacing the derived accent wash. */
  header_grad_from?: string;
  header_grad_to?: string;
  /** Hero wash direction in degrees. Default 150 — the shipped wash's angle. */
  header_grad_angle?: number;
  /** Accent CTA/button fill (same stop twice = a solid button). */
  button_grad_from?: string;
  button_grad_to?: string;
  /** Button fill direction. Default 180 — the shipped vertical accHi→accMid fall. */
  button_grad_angle?: number;
  /** Page background wash painted over the solid color_bg shell. */
  bg_grad_from?: string;
  bg_grad_to?: string;
  /** Background wash direction. Default 180 (top → bottom). */
  bg_grad_angle?: number;
}

export const BRAND_HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const BRAND_COLOR_KEYS = [
  "color_primary",
  "color_secondary",
  "color_accent",
  "color_bg",
  "color_card",
  "color_text",
  "color_success",
  "color_warning",
  "color_error",
] as const;
// The gradient stop keys (hex-validated like the colour roles) and their angle
// keys (integer degrees, normalised into 0..359). Grouped per surface so the
// editors can be BUILT from this table instead of hardcoding key names — see
// BRAND_GRADIENT_FIELDS in brandFieldMeta().
export const BRAND_GRADIENT_STOP_KEYS = [
  "header_grad_from",
  "header_grad_to",
  "button_grad_from",
  "button_grad_to",
  "bg_grad_from",
  "bg_grad_to",
] as const;
export const BRAND_GRADIENT_ANGLE_KEYS = [
  "header_grad_angle",
  "button_grad_angle",
  "bg_grad_angle",
] as const;
export const BRAND_GRADIENT_KEYS: string[] = [...BRAND_GRADIENT_STOP_KEYS, ...BRAND_GRADIENT_ANGLE_KEYS];
// The angle each surface renders with when the tenant set stops but no angle.
// header 150 / button 180 are the literal angles the shipped derived washes use,
// so "same stops, no angle" sits exactly where the design already points.
export const BRAND_GRADIENT_ANGLE_DEFAULTS = {
  header_grad_angle: 150,
  button_grad_angle: 180,
  bg_grad_angle: 180,
} as const;

export const BRAND_HEADER_STYLES: string[] = ["gradient", "solid"];
export const BRAND_BUTTON_SHAPES: string[] = ["rounded", "pill", "square"];
export const BRAND_SURFACE_STYLES: string[] = ["frosted", "solid", "tinted"];
export const BRAND_FONT_SCALES: string[] = ["small", "medium", "large"];
export const BRAND_CARD_SHAPES: string[] = ["rounded", "sharp"];

// --- Preset schemes ---------------------------------------------------------
// A scheme swaps the guest page's SHELL (page, panel, ink, semantic states)
// while leaving the tenant's accent alone. Every named scheme below was chosen
// so text-vs-background AND text-vs-surface both clear WCAG AA 4.5:1 by
// construction (asserted in jest), so picking a preset can never produce an
// unreadable menu.
export interface BrandSchemeRoles {
  background: string;
  surface: string;
  text: string;
  success: string;
  warning: string;
  error: string;
}
export interface BrandSchemeMeta {
  id: string;
  label: string;
  hint: string;
  /**
   * Swatches for the editors' preset picker. "classic"/"custom" preview the
   * shipped dark design so the picker never renders an empty card.
   */
  preview: BrandSchemeRoles;
}

/** The shipped dark design's fixed role values (also the "classic" preview). */
export const BRAND_PALETTE_DEFAULTS: Omit<BrandPalette, "primary" | "secondary" | "accent"> = {
  background: "#08080A",
  surface: "#1A1A1F",
  text: "#ECEAE6",
  success: "#8FB27C",
  warning: "#E4C48C",
  error: "#E0A79B",
};

// Named scheme → the shell roles it pins. "classic" and "custom" are real,
// selectable ids but pin nothing (see BrandConfig.scheme).
export const BRAND_SCHEME_ROLES: Record<string, BrandSchemeRoles> = {
  // Warm dark-copper: the owner app's Rustic Fork ground, warmer than classic.
  copper: {
    background: "#0E0A08",
    surface: "#201812",
    text: "#F1E9DF",
    success: "#97B884",
    warning: "#E4C48C",
    error: "#E0A79B",
  },
  // Light and airy: paper shell, white cards, near-black ink. The semantic
  // states darken so they still read on the light ground.
  airy: {
    background: "#F6F4EF",
    surface: "#FFFFFF",
    text: "#2B2723",
    success: "#3F6F33",
    warning: "#8A5A14",
    error: "#B3402F",
  },
  // High contrast: pure black/white with loud semantic states, for guests who
  // find the frosted dark design too low-contrast.
  contrast: {
    background: "#000000",
    surface: "#101010",
    text: "#FFFFFF",
    success: "#57D982",
    warning: "#FFD666",
    error: "#FF8A7A",
  },
};

export const BRAND_SCHEMES: BrandSchemeMeta[] = [
  { id: "classic", label: "Classic dark", hint: "The shipped near-black design — the default.", preview: { ...BRAND_PALETTE_DEFAULTS } },
  { id: "copper", label: "Warm copper", hint: "A warmer, wood-and-copper take on the dark shell.", preview: BRAND_SCHEME_ROLES.copper! },
  { id: "airy", label: "Light & airy", hint: "Paper-light shell with white cards and dark ink.", preview: BRAND_SCHEME_ROLES.airy! },
  { id: "contrast", label: "High contrast", hint: "Pure black and white, maximum legibility.", preview: BRAND_SCHEME_ROLES.contrast! },
  { id: "custom", label: "Custom", hint: "Pick every colour role yourself.", preview: { ...BRAND_PALETTE_DEFAULTS } },
];
export const BRAND_SCHEME_IDS: string[] = BRAND_SCHEMES.map((s) => s.id);

/**
 * Keys the guest surfaces actually consume. Editors should render exactly these.
 *  - color_primary  → the accent ramp (acc/accHi/accMid/accDeep/accShadow/onAcc)
 *  - font           → guest body font
 *  - header_style   → hero wash: "gradient" (accent → near-black) | "solid" (flat accent)
 *  - button_shape   → control radius --rCtrl: rounded 13px | pill 9999px | square 4px
 *  - surface_style  → panel material --panelBg/--blur/--pbA:
 *      frosted (rgba(26,26,31,0.55) / 22px / 0.12)  ← the shipped look
 *      solid   (rgba(18,18,21,0.94) / 0px  / 0.10)
 *      tinted  (accent-tinted glass: rgba(accShadow,0.42) / 22px / 0.18)
 *  - scheme         → preset shell (see BRAND_SCHEMES)
 *  - font_scale     → guest text size --fs: small 0.92 | medium 1 | large 1.1
 *  - card_shape     → card radius --rCard: rounded 22px | sharp 6px
 */
export const BRAND_LIVE_FIELDS: string[] = [
  "scheme",
  "color_primary",
  "color_secondary",
  "color_accent",
  "color_bg",
  "color_card",
  "color_text",
  "color_success",
  "color_warning",
  "color_error",
  "font",
  "font_scale",
  "header_style",
  "button_shape",
  "surface_style",
  "card_shape",
  ...BRAND_GRADIENT_KEYS,
];

/**
 * Keys accepted and stored but which drive nothing. EMPTY since the palette was
 * revived: every colour key is now a real role in the resolved palette (see
 * resolveBrandPalette), so there is nothing left to hide from the editors.
 */
export const BRAND_LEGACY_FIELDS: string[] = [];

/**
 * New enum-ish keys that can be CLEARED by sending them as null (mirroring how
 * the colour roles have always cleared). The original enum keys (header_style…)
 * keep their ignore-invalid behaviour — existing clients depend on it.
 */
export const BRAND_CLEARABLE_ENUM_KEYS: string[] = ["scheme", "font_scale", "card_shape"];

// Validate a customization payload down to the STORED subset: only the keys the
// caller actually provided AND that pass validation survive (invalid colours,
// unknown fonts and bad enums are silently dropped). Returning just the valid
// provided keys lets SetBranding merge-on-omit (jsonb ||) without a bad value
// ever landing in the column.
export function sanitizeBrandConfigInput(raw: unknown): BrandConfig {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: BrandConfig = {};
  if (typeof s.font === "string" && BRAND_FONTS.includes(s.font.trim())) {out.font = s.font.trim();}
  for (const key of BRAND_COLOR_KEYS) {
    const v = s[key];
    if (typeof v === "string" && BRAND_HEX_RE.test(v.trim())) {out[key] = v.trim();}
  }
  for (const key of BRAND_GRADIENT_STOP_KEYS) {
    const v = s[key];
    if (typeof v === "string" && BRAND_HEX_RE.test(v.trim())) {out[key] = v.trim();}
  }
  for (const key of BRAND_GRADIENT_ANGLE_KEYS) {
    const v = s[key];
    // Angles are numbers only (no numeric strings — same strictness as the enum
    // keys) and normalised into 0..359 so storage never carries "540deg".
    if (typeof v === "number" && Number.isFinite(v)) {out[key] = ((Math.round(v) % 360) + 360) % 360;}
  }
  if (s.header_style === "gradient" || s.header_style === "solid") {out.header_style = s.header_style;}
  if (s.button_shape === "rounded" || s.button_shape === "pill" || s.button_shape === "square") {out.button_shape = s.button_shape;}
  if (s.surface_style === "frosted" || s.surface_style === "solid" || s.surface_style === "tinted") {out.surface_style = s.surface_style;}
  if (typeof s.scheme === "string" && BRAND_SCHEME_IDS.includes(s.scheme.trim())) {out.scheme = s.scheme.trim();}
  if (s.font_scale === "small" || s.font_scale === "medium" || s.font_scale === "large") {out.font_scale = s.font_scale;}
  if (s.card_shape === "rounded" || s.card_shape === "sharp") {out.card_shape = s.card_shape;}
  // Passed through only when already present — the opt-in is STAMPED ON WRITE
  // (see brandPaletteOptIn / SetBranding), never inferred while reading, or every
  // tenant carrying a stale colour key would opt itself in the first time it read.
  const rev = Number(s.palette_rev);
  if (Number.isFinite(rev) && rev >= BRAND_PALETTE_REV) {out.palette_rev = BRAND_PALETTE_REV;}
  return out;
}

/**
 * Does this WRITE opt the tenant into the revived palette? color_primary was
 * always live, so setting only it changes nothing about the retired keys; any
 * other palette colour means the caller is using the new editor.
 *
 * Setting a SCHEME deliberately does NOT opt in: reviving a tenant's stale
 * dormant colours at the very moment they picked a curated preset would let
 * those stale values override the preset they just chose.
 */
export function brandPaletteOptIn(sanitized: BrandConfig): boolean {
  if (sanitized.palette_rev && sanitized.palette_rev >= BRAND_PALETTE_REV) {return true;}
  return BRAND_COLOR_KEYS.some((k) => k !== "color_primary" && typeof sanitized[k] === "string");
}

// Read-time view of the stored brand_config with sane defaults applied so the
// UIs never have to null-check a key. color_primary falls back to the extracted
// logo primary (themePrimary) then theme_color, so tenants that only ever set a
// theme colour look exactly as before. Legacy colours the tenant never set stay
// absent (they drive nothing either way — see BRAND_LEGACY_FIELDS).
//
// The LIVE enum defaults are exactly the shipped dark design, so a tenant that
// never touched branding keeps today's guest page pixel-for-pixel:
// header_style "gradient", button_shape "rounded" (--rCtrl 13px),
// surface_style "frosted", scheme "classic", font_scale "medium" and
// card_shape "rounded". NOTE: button_shape used to default to "pill" while
// nothing consumed it; the default moved to "rounded" when the key became live.
export function resolveBrandConfig(stored: unknown, themePrimary: string | null, themeColor: string | null): BrandConfig {
  const c = sanitizeBrandConfigInput(stored);
  const palette = resolveBrandPalette(stored, themePrimary, themeColor);
  // Every colour key is resolved (never absent) so the editors can prefill a real
  // swatch for each role instead of showing an empty picker. The values ARE the
  // shipped design when the tenant never touched them, so nothing changes visually.
  return {
    font: c.font ?? "Inter",
    header_style: c.header_style ?? "gradient",
    button_shape: c.button_shape ?? "rounded",
    surface_style: c.surface_style ?? "frosted",
    scheme: c.scheme ?? "classic",
    font_scale: c.font_scale ?? "medium",
    card_shape: c.card_shape ?? "rounded",
    color_primary: palette.primary,
    color_secondary: palette.secondary,
    color_accent: palette.accent,
    color_bg: palette.background,
    color_card: palette.surface,
    color_text: palette.text,
    color_success: palette.success,
    color_warning: palette.warning,
    color_error: palette.error,
    // Echoed so an editor that saves back what it loaded keeps the opt-in (and a
    // tenant that has not opted in yet does so by saving the resolved palette).
    ...(c.palette_rev ? { palette_rev: c.palette_rev } : {}),
    // Gradient keys pass through ONLY when stored: unlike the colour roles they
    // have no derived value to prefill — ABSENT is the contract for "render the
    // shipped derived wash", and resolving one in would pin every tenant to it.
    ...Object.fromEntries(BRAND_GRADIENT_KEYS.filter((k) => (c as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, (c as Record<string, unknown>)[k]])),
  };
}

// --- Resolved brand PALETTE -------------------------------------------------
// The guest surfaces (QR order page, feedback, valet, queue) all theme themselves
// from ONE brand colour today: a 6-stop ramp derived from the accent, on a fixed
// near-black shell. The palette below turns that into an explicit, named set of
// roles the tenant can override individually — while every default reproduces the
// shipped design EXACTLY, so an untouched tenant is pixel-identical.
//
// Resolution order per role: explicit key (palette_rev-gated for the four
// revived keys) → the named scheme's value → derived-from-accent / shipped
// default. See BrandConfig.scheme for why the accent trio skips the scheme.
export interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  success: string;
  warning: string;
  error: string;
}

/** The ultimate fallback accent — the value the guest pages have always used. */
export const BRAND_DEFAULT_PRIMARY = "#ea580c";

/**
 * Palette revision. color_secondary / color_bg / color_card / color_text were
 * ACCEPTED BUT DEAD for a long time, so real tenants carry values that were never
 * rendered (csrorganics, for instance, has a mid-grey background and a pure-black
 * card sitting in its brand_config from an old light-theme editor). Reviving those
 * keys blindly would have redecorated live guest pages that nobody asked to
 * change. So the four retired keys only take effect once brand_config carries
 * palette_rev >= this — stamped automatically the first time any palette key
 * other than color_primary is written (see sanitizeBrandConfigInput).
 *
 * Nothing is lost: the old values stay in the column, and because GET returns the
 * RESOLVED palette, an editor that saves what it loaded overwrites the stale
 * values with the correct ones and opts in, in one round-trip.
 */
export const BRAND_PALETTE_REV = 2;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// h in degrees, s & l in 0..1 → #rrggbb. Mirrors the guest pages' hsl2rgb so the
// server-derived secondary/accent land on the SAME stops the client computes.
function brandHslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const rgb = [f(0), f(8), f(4)].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
  return "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
}

// #rrggbb → { h(deg), s(0..100), l(0..1) }. Falls back to the copper hue/sat.
function brandHexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m?.[1]) {return { h: 24, s: 38, l: 0.5 };}
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255, g = ((n >> 8) & 0xff) / 255, b = (n & 0xff) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) {h = (g - b) / d + (g < b ? 6 : 0);}
    else if (mx === g) {h = (b - r) / d + 2;}
    else {h = (r - g) / d + 4;}
    h *= 60;
  }
  return { h, s: s * 100, l };
}

// --- WCAG contrast guard ----------------------------------------------------
// A tenant (or a bad preset) must never be able to make the menu unreadable, so
// the resolved TEXT role is clamped to at least AA 4.5:1 against BOTH grounds it
// actually sits on: the page background and the card surface. The stored value
// is left untouched — only the RESOLVED palette is corrected, and the write path
// reports what happened (brand_contrast) so the editors can say so.

export const BRAND_CONTRAST_MIN = 4.5;

/** WCAG relative luminance of a #rrggbb (0 black … 1 white). */
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  const n = m?.[1] ? parseInt(m[1], 16) : 0;
  const chan = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan((n >> 16) & 0xff) + 0.7152 * chan((n >> 8) & 0xff) + 0.0722 * chan(n & 0xff);
}

/** WCAG contrast ratio between two #rrggbb values (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** One correction the resolver applied to keep the guest pages readable. */
export interface BrandContrastAdjustment {
  role: "text";
  /** The value the tenant's config resolved to before the guard. */
  requested: string;
  /** The value actually served to the guest pages. */
  applied: string;
  /**
   * The ground the requested value failed WORST against. "background gradient"
   * means one of the tenant's bg_grad_from/_to stops — with a background wash,
   * text must clear AA against every ground it can sit on, so the guard
   * validates against the WORST stop too.
   */
  against: "background" | "surface" | "background gradient";
  /** Worst requested-vs-ground ratio, rounded to 2dp. */
  ratio: number;
  /** The minimum the guard enforces (BRAND_CONTRAST_MIN). */
  minimum: number;
}

// Clamp `text` so min(contrast vs bg, contrast vs surface, contrast vs every
// extra ground — e.g. the background-gradient stops) >= 4.5. Keeps the requested
// hue/saturation and walks lightness AWAY from the background; if no lightness
// of that hue can pass (e.g. a dark page with white cards), falls back to
// whichever of white/near-black maximises the worst-pair ratio. Deterministic
// on purpose — same inputs, same palette, testable.
function clampTextContrast(text: string, background: string, surface: string, extraGrounds: string[] = []): { applied: string; changed: boolean; worst: number } {
  const grounds = [background, surface, ...extraGrounds];
  const worstOf = (t: string) => Math.min(...grounds.map((g) => contrastRatio(t, g)));
  const requestedWorst = worstOf(text);
  if (requestedWorst >= BRAND_CONTRAST_MIN) {return { applied: text, changed: false, worst: requestedWorst };}
  const { h, s, l } = brandHexToHsl(text);
  const lighten = relativeLuminance(background) < 0.5;
  let best = text;
  let bestWorst = requestedWorst;
  for (let step = 1; step <= 50; step++) {
    const cand = brandHslHex(h, clamp01(s / 100), clamp01(lighten ? l + step * 0.02 : l - step * 0.02));
    const w = worstOf(cand);
    if (w > bestWorst) {best = cand; bestWorst = w;}
    if (w >= BRAND_CONTRAST_MIN) {return { applied: cand, changed: true, worst: w };}
  }
  for (const cand of ["#FFFFFF", "#0A0A0A"]) {
    const w = worstOf(cand);
    if (w > bestWorst) {best = cand; bestWorst = w;}
  }
  return { applied: best, changed: true, worst: bestWorst };
}

/**
 * Resolve the tenant's full guest palette. `stored` is the raw brand_config jsonb;
 * themePrimary is the logo-extracted colour and themeColor the legacy theme hex —
 * both are only ever fallbacks for `primary`, exactly as before.
 *
 * Every returned value is a valid #rrggbb; nothing is ever null, so a client can
 * theme itself from this object alone with no null-checks and no colour maths.
 * The detailed variant also reports any contrast clamp it had to apply.
 */
export function resolveBrandPaletteDetailed(
  stored: unknown,
  themePrimary: string | null,
  themeColor: string | null,
): { palette: BrandPalette; contrast: BrandContrastAdjustment[] } {
  const c = sanitizeBrandConfigInput(stored);
  const primary = c.color_primary
    ?? (themePrimary && BRAND_HEX_RE.test(themePrimary) ? themePrimary : undefined)
    ?? (themeColor && BRAND_HEX_RE.test(themeColor) ? themeColor : undefined)
    ?? BRAND_DEFAULT_PRIMARY;
  const { h, s } = brandHexToHsl(primary);
  // The named scheme sits between explicit keys and the defaults. "classic" and
  // "custom" pin nothing (see BrandConfig.scheme), so they resolve identically
  // to an absent scheme.
  const scheme = c.scheme ? BRAND_SCHEME_ROLES[c.scheme] : undefined;
  // The four keys that used to be dead only count once the tenant has opted in
  // (see BRAND_PALETTE_REV) — otherwise a stale value from an old editor would
  // silently redecorate a live guest page.
  const revived = Number(c.palette_rev ?? 0) >= BRAND_PALETTE_REV;
  const pick = (v: string | undefined) => (revived ? v : undefined);
  const background = pick(c.color_bg) ?? scheme?.background ?? BRAND_PALETTE_DEFAULTS.background;
  const surface = pick(c.color_card) ?? scheme?.surface ?? BRAND_PALETTE_DEFAULTS.surface;
  const requestedText = pick(c.color_text) ?? scheme?.text ?? BRAND_PALETTE_DEFAULTS.text;
  // A background WASH paints over the shell, so text sits on its stops too: the
  // guard must clear AA against every ground, including the worst gradient stop.
  const bgGrad = resolveBrandGradients(c).background;
  const grounds: { label: BrandContrastAdjustment["against"]; hex: string }[] = [
    { label: "background", hex: background },
    { label: "surface", hex: surface },
    ...(bgGrad ? [
      { label: "background gradient" as const, hex: bgGrad.from },
      { label: "background gradient" as const, hex: bgGrad.to },
    ] : []),
  ];
  const clamp = clampTextContrast(requestedText, background, surface, bgGrad ? [bgGrad.from, bgGrad.to] : []);
  const worstGround = grounds.reduce((a, b) => (contrastRatio(requestedText, a.hex) <= contrastRatio(requestedText, b.hex) ? a : b));
  const contrast: BrandContrastAdjustment[] = clamp.changed
    ? [{
        role: "text",
        requested: requestedText,
        applied: clamp.applied,
        against: worstGround.label,
        ratio: Math.round(Math.min(...grounds.map((g) => contrastRatio(requestedText, g.hex))) * 100) / 100,
        minimum: BRAND_CONTRAST_MIN,
      }]
    : [];
  const palette: BrandPalette = {
    primary,
    secondary: pick(c.color_secondary) ?? brandHslHex(h, clamp01((s - 3) / 100), 0.51),
    // color_accent / _success / _warning / _error are NEW keys — nothing stale can
    // exist under them, so they apply the moment they are set.
    accent: c.color_accent ?? brandHslHex(h, clamp01((s + 7) / 100), 0.75),
    background,
    surface,
    text: clamp.applied,
    success: c.color_success ?? scheme?.success ?? BRAND_PALETTE_DEFAULTS.success,
    warning: c.color_warning ?? scheme?.warning ?? BRAND_PALETTE_DEFAULTS.warning,
    error: c.color_error ?? scheme?.error ?? BRAND_PALETTE_DEFAULTS.error,
  };
  return { palette, contrast };
}

export function resolveBrandPalette(stored: unknown, themePrimary: string | null, themeColor: string | null): BrandPalette {
  return resolveBrandPaletteDetailed(stored, themePrimary, themeColor).palette;
}

// --- Resolved brand GRADIENTS -----------------------------------------------
// The tenant's explicit gradient washes, resolved from the stored config. A
// surface appears here ONLY when both of its stops are stored (the activation
// rule — see the BrandConfig fields); everything else stays undefined, which the
// guest pages read as "render the shipped derived wash". The angle falls back to
// the surface's shipped angle (BRAND_GRADIENT_ANGLE_DEFAULTS), so "stops without
// an angle" points exactly where the design already points.
export interface BrandGradient {
  from: string;
  to: string;
  angle: number;
}
export interface BrandGradients {
  header?: BrandGradient;
  button?: BrandGradient;
  background?: BrandGradient;
}

export function resolveBrandGradients(stored: unknown): BrandGradients {
  const c = sanitizeBrandConfigInput(stored);
  const grad = (from: string | undefined, to: string | undefined, angle: number | undefined, dflt: number): BrandGradient | undefined =>
    from && to ? { from, to, angle: angle ?? dflt } : undefined;
  const out: BrandGradients = {};
  const header = grad(c.header_grad_from, c.header_grad_to, c.header_grad_angle, BRAND_GRADIENT_ANGLE_DEFAULTS.header_grad_angle);
  const button = grad(c.button_grad_from, c.button_grad_to, c.button_grad_angle, BRAND_GRADIENT_ANGLE_DEFAULTS.button_grad_angle);
  const background = grad(c.bg_grad_from, c.bg_grad_to, c.bg_grad_angle, BRAND_GRADIENT_ANGLE_DEFAULTS.bg_grad_angle);
  if (header) {out.header = header;}
  if (button) {out.button = button;}
  if (background) {out.background = background;}
  return out;
}

// The live/legacy split + option lists + preset scheme metadata, returned by
// GetRestaurantSettings and SetRestaurantSettings so both editors read it all
// from one place instead of hardcoding any of it.
export interface BrandFieldMeta {
  brand_fields: { live: string[]; legacy: string[] };
  brand_field_options: {
    font: string[];
    header_style: string[];
    button_shape: string[];
    surface_style: string[];
    scheme: string[];
    font_scale: string[];
    card_shape: string[];
  };
  brand_color_fields: string[];
  brand_field_defaults: Record<string, string>;
  brand_schemes: BrandSchemeMeta[];
  /**
   * The gradient surfaces and the exact keys each one is edited through, so the
   * editors (web + app) BUILD their gradient controls from this table instead of
   * hardcoding key names — a surface added here grows a control everywhere
   * without a client hardcoding a thing.
   */
  brand_gradient_fields: { id: string; label: string; from: string; to: string; angle: string; angle_default: number }[];
}

export function brandFieldMeta(): BrandFieldMeta {
  return {
    brand_fields: { live: [...BRAND_LIVE_FIELDS], legacy: [...BRAND_LEGACY_FIELDS] },
    brand_field_options: {
      font: [...BRAND_FONTS],
      header_style: [...BRAND_HEADER_STYLES],
      button_shape: [...BRAND_BUTTON_SHAPES],
      surface_style: [...BRAND_SURFACE_STYLES],
      scheme: [...BRAND_SCHEME_IDS],
      font_scale: [...BRAND_FONT_SCALES],
      card_shape: [...BRAND_CARD_SHAPES],
    },
    brand_color_fields: [...BRAND_COLOR_KEYS],
    brand_field_defaults: {
      color_primary: BRAND_DEFAULT_PRIMARY,
      // Derived from color_primary when unset — the literal here is the value for
      // the DEFAULT primary, so the editor always has something to show.
      color_secondary: resolveBrandPalette(null, null, null).secondary,
      color_accent: resolveBrandPalette(null, null, null).accent,
      color_bg: BRAND_PALETTE_DEFAULTS.background,
      color_card: BRAND_PALETTE_DEFAULTS.surface,
      color_text: BRAND_PALETTE_DEFAULTS.text,
      color_success: BRAND_PALETTE_DEFAULTS.success,
      color_warning: BRAND_PALETTE_DEFAULTS.warning,
      color_error: BRAND_PALETTE_DEFAULTS.error,
      font: "Inter",
      header_style: "gradient",
      button_shape: "rounded",
      surface_style: "frosted",
      scheme: "classic",
      font_scale: "medium",
      card_shape: "rounded",
      // Angles only: the stops have NO default on purpose — an absent gradient
      // is the contract for "render the shipped derived wash".
      header_grad_angle: String(BRAND_GRADIENT_ANGLE_DEFAULTS.header_grad_angle),
      button_grad_angle: String(BRAND_GRADIENT_ANGLE_DEFAULTS.button_grad_angle),
      bg_grad_angle: String(BRAND_GRADIENT_ANGLE_DEFAULTS.bg_grad_angle),
    },
    brand_schemes: BRAND_SCHEMES.map((s) => ({ ...s, preview: { ...s.preview } })),
    brand_gradient_fields: [
      { id: "header", label: "Header wash", from: "header_grad_from", to: "header_grad_to", angle: "header_grad_angle", angle_default: BRAND_GRADIENT_ANGLE_DEFAULTS.header_grad_angle },
      { id: "button", label: "Buttons", from: "button_grad_from", to: "button_grad_to", angle: "button_grad_angle", angle_default: BRAND_GRADIENT_ANGLE_DEFAULTS.button_grad_angle },
      { id: "background", label: "Page background", from: "bg_grad_from", to: "bg_grad_to", angle: "bg_grad_angle", angle_default: BRAND_GRADIENT_ANGLE_DEFAULTS.bg_grad_angle },
    ],
  };
}
