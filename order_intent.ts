/**
 * What a tap on the item tick MEANS — resolved from the request alone.
 *
 * The tick is a toggle: tapping a served item again un-serves it, so a mis-tap
 * is recoverable. Online that is unambiguous, because the toggle resolves
 * against state read microseconds after the tap.
 *
 * A REPLAYED tap is a different thing. Once writes can be queued offline
 * (services/outbox.dart) a serve can arrive minutes late, after another device
 * already served the same item — and a toggle resolved at *handling* time then
 * reads "already served" and un-serves it. The idempotency key cannot save
 * this: the key is consumed once, and the ambiguity is in the request, not in
 * the delivery.
 *
 * So the caller may state intent, and the toggle is only the fallback for
 * callers that don't:
 *   undo=1 / {undo:true}   -> unserve, no state read
 *   undo=0 / {undo:false}  -> serve,   no state read
 *   absent                 -> toggle against current state (legacy, online)
 *
 * Extracted as a pure function because the route files are not directly
 * mountable in the jest setup — same reasoning as billing_math.ts and
 * report_window.ts.
 */
export type ServeIntent = "serve" | "unserve" | "toggle";

export function resolveServeIntent(
	query: unknown,
	body: unknown,
): ServeIntent {
	const q = (query ?? {}) as Record<string, unknown>;
	const b = (body ?? {}) as Record<string, unknown>;
	// Truthy first: `undo=1` is the long-standing forced undo and must keep
	// winning, including when a client sends both.
	if (q.undo === "1" || b.undo === true) return "unserve";
	if (q.undo === "0" || b.undo === false) return "serve";
	return "toggle";
}
