/**
 * Guest feedback: the public question/submit surface (proxied to the Python
 * service) and the staff-side reporting, recovery queue and stats.
 */
import type { Express, Request, Response } from "express";
import { AddFeedbackEntry, AddNotification, Audit_log_category, CreateValetVehicleState, GetFeedbackEntries, GetFeedbackSummary, GetRecoveryTickets, GetRestaurantTimezone, GetValetVehicleMetaByBookingIds, GetValetVehicleStates, ResolveRecoveryTicket, UpsertValetVehicleMeta, addDaysToKey, dayKeyOf, getRestaurantIdFromUsername, weekdayOfDayKey, withTenant, zonedClockParts } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { PERM_FEEDBACK_RESOLVE, PY_SERVER_URL, clampLimit, enforceRoles, extractEmployeeId, fetchWithTimeout, log_audit, rateLimit, validate, validateAction } from "./_shared.js";
import { updateValetStateAndPublish } from "./valet.js";


function getFeedbackCategoryLabel(category: number | string): string {
	if (typeof category === "number") {
		switch (category) {
			case 1:
				return "initial greeting";
			case 2:
				return "waiter service";
			case 3:
				return "food";
			case 4:
				return "ambience";
			case 5:
				return "restroom";
			case 6:
				return "valet parking";
			default:
				return "this question";
		}
	}

	const normalized = category.trim().toLowerCase();
	if (!normalized) {
		return "this question";
	}
	if (normalized === "1") {return "initial greeting";}
	if (normalized === "2") {return "waiter service";}
	if (normalized === "3") {return "food";}
	if (normalized === "4") {return "ambience";}
	if (normalized === "5") {return "restroom";}
	if (normalized === "6") {return "valet parking";}
	return normalized.replace(/_/g, " ");
}

function normalizeFollowUpPromptForCategory(prompt: string, categoryLabel: string, rate: number): string {
	const compact = prompt.replace(/\s+/g, " ").trim();
	if (!compact) {
		return `You rated ${categoryLabel} ${rate}/5. Could you share what influenced that rating?`;
	}

	let next = compact;
	const replacement = categoryLabel === "food" ? "food" : categoryLabel;

	if (categoryLabel !== "food") {
		next = next.replace(/\bthe\s+food\b/gi, `the ${replacement}`);
		next = next.replace(/\bfood\b/gi, replacement);
	}

	next = next.replace(/\bthe\s+this\s+question\b/gi, "this question");
	next = next.replace(/\bthe\s+1\b/gi, "this question");
	return next;
}

// The customer feedback app is unauthenticated (a guest, no session). It carries
// the restaurant/outlet/employee from the feedback link as headers (or body), the
// same way the public /qr/* endpoints identify their tenant.
function feedbackHeader(req: Request, name: string, bodyKey: string): string {
	const v = req.headers[name];
	const h = Array.isArray(v) ? v[0] : v;
	if (typeof h === "string" && h.trim()) {return h.trim();}
	const body = req.body as Record<string, unknown> | undefined;
	const bv = body?.[bodyKey];
	return typeof bv === "string" ? bv.trim() : "";
}
const feedbackRestaurantId = (req: Request) => feedbackHeader(req, "x-restaurant-id", "restaurantId");
const feedbackOutletId = (req: Request) => feedbackHeader(req, "x-outlet-id", "outletId");
const feedbackEmployeeId = (req: Request) => feedbackHeader(req, "x-employee-id", "employeeId");

export function registerGuestFeedbackRoutes(app: Express): void {

app.post("/get_main_feedback_question", validate, async (req: Request, res: Response) => {
	const restaurantId = feedbackRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const category = typeof body?.category === 'number' ? body.category : undefined;
	if (!category) {
		res.status(400).json({ error: "Missing category" });
		return;
	}
	if (category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	try {
		const response = await fetchWithTimeout(
			`${PY_SERVER_URL}/get_main_feedback_question/${encodeURIComponent(category)}`,
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
		return;
	} catch (error) {
		// The Python AI-question service is OPTIONAL. When it's unreachable
		// (not running / ECONNREFUSED / timeout) the feedback form must still
		// work — fall back to a plain category-label question instead of 500.
		logger.warn({ err: error }, "get_main_feedback_question_fallback: py service unreachable, using category label");
		res.json({ feedback: `How was the ${getFeedbackCategoryLabel(category).toLowerCase()}?` });
		return;
	}
});

app.post("/get_follow_up_question", validate, async (req: Request, res: Response) => {
	const restaurantId = feedbackRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const category = typeof body?.category === 'number' ? body.category : undefined;
	const rate = body?.rate === null || body?.rate === undefined ? undefined : Number(body.rate);
	if (!category || !rate) {
		res.status(400).json({ error: "Missing category or rate" });
		return;
	}
	if (category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	if (rate < 1 || rate > 5) {
		res.status(400).json({ error: "Invalid rate" });
		return;
	}

	try {
		const response = await fetchWithTimeout(
			`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(category)}/${encodeURIComponent(rate)}`,
		);
		const payload = await response.json();
		const data = (payload ?? {}) as Record<string, unknown>;
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		const categoryLabel = getFeedbackCategoryLabel(category);
		const rawFeedback = typeof data.feedback === "string" ? data.feedback : "";
		const normalizedFeedback = normalizeFollowUpPromptForCategory(rawFeedback, categoryLabel, rate);
		res.json({ ...data, feedback: normalizedFeedback });
		return;
	} catch (error) {
		// Optional Python service unreachable — build a follow-up prompt from
		// the category label + rating (same helper the success path uses) so
		// the guest can still add detail instead of hitting a 500.
		logger.warn({ err: error }, "get_follow_up_question_fallback: py service unreachable, using category label");
		res.json({ feedback: normalizeFollowUpPromptForCategory("", getFeedbackCategoryLabel(category), rate) });
		return;
	}
});

app.post("/feedback/dynamic-follow-up", validate, async (req: Request, res: Response) => {
	const restaurantId = feedbackRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const categoryLabel = typeof body?.category_label === "string" ? body.category_label.trim() : "";
	const rating = Number(body?.rating);
	const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
	const mainQuestion = typeof body?.main_question === "string" ? body.main_question.trim() : "";
	const firstFollowUpQuestion =
		typeof body?.first_follow_up_question === "string" ? body.first_follow_up_question.trim() : "";

	if (!categoryLabel || !Number.isFinite(rating) || !reason) {
		res.status(400).json({ error: "category_label, rating, and reason are required" });
		return;
	}

	if (reason.length < 8) {
		res.status(400).json({ error: "reason is too short" });
		return;
	}

	try {
		const proxyResponse = await fetchWithTimeout(
			`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(categoryLabel)}/${encodeURIComponent(rating)}`,
		);

		const proxyData = (await proxyResponse.json()) as Record<string, unknown>;
		if (!proxyResponse.ok) {
			res.status(proxyResponse.status).json(proxyData);
			return;
		}

		const aiPrompt = typeof proxyData.feedback === "string" ? proxyData.feedback.trim() : "";
		const normalizedAiPrompt = normalizeFollowUpPromptForCategory(aiPrompt, categoryLabel.toLowerCase(), rating);
		const contextualFallback =
			mainQuestion && firstFollowUpQuestion
				? `Thanks for sharing. Based on your feedback about ${categoryLabel}, what one change should we prioritize?`
				: `Thanks for sharing. What one change should we prioritize for ${categoryLabel}?`;
		const followUpPrompt = normalizedAiPrompt.length > 0 ? normalizedAiPrompt : contextualFallback;
		res.json({ follow_up_prompt: followUpPrompt });
	} catch (error) {
		logger.error({ err: error }, "feedback_dynamic_follow_up_failed");
		res.status(500).json({ error: "Unable to generate dynamic follow-up" });
	}
});

app.post("/feedback/valet-checkin", rateLimit("valet_checkin", 10, 60_000), validate, async (req: Request, res: Response) => {
	const ridInput = feedbackRestaurantId(req);
	if (!ridInput) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	// Resolve+validate the tenant from its public slug (like the sibling /feedback
	// and /qr routes) and use the resolved res_id — never trust the raw client id to
	// address another tenant's valet records. The authenticated valet flow also keys
	// on res_id, so this is consistent as well as safe.
	const restaurantId = await getRestaurantIdFromUsername(ridInput).catch(() => null);
	if (!restaurantId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const numberPlate = typeof body?.number_plate === "string" ? body.number_plate.trim() : "";
	if (!numberPlate) {
		res.status(400).json({ error: "number_plate is required" });
		return;
	}
	const customerName = typeof body?.customer_name === "string" ? body.customer_name.trim() : "";
	const normalizedPlate = numberPlate.replace(/\s+/g, "").toUpperCase();
	const outletId = feedbackOutletId(req) || undefined;

	// Advance a valet record to state 3 (customer requested car) and broadcast it
	// to the live valet board.
	const requestRetrieval = (bookingId: string) =>
		updateValetStateAndPublish(restaurantId, bookingId, "3", outletId);

	try {
		// Read the tenant's valet records. Prefer the optional Python service (keeps
		// the existing read path), but fall back to the TS DB layer so matching still
		// works when Python is down — the guest's "bring my car" must not depend on it.
		interface ValetLite { booking_id: string; number_plate: string; state: number }
		let records: ValetLite[] = [];
		let readOk = false;
		try {
			const recordsResponse = await fetchWithTimeout(
				`${PY_SERVER_URL}/get_all_valet_records/${encodeURIComponent(restaurantId)}`,
				{ headers: outletId ? { "X-Outlet-Id": outletId } : undefined },
			);
			if (recordsResponse.ok) {
				const recordsPayload = (await recordsResponse.json().catch(() => null)) as
					| Record<string, unknown>
					| Record<string, unknown>[]
					| null;
				const raw = Array.isArray(recordsPayload)
					? recordsPayload
					: Array.isArray((recordsPayload)?.records)
						? (((recordsPayload).records as unknown[]) as Record<string, unknown>[])
						: [];
				records = raw.map((r) => ({
					booking_id:
						typeof r.booking_id === "string"
							? r.booking_id
							: typeof (r).bookingId === "string"
								? ((r).bookingId)
								: "",
					number_plate: typeof r.number_plate === "string" ? r.number_plate : "",
					state: Number(r.state),
				}));
				readOk = true;
			} else {
				logger.warn({ status: recordsResponse.status }, "feedback_valet_checkin: py valet read non-ok, falling back to db");
			}
		} catch (err) {
			logger.warn({ err }, "feedback_valet_checkin: py valet read failed, falling back to db");
		}

		if (!readOk) {
			const states = await GetValetVehicleStates(restaurantId, outletId);
			const metaByBookingId = await GetValetVehicleMetaByBookingIds(
				restaurantId,
				states.map((s) => s.booking_id),
				outletId,
			);
			records = states.map((s) => ({
				booking_id: s.booking_id,
				number_plate: metaByBookingId[s.booking_id]?.number_plate ?? "",
				state: s.state,
			}));
		}

		const matching = records.filter((record) => {
			const bookingId = typeof record.booking_id === "string" ? record.booking_id.trim() : "";
			return bookingId.length > 0 && record.number_plate.replace(/\s+/g, "").toUpperCase() === normalizedPlate;
		});

		// A record that's added (1) or parked (2) but not yet requested can be advanced
		// straight to a retrieval request. Prefer a parked car when both exist.
		const advanceable = matching
			.filter((record) => record.state === 1 || record.state === 2)
			.sort((a, b) => b.state - a.state);
		// A retrieval already underway: requested (3), accepted (4), or arrived (5).
		const inProgress = matching.filter((record) => record.state >= 3 && record.state <= 5).sort((a, b) => b.state - a.state);

		if (advanceable.length > 0) {
			const candidate = advanceable[0]!;
			await requestRetrieval(candidate.booking_id.trim());
			res.json({ success: true, action: "updated_to_3", current_state: 3, created: false, booking_id: candidate.booking_id.trim() });
			return;
		}

		if (inProgress.length > 0) {
			const candidate = inProgress[0]!;
			res.json({ success: true, action: "already_requested", current_state: candidate.state, created: false, booking_id: candidate.booking_id.trim() });
			return;
		}

		// No active/in-progress record for this plate (the vehicle was never formally
		// parked, or the only match is a completed past visit). Create one via the TS
		// DB layer — works without Python — then advance it straight to a retrieval
		// request so it lands on the valet board as "customer requested car".
		const created = await CreateValetVehicleState(restaurantId, undefined, undefined, outletId);
		const meta = await UpsertValetVehicleMeta(
			restaurantId,
			created.booking_id,
			normalizedPlate,
			customerName || null,
			outletId,
		);
		// Broadcast the new row (mirrors POST /create_valet_record); the state->3
		// transition below then emits valet:updated so live boards show it as a request.
		emitRestaurant(restaurantId, "valet:created", {
			message: "New valet record created successfully.",
			booking_id: created.booking_id,
			entry_time: created.entry_time,
			bay_id: created.bay_id,
			number_plate: meta.number_plate,
			customer_name: meta.customer_name ?? undefined,
		});
		await requestRetrieval(created.booking_id);
		res.json({ success: true, action: "created", current_state: 3, created: true, booking_id: created.booking_id });
		return;
	} catch (error) {
		// Best-effort: the guest feedback flow must never 500. Log and return a soft
		// failure so the form continues (the feedback submit itself is unaffected).
		logger.error({ err: error }, "feedback_valet_checkin_failed");
		res.json({ success: false, action: "error", current_state: null, created: false });
		return;
	}
});

app.post("/feedback/submit", rateLimit("feedback", 20, 60_000), async (req: Request, res: Response) => {
	// Public (customer) endpoint — no session. The restaurant/outlet/employee come
	// from the feedback link via headers (or body), then the write runs inside the
	// tenant context so RLS isolates it.
	const ridInput = feedbackRestaurantId(req);
	// employeeId (the waiter) is OPTIONAL: a table with no resolvable waiter (e.g.
	// QR-self-order only) still submits feedback, just unattributed (emp_id NULL).
	const employeeId = feedbackEmployeeId(req) ?? "";
	if (!ridInput) { res.status(400).json({ error: "Missing restaurantId" }); return; }

	let resolvedId: string | null = null;
	try { resolvedId = await getRestaurantIdFromUsername(ridInput); } catch { resolvedId = null; }
	if (!resolvedId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const rid: string = resolvedId;
	const outletId = feedbackOutletId(req);

	const body = req.body as Record<string, unknown> | undefined;
	const categoryRatingsRaw = body?.category_ratings;
	if (!Array.isArray(categoryRatingsRaw) || categoryRatingsRaw.length === 0) {
		res.status(400).json({ error: "category_ratings must be a non-empty array" });
		return;
	}

	const category_ratings = categoryRatingsRaw
		.slice(0, 25) // cap categories (anti-DoS); a real feedback form has a handful
		.map((item) => {
			const row = item as Record<string, unknown>;
			return {
				key: String(row.key ?? "").trim(),
				label: String(row.label ?? "").trim(),
				rating: Number(row.rating),
				question: row.question === null || row.question === undefined ? null : String(row.question),
				follow_up: row.follow_up === null || row.follow_up === undefined ? null : String(row.follow_up),
				follow_up_answer: row.follow_up_answer === null || row.follow_up_answer === undefined ? null : String(row.follow_up_answer),
			};
		})
		.filter((item) => item.key.length > 0 && item.label.length > 0 && Number.isFinite(item.rating));
	if (category_ratings.length === 0) {
		res.status(400).json({ error: "No valid category ratings found" });
		return;
	}

	const visitDateRaw = body?.visit_date;
	const visitDate = typeof visitDateRaw === "string" && visitDateRaw.trim().length > 0 ? new Date(visitDateRaw) : null;

	// Optional NPS (0–10) — only stored when the guest actually answered it.
	const npsRaw = body?.nps;
	const npsNum = typeof npsRaw === "number" ? npsRaw : typeof npsRaw === "string" && npsRaw.trim() !== "" ? Number(npsRaw) : NaN;
	const nps = Number.isFinite(npsNum) ? Math.max(0, Math.min(10, Math.round(npsNum))) : null;

	try {
		const saved = await withTenant({ res_id: rid, outlet_id: outletId || "", employeeId, role: "" }, async () => {
			const s = await AddFeedbackEntry(rid, employeeId, {
				customer_name: typeof body?.customer_name === "string" ? body.customer_name : null,
				visit_date: visitDate && !Number.isNaN(visitDate.getTime()) ? visitDate : null,
				comments: typeof body?.comments === "string" ? body.comments : null,
				category_ratings,
				image_theme:
					body?.image_theme && typeof body.image_theme === "object"
						? {
							background: String((body.image_theme as Record<string, unknown>).background ?? ""),
							surface: String((body.image_theme as Record<string, unknown>).surface ?? ""),
							text: String((body.image_theme as Record<string, unknown>).text ?? ""),
							accent: String((body.image_theme as Record<string, unknown>).accent ?? ""),
						}
						: null,
				source: typeof body?.source === "string" ? body.source : "feedback_form",
				nps,
			});
			// Real-time low-score alert: a ≤2/5 rating pings the manager notification
			// bell immediately. Best-effort — a bell failure never fails the submit.
			if (s.overall_rating <= 2) {
				try {
					const guest = typeof body?.customer_name === "string" && body.customer_name.trim() ? body.customer_name.trim() : "a guest";
					const snippet = typeof body?.comments === "string" && body.comments.trim() ? `"${body.comments.trim().slice(0, 140)}"` : "No comment left.";
					await AddNotification(rid, {
						type: "warning",
						title: `⚠ Low feedback: ${s.overall_rating}/5 from ${guest}`,
						body: s.waiter_name ? `${snippet} — served by ${s.waiter_name}` : snippet,
						meta: { feedback_id: s.id, overall_rating: s.overall_rating, waiter_name: s.waiter_name },
					});
				} catch (err) { logger.warn({ err }, "low_feedback_notification_failed"); }
			}
			return s;
		});
		try { emitRestaurant(rid, "feedback:created", saved); } catch (err) { logger.warn({ err }, "emit feedback:created failed"); }
		if (saved.recovery) { try { emitRestaurant(rid, "feedback:recovery", { id: saved.id }); } catch {/* ignore */} }
		res.status(201).json({ success: true, id: saved.id, submitted_at: saved.submitted_at, recovery: saved.recovery });
	} catch (error) {
		logger.error({ err: error }, "submit_feedback_failed");
		res.status(500).json({ error: "Unable to submit feedback" });
	}
});
}


export function registerFeedbackAdminRoutes(app: Express): void {

app.get("/feedback", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	const limit = clampLimit(req.query.limit, 100, 500);

	try {
		const items = await GetFeedbackEntries(auth.restaurantId, limit);
		res.json({ items });
	} catch (error) {
		logger.error({ err: error }, "get_feedback_failed");
		res.status(500).json({ error: "Unable to fetch feedback" });
	}
});

// Service-recovery tickets (staff): list open low-rating feedback + resolve.
app.get("/feedback/recovery", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {return;}
	const includeResolved = String(req.query.all ?? "") === "1" || req.query.all === "true";
	try { res.json({ tickets: await GetRecoveryTickets(auth.restaurantId, includeResolved) }); }
	catch (err) { logger.error({ err }, "get_recovery_tickets_failed"); res.status(500).json({ error: "Unable to fetch recovery tickets" }); }
});

app.post("/feedback/recovery/:id/resolve", validateAction(PERM_FEEDBACK_RESOLVE), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {return;}
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	const note = typeof (req.body as Record<string, unknown> | undefined)?.note === "string" ? String((req.body as Record<string, unknown>).note) : undefined;
	try {
		await ResolveRecoveryTicket(auth.restaurantId, id, note, extractEmployeeId(req) ?? undefined);
		try { await log_audit(req, "0cb6768b-92ff-4848-8631-52ef9d65cf53", `Resolved service-recovery ticket ${id}`, Audit_log_category.General, { id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (err) { logger.error({ err }, "resolve_recovery_ticket_failed"); res.status(400).json({ error: "Unable to resolve ticket" }); }
});

app.get("/feedback/summary", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	try {
		const summary = await GetFeedbackSummary(auth.restaurantId);
		res.json(summary);
	} catch (error) {
		logger.error({ err: error }, "get_feedback_summary_failed");
		res.status(500).json({ error: "Unable to fetch feedback summary" });
	}
});

app.get("/feedback/stats", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {return;}

	try {
		const mode = String(req.query.mode ?? "daily");
		// Every bucket below is a RESTAURANT calendar day/hour. Reading the
		// instants with getUTC* shifted the hourly histogram by the zone offset
		// and, when the client omitted `date`, defaulted to the wrong day during
		// the restaurant's own late shift.
		const tz = await GetRestaurantTimezone(auth.restaurantId);
		const rows = await GetFeedbackEntries(auth.restaurantId, 5000);

		// A request parameter is either an explicit YYYY-MM-DD (already a
		// calendar day — take it as written) or an instant to be read in `tz`.
		const dayKeyParam = (s: string | undefined | null): string | null => {
			const raw = String(s ?? "").trim();
			if (!raw) {return null;}
			if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {return raw;}
			const d = new Date(raw);
			return isNaN(d.getTime()) ? null : dayKeyOf(d, tz);
		};
		const localKeys = rows
			.map((r) => zonedClockParts((r).submitted_at ?? (r).submittedAt, tz))
			.filter((p): p is NonNullable<typeof p> => p !== null);

		if (mode === "daily") {
			const targetYMD = dayKeyParam(String(req.query.date ?? "")) ?? dayKeyOf(new Date(), tz);
			const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
			for (const p of localKeys) {
				if (p.key !== targetYMD) {continue;}
				const bucket = hours[p.hour];
				if (bucket) {bucket.count += 1;}
			}
			return res.json({ mode: "daily", date: targetYMD, hours });
		}

		if (mode === "weekly") {
			const anchor = dayKeyParam(String(req.query.weekStart ?? "")) ?? dayKeyOf(new Date(), tz);
			const startKey = addDaysToKey(anchor, -((weekdayOfDayKey(anchor) + 6) % 7));
			const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
			const days = Array.from({ length: 7 }, (_, i) => ({ label: dayLabels[i]!, date: addDaysToKey(startKey, i), count: 0 }));
			const idxByKey = new Map(days.map((d, i) => [d.date, i]));
			for (const p of localKeys) {
				const idx = idxByKey.get(p.key);
				if (idx === undefined) {continue;}
				days[idx]!.count += 1;
			}
			return res.json({ mode: "weekly", weekStart: days[0]!.date, days });
		}

		if (mode === "monthly") {
			// For monthly mode, return week buckets that cover the full calendar month of the provided start date.
			const anchor = dayKeyParam(String(req.query.start ?? "")) ?? dayKeyOf(new Date(), tz);
			const year = Number(anchor.slice(0, 4));
			const month = Number(anchor.slice(5, 7)); // 1-indexed
			const monthStart = `${anchor.slice(0, 7)}-01`;
			const monthEnd = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
			// weekStart is the Monday on or before monthStart
			let weekStart = addDaysToKey(monthStart, -((weekdayOfDayKey(monthStart) + 6) % 7));
			const weeks = [] as { start: string; end: string; label: string; count: number }[];
			while (weekStart < monthEnd) {
				const end = addDaysToKey(weekStart, 7);
				weeks.push({ start: weekStart, end, label: weekStart.slice(5, 10), count: 0 });
				weekStart = end;
			}
			// count events
			for (const p of localKeys) {
				for (const w of weeks) {
					if (p.key >= w.start && p.key < w.end) { w.count += 1; break; }
				}
			}
			return res.json({ mode: "monthly", month: `${year}-${String(month).padStart(2, '0')}`, start: weeks[0]?.start ?? monthStart, weeks });
		}

		if (mode === "yearly") {
			const yearParam = Number(req.query.year ?? dayKeyOf(new Date(), tz).slice(0, 4));
			const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i], count: 0 }));
			for (const p of localKeys) {
				if (Number(p.key.slice(0, 4)) !== yearParam) {continue;}
				const bucket = months[Number(p.key.slice(5, 7)) - 1];
				if (bucket) {bucket.count += 1;}
			}
			return res.json({ mode: "yearly", year: yearParam, months });
		}

		return res.status(400).json({ error: "Unknown mode" });
	} catch (error) {
		logger.error({ err: error }, 'get_feedback_stats_failed');
		res.status(500).json({ error: 'Unable to fetch feedback stats' });
	}
});
}
