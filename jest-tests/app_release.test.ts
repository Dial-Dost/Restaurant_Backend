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

	test("every non-empty download URL is absolute https", () => {
		// update_checker.dart refuses anything not starting with http, and a
		// relative path here would silently disable in-app install.
		// Collected rather than asserted per-iteration so a failure names WHICH
		// platform is wrong; jest's expect takes no message argument.
		const bad = Object.entries(APP_RELEASE.downloads)
			.filter(([, url]) => url !== "") // a platform with no build is legitimate
			.filter(([, url]) => !/^https:\/\//.test(url) || !url.includes("/downloads/"))
			.map(([platform, url]) => `${platform}: ${url}`);
		expect(bad).toEqual([]);
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
