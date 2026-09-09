// `GET /me/scorecard` — the REDACTION, which is the only thing about this route
// that can go wrong quietly.
//
// The route exists so a waiter can see their own APC, attendance, guest rating
// and composite score WITHOUT being handed the analytics action, which would
// hand them the whole restaurant. It gets those figures by running the same
// `GetStaffPerformance` an owner runs and returning one row of it — so
// everything the owner's payload carries is, for a moment, in scope, and two
// fields in it are restaurant-wide:
//
//   * `benchmarks` / `component.benchmark` — the house average per cover and the
//     house median turnaround.
//   * the PROSE on two components, which quotes those same figures: "…across 12
//     settled bills (31 covers), against a house average of 612.5."
//
// A leak here would not throw, would not fail a type check and would not look
// wrong on screen — it would simply put the restaurant's average per cover on
// every waiter's phone. Hence this file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";

import {
	HOUSE_COMPARISON_MARKER,
	redactComponent,
	withoutHouseComparison,
} from "../me_scorecard";

// The two notes EXACTLY as GetStaffPerformance builds them, for a waiter with
// twelve settled bills and nine timed tables.
const APC_NOTE =
	"Pre-tax spend per cover across 12 settled bills (31 covers), against a house average of 612.5.";
const TAT_NOTE =
	"Median seated-to-released time over 9 tables, against a house median of 46.5 minutes.";

// The two that carry no house figure and must come through untouched.
const RATING_NOTE = "Average of 9 guest ratings.";
const ATTENDANCE_NOTE =
	"Present on 23 of 25 open days (1 excused by approved leave); 2 late starts against a typical 10:05.";

const component = (note: string, benchmark: number | null) => ({
	value: 612.5,
	score: 88,
	available: true,
	unit: "currency per cover",
	sample: 12,
	benchmark,
	note,
});

describe("withoutHouseComparison", () => {
	test("cuts the house figure out of the APC note and leaves a sentence", () => {
		const out = withoutHouseComparison(APC_NOTE);
		expect(out).toBe("Pre-tax spend per cover across 12 settled bills (31 covers).");
		expect(out).not.toContain("612.5");
		expect(out).not.toContain("house");
		expect(out.endsWith(".")).toBe(true);
	});

	test("does the same for turnaround, whose benchmark is a house median", () => {
		const out = withoutHouseComparison(TAT_NOTE);
		expect(out).toBe("Median seated-to-released time over 9 tables.");
		expect(out).not.toContain("46.5");
	});

	test("a note with nothing to hide is returned byte for byte", () => {
		expect(withoutHouseComparison(RATING_NOTE)).toBe(RATING_NOTE);
		expect(withoutHouseComparison(ATTENDANCE_NOTE)).toBe(ATTENDANCE_NOTE);
		expect(withoutHouseComparison("")).toBe("");
	});

	// The waiter's OWN sample counts are not the restaurant's business to hide —
	// they are what makes the score legible ("this rests on 12 bills, not 2").
	test("what survives is everything about the reader", () => {
		const out = withoutHouseComparison(APC_NOTE);
		expect(out).toContain("12 settled bills");
		expect(out).toContain("31 covers");
	});
});

describe("redactComponent", () => {
	test("the benchmark key is ABSENT, not null", () => {
		const out = redactComponent(component(APC_NOTE, 612.5));
		// `in` rather than a null check: a null benchmark would still tell a
		// reader that a benchmark exists, and a future field added to
		// PerformanceComponent must not ride along either.
		expect("benchmark" in out).toBe(false);
		expect(Object.keys(out).sort()).toEqual(
			["available", "note", "sample", "score", "unit", "value"],
		);
	});

	test("no house figure survives anywhere in the serialised component", () => {
		const json = JSON.stringify(redactComponent(component(APC_NOTE, 612.5)));
		expect(json).not.toContain("house");
		// 612.5 is BOTH this waiter's own APC and (in this fixture) the house
		// average, so the check is on the prose, which is where the house one
		// lived. Their own `value` is exactly what the route is for.
		expect(JSON.parse(json).value).toBe(612.5);
	});

	test("everything the reader needs to understand their own score survives", () => {
		const out = redactComponent(component(RATING_NOTE, null));
		expect(out).toEqual({
			value: 612.5,
			score: 88,
			available: true,
			unit: "currency per cover",
			sample: 12,
			note: RATING_NOTE,
		});
	});

	test("an unmeasured component stays unmeasured — never scored zero", () => {
		const out = redactComponent({
			value: null,
			score: null,
			available: false,
			unit: "stars (1-5)",
			sample: 0,
			benchmark: null,
			note: "No guest feedback was attributed to them in this window — scored as excluded, NOT as zero stars.",
		});
		expect(out.value).toBeNull();
		expect(out.score).toBeNull();
		expect(out.available).toBe(false);
	});
});

// THE CONTRACT WITH THE OTHER FILE.
//
// The redaction cuts at a literal phrase that `GetStaffPerformance` writes. If
// that wording is ever reworded — "compared with a house average of", say — the
// cut silently stops cutting and every waiter's scorecard starts carrying the
// restaurant's average per cover. Nothing else in the codebase would notice, so
// this is where it is noticed.
describe("the marker is still what database_supabase.ts writes", () => {
	const source = readFileSync(
		join(__dirname, "..", "database_supabase.ts"),
		"utf8",
	);

	test("both benchmarked notes are still introduced by the marker", () => {
		expect(source).toContain("against a house average of");
		expect(source).toContain("against a house median of");
		// …and both of those begin with the exact string the redactor searches
		// for, comma and spacing included.
		expect(HOUSE_COMPARISON_MARKER).toBe(", against a house ");
		expect(source).toContain(`${HOUSE_COMPARISON_MARKER}average of`);
		expect(source).toContain(`${HOUSE_COMPARISON_MARKER}median of`);
	});

	test("no THIRD component has quietly grown a house comparison", () => {
		// Two, and only two, of the four components are scored relatively. A
		// third would need its own redaction, and this is the assertion that
		// says so out loud instead of leaking it.
		const occurrences = source.split(HOUSE_COMPARISON_MARKER).length - 1;
		expect(occurrences).toBe(2);
	});
});
