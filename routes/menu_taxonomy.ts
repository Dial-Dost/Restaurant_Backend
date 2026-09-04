/**
 * MENU GROUPS + ITEM VARIATIONS — the HTTP surface over migration 039.
 *
 * A GROUP is how the money is CUT (Food / Beverage / Liquor / Tobacco) or where
 * the food is MADE (Kitchen / Bar / Bakery). It is the axis an accountant and a
 * licensing return ask for first, and no report could produce it because nothing
 * on the menu said which was which.
 *
 * A VARIATION is a PRICE POINT of one dish — Half at ₹150 against a Full at
 * ₹250. Today a Half is entered as a separate menu item or typed at the till as
 * an off-menu line, which is how one dish's sales end up split across three rows
 * with three different names.
 *
 * The tables, the merge rules (menu_taxonomy.ts), the classification
 * (mis_capture.ts) and the price floor (billing_math.ts) were all written
 * before this file. What is left here is authorisation, the shape of a request,
 * the audit line, and the refusals.
 *
 * ============================================================================
 * THE PRIME CONSTRAINT: A RESTAURANT THAT CONFIGURES NOTHING IS UNCHANGED
 * ============================================================================
 * Most tenants will never open this screen, and for them nothing about this
 * feature may be observable. That is not a wish, it is a property with a
 * mechanism behind it at every layer:
 *
 *   * NO GROUP, NO VARIATION -> no rows in either table. ListMenuGroups and
 *     ListMenuVariations return [], variationPayloadFor returns `{}` rather than
 *     `{variations: []}`, and the guest menu payload is therefore byte-identical
 *     to the one served before 039 existed — the same contract `posters` and
 *     `brand_config` already follow on that route.
 *   * NO variation_id ON A LINE -> resolveLinePriceFloor returns the item's base
 *     price, which is arithmetically what both order paths did before.
 *   * MIGRATION 039 UNAPPLIED -> every read here goes through captureRead, which
 *     degrades a missing table to "nothing configured". The editor opens empty
 *     instead of 500-ing, and every other screen is untouched.
 *
 * jest-tests/menu_taxonomy.test.ts pins that parity field by field rather than
 * trusting the paragraph above.
 *
 * ============================================================================
 * WHY THESE RIDE ON THE MENU PERMISSIONS AND NOT ON A NEW ONE
 * ============================================================================
 * Reading is View Menu; writing is Edit Menu — the SAME pair PATCH /menu/:id/price
 * and PUT /menu/badges already use. That is deliberate, and it is the opposite of
 * the call made for the 034/035/036 capture routes, which got Actions of their
 * own. The distinction is what the write DOES: a comp, a void and a waiver each
 * REDUCE WHAT ONE GUEST PAYS ON ONE OPEN BILL, which is a floor act a waiter
 * could abuse tonight, so each earned its own grantable permission and a second
 * name against it. Editing a variation's price is a MENU price edit — the same
 * act, the same blast radius and the same reversibility as editing the dish's
 * own price, which has always been Edit Menu. Inventing a third menu permission
 * for it would mean every tenant has to re-grant something to keep doing what
 * they already do, and would leave "Edit Menu" holders able to change a dish's
 * price but not its Half price, which is not a distinction anyone asked for.
 *
 * Both ids are spelled in full below rather than through a PERM_ constant,
 * matching routes/menu.ts, so the two files read the same way.
 *
 * ============================================================================
 * WHAT THIS FILE REFUSES TO EXPOSE
 * ============================================================================
 *   * ANY WHOLESALE REPLACE. There is no PUT /menu-groups and no PUT
 *     /menu-variations. A full-replace bulk save once wiped 56 menu items'
 *     images, sections and recipes, and the rule that came out of it is that a
 *     field absent from a payload means "keep what is stored". Every write here
 *     is one row, snapshotted, merged and written back.
 *   * DELETE, of either kind. 039 says deactivation, not deletion, for both
 *     tables: a variation id is stamped onto order lines, and an order that
 *     named "Half" must still be able to print that label next year. Retiring is
 *     `{"active": false}` on the PATCH.
 *   * MOVING A VARIATION TO ANOTHER DISH. mergeMenuVariationPatch refuses it in
 *     a sentence an owner can act on, and UpdateMenuVariationById leaves the
 *     column out of the UPDATE so no later caller can do it by accident. Doing
 *     it would relabel every past sale that named the variation.
 *   * A GROUP ON THE GUEST MENU. A group is a classification for reports; the
 *     public payload is deliberately untouched by it.
 *
 * ============================================================================
 * NO idempotent() ON ANY ROUTE HERE — so the Flutter outbox ALLOWLIST in
 * restaurant_owner_app/lib/services/outbox.dart is UNCHANGED and still mirrors
 * the server opt-in exactly.
 * ============================================================================
 * These are menu-configuration writes made once, at a desk, by an owner — not
 * writes a waiter makes fifty times during service on a phone that keeps losing
 * signal, which is the population idempotency.ts exists for. Every one of them
 * is also already safe to repeat by construction: a create is refused with a 409
 * when the name is taken, and a PATCH is a merge over a snapshot, so replaying
 * it lands the same row.
 */
import type { Express, Request, Response } from "express";
import {
	Audit_log_category,
	GetMenuGroupAssignments,
	GetMenuGroupById,
	GetMenuVariationById,
	ListMenuGroups,
	ListMenuVariations,
	MENU_GROUP_KINDS,
	SetMenuGroupAssignment,
	UpdateMenuGroupById,
	UpdateMenuVariationById,
	UpsertMenuGroup,
	UpsertMenuVariation,
	mergeMenuGroupPatch,
	mergeMenuVariationPatch,
	type MenuGroupKind,
	type MenuGroupRecord,
	type MenuVariationRecord,
} from "../database_supabase.js";
import { logger } from "../observability.js";
import { extractRestaurantId, log_audit, validateAction } from "./_shared.js";


// The same two ids routes/menu.ts gates the menu with — see this file's header
// for why a variation's price edit is a menu edit and not a new permission.
const PERM_VIEW_MENU = "f4177b38-77fa-4d8c-9fbd-c4f06bf28610";
const PERM_EDIT_MENU = "ed800655-b937-44ba-a7ca-7458295886c9";

/**
 * The same shape database_supabase.ts's isUuid() guards with. Spelled here so a
 * query-string filter can be REFUSED at the edge instead of being dropped
 * silently in the data layer — see GET /menu-variations.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Postgres unique_violation — a group/variation with that name already exists. */
function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23505";
}

/** Postgres foreign_key_violation — the named dish is not on this outlet's menu. */
function isForeignKeyViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23503";
}

/**
 * `?include_inactive=true` — retired rows included.
 *
 * DEFAULT FALSE on every read, because the usual caller is a picker and a retired
 * price point must never be offerable again. The editor asks for them
 * explicitly, which is also the only way to reinstate one.
 */
function wantsInactive(req: Request): boolean {
	const raw = req.query.include_inactive;
	return raw === "true" || raw === "1";
}

/**
 * `?kind=revenue|production`.
 *
 * An UNKNOWN value is refused rather than defaulted, for the reason
 * mergeMenuGroupPatch gives: a group filed on one axis is invisible to a report
 * asking for the other, so a typo has to be told, not absorbed into the wrong
 * answer. Returns `{ ok: false }` once the refusal has been sent.
 *
 * ABSENT means "both axes" here and "revenue" at the two call sites that must
 * pick one. That is not an inconsistency — it is the difference between listing
 * and resolving. Listing both is lossless (the caller can filter what it got);
 * defaulting the LIST to revenue would silently hide every production group an
 * owner had configured, which is the worse failure. Resolution, by contrast,
 * cannot straddle the axes: an item's group is coalesced per kind, so
 * /menu-group-assignments has to be told which one and revenue — how the money
 * is cut — is the one every tenant wants first.
 */
function readKind(req: Request, res: Response): { ok: true; kind?: MenuGroupKind } | { ok: false } {
	const raw = typeof req.query.kind === "string" ? req.query.kind.trim().toLowerCase() : "";
	if (!raw) {return { ok: true };}
	const found = MENU_GROUP_KINDS.find((k) => k === raw);
	if (!found) {
		res.status(400).json({ error: `kind must be one of: ${MENU_GROUP_KINDS.join(", ")}` });
		return { ok: false };
	}
	return { ok: true, kind: found };
}


export function registerMenuTaxonomyRoutes(app: Express): void {

// --- GROUPS: read ------------------------------------------------------------

/*
	The outlet's groups. BOTH axes unless one is asked for.

	GET /menu-groups?kind=revenue&include_inactive=false
	  -> 200 { kind, kinds, groups: [...] }

	`kind` echoes back what was applied (null = both), so a client never has to
	guess what it received. `kinds` is served rather than hardcoded in each
	client, so the two editors and the report screens can never offer an axis the
	server would refuse.
*/
app.get("/menu-groups", validateAction(PERM_VIEW_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const parsed = readKind(req, res);
	if (!parsed.ok) {return;}
	try {
		const groups = await ListMenuGroups(restaurantId, {
			...(parsed.kind ? { kind: parsed.kind } : {}),
			includeInactive: wantsInactive(req),
		});
		res.json({ kind: parsed.kind ?? null, kinds: MENU_GROUP_KINDS, groups });
	} catch (err) {
		logger.error({ err }, "list_menu_groups_failed");
		res.status(500).json({ error: "Unable to fetch menu groups" });
	}
});

/*
	The classification map: every category and every dish, with what it is filed
	as and what that resolves to.

	GET /menu-group-assignments?kind=revenue
	  -> 200 { kind, groups, categories, items, unclassified_items }

	This is the ONLY place a client can learn a category's id — GetMenuCategories
	returns bare names and GetMenuItems flattens the taxonomy to one string — so
	without it the category default, which is the assignment worth making, could
	not be set at all.

	`unclassified_items` is deliberately prominent: a report that cuts by group
	carries an Unclassified bucket, and its totals only equal the sales summary's
	because that bucket is counted. An owner should meet that number here, before
	a report shows it to their accountant.
*/
app.get("/menu-group-assignments", validateAction(PERM_VIEW_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const parsed = readKind(req, res);
	if (!parsed.ok) {return;}
	try {
		res.json(await GetMenuGroupAssignments(restaurantId, parsed.kind ?? "revenue"));
	} catch (err) {
		logger.error({ err }, "get_menu_group_assignments_failed");
		res.status(500).json({ error: "Unable to fetch menu group assignments" });
	}
});

// --- GROUPS: write -----------------------------------------------------------

/*
	Create a group.

	POST /menu-groups  body { name, kind?, active?, sort_order? }
	  -> 201 { group }
	  -> 409 { error, group } when that name is already taken on that axis

	THE 409 IS THE POINT. "Beverage" and "beverage" as two groups would split one
	bucket in two on every report that sums by name, which is why 039 makes the
	name unique per (outlet, kind) case-insensitively. Handing the EXISTING row
	back with the refusal lets an editor offer "you already have this — edit it?"
	instead of a dead end, and it is strictly better than the alternative of
	quietly adopting the stored row: adopting it would apply this payload's
	defaults to a group somebody else configured, silently reactivating a retired
	one and resetting its position.
*/
app.post("/menu-groups", validateAction(PERM_EDIT_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	// A create merges over NOTHING, which is how the module documents its
	// defaults (revenue / active / position 0) in one place instead of here.
	const merged = mergeMenuGroupPatch(null, body);
	if (!merged.ok) { res.status(400).json({ error: merged.error }); return; }
	const write = merged.value;

	try {
		const existing = (await ListMenuGroups(restaurantId, { kind: write.kind, includeInactive: true }))
			.find((g: MenuGroupRecord) => g.name.trim().toLowerCase() === write.name.trim().toLowerCase());
		if (existing) {
			res.status(409).json({
				error: existing.active
					? `A ${write.kind} group called "${existing.name}" already exists.`
					: `A ${write.kind} group called "${existing.name}" already exists but is retired — reinstate it instead of creating a second one.`,
				group: existing,
			});
			return;
		}
		const group = await UpsertMenuGroup(restaurantId, write);
		try {
			await log_audit(req, PERM_EDIT_MENU, `Added menu group ${group.name} (${group.kind})`, Audit_log_category.Menu, {
				group_id: group.id, name: group.name, kind: group.kind, active: group.active, sort_order: group.sort_order,
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-group-create failed"); }
		res.status(201).json({ group });
	} catch (err) {
		if (isUniqueViolation(err)) {
			// Lost the race against another editor between the check above and the
			// insert. Same answer, because it is the same situation.
			res.status(409).json({ error: `A ${write.kind} group called "${write.name}" already exists.` });
			return;
		}
		logger.error({ err }, "create_menu_group_failed");
		res.status(500).json({ error: "Unable to create the menu group" });
	}
});

/*
	Edit a group — rename it, move it to the other axis, reposition it, retire it.

	PATCH /menu-groups/:id  body { name?, kind?, active?, sort_order? }
	  -> 200 { group }

	A MERGE OVER A SNAPSHOT, never a replace: a key absent from the body keeps
	what is stored. So `{"active": false}` retires a group without touching its
	name, its axis or its position — which is the whole reason a client is allowed
	to send a partial body at all.

	RETIRING IS THE ONLY WAY OUT. There is no DELETE: a group id sits on menu rows
	and categories, and reports resolve it at read time so that a classification
	correction makes the last six months right (039's header). Deleting one would
	strand those references and rewrite history as Unclassified.
*/
app.patch("/menu-groups/:id", validateAction(PERM_EDIT_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const groupId = String(req.params.id ?? "").trim();
	if (!groupId) { res.status(400).json({ error: "group id is required" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;

	try {
		const stored = await GetMenuGroupById(restaurantId, groupId);
		if (!stored) { res.status(404).json({ error: "Menu group not found" }); return; }
		const merged = mergeMenuGroupPatch(stored, body);
		if (!merged.ok) { res.status(400).json({ error: merged.error }); return; }
		const group = await UpdateMenuGroupById(restaurantId, groupId, merged.value);
		if (!group) { res.status(404).json({ error: "Menu group not found" }); return; }
		try {
			await log_audit(req, PERM_EDIT_MENU, `Updated menu group ${group.name} (${group.kind})`, Audit_log_category.Menu, {
				group_id: group.id, name: group.name, kind: group.kind, active: group.active, sort_order: group.sort_order,
				prior: { name: stored.name, kind: stored.kind, active: stored.active, sort_order: stored.sort_order },
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-group-update failed"); }
		res.json({ group });
	} catch (err) {
		if (isUniqueViolation(err)) {
			res.status(409).json({ error: "Another group on that axis already has this name." });
			return;
		}
		logger.error({ err }, "update_menu_group_failed");
		res.status(500).json({ error: "Unable to update the menu group" });
	}
});

/*
	File a CATEGORY (the default) or one DISH (the exception) under a group.

	POST /menu-group-assignments
	  body { main_cat_id | menu_id, group_id | null }
	  -> 200 { assigned: true, target, group_id }

	TWO TARGETS, ONE ROUTE, because they are one decision with a precedence:
	item override -> category default -> Unclassified. Setting the group on ~12
	categories is the workflow; the per-item override exists for the genuine
	exception (the mocktail listed under Desserts), and 039 declined to make
	owners do 300 edits to avoid it.

	`group_id: null` CLEARS. On an item that means "fall back to my category"; on
	a category it means "everything under me is Unclassified until somebody says
	otherwise". Neither is an error — an unclassified menu is what every tenant
	has on the day this ships, and the reports say so out loud rather than
	inventing a group.

	The group is NOT snapshotted onto anything. It is resolved when a report runs,
	so fixing a six-month-old misfiling makes six months of reports right instead
	of freezing the error into history.
*/
app.post("/menu-group-assignments", validateAction(PERM_EDIT_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const menuId = typeof body.menu_id === "string" ? body.menu_id.trim() : "";
	const mainCatId = typeof body.main_cat_id === "string" ? body.main_cat_id.trim() : "";
	if (!menuId && !mainCatId) { res.status(400).json({ error: "menu_id or main_cat_id is required" }); return; }
	if (menuId && mainCatId) {
		// Refused rather than picking one: the two mean different things (an
		// exception versus a default), and silently honouring the item while
		// ignoring the category would leave the owner looking at a screen that
		// disagrees with the report.
		res.status(400).json({ error: "Send either menu_id or main_cat_id, not both." });
		return;
	}
	// `null` is a real value here — it clears the assignment — so an absent key
	// and an explicit null are deliberately treated the same way. There is
	// nothing else this route could preserve.
	const groupId = typeof body.group_id === "string" && body.group_id.trim() ? body.group_id.trim() : null;

	try {
		if (groupId) {
			// A group from ANOTHER outlet, or one that never existed, would be
			// stored as a dangling uuid that resolves to nothing — an item that
			// looks classified on this screen and reports as Unclassified. Checked
			// here because neither column carries a foreign key (039 left them bare
			// so an unapplied migration cannot break a menu write).
			const known = await GetMenuGroupById(restaurantId, groupId);
			if (!known) { res.status(400).json({ error: "That group is not one of this outlet's menu groups." }); return; }
		}
		const ok = await SetMenuGroupAssignment(
			restaurantId,
			menuId ? { menu_id: menuId } : { main_cat_id: mainCatId },
			groupId,
		);
		if (!ok) { res.status(404).json({ error: menuId ? "Menu item not found" : "Menu category not found" }); return; }
		const target = menuId ? `item ${menuId}` : `category ${mainCatId}`;
		try {
			await log_audit(req, PERM_EDIT_MENU, groupId ? `Filed menu ${target} under group ${groupId}` : `Cleared the menu group on ${target}`, Audit_log_category.Menu, {
				...(menuId ? { menu_id: menuId } : { main_cat_id: mainCatId }),
				group_id: groupId,
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-group-assign failed"); }
		res.json({ assigned: true, ...(menuId ? { menu_id: menuId } : { main_cat_id: mainCatId }), group_id: groupId });
	} catch (err) {
		logger.error({ err }, "assign_menu_group_failed");
		res.status(400).json({ error: String((err as { message?: unknown })?.message ?? "Unable to file that under a group") });
	}
});

// --- VARIATIONS: read --------------------------------------------------------

/*
	The price points of one dish, or of the whole menu.

	GET /menu-variations?menu_id=<uuid>&include_inactive=false
	  -> 200 { variations: [...] }

	Serves the STORED rows (an editor has to see sort_order and the retired ones
	it may reinstate). What a GUEST is offered is a narrower thing — see
	publicVariationsByItem, which drops the inactive rows and lets at most one
	claim `is_default`; that shaping belongs to the guest payload, not here.
*/
app.get("/menu-variations", validateAction(PERM_VIEW_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const menuId = typeof req.query.menu_id === "string" ? req.query.menu_id.trim() : "";
	// A MALFORMED menu_id is refused rather than ignored. ListMenuVariations
	// drops a non-uuid filter and answers for the WHOLE menu, so a client with a
	// typo'd id would silently be handed every dish's price points and render
	// them against one dish — a wrong answer that looks like a right one.
	if (menuId && !UUID_RE.test(menuId)) { res.status(400).json({ error: "menu_id must be a menu item id" }); return; }
	try {
		const variations = await ListMenuVariations(restaurantId, {
			...(menuId ? { menu_id: menuId } : {}),
			includeInactive: wantsInactive(req),
		});
		res.json({ variations });
	} catch (err) {
		logger.error({ err }, "list_menu_variations_failed");
		res.status(500).json({ error: "Unable to fetch menu variations" });
	}
});

// --- VARIATIONS: write -------------------------------------------------------

/*
	Add a price point to a dish.

	POST /menu-variations  body { menu_id, name, price, is_default?, active?, sort_order? }
	  -> 201 { variation }
	  -> 409 { error, variation } when that dish already has one by that name

	A ZERO PRICE IS REFUSED even though the CHECK allows it, and this is the money
	sentence in this file: applyMenuPriceFloor and repriceFromMenu floor a line
	naming a variation at the VARIATION's price, so a ₹0 variation is a standing
	invitation to ring any quantity of that dish in at ₹0 with the bill still
	printing its name. Free food is a non-chargeable (migration 034) — a different
	act, with a reason, an authoriser and a ledger row.

	`price` here is not a suggestion the till may undercut. It becomes the floor,
	on the guest QR path and the staff path alike, the moment a line names this id.
*/
app.post("/menu-variations", validateAction(PERM_EDIT_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const merged = mergeMenuVariationPatch(null, body);
	if (!merged.ok) { res.status(400).json({ error: merged.error }); return; }
	const write = merged.value;

	try {
		const existing = (await ListMenuVariations(restaurantId, { menu_id: write.menu_id, includeInactive: true }))
			.find((v: MenuVariationRecord) => v.name.trim().toLowerCase() === write.name.trim().toLowerCase());
		if (existing) {
			res.status(409).json({
				error: existing.active
					? `This dish already has a "${existing.name}".`
					: `This dish already has a retired "${existing.name}" — reinstate it instead of creating a second one.`,
				variation: existing,
			});
			return;
		}
		const variation = await UpsertMenuVariation(restaurantId, write);
		try {
			await log_audit(req, PERM_EDIT_MENU, `Added variation ${variation.name} (₹${variation.price.toFixed(2)}) to menu item ${variation.menu_id}`, Audit_log_category.Menu, {
				variation_id: variation.id, menu_id: variation.menu_id, name: variation.name,
				price: variation.price, is_default: variation.is_default, active: variation.active,
				sort_order: variation.sort_order,
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-variation-create failed"); }
		res.status(201).json({ variation });
	} catch (err) {
		if (isForeignKeyViolation(err)) {
			// 039 gives "MenuVariations" a real composite FK to (id, res_id,
			// outlet_id) on "Menu", so a variation can point neither at a missing
			// dish nor across a tenant. This is that guard reporting for duty.
			res.status(400).json({ error: "That dish is not on this outlet's menu." });
			return;
		}
		if (isUniqueViolation(err)) {
			res.status(409).json({ error: `This dish already has a "${write.name}".` });
			return;
		}
		logger.error({ err }, "create_menu_variation_failed");
		res.status(500).json({ error: "Unable to create the variation" });
	}
});

/*
	Edit a price point — reprice it, rename it, reposition it, retire it.

	PATCH /menu-variations/:id  body { name?, price?, is_default?, active?, sort_order? }
	  -> 200 { variation }

	THE MERGE IS WHAT MAKES `{"active": false}` SAFE. A client retiring a Half
	plate sends two keys; without a snapshot to merge over, every field it did not
	send would take a default — and a defaulted price is ₹0, which is a ₹0 FLOOR,
	which means every line naming that variation could be rung in at nothing. So a
	key that is absent keeps what is stored, always, and a price that IS sent must
	be a positive number.

	`menu_id` cannot be changed. Sending a different one is refused with a
	sentence, not ignored: the id on this row is stamped onto order lines, so
	re-pointing it would silently relabel every past sale that named it — last
	month's "Half" would start reporting under another dish. Retire this one and
	add a variation to the other dish instead.

	NOT REFUSED: two variations both claiming `is_default`. 039 declined to
	constrain that ("a dish may legitimately force the guest to choose") and
	publicVariationsByItem lets only the first survive when it serves the guest —
	a presentation rule applied once at the edge, which never rewrites the row an
	owner typed.
*/
app.patch("/menu-variations/:id", validateAction(PERM_EDIT_MENU), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const variationId = String(req.params.id ?? "").trim();
	if (!variationId) { res.status(400).json({ error: "variation id is required" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;

	try {
		const stored = await GetMenuVariationById(restaurantId, variationId);
		if (!stored) { res.status(404).json({ error: "Variation not found" }); return; }
		const merged = mergeMenuVariationPatch(stored, body);
		if (!merged.ok) { res.status(400).json({ error: merged.error }); return; }
		const variation = await UpdateMenuVariationById(restaurantId, variationId, merged.value);
		if (!variation) { res.status(404).json({ error: "Variation not found" }); return; }
		try {
			await log_audit(req, PERM_EDIT_MENU, `Updated variation ${variation.name} (₹${variation.price.toFixed(2)}) on menu item ${variation.menu_id}`, Audit_log_category.Menu, {
				variation_id: variation.id, menu_id: variation.menu_id, name: variation.name,
				price: variation.price, is_default: variation.is_default, active: variation.active,
				sort_order: variation.sort_order,
				// The prior PRICE is the one an auditor asks about — this row is a
				// billing floor, so a change to it changes what a guest can be
				// charged from the next line onwards.
				prior: { name: stored.name, price: stored.price, is_default: stored.is_default, active: stored.active, sort_order: stored.sort_order },
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-variation-update failed"); }
		res.json({ variation });
	} catch (err) {
		if (isUniqueViolation(err)) {
			res.status(409).json({ error: "This dish already has another variation with that name." });
			return;
		}
		logger.error({ err }, "update_menu_variation_failed");
		res.status(500).json({ error: "Unable to update the variation" });
	}
});
}
