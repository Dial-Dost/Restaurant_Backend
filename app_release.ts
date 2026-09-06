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
 * THE ENV STILL WINS. Every field below is overridable by its original
 * environment variable, so the operator keeps the ability to change what
 * clients see WITHOUT a deploy — pulling a bad release, or forcing an upgrade
 * during an incident, at a moment when waiting for CI is the wrong answer. This
 * is a default, not a replacement.
 *
 * ORDER OF OPERATIONS WHEN RELEASING, and it matters:
 *   1. Build the clients with the production dart-defines and check the API host
 *      is actually baked in (config.dart defaults to localhost).
 *   2. Commit the artifacts to Restaurant_Dashboard_UI/public/downloads/ and let
 *      that deploy — the files must be DOWNLOADABLE first.
 *   3. Only then bump `latest` here. The reverse order points every client at a
 *      download that 404s.
 */

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
	latest: "1.8.4",
	// Not a hard gate. Raise this only to force an upgrade off a build that is
	// genuinely broken — it takes the choice away from the owner mid-service.
	min_supported: "0.0.0",
	notes:
		"The What-If Simulator is now yours to configure: pick exactly the levers you want to test " +
		"from 34 parameters across pricing, staffing, operations, marketing and overhead. Remove one " +
		"and it quietly goes back to your own numbers rather than zero.",
	downloads: {
		windows: "https://experiosolutions.dialdost.com/downloads/RestaurantDash-Windows.zip",
		android: "https://experiosolutions.dialdost.com/downloads/RestaurantDash-Android.apk",
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
 * The manifest as served. Env beats code, field by field, so an operator can
 * override exactly one thing (pull a release, force an upgrade) without having
 * to restate the rest.
 */
export function resolveAppRelease(): AppReleaseManifest {
	return {
		latest: envOverride("APP_LATEST_VERSION") ?? APP_RELEASE.latest,
		min_supported: envOverride("APP_MIN_VERSION") ?? APP_RELEASE.min_supported,
		// Deliberately ?? and not ||: an operator setting APP_UPDATE_NOTES to an
		// empty string is asking for no notes, and blanking them is a legitimate
		// way to strip a wrong changelog in a hurry. envOverride already treats
		// whitespace-only as unset, so "" here is an explicit choice.
		notes: process.env.APP_UPDATE_NOTES ?? APP_RELEASE.notes,
		downloads: {
			windows: envOverride("APP_DOWNLOAD_WINDOWS") ?? APP_RELEASE.downloads.windows,
			android: envOverride("APP_DOWNLOAD_ANDROID") ?? APP_RELEASE.downloads.android,
			ios: envOverride("APP_DOWNLOAD_IOS") ?? APP_RELEASE.downloads.ios,
		},
	};
}
