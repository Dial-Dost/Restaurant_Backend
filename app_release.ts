/**
 * THE OWNER-APP RELEASE MANIFEST — the thing `/app/version` serves.
 *
 * WHY THIS IS CODE AND NOT ENV. It used to live entirely in environment
 * variables on the VPS, which meant shipping an app update was: build the
 * artifacts, push them, then SSH to the box as root and edit `.env`. Everything
 * up to that last step was automated; the last step needed a human with server
 * access, so every release stalled there — and a release that is half-automated
 * is one somebody eventually does at 11pm from a phone.
 *
 * As a module it is baked into the image by the existing build (`build/` is
 * copied wholesale in Dockerfile.node), so the ordinary deploy pipeline ships
 * it. Releasing the app becomes: commit the artifacts, bump the version here,
 * push. No box access, no separate runbook step.
 *
 * THE OVERRIDE USES NEW NAMES, AND THAT IS THE WHOLE POINT. The obvious design
 * — keep reading APP_LATEST_VERSION and let env win — is wrong here, and I
 * shipped it once before catching it: those variables are ALREADY SET on the
 * box, so env would shadow this file and the first "automated" release would
 * still have needed someone to SSH in and delete six variables. That is the
 * exact manual step this exists to remove.
 *
 * So the code is the default and the escape hatch is APP_RELEASE_PIN_* — names
 * nothing currently sets. An operator can still pull a bad release or force an
 * upgrade without waiting for CI; they just say so explicitly. The legacy
 * variables are now INERT, which is a footgun if discovered at 2am, so
 * `warnAboutLegacyReleaseEnv` logs them at boot by name.
 *
 * WHERE THE ARTIFACTS LIVE, AND WHY THAT MOVED. They used to be committed into
 * Restaurant_Dashboard_UI/public/downloads/ — ~115MB of binaries into git per
 * release, and a second repository CI would have needed a write token for. They
 * are now GitHub RELEASE ASSETS of the owner-app repo, published by that repo's
 * `Release clients` workflow, which also proves the production URLs are baked in
 * and that the APK carries the same signing certificate as the build already in
 * the field. See restaurant_owner_app/docs/RELEASE.md.
 *
 * The URLs below are DERIVED from `latest` rather than written out, so bumping
 * the version cannot leave them pointing at the previous build's assets. That
 * desync is silent in the worst direction: the dialog offers "1.8.5" and hands
 * the client 1.8.4, which then reports itself as out of date and offers the same
 * update again on every launch.
 *
 * ORDER OF OPERATIONS WHEN RELEASING, and it matters:
 *   1. Bump `version:` in the owner app's pubspec.yaml and tag it `v<version>`.
 *      The workflow refuses a tag that disagrees with pubspec.
 *   2. Let the workflow finish. It builds both clients with the production
 *      dart-defines, asserts the API host is really in the binary (config.dart
 *      defaults to localhost), asserts the Windows zip is flat, asserts the APK
 *      signature, and publishes the two assets under that tag. The files must be
 *      DOWNLOADABLE first.
 *   3. Only then bump `latest` here and push. The reverse order points every
 *      client at a download that 404s.
 */

/**
 * Where the built clients are published. Kept next to the version it is joined
 * to: these two lines are the whole release, and splitting them is how they
 * drift apart.
 *
 * The tag is `v${latest}` and the asset filenames are fixed by the workflow's
 * WINDOWS_ASSET / ANDROID_ASSET — renaming one there 404s every client that
 * reads this manifest.
 */
const OWNER_APP_REPO = "https://github.com/Dial-Dost/restaurant_owner_app";

/** Where a published GitHub release asset lives, once the workflow has made one. */
const releaseAsset = (version: string, file: string): string =>
	`${OWNER_APP_REPO}/releases/download/v${version}/${file}`;

/**
 * The dashboard-hosted artifacts, which is where the CLIENTS IN THE FIELD
 * actually download from today.
 *
 * NOT YET SWITCHED TO releaseAsset(), deliberately. The `Release clients`
 * workflow that publishes GitHub release assets has never run — there are no
 * tags and no releases in the owner-app repo — so every releaseAsset() URL is
 * currently a 404. Pointing the manifest at them would break in-app update for
 * the whole fleet, and it would break it in the file that documents
 * "artifacts first, manifest second" three paragraphs above.
 *
 * THE SWITCH IS ONE LINE, and the order is: add the signing secrets, let the
 * workflow publish v<version> once, confirm both asset URLs return 200, THEN
 * change these two to releaseAsset(LATEST, …) and push. Until that has
 * happened, these files are the live download and are served from the
 * dashboard's public/downloads/.
 */
const dashboardAsset = (file: string): string =>
	`https://experiosolutions.dialdost.com/downloads/${file}`;

/** The version the manifest advertises. Bump this and the URLs follow. */
const LATEST = "2.0.1";

/** One platform's download URL, or "" when that platform has no build. */
export interface AppDownloads {
	windows: string;
	android: string;
	ios: string;
}

export interface AppReleaseManifest {
	latest: string;
	/** Clients older than this are hard-gated into updating. */
	min_supported: string;
	notes: string;
	downloads: AppDownloads;
}

/**
 * The shipped release. Bump `latest` and rewrite `notes` in the same commit that
 * lands the artifacts; that commit IS the release.
 *
 * `notes` is read by a restaurant owner, not a developer: say what changed for
 * them, in their words, and skip the internals.
 */
export const APP_RELEASE: AppReleaseManifest = {
	latest: LATEST,
	// Not a hard gate. Raise this only to force an upgrade off a build that is
	// genuinely broken — it takes the choice away from the owner mid-service.
	min_supported: "0.0.0",
	notes:
		"The kitchen ticket now looks like your reference KOT, in its own typeface, and you can choose Small, "+
		"Standard or Large text in Settings (or switch back to the old text ticket if a kitchen printer prints it "+
		"blank). A held dish now just says [Hold]. When a bill has been printed, the waiter sees the same table "+
		"number marked Next party for the next guests. Settle as NC is now a way to close a bill, and NC bills "+
		"show in reports. The reason is optional when removing a service charge, and the clear button in the "+
		"order search now clears the text.",
	downloads: {
		windows: dashboardAsset("RestaurantDash-Windows.zip"),
		android: dashboardAsset("RestaurantDash-Android.apk"),
		// No iOS build exists. "" is the honest answer and update_checker.dart
		// treats it as "no in-app download for this platform".
		ios: "",
	},
};

/** A trimmed env override, or undefined when the variable is unset or blank. */
function envOverride(name: string): string | undefined {
	const raw = process.env[name];
	if (typeof raw !== "string") { return undefined; }
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The variables this file replaced. They may still be set on a box provisioned
 * before it, where they now do NOTHING — so say so once, loudly, at boot. A
 * silently ignored setting is how someone spends an incident editing a file
 * that cannot help them.
 */
export const LEGACY_RELEASE_ENV = [
	"APP_LATEST_VERSION", "APP_MIN_VERSION", "APP_UPDATE_NOTES",
	"APP_DOWNLOAD_WINDOWS", "APP_DOWNLOAD_ANDROID", "APP_DOWNLOAD_IOS",
] as const;

/** Names of legacy release variables that are set and now inert. */
export function inertReleaseEnv(): string[] {
	return LEGACY_RELEASE_ENV.filter((n) => typeof process.env[n] === "string" && process.env[n]!.trim().length > 0);
}

/**
 * The manifest as served. The CODE above is the default; an APP_RELEASE_PIN_*
 * variable overrides exactly one field, so an operator pulling a bad release
 * does not have to restate the other five. The legacy APP_* names are NOT read
 * here — see the header for why that inversion is the entire point.
 */
export function resolveAppRelease(): AppReleaseManifest {
	return {
		latest: envOverride("APP_RELEASE_PIN_VERSION") ?? APP_RELEASE.latest,
		min_supported: envOverride("APP_RELEASE_PIN_MIN") ?? APP_RELEASE.min_supported,
		// Deliberately ?? and not ||: setting the pin to an empty string is asking
		// for NO notes, and blanking a wrong changelog in a hurry is legitimate.
		// envOverride treats whitespace-only as unset, so "" here is a choice.
		notes: process.env.APP_RELEASE_PIN_NOTES ?? APP_RELEASE.notes,
		downloads: {
			windows: envOverride("APP_RELEASE_PIN_WINDOWS") ?? APP_RELEASE.downloads.windows,
			android: envOverride("APP_RELEASE_PIN_ANDROID") ?? APP_RELEASE.downloads.android,
			ios: envOverride("APP_RELEASE_PIN_IOS") ?? APP_RELEASE.downloads.ios,
		},
	};
}

/**
 * Log once, at boot, if a legacy release variable is still set. It no longer
 * does anything, and finding that out during an incident — after editing it and
 * restarting and seeing no change — is the worst possible moment.
 */
export function warnAboutLegacyReleaseEnv(log: { warn: (o: unknown, m: string) => void }): void {
	const inert = inertReleaseEnv();
	if (inert.length === 0) { return; }
	log.warn(
		{ inert, replacement: "APP_RELEASE_PIN_*" },
		`These release variables are set but NO LONGER READ: ${inert.join(", ")}. ` +
		"The shipped manifest now lives in app_release.ts and ships with the deploy. " +
		"To override a field without deploying, use APP_RELEASE_PIN_VERSION / _MIN / _NOTES / " +
		"_WINDOWS / _ANDROID / _IOS. The old variables can be deleted from .env at your leisure.",
	);
}
