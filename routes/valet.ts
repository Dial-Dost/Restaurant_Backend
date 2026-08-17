/**
 * Valet: bays, vehicle records, plate OCR, state transitions, key log and charging
 * the valet fee to a bill.
 */
import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { AddNotification, AddOrder, AddParkingBay, Audit_log_category, CreateValetVehicleState, DeleteParkingBay, GetEmployeeDetailsFromEmpID, GetParkingBays, GetTables, GetValetVehicleMetaByBookingIds, GetValetVehicleState, GetValetVehicleStates, SetParkingBayCurrent, UpdateParkingBay, UpdateValetVehicleBay, UpdateValetVehicleOps, UpdateValetVehicleState, UpsertValetVehicleMeta } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { uploadMenuImage } from "../storage_bucket_supabase.js";
import { PERM_VALET_CHARGE, PERM_VALET_KEYS, PERM_VALET_OPS, enforceRoles, extractEmployeeId, log_audit, validateAction } from "./_shared.js";


// Port of the Flutter _extractPlate heuristic (modules.dart) so web scans
// validate plates identically to the on-device Android OCR path: prefer the
// canonical Indian format, else the longest 5-11 char token mixing letters+digits.
function extractPlate(raw: string): string | null {
	const up = raw.toUpperCase();
	const canonical = /[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{3,4}/;
	const m = canonical.exec(up);
	if (m) {return m[0].replace(/[\s-]/g, "");}
	let best: string | null = null;
	for (const tok of up.split(/[^A-Z0-9]+/)) {
		if (tok.length < 5 || tok.length > 11) {continue;}
		const hasLetter = /[A-Z]/.test(tok);
		const hasDigit = /\d/.test(tok);
		if (hasLetter && hasDigit && (best === null || tok.length > best.length)) {best = tok;}
	}
	return best;
}

// Web valet plate OCR — mirrors the Flutter app's on-device scan
// (_ValetCheckInDialog._scanPlate). Runs FREE, on-server OCR via tesseract.js
// (no API key, no per-scan cost) so the web valet page offers the same
// "snap a photo -> prefill the plate" flow. The caller always falls back to
// manual entry, so any OCR failure returns { plate: null } with 200, not a 500.
//
// One tesseract worker is created lazily and reused (loading the eng model per
// request would be slow); scans are chained so concurrent calls don't clash on
// the single worker. The eng model + wasm core download once on first use and
// are cached by tesseract.js.
let plateOcrWorkerPromise: Promise<import("tesseract.js").Worker> | null = null;
async function getPlateOcrWorker() {
	if (!plateOcrWorkerPromise) {
		plateOcrWorkerPromise = (async () => {
			const { createWorker, PSM } = await import("tesseract.js");
			const worker = await createWorker("eng");
			// Plates are a single line of A-Z/0-9. SINGLE_LINE page segmentation +
			// a restricted charset markedly improve accuracy vs the default AUTO mode
			// (which mis-segments a plate and drops/garbles characters).
			await worker.setParameters({
				tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -",
				tessedit_pageseg_mode: PSM.SINGLE_LINE,
			});
			return worker;
		})();
		// If init fails, drop the cached promise so the next scan retries fresh.
		plateOcrWorkerPromise.catch(() => { plateOcrWorkerPromise = null; });
	}
	return plateOcrWorkerPromise;
}
let plateOcrChain: Promise<unknown> = Promise.resolve();
function runPlateOcr(buffer: Buffer): Promise<string> {
	const task = plateOcrChain.then(async () => {
		const worker = await getPlateOcrWorker();
		const { data } = await worker.recognize(buffer);
		return data.text ?? "";
	});
	plateOcrChain = task.catch(() => {}); // keep the queue alive past a failed scan
	return task;
}

export async function updateValetStateAndPublish(
	restaurantId: string,
	bookingId: string,
	state: string,
	outletId?: string,
): Promise<Record<string, unknown>> {
	const stateNum = Number(state);
	if (!Number.isFinite(stateNum)) {
		throw Object.assign(new Error("Unable to update valet state"), {
			status: 400,
			payload: { error: "Invalid state" },
		});
	}

	const updated = await UpdateValetVehicleState(restaurantId, bookingId, stateNum, outletId);
	if (!updated) {
		throw Object.assign(new Error("Unable to update valet state"), {
			status: 404,
			payload: { error: `No active valet record found for that booking ID - ${bookingId}.` },
		});
	}

	const payload: Record<string, unknown> = {
		message: "Valet state updated successfully.",
		booking_id: updated.booking_id,
	};

	// Centralized publisher path for valet state updates.
	emitRestaurant(restaurantId, "valet:updated", { booking_id: bookingId, state, detail: payload });
	return payload;
}

// --- Valet ops depth (Wave D) ------------------------------------------------
// Audit actions seeded by ensureValetOpsColumns (database_supabase.ts).
const VALET_ACTION_KEY_LOG = "4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18";
const VALET_ACTION_OPS_UPDATE = "8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413";
const VALET_ACTION_CHARGE = "6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791";

// Best-effort number plate lookup for honest audit/notification copy.
async function valetPlateFor(restaurantId: string, bookingId: string, outletId?: string): Promise<string> {
	try {
		const meta = await GetValetVehicleMetaByBookingIds(restaurantId, [bookingId], outletId);
		return meta[bookingId]?.number_plate ?? bookingId.slice(-6).toUpperCase();
	} catch {
		return bookingId.slice(-6).toUpperCase();
	}
}

export function registerValetInfoRoute(app: Express): void {

app.get("/valet-info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const [records, bays] = await Promise.all([
			GetValetVehicleStates(auth.restaurantId, auth.outletId),
			GetParkingBays(auth.restaurantId, auth.outletId),
		]);
		const metaByBookingId = await GetValetVehicleMetaByBookingIds(
			auth.restaurantId,
			records.map((row) => row.booking_id),
			auth.outletId,
		);

		const bayById = new Map((bays ?? []).map((bay) => [String(bay.Bay_id), bay.Bay_name]));
		const stateMap: Record<number, string> = {
			1: "Vehicle added",
			2: "Parked",
			3: "Request to bring car (from customer)",
			4: "Request accepted (from valet)",
			5: "Car arrived at entrance",
			6: "Customer took car",
		};

		const bookings = records.map((row) => {
			const meta = metaByBookingId[row.booking_id];
			return {
				booking_id: row.booking_id,
				customer_name: meta?.customer_name ?? undefined,
				bay_id: row.bay_id,
				bay_name: row.bay_id ? (bayById.get(String(row.bay_id)) ?? null) : null,
				booking_date_time: row.entry_time ?? undefined,
				exit_date_time: row.exit_time ?? undefined,
				status: stateMap[row.state] ?? "Vehicle added",
				active: row.state !== 6,
				number_plate: meta?.number_plate ?? undefined,
				// Valet ops depth (Wave D)
				parking_location: row.parking_location,
				key_holder: row.key_holder,
				key_updated_at: row.key_updated_at,
				condition_notes: row.condition_notes,
				condition_photo_url: row.condition_photo_url,
				eta_minutes: row.eta_minutes,
				requested_at: row.requested_at,
			};
		});

		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit valet-info failed');
		}

		res.json({
			role: auth.role,
			generated_at: new Date().toISOString(),
			bays,
			bookings,
		});
	} catch (error) {
		logger.error({ err: error }, "valet_info_failed");
		res.status(500).json({ error: "Unable to fetch valet info" });
	}
});
}


export function registerValetRoutes(app: Express): void {



// Rtamanyu's integration
app.get("/valet-bays", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const data = await GetParkingBays(auth.restaurantId, auth.outletId);
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "fetch_valet_bays_failed");
		res.status(500).json({ error: "Unable to fetch valet bays" });
		return;
	}
});

app.post("/add-valet-bay", validateAction("ae8ce7c0-1e06-4722-8a06-817267eec785"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);
	if (!bayName) {
		res.status(400).json({ error: "Missing Bay_name" });
		return;
	}

	try {
		const bay = await AddParkingBay(
			auth.restaurantId,
			bayName,
			Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0,
			auth.outletId,
		);
		const data = {
			message: "Bay added",
			...bay,
		};

		// Broadcast bay added
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_added", data);
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_added failed");
		}
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "add_valet_bay_failed");
		res.status(500).json({ error: "Unable to add valet bay" });
		return;
	}
});

app.post("/delete-valet-bay", validateAction("6e9be65f-4081-4b86-8ba0-0592ee26f7f2"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}
	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	if (!bayId && !bayName) {
		res.status(400).json({ error: "Missing Bay_id or Bay_name" });
		return;
	}

	try {
		const deleted = await DeleteParkingBay(auth.restaurantId, bayId ?? null, bayName ?? null, auth.outletId);
		if (!deleted) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay deleted",
			...deleted,
		};

		// Broadcast bay deleted
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_deleted", data);
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_deleted failed");
		}
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "delete_valet_bay_failed");
		res.status(500).json({ error: "Unable to delete valet bay" });
		return;
	}
});


app.post("/update-valet-bay", validateAction("2caeab74-5941-424d-9c3a-5c68ef0186e1"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}

	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);

	if (!bayName) {
		res.status(400).json({ error: "Missing Bay_name" });
		return;
	}

	try {
		const updated = await UpdateParkingBay(
			auth.restaurantId,
			bayId ?? null,
			bayName,
			Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0,
			auth.outletId,
		);
		if (!updated) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay updated",
			...updated,
		};

		// Broadcast bay updated
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_updated", data);
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_updated failed");
		}
		res.json(data);
		return;
	} catch (err) {
		logger.error({ err }, "update_valet_bay_failed");
		res.status(500).json({ error: "Unable to update valet bay" });
	}
});


app.post("/set-valet-bay-current", validateAction("2ff51c3d-f18c-406c-9f49-7c54f468c835"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}

	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const current = body?.current_capacity === null || body?.current_capacity === undefined ? undefined : Number(body.current_capacity);

	if (!bayId || current === undefined || Number.isNaN(current)) {
		res.status(400).json({ error: "Missing Bay_id or current_capacity" });
		return;
	}

	try {
		const updated = await SetParkingBayCurrent(auth.restaurantId, bayId, Number(current), auth.outletId);
		if (!updated) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay current capacity set",
			...updated,
		};

		// Broadcast bay current capacity update
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_current_set", { Bay_id: body?.Bay_id, current_capacity: Number(current) });
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_current_set failed");
		}
		res.json(data);
		return;
	} catch (err) {
		logger.error({ err }, "set_valet_bay_current_failed");
		res.status(500).json({ error: "Unable to set bay current capacity" });
		return;
	}
});

app.post("/create_valet_record", validateAction("892b50f3-51fc-4099-8f31-01e8dd8c3d44"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const number_plate = typeof body?.number_plate === 'string' ? body.number_plate.trim().toUpperCase() : undefined;
	const customer_name = typeof body?.customer_name === 'string' ? body.customer_name.trim() : undefined;
	const bayIdRaw =
		typeof body?.bay_id === 'string'
			? body.bay_id.trim()
			: typeof body?.Bay_id === 'string'
				? body.Bay_id.trim()
				: undefined;
	const bayNameRaw =
		typeof body?.bay_name === 'string'
			? body.bay_name.trim()
			: typeof body?.Bay_name === 'string'
				? body.Bay_name.trim()
				: undefined;
	const bayIdentifier = bayIdRaw || bayNameRaw;
	const entryTimeRaw =
		typeof body?.booking_date_time === 'string'
			? body.booking_date_time
			: typeof body?.entry_time === 'string'
				? body.entry_time
				: typeof body?.date_time === 'string'
					? body.date_time
					: undefined;

	let entryTime: Date | undefined;
	if (entryTimeRaw) {
		const parsed = new Date(entryTimeRaw);
		if (Number.isNaN(parsed.getTime())) {
			res.status(400).json({ error: "Invalid booking_date_time" });
			return;
		}
		entryTime = parsed;
	}

	if (!number_plate) {
		res.status(400).json({ error: "Missing number plate" });
		return;
	}

	try {
		const created = await CreateValetVehicleState(auth.restaurantId, entryTime, bayIdentifier, auth.outletId);
		const meta = await UpsertValetVehicleMeta(
			auth.restaurantId,
			created.booking_id,
			number_plate,
			customer_name,
			auth.outletId,
		);
		const data = {
			message: "New valet record created successfully.",
			booking_id: created.booking_id,
			entry_time: created.entry_time,
			bay_id: created.bay_id,
			number_plate: meta.number_plate,
			customer_name: meta.customer_name ?? undefined,
		};

		// Broadcast created valet record to connected frontends
		emitRestaurant(auth.restaurantId, "valet:created", data);
		try { await log_audit(req, "892b50f3-51fc-4099-8f31-01e8dd8c3d44", `Valet checked in ${number_plate}`, Audit_log_category.Valet, { booking_id: created.booking_id, bay_id: created.bay_id }); } catch (err) { logger.warn({ err }, "log_audit valet-checkin failed"); }
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "create_valet_record_failed");
		res.status(500).json({ error: "Unable to create valet record" });
		return;
	}
});

app.post("/valet/scan-plate", validateAction("892b50f3-51fc-4099-8f31-01e8dd8c3d44"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const imageRaw = typeof body?.image === 'string' ? body.image.trim() : undefined;
	if (!imageRaw) {
		res.status(400).json({ error: "Missing image" });
		return;
	}

	// Accept an optional `data:image/...;base64,` prefix; keep only the payload.
	const base64 = imageRaw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
	if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
		res.status(400).json({ error: "Invalid image data" });
		return;
	}
	// Reject payloads larger than ~6MB (base64 decodes to ~3/4 of its length).
	if (Math.floor((base64.length * 3) / 4) > 6 * 1024 * 1024) {
		res.status(400).json({ error: "Image too large" });
		return;
	}

	try {
		const buffer = Buffer.from(base64, "base64");
		const text = await runPlateOcr(buffer);
		// tesseract often sprinkles stray spaces inside a plate ("KA05 MH 12 34"),
		// which would split it into short tokens. Collapse gaps BETWEEN alphanumerics
		// so the plate stays whole, and try both forms (compacted wins when it yields
		// a longer/canonical match). extractPlate still handles surrounding text.
		const compact = text.replace(/([A-Za-z0-9])[ \t]+([A-Za-z0-9])/g, "$1$2").replace(/([A-Za-z0-9])[ \t]+([A-Za-z0-9])/g, "$1$2");
		const plate = extractPlate(compact) ?? extractPlate(text);
		res.json({ plate: plate ?? null });
		return;
	} catch (error) {
		logger.error({ err: error }, "valet_scan_plate_failed");
		res.json({ plate: null, error: "Plate scanning failed" });
		return;
	}
});

app.post("/get_valet_info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const record = await GetValetVehicleState(auth.restaurantId, booking_id, auth.outletId);
		if (!record) {
			res.status(404).json({ error: `No valet found with that booking ID - ${booking_id}.` });
			return;
		}
		const metaByBookingId = await GetValetVehicleMetaByBookingIds(auth.restaurantId, [booking_id], auth.outletId);
		const meta = metaByBookingId[booking_id];
		res.json({
			booking_id: record.booking_id,
			state: record.state,
			entry_time: record.entry_time,
			exit_time: record.exit_time,
			bay_id: record.bay_id,
			number_plate: meta?.number_plate,
			customer_name: meta?.customer_name ?? undefined,
			parking_location: record.parking_location,
			key_holder: record.key_holder,
			key_updated_at: record.key_updated_at,
			condition_notes: record.condition_notes,
			condition_photo_url: record.condition_photo_url,
			eta_minutes: record.eta_minutes,
			requested_at: record.requested_at,
		});
		return;
	} catch (error) {
		logger.error({ err: error }, "fetch_valet_info_failed");
		res.status(500).json({ error: "Unable to fetch valet info" });
		return;
	}
});


app.post("/update_valet_state", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	const state = body?.state === null || body?.state === undefined ? undefined : String(body.state).trim();
	if (!booking_id || !state) {
		res.status(400).json({ error: "Missing booking ID or state" });
		return;
	}

	try {
		const data = await updateValetStateAndPublish(auth.restaurantId, booking_id, state, auth.outletId);
		try { await log_audit(req, "b8e02c25-b91c-427c-b462-8df009ede055", `Valet state -> ${state} for ${booking_id}`, Audit_log_category.Valet, { booking_id, state }); } catch (err) { logger.warn({ err }, "log_audit valet-state failed"); }
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "update_valet_state_failed");
		const status = typeof (error as { status?: unknown })?.status === "number"
			? ((error as { status: number }).status)
			: 500;
		const payload = (error as { payload?: unknown })?.payload;
		if (status !== 500 && payload && typeof payload === "object") {
			res.status(status).json(payload);
			return;
		}
		res.status(500).json({ error: "Unable to update valet state" });
		return;
	}
});

app.post("/update_valet_bay", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	// Accept bay_id in body; fall back to bay_name for backward compatibility
	const bay_id_raw = body?.bay_id ?? body?.bay_name;
	const bay_id = bay_id_raw === null || bay_id_raw === undefined ? undefined : String(bay_id_raw).trim();
	if (!booking_id || !bay_id) {
		res.status(400).json({ error: "Missing booking ID or bay id" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleBay(auth.restaurantId, booking_id, bay_id, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No active valet record found for that booking ID - ${booking_id}.` });
			return;
		}
		const data = {
			message: "Valet bay updated successfully.",
			booking_id: updated.booking_id,
			bay_id: updated.bay_id,
		};
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "update_valet_bay_failed");
		res.status(500).json({ error: String((error as Error)?.message ?? "Unable to update valet bay") });
		return;
	}
});

app.post("/unassign-valet-bay", validateAction("5ef876a7-eb92-4602-b4d3-5590ce379540"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleBay(auth.restaurantId, booking_id, null, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No active valet record found for that booking ID - ${booking_id}.` });
			return;
		}
		const data = {
			message: "Valet bay updated successfully.",
			booking_id: updated.booking_id,
			bay_id: updated.bay_id,
		};
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "unassign_valet_bay_failed");
		res.status(500).json({ error: "Unable to unassign valet bay" });
		return;
	}
});

// Occupied tables a valet fee can be charged to (the valet role cannot call
// /get-tables, so the picker gets its own read under the valet-info action).
app.get("/valet/charge-targets", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	try {
		const tables = await GetTables(auth.restaurantId);
		const targets = (tables ?? [])
			.filter((t) => t.occupied === true)
			.map((t) => ({ table_name: t.table_name, covers: t.covers ?? null }));
		res.json({ tables: targets });
	} catch (error) {
		logger.error({ err: error }, "valet_charge_targets_failed");
		res.status(500).json({ error: "Unable to fetch occupied tables" });
	}
});

// Parking location / condition notes (+ optional photo) / retrieval ETA.
app.post("/valet/:bookingId/ops", validateAction(PERM_VALET_OPS), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId.trim() : "";
	if (!bookingId) { res.status(400).json({ error: "Missing booking ID" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;

	const patch: import("../database_supabase.js").ValetOpsPatch = {};
	if ("parking_location" in body) {patch.parking_location = typeof body.parking_location === "string" ? body.parking_location.slice(0, 120) : null;}
	if ("condition_notes" in body) {patch.condition_notes = typeof body.condition_notes === "string" ? body.condition_notes.slice(0, 1000) : null;}
	if ("eta_minutes" in body) {
		const eta = Number(body.eta_minutes);
		patch.eta_minutes = Number.isFinite(eta) && eta > 0 ? Math.min(240, Math.round(eta)) : null;
	}
	// Optional condition photo — reuses the menu-image storage helper.
	if (typeof body.condition_photo_base64 === "string" && body.condition_photo_base64.trim()) {
		try {
			const url = await uploadMenuImage(
				body.condition_photo_base64,
				typeof body.condition_photo_content_type === "string" ? body.condition_photo_content_type : "image/jpeg",
			);
			if (url) {patch.condition_photo_url = url;}
		} catch (err) {
			logger.warn({ err }, "valet condition photo upload failed");
		}
	} else if ("condition_photo_url" in body) {
		patch.condition_photo_url = typeof body.condition_photo_url === "string" ? body.condition_photo_url.slice(0, 500) : null;
	}

	if (Object.keys(patch).length === 0) {
		res.status(400).json({ error: "Nothing to update — send parking_location, condition_notes, eta_minutes or a condition photo" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleOps(auth.restaurantId, bookingId, patch, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No valet record found for that booking ID - ${bookingId}.` });
			return;
		}
		const plate = await valetPlateFor(auth.restaurantId, bookingId, auth.outletId);
		const changed = Object.keys(patch).join(", ");
		try {
			await log_audit(req, VALET_ACTION_OPS_UPDATE, `Valet ops (${changed}) updated for ${plate}`, Audit_log_category.Valet, { booking_id: bookingId, ...patch });
		} catch (err) { logger.warn({ err }, "log_audit valet-ops failed"); }
		try { emitRestaurant(auth.restaurantId, "valet:updated", { booking_id: bookingId, ops: patch }); } catch (err) { logger.warn({ err }, "emit valet:updated failed"); }
		res.json({ success: true, record: updated });
	} catch (error) {
		logger.error({ err: error }, "update_valet_ops_failed");
		res.status(500).json({ error: "Unable to update valet record" });
	}
});

// Digital key log: "take" puts the keys in the logged-in attendant's hands,
// "handover" records them leaving (returned to guest / hung on the board).
app.post("/valet/:bookingId/keys", validateAction(PERM_VALET_KEYS), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId.trim() : "";
	const action = String((req.body as Record<string, unknown> | undefined)?.action ?? "").trim().toLowerCase();
	if (!bookingId) { res.status(400).json({ error: "Missing booking ID" }); return; }
	if (action !== "take" && action !== "handover") {
		res.status(400).json({ error: "action must be 'take' or 'handover'" });
		return;
	}

	try {
		let holder: string | null = null;
		if (action === "take") {
			const employeeId = extractEmployeeId(req);
			const emp = employeeId ? await GetEmployeeDetailsFromEmpID(employeeId).catch(() => null) : null;
			// Ignore placeholder name parts ("-") so the log reads "Admin", not "Admin -".
			const fullName = [emp?.emp_Fname, emp?.emp_Lname]
				.map((s) => String(s ?? "").trim())
				.filter((s) => s && s !== "-")
				.join(" ");
			holder = fullName || emp?.employee_Username || "attendant";
		}
		const updated = await UpdateValetVehicleOps(auth.restaurantId, bookingId, { key_holder: holder }, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No valet record found for that booking ID - ${bookingId}.` });
			return;
		}
		const plate = await valetPlateFor(auth.restaurantId, bookingId, auth.outletId);
		try {
			await log_audit(
				req,
				VALET_ACTION_KEY_LOG,
				action === "take" ? `${holder} took keys for ${plate}` : `Keys for ${plate} handed over`,
				Audit_log_category.Valet,
				{ booking_id: bookingId, action, key_holder: holder },
			);
		} catch (err) { logger.warn({ err }, "log_audit valet-keys failed"); }
		try { emitRestaurant(auth.restaurantId, "valet:updated", { booking_id: bookingId, key_holder: holder }); } catch (err) { logger.warn({ err }, "emit valet:updated failed"); }
		res.json({ success: true, key_holder: updated.key_holder, key_updated_at: updated.key_updated_at });
	} catch (error) {
		logger.error({ err: error }, "update_valet_keys_failed");
		res.status(500).json({ error: "Unable to update key log" });
	}
});

// Valet fee → the table's POS bill (folio integration). The fee is posted as a
// normal ORDER line item ("Valet parking") on the table, so it flows through the
// existing one-bill-per-table math (subtotal → discount → service charge → tax)
// with zero special-casing; AddOrder rejects unoccupied tables, which is exactly
// the "no open session" guard.
app.post("/valet/:bookingId/charge", validateAction(PERM_VALET_CHARGE), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId.trim() : "";
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
	if (!bookingId) { res.status(400).json({ error: "Missing booking ID" }); return; }
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	if (!(amount > 0)) { res.status(400).json({ error: "amount must be a positive number" }); return; }

	try {
		const record = await GetValetVehicleState(auth.restaurantId, bookingId, auth.outletId);
		if (!record) {
			res.status(404).json({ error: `No valet record found for that booking ID - ${bookingId}.` });
			return;
		}
		const plate = await valetPlateFor(auth.restaurantId, bookingId, auth.outletId);

		const employeeId = extractEmployeeId(req);
		const emp = employeeId ? await GetEmployeeDetailsFromEmpID(employeeId).catch(() => null) : null;

		let orderId: string;
		try {
			const result = await AddOrder(auth.restaurantId, {
				table: tableName,
				customer: "Guest",
				// Served: the fee must never appear as a pending kitchen ticket.
				status: "Served",
				items: [{
					id: randomUUID(),
					name: "Valet parking",
					quantity: 1,
					price: amount,
					orderedAt: new Date().toISOString(),
					note: `Vehicle ${plate}`,
				}],
				subtotal: amount,
				total: amount,
				taxes: [],
				applyServiceCharge: false,
				note: `Valet parking fee — vehicle ${plate}`,
				taken_by_employee_id: employeeId ?? null,
				taken_by_employee_name: emp?.employee_Username ?? null,
				taken_by_employee_role: "valet",
			} as any);
			orderId = result.id;
		} catch (error: any) {
			// AddOrder's guards ("Table not found", "Cannot add order to unoccupied
			// table…") are clean client errors, not server faults.
			res.status(400).json({ error: String(error?.message ?? "Unable to post valet fee") });
			return;
		}

		try {
			await log_audit(req, VALET_ACTION_CHARGE, `Valet fee ${amount} charged to ${tableName} for ${plate}`, Audit_log_category.Valet, { booking_id: bookingId, table_name: tableName, amount, order_id: orderId });
		} catch (err) { logger.warn({ err }, "log_audit valet-charge failed"); }
		try {
			await AddNotification(auth.restaurantId, {
				type: "valet",
				title: `Valet fee added to ${tableName}`,
				body: `Valet parking (${plate}) — ${amount} on the table's bill`,
				meta: { booking_id: bookingId, table_name: tableName, amount, order_id: orderId },
			});
		} catch (err) { logger.warn({ err }, "valet charge notification failed"); }
		try { emitRestaurant(auth.restaurantId, "order:updated", { order_id: orderId, table: tableName }); } catch (err) { logger.warn({ err }, "emit order:updated failed"); }

		res.status(201).json({ success: true, order_id: orderId, table_name: tableName, amount });
	} catch (error) {
		logger.error({ err: error }, "valet_charge_failed");
		res.status(500).json({ error: "Unable to charge valet fee" });
	}
});
}
