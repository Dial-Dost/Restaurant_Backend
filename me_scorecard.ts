/**
 * me_scorecard.ts — THE REDACTION behind `GET /me/scorecard`.
 *
 * A waiter's own scorecard is `GetStaffPerformance` filtered to one row. That
 * computation is built for an OWNER, so the row it produces carries the house
 * figures it was scored against — the restaurant's average per cover and its
 * median table turnaround — in three places:
 *
 *   * `benchmarks` on the payload,
 *   * `benchmark` on each component,
 *   * and, easiest to miss, the component's own PROSE: "…across 12 settled bills
 *     (31 covers), against a house average of 612.5."
 *
 * Taking those out is the whole difference between "your score" and "your score
 * plus what the restaurant makes per head", so it lives here rather than inline
 * in the route: a pure module with no runtime imports, which means
 * `me_scorecard.test.ts` can load it without a database and pin every rule.
 * Same reason billing_math.ts and mis_report_math.ts exist.
 *
 * The type import below is ERASED at compile time (`import type`), so nothing in
 * this file pulls the data layer in.
 */
import type { PerformanceComponent } from "./database_supabase.js";

/**
 * The exact phrase `GetStaffPerformance` uses to introduce a house comparison
 * inside a component note, in both places it does so:
 *
 *   apc: "…across 12 settled bills (31 covers), against a house average of 612.5."
 *   tat: "…over 9 tables, against a house median of 46.5 minutes."
 *
 * A named constant because it is a CONTRACT WITH ANOTHER FILE, not a formatting
 * detail: `me_scorecard.test.ts` asserts that the shipped notes still contain
 * it, so if the wording in database_supabase.ts is ever changed the redaction
 * fails loudly in CI instead of quietly leaking a house figure to every waiter.
 */
export const HOUSE_COMPARISON_MARKER = ", against a house ";

/** A component note with its house comparison removed, still a sentence. */
export function withoutHouseComparison(note: string): string {
	const at = note.indexOf(HOUSE_COMPARISON_MARKER);
	if (at < 0) { return note; }
	const kept = note.slice(0, at).trimEnd();
	return kept.endsWith(".") ? kept : `${kept}.`;
}

/** What a component looks like once every restaurant-wide figure is out of it. */
export interface SelfComponent {
	value: number | null;
	score: number | null;
	available: boolean;
	unit: string;
	sample: number;
	note: string;
}

/**
 * One performance component, scrubbed.
 *
 * Built by CONSTRUCTION — a new object with the six fields that survive — rather
 * than by deleting a key from a copy. A field added to [PerformanceComponent]
 * later is then absent here until somebody decides it may be seen, which is the
 * only correct default for a payload whose entire job is to be smaller than its
 * source.
 */
export function redactComponent(c: PerformanceComponent): SelfComponent {
	return {
		value: c.value,
		score: c.score,
		available: c.available,
		unit: c.unit,
		sample: c.sample,
		note: withoutHouseComparison(c.note),
	};
}
