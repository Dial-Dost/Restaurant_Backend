/**
 * Restaurant-level configuration: branding, logo (raw + ESC/POS), timezones,
 * settings read/write and the restaurant profile.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, GetPublicBranding, GetRestaurantLogo, GetRestaurantProfile, GetRestaurantSettings, SetBranding, SetRestaurantSettings, UpdateRestaurantProfile } from "../database_supabase.js";
import { BILL_LOGO_SVG_MAX_CHARS, billLogoDots, billLogoInkShare, cleanBillLogoSvg, rasterizeBillLogo } from "../bill_logo.js";
import { logger } from "../observability.js";
import { uploadMenuImage } from "../storage_bucket_supabase.js";
import { PERM_BRANDING, PERM_SETTINGS, buildBillLogoRaster, buildLogoEscPos, callerHasPermission, enforcePermission, extractEmployeeId, extractRestaurantId, log_audit, validate, validateAction } from "./_shared.js";


// Set the restaurant's customer-facing branding (logo + theme color). Accepts a
// logo as a hosted URL or base64 (uploaded server-side).
// Settings/branding keys that must NEVER be copied into an audit entry's
// before-state — credentials would then sit in plain text in the log.
const UNDO_SECRET_SETTING_KEYS = new Set(["razorpay_key_secret", "msg_key_secret", "msg_webhook_secret"]);

// Diff two settings snapshots into an undo envelope covering ONLY the keys that
// actually changed. Returns null when nothing reversible changed.
function buildSettingsUndo(priorIn: unknown, nextIn: unknown): Record<string, unknown> | null {
	// Accept any settings-shaped object (interfaces lack an index signature, so we
	// widen at the boundary and treat the payloads as key bags for the diff).
	const prior = priorIn as Record<string, unknown> | null;
	const next = (nextIn ?? {}) as Record<string, unknown>;
	if (!prior) {return null;}
	const before: Record<string, unknown> = {};
	const after: Record<string, unknown> = {};
	for (const key of Object.keys(next)) {
		if (UNDO_SECRET_SETTING_KEYS.has(key)) {continue;}
		if (JSON.stringify(prior[key] ?? null) === JSON.stringify(next[key] ?? null)) {continue;}
		before[key] = prior[key] ?? null;
		after[key] = next[key] ?? null;
	}
	if (Object.keys(after).length === 0) {return null;}
	return { kind: "restaurant_settings", target_id: null, before, after };
}

// Diff two branding snapshots. Top-level fields keep their own names; every
// other key comes from brand_config and is restored back into it.
function buildBrandingUndo(
	priorIn: unknown,
	nextIn: unknown,
): Record<string, unknown> | null {
	// Callers pass richer branding snapshots (GetPublicBranding / SetBranding
	// results whose brand_config is a typed interface); widen at the boundary.
	type BrandingSnap = { logo_url: string | null; theme_color: string | null; queue_show_menu: boolean; brand_config: Record<string, unknown> };
	const prior = priorIn as BrandingSnap | null;
	const next = nextIn as BrandingSnap;
	if (!prior) {return null;}
	const before: Record<string, unknown> = {};
	const after: Record<string, unknown> = {};
	const put = (key: string, a: unknown, b: unknown) => {
		if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) {return;}
		before[key] = a ?? null;
		after[key] = b ?? null;
	};
	put("logo_url", prior.logo_url, next.logo_url);
	put("theme_color", prior.theme_color, next.theme_color);
	put("queue_show_menu", prior.queue_show_menu, next.queue_show_menu);
	for (const key of Object.keys(next.brand_config ?? {})) {
		put(key, (prior.brand_config ?? {})[key], (next.brand_config ?? {})[key]);
	}
	if (Object.keys(after).length === 0) {return null;}
	return { kind: "branding", target_id: null, before, after };
}

// Settings fields that are CREDENTIALS or fraud-detection thresholds. The rest
// of the document is operational (currency, taxes, service charge, printing,
// kitchen sections, timezone…) and every POS/KDS screen reads it, so the GET
// stays open to any authenticated user — but these keys are stripped for anyone
// without PERM_SETTINGS. msg_webhook_secret in particular is the HMAC key that
// authenticates the PUBLIC /webhooks/whatsapp/:slug endpoint.
const SETTINGS_PRIVILEGED_FIELDS = [
	"msg_provider",
	"msg_sender",
	"msg_key_id",
	"msg_secret_configured",
	"msg_webhook_secret",
	"msg_reminder_hours",
	"razorpay_key_id",
	"razorpay_configured",
	"discount_approval_threshold",
	"alert_discount_pct",
	"alert_void_count",
] as const;

function redactRestaurantSettings(settings: Awaited<ReturnType<typeof GetRestaurantSettings>>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...settings };
	for (const key of SETTINGS_PRIVILEGED_FIELDS) {
		delete out[key];
	}
	return out;
}

// --- Restaurant timezone -----------------------------------------------------
// The tenant's IANA zone is the DISPLAY/PARSE zone for every instant the system
// records. Instants themselves are always stored UTC (timestamptz); the zone
// only decides how "2026-07-29T18:30:00Z" is rendered as a wall clock, and how a
// bare reservation wall-clock string is read back into an instant.
//
// The selectable list is seeded from the ICU database the Node runtime already
// carries (Intl.supportedValuesOf), so it stays in step with whatever zones
// Intl.DateTimeFormat will actually accept here — no bundled list to go stale
// and no new dependency.
//
// It cannot be used RAW, though, and this is the trap: supportedValuesOf returns
// only CANONICAL ids, and canonical for India is the legacy alias
// "Asia/Calcutta". Our default — and every existing tenant's stored value — is
// "Asia/Kolkata", which Intl accepts happily but which is NOT in that list. A
// picker built on the raw list would therefore fail to show the value the
// restaurant is actually on. So the stored/known-good zones are unioned in and
// the result is sorted; aliases and their canonical twins both appear and both
// work (they are the same zone).
function supportedTimezones(...alsoInclude: string[]): string[] {
	const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
	let list: string[] = [];
	try {
		const values = typeof supported === "function" ? supported("timeZone") : [];
		if (Array.isArray(values)) {list = values;}
	} catch {/* small-ICU build: the union below still yields a usable minimum */}
	const merged = new Set(list);
	// Always offered: UTC (absent from the canonical list) and the default, plus
	// whatever the caller passes (the tenant's current zone), so the picker can
	// always render the value that is in force.
	for (const tz of ["UTC", "Asia/Kolkata", ...alsoInclude]) {
		if (tz && isValidTimezone(tz)) {merged.add(tz);}
	}
	return [...merged].sort((a, b) => a.localeCompare(b));
}

// True when Intl will accept this zone id — the same check sanitizeTimezone
// makes, but reported instead of silently swallowed, so a typo'd zone is a 400
// rather than an invisible reset to Asia/Kolkata.
function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function registerRestaurantLogoRoutes(app: Express): void {

app.get('/restaurant/logo', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	try {
		const logoBase64 = await GetRestaurantLogo(restaurantId);
		if (!logoBase64) {return res.status(404).json({ error: 'Logo not found' });}
		return res.json({ logo_base64: logoBase64 });
	} catch (err) {
		logger.error({ err }, 'get restaurant logo failed');
		return res.status(500).json({ error: 'Internal' });
	}
});

app.get('/restaurant/logo/escpos', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	try {
		const out = await buildLogoEscPos(restaurantId);
		if (!out) {return res.status(404).json({ error: 'Logo not found' });}
		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Content-Length', String(out.length));
		return res.send(out);
	} catch (err) {
		logger.error({ err }, 'get restaurant escpos failed');
		return res.status(500).json({ error: 'Internal' });
	}
});

// 5.1 — THE LOGO THE BILL PRINTS, FOR THE SCREENS THAT PREVIEW THE BILL.
//
// GET /restaurant/logo is the BRANDING PNG. The roll prints something else: the
// SVG bill logo when the tenant stored one, fitted to THIS tenant's roll and
// thresholded to one bit (bill_logo.ts). A preview drawn off the branding PNG
// showed no logo at all for an SVG-only tenant, and the colour original for
// everyone else. This answers with a PNG of the raster the printer receives, so
// the web print page and the app's bill preview show the paper's own logo.
// 404 when there is none, exactly like /restaurant/logo, so a caller falls back
// the same way for both.
app.get('/restaurant/logo/bill', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	try {
		const settings = await GetRestaurantSettings(restaurantId).catch(() => null);
		const raster = await buildBillLogoRaster(restaurantId, billLogoDots(settings?.bill_paper_width));
		if (!raster) {return res.status(404).json({ error: 'Logo not found' });}
		return res.json({ logo_base64: raster.png.toString('base64'), width: raster.width, height: raster.height });
	} catch (err) {
		logger.error({ err }, 'get restaurant bill logo failed');
		return res.status(500).json({ error: 'Internal' });
	}
});
}


export function registerSettingsRoutes(app: Express): void {

app.post("/restaurant/branding", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_BRANDING))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	let logoUrl: string | undefined = typeof body.logo_url === "string" ? body.logo_url.trim() : undefined;
	const themeColor = typeof body.theme_color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.theme_color)
		? body.theme_color
		: undefined;
	const queueShowMenu = typeof body.queue_show_menu === "boolean" ? body.queue_show_menu : undefined;
	// Customer-page customization object. Live keys are the full palette
	// (color_primary / _secondary / _accent / _bg / _card / _text / _success /
	// _warning / _error) plus font, header_style, button_shape, surface_style and
	// the preset generation: scheme, font_scale, card_shape — see
	// BRAND_LIVE_FIELDS; `brand_fields.legacy` is now empty.
	// Passed through as-is — SetBranding sanitizes it (invalid keys dropped) and
	// merges it onto the stored config (keys omitted here keep their value;
	// colour roles and the three new enum keys sent as null are CLEARED). The
	// response carries brand_contrast when the WCAG guard adjusted the text
	// colour, so the editors can tell the owner.
	const brandConfig = body.brand_config && typeof body.brand_config === "object" ? body.brand_config : undefined;
	try {
		if (!logoUrl && typeof body.logo_base64 === "string" && body.logo_base64.length > 0) {
			const url = await uploadMenuImage(body.logo_base64, typeof body.content_type === "string" ? body.content_type : "image/png");
			if (url) {logoUrl = url;}
		}
		// Snapshot before the write so the undo restores only the branding fields
		// this request changed (SetBranding merges brand_config key-by-key).
		const priorBranding = await GetPublicBranding(restaurantId).catch(() => null);
		const result = await SetBranding(restaurantId, { logo_url: logoUrl ?? null, theme_color: themeColor ?? null, queue_show_menu: queueShowMenu, brand_config: brandConfig });
		const brandingUndo = buildBrandingUndo(priorBranding, result);
		try {
			await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Updated customer-page branding`, Audit_log_category.General, {
				theme_color: result.theme_color,
				logo: !!result.logo_url,
				...(brandingUndo ? { undo: brandingUndo } : {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit branding failed"); }
		res.json(result);
	} catch (err: any) {
		logger.error({ err }, "set_branding_failed");
		res.status(500).json({ error: "Unable to save branding" });
	}
});

// The zones the settings UI offers, plus the one currently in force so the picker
// can preselect it without a second call. Deliberately NOT behind PERM_SETTINGS
// (the zone is how every screen labels its timestamps, not a privileged value) —
// authenticated is enough.
app.get("/restaurant/timezones", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	// The list itself does not depend on the tenant; the current value does, and a
	// failure to read it must not take the picker down.
	const current = restaurantId
		? await GetRestaurantSettings(restaurantId).then((s) => s.timezone).catch(() => "Asia/Kolkata")
		: "Asia/Kolkata";
	res.json({ timezones: supportedTimezones(current), current, default: "Asia/Kolkata" });
});

// Restaurant operational settings (e.g. push orders straight to kitchen vs. require approval).
app.get("/restaurant/settings", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const settings = await GetRestaurantSettings(restaurantId);
		// Same gate as the POST: the full document is admin-only. Non-holders get
		// the operational subset with the credentials/thresholds removed.
		res.json(callerHasPermission(req, PERM_SETTINGS) ? settings : redactRestaurantSettings(settings));
	}
	catch (err) { logger.error({ err }, "get_settings_failed"); res.status(500).json({ error: "Unable to load settings" }); }
});

app.post("/restaurant/settings", validate, async (req: Request, res: Response) => {
	// Settings hold payment keys, taxes and operational toggles — admin-only.
	if (!(await enforcePermission(req, res, PERM_SETTINGS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	// AN SVG BILL LOGO IS CHECKED HERE, AND REFUSED OUT LOUD.
	//
	// It used to be sanitized deep in the data layer to "" when it failed a check
	// — stored as NULL, answered 200 — so the app said "Bill logo saved." over an
	// empty card and no owner could tell why. Now the three ways an upload can be
	// unusable each come back as a 400 with a sentence the app shows as-is:
	// not an SVG, too large, or an SVG that prints as nothing (it cannot be drawn,
	// or it is white/very light and thresholds to blank paper). Sending "" still
	// clears the logo, exactly as before.
	if (typeof body.bill_logo_svg === "string" && body.bill_logo_svg.trim()) {
		const cleaned = cleanBillLogoSvg(body.bill_logo_svg);
		if (!cleaned.ok) {
			res.status(400).json({
				error: "Invalid bill logo",
				details: cleaned.reason === "too_large"
					? `That SVG is too large (over ${Math.round(BILL_LOGO_SVG_MAX_CHARS / 1000)} KB). Export a simpler version of the logo and try again.`
					: "That file is not an SVG logo. Export the logo as .svg from your design tool and choose that file.",
			});
			return;
		}
		const raster = await rasterizeBillLogo(Buffer.from(cleaned.svg, "utf8"), billLogoDots("80mm"));
		if (!raster || billLogoInkShare(raster) === 0) {
			res.status(400).json({
				error: "Invalid bill logo",
				details: !raster
					? "That SVG could not be drawn for printing. Try exporting it again with text converted to outlines."
					: "That logo prints as blank paper: it is white or very light. Bills print in black only, so choose a dark version of the logo.",
			});
			return;
		}
	}
	// Reject an unknown zone instead of letting sanitizeTimezone quietly coerce it
	// to Asia/Kolkata: the owner would see the save succeed and every timestamp
	// keep rendering in the wrong zone with nothing to explain it. Only validated
	// when the caller actually sent the key — omitting it still means "unchanged".
	// The trimmed id is written back onto the payload so that is what gets saved.
	if (body.timezone !== undefined) {
		const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
		if (!tz || !isValidTimezone(tz)) {
			res.status(400).json({
				error: `"${String(body.timezone)}" is not a known IANA timezone. Use an id like "Asia/Kolkata" or "America/New_York" — see GET /restaurant/timezones for the full list.`,
			});
			return;
		}
		body.timezone = tz;
	}
	try {
		// Snapshot before the write so the undo can restore ONLY the keys this
		// request actually changed (never the whole settings document).
		const priorSettings = await GetRestaurantSettings(restaurantId).catch(() => null);
		const result = await SetRestaurantSettings(restaurantId, {
			auto_push_orders: typeof body.auto_push_orders === "boolean" ? body.auto_push_orders : undefined,
			currency: typeof body.currency === "string" ? body.currency : undefined,
			payment_methods: Array.isArray(body.payment_methods) ? body.payment_methods : undefined,
			taxes: Array.isArray(body.taxes) ? body.taxes : undefined,
			razorpay_key_id: typeof body.razorpay_key_id === "string" ? body.razorpay_key_id : undefined,
			razorpay_key_secret: typeof body.razorpay_key_secret === "string" ? body.razorpay_key_secret : undefined,
			service_charge: typeof body.service_charge === "number" ? body.service_charge : undefined,
			discount_approval_threshold: typeof body.discount_approval_threshold === "number" ? body.discount_approval_threshold : undefined,
			bill_reopen_window_min: typeof body.bill_reopen_window_min === "number" ? body.bill_reopen_window_min : undefined,
			alert_discount_pct: typeof body.alert_discount_pct === "number" ? body.alert_discount_pct : undefined,
			alert_void_count: typeof body.alert_void_count === "number" ? body.alert_void_count : undefined,
			loyalty_earn_per_100: typeof body.loyalty_earn_per_100 === "number" ? body.loyalty_earn_per_100 : undefined,
			loyalty_point_value: typeof body.loyalty_point_value === "number" ? body.loyalty_point_value : undefined,
			booking_deposit_amount: typeof body.booking_deposit_amount === "number" ? body.booking_deposit_amount : undefined,
			booking_deposit_min_party: typeof body.booking_deposit_min_party === "number" ? body.booking_deposit_min_party : undefined,
			booking_cancel_window_hours: typeof body.booking_cancel_window_hours === "number" ? body.booking_cancel_window_hours : undefined,
			booking_min_spend: typeof body.booking_min_spend === "number" ? body.booking_min_spend : undefined,
			msg_provider: typeof body.msg_provider === "string" ? body.msg_provider : undefined,
			msg_sender: typeof body.msg_sender === "string" ? body.msg_sender : undefined,
			msg_key_id: typeof body.msg_key_id === "string" ? body.msg_key_id : undefined,
			msg_key_secret: typeof body.msg_key_secret === "string" ? body.msg_key_secret : undefined,
			msg_reminder_hours: typeof body.msg_reminder_hours === "number" ? body.msg_reminder_hours : undefined,
			feedback_config: body.feedback_config !== undefined ? body.feedback_config : undefined,
			bill_logo_svg: body.bill_logo_svg !== undefined ? body.bill_logo_svg : undefined,
			bill_paper_width: body.bill_paper_width !== undefined ? body.bill_paper_width : undefined,
			// Printed-bill header identity + the custom sentence above the bill QR.
			// Presence-checked, not truthiness-checked: sending "" is how an owner
			// CLEARS a field (and clearing bill_qr_note restores the built-in valet
			// line), so an empty string has to reach the data layer.
			bill_legal_name: body.bill_legal_name !== undefined ? body.bill_legal_name : undefined,
			bill_gstin: body.bill_gstin !== undefined ? body.bill_gstin : undefined,
			bill_qr_note: body.bill_qr_note !== undefined ? body.bill_qr_note : undefined,
			kitchen_sections: Array.isArray(body.kitchen_sections) ? body.kitchen_sections : undefined,
			inventory_categories: Array.isArray(body.inventory_categories) ? body.inventory_categories : undefined,
			timezone: typeof body.timezone === "string" ? body.timezone : undefined,
			require_table_otp: typeof body.require_table_otp === "boolean" ? body.require_table_otp : undefined,
			// Whether barking an order also prints its kitchen docket (migration
			// 040). undefined leaves the stored value alone; only an explicit
			// boolean writes, so a client that has never heard of this setting
			// cannot silently turn it off by omitting it.
			kot_auto_print: typeof body.kot_auto_print === "boolean" ? body.kot_auto_print : undefined,
			// Whether the customer bill prints the feedback/valet QR (bill_show_qr).
			// Same rule: only an explicit boolean writes.
			bill_show_qr: typeof body.bill_show_qr === "boolean" ? body.bill_show_qr : undefined,
		});
		const settingsUndo = buildSettingsUndo(priorSettings, result);
		try {
			await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Updated restaurant settings`, Audit_log_category.General, {
				auto_push_orders: result.auto_push_orders,
				currency: result.currency,
				...(settingsUndo ? { undo: settingsUndo } : {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit settings failed"); }
		res.json(result);
	} catch (err) {
		logger.error({ err }, "set_settings_failed");
		res.status(500).json({ error: "Unable to save settings" });
	}
});
}


export function registerRestaurantProfileReadRoute(app: Express): void {

app.get("/restaurant/profile", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = extractEmployeeId(req) ?? undefined;
	try {
		const profile = await GetRestaurantProfile(restaurantId, employeeId);
		res.json(profile);
	} catch (error) {
		logger.error({ err: error }, "get_restaurant_profile_failed");
		res.status(500).json({ error: "Unable to fetch profile" });
	}
});
}


export function registerRestaurantProfileWriteRoute(app: Express): void {

app.put("/restaurant/profile", validateAction("60d14e9c-45cc-4dc2-b017-56058cc3ae33"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	// Accept BOTH the short shape sent by the owner app ({name,address,phone,
	// email,hours}) and the long RestaurantProfileRecord shape sent by the web
	// ({restaurant_name,outlet_add,outlet_phone,email,outlet_hours,…}). Previously
	// the endpoint only accepted the short keys while the data layer read the long
	// ones, so the app 500'd ("Unable to update profile") and the web silently
	// no-op'd — this normalizes the two into one record.
	const b = (req.body ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const restaurant_name = (str(b.name) ?? str(b.restaurant_name) ?? "").trim();
	const outlet_add = (str(b.address) ?? str(b.outlet_add) ?? "").trim();
	const outlet_phone = (str(b.phone) ?? str(b.outlet_phone) ?? "").trim();
	const email = (str(b.email) ?? "").trim();
	const outlet_hours = (str(b.hours) ?? str(b.outlet_hours) ?? "").trim();

	if (!restaurant_name) {
		res.status(400).json({ error: "Restaurant name is required" });
		return;
	}

	const employeeId = extractEmployeeId(req) ?? undefined;
	try {
		await UpdateRestaurantProfile(restaurantId, { restaurant_name, outlet_add, outlet_phone, outlet_hours, email }, employeeId);
		res.json({ success: true });
	} catch (error) {
		logger.error({ err: error }, "update_restaurant_profile_failed");
		res.status(500).json({ error: "Unable to update profile" });
	}
});
}
