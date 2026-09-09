/**
 * SELF-SCOPED READS — what the signed-in employee may know about THEMSELVES.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A waiter's Overview is now their own scorecard: their average per cover, their
 * attendance, their guest ratings and the composite performance score built from
 * those. Every one of those numbers already exists — inside
 * `GET /analytics/staff-performance`, which returns a row PER EMPLOYEE and is
 * gated on `validateAction("df75119b-…")`, the action named "View Order APC".
 *
 * So there were exactly two ways to put a waiter's own score on their own
 * screen, and only one of them is safe:
 *
 *   (a) grant waiters the analytics action. That hands them the whole
 *       restaurant — month-to-date revenue, every colleague's score, the house
 *       APC, the concerns list — to show them one number about themselves. It is
 *       the opposite of what the scoping is for.
 *   (b) this route: the SAME computation, filtered server-side to the caller's
 *       own row before it leaves the process, with the house comparisons taken
 *       out. Nothing new is computed and no permission is widened; a strictly
 *       smaller answer is served to an identity that could not read the larger
 *       one.
 *
 * IDENTITY COMES FROM THE SESSION, NEVER FROM THE REQUEST. There is no
 * `?employee_id=` and no body — `extractEmployeeId(req)` reads the verified
 * session, so "my scorecard" cannot be pointed at a colleague by editing a URL.
 * That is the whole security property of the endpoint and it is why the handler
 * takes no parameters at all.
 *
 * WHAT IS REDACTED, AND WHY IT HAS TO BE (see me_scorecard.ts)
 * -----------------------------------------------------------
 * `StaffPerformanceRow` carries the house figures it was scored against:
 * `benchmarks.apc` is the restaurant's average per cover, `benchmarks.tat_minutes`
 * its median turnaround, and each component repeats its own `benchmark` and
 * quotes it in prose ("…against a house average of 612.5"). Those are
 * restaurant-wide numbers — precisely what a scoped Overview must not carry — so
 * the benchmark fields are dropped and the two notes that quote one are cut back
 * to the half that is about the reader. The employee's OWN value, score, sample
 * and unit all survive: the score would be unreadable without them.
 */
import type { Express, Request, Response } from "express";
import { GetMyAttendance, GetStaffPerformance } from "../database_supabase.js";
import { logger } from "../observability.js";
import { HOUSE_COMPARISON_MARKER, redactComponent, withoutHouseComparison } from "../me_scorecard.js";
import { extractEmployeeId, extractRestaurantId, validate, windowQuery } from "./_shared.js";

// Re-exported so the route and its rules are one import for a reader who starts
// here. The implementations live in me_scorecard.ts because that module has no
// runtime imports and can therefore be tested without a database — see its
// header.
export { HOUSE_COMPARISON_MARKER, redactComponent, withoutHouseComparison };

export function registerSelfScorecardRoute(app: Express): void {

// The signed-in employee's own scorecard: APC, guest rating, attendance and
// turnaround, the weights each carries, and the composite score.
//
// `validate` and nothing more. That is not a missing permission check — it is
// the point: every figure here is about the caller, so the only authorisation
// question ("is this really them?") is the session itself. Adding an action
// would gate a waiter out of their own numbers, which is the problem this route
// exists to solve.
app.get("/me/scorecard", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try {
		const [perf, attendance] = await Promise.all([
			GetStaffPerformance(restaurantId, windowQuery(req)),
			// The LIVE half — clocked in right now, since when, minutes today,
			// whether the shift is still awaiting approval. The performance
			// component next to it is a 30-day average and cannot answer "am I
			// on the clock", which is the one attendance question a waiter opens
			// this screen with.
			GetMyAttendance(restaurantId, employeeId),
		]);
		const mine = perf.rows.find((r) => r.employee_id === employeeId) ?? null;
		res.json({
			window_days: perf.window_days,
			from: perf.from,
			to: perf.to,
			window: perf.window,
			timezone: perf.timezone,
			generated_at: perf.generated_at,
			// The nominal weights are the same for every employee and say nothing
			// about the restaurant's trade, so they travel: they are what lets the
			// app show WHY a score is what it is.
			weights: perf.weights,
			employee_id: employeeId,
			// null when the roster has no row for this session's employee (an
			// identity from another outlet, a deleted record). The app renders
			// that as "no score yet", never as a zero.
			employee_name: mine?.employee_name ?? null,
			role: mine?.role ?? null,
			score: mine?.score ?? null,
			components_available: mine?.components_available ?? 0,
			effective_weights: mine?.effective_weights ?? null,
			components: mine
				? {
					apc: redactComponent(mine.components.apc),
					rating: redactComponent(mine.components.rating),
					attendance: redactComponent(mine.components.attendance),
					tat: redactComponent(mine.components.tat),
				}
				: null,
			attendance_now: attendance,
		});
	} catch (err) {
		logger.error({ err }, "my_scorecard_failed");
		res.status(500).json({ error: "Unable to fetch your scorecard" });
	}
});

}
