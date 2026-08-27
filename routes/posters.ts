/**
 * Promotional POSTERS: the staff-side library behind the guest menu's poster
 * slots. Upload, list, edit (placement / order / schedule / pause), delete.
 *
 * Gated by PERM_BRANDING ("Manage Branding"), not by a new permission. A poster
 * is presentation on the customer-facing pages — exactly what that permission
 * already governs for the logo, the palette and the queue menu toggle — and
 * minting a permission nobody's roles carry would lock every existing tenant out
 * of a feature they just asked for until an admin edited their roles.
 *
 * Gated with validateAction(...) and NOT with bare `validate`: `validate` is a
 * no-op alias that authenticates without checking a single permission, so a
 * route that only wears it is open to every logged-in waiter.
 */
import type { Express, Request, Response } from "express";
import {
  Audit_log_category,
  CreatePoster,
  DeletePoster,
  ListPosters,
  POSTER_MAX_STORED,
  POSTER_MAX_UPLOAD_BYTES,
  POSTER_PLACEMENT_META,
  UpdatePoster,
  sanitizePosterPatch,
  validatePosterUpload,
} from "../database_supabase.js";
import { logger } from "../observability.js";
import { uploadPosterImage } from "../storage_bucket_supabase.js";
import { PERM_BRANDING, extractEmployeeId, extractRestaurantId, log_audit, validateAction } from "./_shared.js";

// A poster save failure that is the OWNER'S to fix (a backwards date window, the
// library being full) carries a message worth showing; anything else is an
// internal fault and must not leak its text. Both arrive here as thrown Errors
// from the db layer, so they are told apart by whether the message is one the db
// layer deliberately wrote for a human.
const OWNER_FIXABLE = [
  "The end date is before the start date.",
  `You can keep up to ${String(POSTER_MAX_STORED)} posters. Delete one to add another.`,
];
function posterClientError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : "";
  return OWNER_FIXABLE.includes(msg) ? msg : null;
}

export function registerPosterRoutes(app: Express): void {

// The library, plus the two things the editors would otherwise have to hardcode:
// the placement catalogue (labels + hints) and the restaurant's CURRENT day key,
// which is what lets an editor mark a row "showing now" using the same rule the
// guest page uses instead of the browser's own clock (an owner in Dubai
// administering a Kolkata restaurant has a different idea of "today").
app.get("/posters", validateAction(PERM_BRANDING), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const { posters, today, timezone } = await ListPosters(restaurantId);
		res.json({
			posters,
			today,
			timezone,
			placements: POSTER_PLACEMENT_META,
			max_posters: POSTER_MAX_STORED,
			max_upload_bytes: POSTER_MAX_UPLOAD_BYTES,
		});
	} catch (err) {
		logger.error({ err }, "list_posters_failed");
		res.status(500).json({ error: "Unable to load posters" });
	}
});

// Create. The image is uploaded in the SAME request as the metadata (rather than
// an upload endpoint plus a create endpoint, the way /menu/upload-image works)
// because a poster row without an image is not a thing that can exist: splitting
// them would leave an abandoned object in the bucket every time an owner picked
// a file and then closed the dialog.
app.post("/posters", validateAction(PERM_BRANDING), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;

	// Size + declared type FIRST, before the payload is decoded into a Buffer or
	// handed to an image decoder. See validatePosterUpload: the point is that the
	// expensive work never runs on a payload we were always going to refuse.
	const check = validatePosterUpload({ image_base64: body.image_base64, content_type: body.content_type });
	if (!check.ok) { res.status(400).json({ error: check.error }); return; }

	try {
		const uploaded = await uploadPosterImage(String(body.image_base64), check.content_type);
		if (!uploaded.ok) {
			// The two failures get two answers on purpose. "unreadable" means the
			// declared type was a claim the bytes did not honour — that is the
			// owner's to fix, so 400 with something they can act on. "storage" is our
			// environment being wrong; 502 with the same wording /menu/upload-image
			// already uses, so an operator seeing it in the logs recognises it.
			if (uploaded.reason === "storage") {
				logger.error({ restaurantId }, "poster_upload_storage_unavailable");
				res.status(502).json({ error: "Image upload failed (storage not configured)" });
				return;
			}
			res.status(400).json({ error: "We couldn't read that image. Try a PNG, JPEG or WebP export." });
			return;
		}
		const poster = await CreatePoster(restaurantId, {
			image_url: uploaded.url,
			width: uploaded.width,
			height: uploaded.height,
			patch: sanitizePosterPatch(body),
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try {
			await log_audit(req, PERM_BRANDING, `Added guest-menu poster${poster.title ? ` "${poster.title}"` : ""}`, Audit_log_category.General, {
				poster_id: poster.id,
				placement: poster.placement,
				start_on: poster.start_on,
				end_on: poster.end_on,
			});
		} catch (err) { logger.warn({ err }, "log_audit poster-create failed"); }
		res.status(201).json(poster);
	} catch (err) {
		const client = posterClientError(err);
		if (client) { res.status(400).json({ error: client }); return; }
		logger.error({ err }, "create_poster_failed");
		res.status(500).json({ error: "Unable to save poster" });
	}
});

// Edit: title, placement, order, schedule, paused. Merge-on-omit — a field the
// editor did not send keeps its stored value; a date sent as null clears that
// bound. The IMAGE is not replaceable here on purpose: swapping the picture
// under a poster's id is indistinguishable to an owner from deleting it and
// adding a new one, and this way there is exactly one code path that puts bytes
// in the bucket.
app.patch("/posters/:id", validateAction(PERM_BRANDING), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const posterId = req.params.id;
	const body = (req.body ?? {}) as Record<string, unknown>;
	// image_url is stripped rather than ignored silently further down, so a client
	// that tries gets nothing rather than a partially-applied save.
	delete body.image_url;
	try {
		const poster = await UpdatePoster(restaurantId, posterId, body);
		if (!poster) { res.status(404).json({ error: "Poster not found" }); return; }
		try {
			await log_audit(req, PERM_BRANDING, `Updated guest-menu poster${poster.title ? ` "${poster.title}"` : ""}`, Audit_log_category.General, {
				poster_id: poster.id,
				placement: poster.placement,
				active: poster.active,
				start_on: poster.start_on,
				end_on: poster.end_on,
			});
		} catch (err) { logger.warn({ err }, "log_audit poster-update failed"); }
		res.json(poster);
	} catch (err) {
		const client = posterClientError(err);
		if (client) { res.status(400).json({ error: client }); return; }
		logger.error({ err }, "update_poster_failed");
		res.status(500).json({ error: "Unable to save poster" });
	}
});

// Delete. NO undo envelope, deliberately: PerformAuditUndo is an allowlist that
// denies by default (see the `undo` kinds table in database_supabase.ts), and a
// poster undo would have to re-insert a row under its original id to be worth
// anything. Instead the whole record — image URL included — goes into the audit
// detail, so an owner who deletes the wrong poster can be put back by hand
// without the image having been touched (DeletePoster leaves the object in the
// bucket for exactly this reason).
app.delete("/posters/:id", validateAction(PERM_BRANDING), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const posterId = req.params.id;
	try {
		const removed = await DeletePoster(restaurantId, posterId);
		if (!removed) { res.status(404).json({ error: "Poster not found" }); return; }
		try {
			await log_audit(req, PERM_BRANDING, `Deleted guest-menu poster${removed.title ? ` "${removed.title}"` : ""}`, Audit_log_category.General, {
				poster: removed,
			});
		} catch (err) { logger.warn({ err }, "log_audit poster-delete failed"); }
		res.json({ deleted: removed.id });
	} catch (err) {
		logger.error({ err }, "delete_poster_failed");
		res.status(500).json({ error: "Unable to delete poster" });
	}
});
}
