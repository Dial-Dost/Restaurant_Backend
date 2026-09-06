import { APP_RELEASE, inertReleaseEnv, resolveAppRelease, warnAboutLegacyReleaseEnv } from "../app_release.js";

/**
 * The release manifest is how every installed owner app learns a new build
 * exists. Its failure mode is silence: get it wrong and nothing errors, no
 * alarm fires, and clients simply never update — which is indistinguishable
 * from "nobody has released anything" until someone notices the fleet is
 * months behind.
 *
 * So the shape is pinned, and so is the env-override contract that lets an
 * operator pull a bad release without waiting for a deploy.
 */
describe("app release manifest", () => {
	const KEYS = [
		"APP_RELEASE_PIN_VERSION", "APP_RELEASE_PIN_MIN", "APP_RELEASE_PIN_NOTES",
		"APP_RELEASE_PIN_WINDOWS", "APP_RELEASE_PIN_ANDROID", "APP_RELEASE_PIN_IOS",
		// The legacy names, cleared too: the point of the test below is that they
		// are INERT, and a stray one in the developer's own env would mask that.
		"APP_LATEST_VERSION", "APP_MIN_VERSION", "APP_UPDATE_NOTES",
		"APP_DOWNLOAD_WINDOWS", "APP_DOWNLOAD_ANDROID", "APP_DOWNLOAD_IOS",
	] as const;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; }
		}
	});

	test("serves the shipped release when nothing is overridden", () => {
		expect(resolveAppRelease()).toEqual(APP_RELEASE);
	});

	test("the shipped version is a real dotted version, not a placeholder", () => {
		// The old env-driven handler fell back to "1.0.0", which is BELOW every
		// build ever shipped — so a box with the variable unset told every client
		// it was already current, forever, in total silence.
		expect(APP_RELEASE.latest).toMatch(/^\d+\.\d+\.\d+$/);
		expect(APP_RELEASE.latest).not.toBe("1.0.0");
	});

	test("every non-empty download URL is absolute https and names a real file", () => {
		// update_checker.dart refuses anything not starting with http, and a
		// relative path here would silently disable in-app install.
		//
		// The old form of this test also required the URL to contain
		// "/downloads/", which was a proxy for "points at a file, not a bare
		// origin" back when the artifacts were committed to the dashboard's
		// public/downloads/. They are GitHub release assets now, so that literal
		// no longer appears — the check below tests the actual property that
		// mattered (a real filename with the platform's extension) rather than
		// the path that used to imply it.
		//
		// Collected rather than asserted per-iteration so a failure names WHICH
		// platform is wrong; jest's expect takes no message argument.
		const EXPECTED_EXT: Record<string, string> = {
			windows: ".zip",
			android: ".apk",
			ios: ".ipa",
		};
		const bad = Object.entries(APP_RELEASE.downloads)
			.filter(([, url]) => url !== "") // a platform with no build is legitimate
			.filter(([platform, url]) => {
				if (!/^https:\/\//.test(url)) { return true; }
				const path = new URL(url).pathname;
				// A filename, not a directory or a bare origin.
				const file = path.slice(path.lastIndexOf("/") + 1);
				return file === "" || !file.endsWith(EXPECTED_EXT[platform] ?? "");
			})
			.map(([platform, url]) => `${platform}: ${url}`);
		expect(bad).toEqual([]);
	});

	test("a release-asset URL is pinned to the version being advertised", () => {
		// THE DESYNC THIS PREVENTS. `latest` and the download URLs are two
		// statements of the same fact. Once the URLs carry the tag in the path,
		// bumping one without the other makes the dialog offer "1.8.5" while
		// handing the client the 1.8.4 artifact — which installs happily, reports
		// itself as out of date, and offers the same update again on every launch,
		// forever. Nothing errors; the fleet just stops moving.
		//
		// SCOPED TO RELEASE-ASSET URLS ON PURPOSE. The manifest still points at the
		// dashboard-hosted files, which carry no version in the path because they
		// are overwritten in place each release. Asserting the pin unconditionally
		// would fail on the URLs that are actually live and correct — so this
		// checks the rule for the form it applies to, and the test below keeps the
		// two forms from being mixed.
		const pinned = Object.entries(APP_RELEASE.downloads)
			.filter(([, url]) => url !== "" && url.includes("/releases/download/"))
			.filter(([, url]) => !url.includes(`/v${APP_RELEASE.latest}/`))
			.map(([platform, url]) => `${platform}: ${url}`);
		expect(pinned).toEqual([]);
	});

	test("every platform is served from ONE host, not a mix", () => {
		// Half-migrating (windows on release assets, android still on the
		// dashboard) is the state that looks fine in review and leaves one
		// platform 404ing. Whichever host is chosen, both must use it.
		const hosts = new Set(
			Object.values(APP_RELEASE.downloads)
				.filter((u) => u !== "")
				.map((u) => new URL(u).host),
		);
		expect([...hosts]).toHaveLength(1);
	});

	test("windows and android both have a build", () => {
		// iOS legitimately has none. These two do not: they are the shipped
		// platforms, and an empty URL here is a release that cannot install.
		expect(APP_RELEASE.downloads.windows).not.toBe("");
		expect(APP_RELEASE.downloads.android).not.toBe("");
	});

	test("min_supported never exceeds latest", () => {
		// Otherwise every client is hard-gated into an upgrade that does not
		// exist yet — the whole fleet locked out mid-service.
		const cmp = (a: string, b: string) => {
			const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
			for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) { return (pa[i] ?? 0) - (pb[i] ?? 0); } }
			return 0;
		};
		expect(cmp(APP_RELEASE.min_supported, APP_RELEASE.latest)).toBeLessThanOrEqual(0);
	});

	test("a pin still wins, field by field — the incident escape hatch", () => {
		process.env.APP_RELEASE_PIN_VERSION = "9.9.9";
		const r = resolveAppRelease();
		expect(r.latest).toBe("9.9.9");
		// ...and overriding one field must not blank the others.
		expect(r.downloads.windows).toBe(APP_RELEASE.downloads.windows);
		expect(r.notes).toBe(APP_RELEASE.notes);
	});

	test("a blank or whitespace env var is treated as unset, not as an empty release", () => {
		// A stray `APP_DOWNLOAD_WINDOWS=` in a .env would otherwise erase the
		// download URL and quietly break in-app install on that platform.
		process.env.APP_RELEASE_PIN_WINDOWS = "   ";
		process.env.APP_RELEASE_PIN_VERSION = "";
		const r = resolveAppRelease();
		expect(r.downloads.windows).toBe(APP_RELEASE.downloads.windows);
		expect(r.latest).toBe(APP_RELEASE.latest);
	});

	test("notes CAN be deliberately blanked, unlike the other fields", () => {
		// Stripping a wrong changelog in a hurry is legitimate; an empty download
		// URL never is. This asymmetry is intentional — see resolveAppRelease.
		process.env.APP_RELEASE_PIN_NOTES = "";
		expect(resolveAppRelease().notes).toBe("");
	});

	// THE BUG THIS FILE EXISTS TO PREVENT A REPEAT OF. The first version of this
	// module let the LEGACY names win. Those variables are already set on the
	// production box, so the code manifest was shadowed and the first "automated"
	// release still needed someone to SSH in and delete six variables — the exact
	// manual step the module was written to remove. Verified live: the deploy
	// succeeded and /app/version still served the previous version.
	test("the legacy APP_* variables are INERT and cannot shadow the shipped release", () => {
		process.env.APP_LATEST_VERSION = "0.0.1";
		process.env.APP_UPDATE_NOTES = "stale notes from a box provisioned in 2026";
		process.env.APP_DOWNLOAD_WINDOWS = "https://example.invalid/old.zip";
		const r = resolveAppRelease();
		expect(r.latest).toBe(APP_RELEASE.latest);
		expect(r.notes).toBe(APP_RELEASE.notes);
		expect(r.downloads.windows).toBe(APP_RELEASE.downloads.windows);
	});

	test("a set-but-inert legacy variable is reported, so nobody debugs it blind", () => {
		process.env.APP_LATEST_VERSION = "0.0.1";
		expect(inertReleaseEnv()).toContain("APP_LATEST_VERSION");
		const warned: string[] = [];
		warnAboutLegacyReleaseEnv({ warn: (_o, m) => warned.push(m) });
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("APP_LATEST_VERSION");
		expect(warned[0]).toContain("APP_RELEASE_PIN_VERSION");
	});

	test("nothing is logged when no legacy variable is set", () => {
		const warned: string[] = [];
		warnAboutLegacyReleaseEnv({ warn: (_o, m) => warned.push(m) });
		expect(warned).toEqual([]);
	});
});
