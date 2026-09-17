/**
 * Floor plan: tables, table sections/zones, seating suggestions, occupancy and
 * covers.
 */
import type { Express, Request, Response } from "express";
import { AddTable, Audit_log_category, DeleteTableSection, GetBillForTable, GetOrderKotContext, GetOrderKotNumbers, GetSeatingSuggestion, GetTableReleaseImpact, GetTableSections, GetTableStatus, GetTables, MoveOrderToTable, MoveTableParty, OccupyTable, ReleaseTable, RemoveTable, RenameTableSection, ReorderTableSections, TableSectionExists, UpdateTable, UpdateTableCovers, normalizeTableSection, runTenantQuery, runTenantTransaction, type TableSectionSummary } from "../database_supabase.js";
import { idempotent } from "../idempotency.js";
import { printKotTableChange } from "../kot_move.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { hidesPrices, redactBillForTable, redactMoveAnswer, redactTableList } from "../price_scope.js";
import { mayReleaseTable } from "../release_authority.js";
import { SectionOrderRequestError, compareTableSections, readSectionOrderRequest } from "../table_sections_order.js";
// Client items 1 and 2: one fingerprint of the paper, the one the print gate uses.
import { billPaperStale } from "./bills.js";
import { AUDIT_TABLE_UPDATED, PERM_CLOSE_BILL, PERM_TABLE_SECTIONS, extractEmployeeId, extractEmployeeUsername, extractRestaurantId, log_audit, moveReprintFields, nextPartyAfterPrint, nextPartyPrintMessage, noteAdditionToPrintedBill, refuseOrderOnPrintedBill, validateAction, type PrintedBillGuard } from "./_shared.js";
import { voidItemsText } from "../mis_report_math.js";
import { moveOrderAuditSentence } from "../order_moves.js";
import { RESERVED_TABLE_NAME_ERROR, isReservedPartyName } from "../next_party.js";


/*
	Sections have no table of their own — a zone IS the set of tables carrying
	that label — so "create a section" and "move a table into a section" are the
	SAME write. This resolves which one the caller is actually doing: naming a
	label no live table carries yet CREATES a zone (needs "Manage Table
	Sections"), naming one that already exists only MOVES a table into it (stays
	on "Table Added", so the floor can re-seat mid-service). Unassigning
	(null/"") is never a create.
	Returns true when it has already answered with 403 — the caller must return.
*/
async function requireSectionAdminForNewSection(
	req: Request,
	res: Response,
	restaurantId: string,
	section: string | null | undefined,
): Promise<boolean> {
	const label = typeof section === "string" ? section.trim() : "";
	if (!label) {return false;}
	const actions = req.auth?.actions ?? [];
	if (actions.includes("*") || actions.includes(PERM_TABLE_SECTIONS)) {return false;}
	if (await TableSectionExists(restaurantId, label)) {return false;}
	res.status(403).json({
		error: "Action not permitted",
		details: `Creating the new section "${label}" requires the Manage Table Sections permission. Moving a table into an existing section does not.`,
	});
	return true;
}

// --- Floor-zone roster ("Table_sections", migration 023) ---------------------
// "Tables".section stays the source of truth for WHICH zone a table sits in — a
// drag is still a single-row UPDATE. These rows only record that a zone NAME
// exists, so a zone with no tables in it survives a reload and reaches every
// device instead of living in one browser's localStorage.
//
// Every statement is keyed on lower(btrim(name)) because that is how the rest of
// the section code resolves a zone (GetTableSections / RenameTableSection); a
// case-sensitive key here would let "Patio" and "patio" both exist while a
// rename swept both.
//
// These run on the request's tenant connection, so RLS scopes them to app.res_id
// on top of the explicit res_id/outlet_id predicates.

interface ZoneScope { res_id: string; outlet_id: string }

// req.auth carries the SAME res_id/outlet_id that openTenantConnection bound the
// connection to, which is the pair resolveRestaurantContext resolves for every
// data-layer call on this request. Null only if the route is unauthenticated,
// which none of the section routes are.
function zoneScope(req: Request): ZoneScope | null {
	const res_id = req.auth?.res_id;
	const outlet_id = req.auth?.outlet_id;
	return res_id && outlet_id ? { res_id, outlet_id } : null;
}

async function listStoredZones(scope: ZoneScope): Promise<string[]> {
	const rows = await runTenantQuery<{ name: string }>(
		`select btrim(name) as name from "Table_sections"
		  where res_id = $1 and outlet_id = $2 and btrim(name) <> ''
		  order by lower(btrim(name))`,
		[scope.res_id, scope.outlet_id],
	);
	return rows.map((r) => r.name);
}

/** Inserts the zone; returns false when one already exists under that name. */
async function insertStoredZone(scope: ZoneScope, name: string): Promise<boolean> {
	const rows = await runTenantQuery<{ id: string }>(
		`insert into "Table_sections" (res_id, outlet_id, name) values ($1, $2, $3)
		 on conflict do nothing returning id`,
		[scope.res_id, scope.outlet_id, name],
	);
	return rows.length > 0;
}

/**
 * Point the roster row at the new name. Returns how many rows moved; 0 means the
 * zone only ever existed as a table label (created before migration 023 backfilled,
 * or by a table drag), so the caller upserts instead — a rename must never leave
 * the roster naming a zone that no longer exists.
 */
async function renameStoredZone(scope: ZoneScope, from: string, to: string): Promise<number> {
	const rows = await runTenantQuery<{ id: string }>(
		`update "Table_sections" set name = $4
		  where res_id = $1 and outlet_id = $2 and lower(btrim(name)) = lower(btrim($3))
		  returning id`,
		[scope.res_id, scope.outlet_id, from, to],
	);
	return rows.length;
}

async function deleteStoredZone(scope: ZoneScope, name: string): Promise<number> {
	const rows = await runTenantQuery<{ id: string }>(
		`delete from "Table_sections"
		  where res_id = $1 and outlet_id = $2 and lower(btrim(name)) = lower(btrim($3))
		  returning id`,
		[scope.res_id, scope.outlet_id, name],
	);
	return rows.length;
}

/**
 * The floor's zone list as every caller must see it: the zones the TABLES carry
 * (with their counts) unioned with the ROSTER (where an empty zone is the only
 * kind that can live), de-duplicated case-insensitively, and put in the outlet's
 * chosen order.
 *
 * Shared by GET /table-sections and PUT /table-sections/order so the reorder
 * answers with the exact list the next GET would produce — a client that adopts
 * the response cannot end up showing an order the server does not hold.
 *
 * The SORT is the last thing that happens and it happens unconditionally.
 * Sorting inside the `if (scope)` (as this did when the union was inline) was
 * harmless only because every section route is authenticated and therefore
 * always has a scope; leaving the one line that decides the order dependent on
 * that is a trap for whoever adds the next caller.
 */
async function buildSectionRoster(
	req: Request,
	restaurantId: string,
): Promise<{ sections: TableSectionSummary[]; unassigned: number }> {
	const roster = await GetTableSections(restaurantId);
	const scope = zoneScope(req);
	if (scope) {
		// Union the two sources: zones derived from "Tables".section already carry
		// their counts, and any roster row they don't cover is an EMPTY zone (0/0).
		// Keyed case-insensitively, the same way rename/delete resolve a zone, so a
		// stored "patio" never renders a second time next to a table's "Patio".
		const seen = new Set(roster.sections.map((s) => s.section.trim().toLowerCase()));
		for (const name of await listStoredZones(scope)) {
			const key = name.trim().toLowerCase();
			if (seen.has(key)) { continue; }
			seen.add(key);
			// An empty zone has no table to be summarised from, so its position AND
			// its birth instant both have to come off the raw maps rather than a
			// summary row. Without the second one, every empty zone would sort into
			// the undated tail and an owner's brand-new empty section would outrank
			// the room they have been serving in for years.
			roster.sections.push({
				section: name,
				tables: 0,
				seats: 0,
				sort_order: roster.order[key] ?? null,
				created_at: roster.born[key] ?? null,
			});
		}
	}
	// Sorted on the SAME comparator the database reader used, with the ISO
	// instants converted back to the epoch millis it compares on. A summary whose
	// created_at is unparseable degrades to "undated" rather than to NaN, which
	// compareTableSections treats as the alphabetical tail.
	roster.sections.sort((a, b) => compareTableSections(sortable(a), sortable(b)));
	return { sections: roster.sections, unassigned: roster.unassigned };
}

/** A section summary as the shared comparator wants it: the wire carries the
 *  birth instant as ISO-8601 (readable in a log and in a response), the ordering
 *  compares epoch millis. */
function sortable(s: TableSectionSummary): { section: string; sort_order: number | null; created_at: number | null } {
	const at = s.created_at ? Date.parse(s.created_at) : Number.NaN;
	return { section: s.section, sort_order: s.sort_order, created_at: Number.isFinite(at) ? at : null };
}

/**
 * The table as it stands BEFORE a PATCH, so the audit reason can name what
 * actually changed ("moved from Patio to Garden") instead of reprinting every
 * field on every edit. Best-effort: a null snapshot degrades the wording, never
 * the write.
 */
async function readTableBeforeUpdate(
	scope: ZoneScope,
	tableName: string,
): Promise<{ capacity: number; max_capacity: number | null; section: string | null } | null> {
	const rows = await runTenantQuery<{ capacity: string | number; max_capacity: number | null; section: string | null }>(
		`select capacity, max_capacity, nullif(btrim(coalesce(section, '')), '') as section
		   from "Tables"
		  where res_id = $1 and outlet_id = $2 and lower(btrim(table_name)) = lower(btrim($3))
		    and coalesce(is_deleted, false) = false
		  limit 1`,
		[scope.res_id, scope.outlet_id, tableName],
	);
	const row = rows[0];
	if (!row) {return null;}
	return { capacity: Number(row.capacity), max_capacity: row.max_capacity, section: row.section };
}

/*
	Floor sections (zones). A zone lives in TWO places and the routes below keep
	them in step: "Tables".section says which zone each table is in (a drag is one
	single-row UPDATE), and "Table_sections" records that the NAME exists so a zone
	with no tables in it still exists. Before migration 023 there was no second
	source, so "Add Section" in the web UI could not reach the server at all — it
	wrote the new zone to localStorage, which meant no audit entry and a zone that
	never left that one browser.

	Migration 041 added a third thing a zone can carry: "Table_sections".sort_order,
	the outlet's chosen position for it. Null everywhere until somebody rearranges,
	and null sorts into the alphabetical tail, so the list reads exactly as it
	always did until it is deliberately changed.

	GET    /table-sections            -> { sections: [{ section, tables, seats, sort_order }], unassigned }
	                                     in the outlet's chosen order
	PUT    /table-sections/order      body { "sections": ["Entrance", "Bar"] } -> the GET body
	POST   /table-sections            body { "name": "Garden" } -> { section, tables, seats }
	PATCH  /table-sections/:name      body { "name": "New name" } -> { section, updated }
	                                     409 if the new name is already a zone (both
	                                     sources checked); never merges two zones
	DELETE /table-sections/:name      -> { section, updated }  (tables become unassigned;
	                                     no table is ever deleted by this route)
	To MOVE one table, use PATCH /table/:name { section } — one row, O(1) per drop.

	PERMISSION SPLIT (see requireSectionAdminForNewSection below):
	  • Creating a zone, renaming one, removing one — and listing the zone
	    roster — is floor-plan ADMINISTRATION and needs "Manage Table Sections"
	    (2f7c5a94…). It reshapes how the whole floor is organised.
	  • MOVING a table into a zone that already exists (and un-assigning it)
	    stays on "Table Added" (194ce6ee…), the permission the floor already
	    holds for editing tables. Re-seating during service must never wait on
	    an admin-level grant, and a move cannot invent or destroy a zone.
	Admin ("*") passes both.
*/
const TABLE_SECTION_PERM = PERM_TABLE_SECTIONS;

function FoldedTables(table: any[]): any[][] {
	if (table.length == 0) {
		return [];
	}

	const min: number = table[0].capacity;
	const max: number = table[table.length - 1].capacity;

	const folded_tables = [];

	let curr_index = 0;
	for (let capacity = min; capacity <= max; capacity++) {
		const cur_table = [];
		let push = false;
		while (
			table.length > curr_index &&
			table[curr_index].capacity == capacity
		) {
			cur_table.push(table[curr_index]);
			curr_index += 1;
			push = true;
		}
		if (push) {
			folded_tables.push(cur_table);
		}
	}

	return folded_tables;
}

export function registerTableRoutes(app: Express): void {

/*
	Needs request body as
	{
	   "table": {
		   "name": "T1",
		   "capacity": 4, // Optional — normal (comfortable) seats
		   "max_capacity": 6, // Optional — most it can take with extra chairs.
		                      // Defaults to capacity; clamped up if sent lower.
		   "section": "Garden" // Optional floor section/zone. Absent/blank = unassigned.
	   }
	}
	returns the table_name if you want to store it somewhere
*/
app.post("/add-table", validateAction("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const table = req.body.table;
	// A whitespace-only name is truthy, so it used to slip past this check and
	// create a permanent, nameless, un-deletable table row (lookups match on the
	// trimmed name, so nothing could ever address it again).
	if (typeof table?.name !== "string" || table.name.trim().length === 0) {
		res.status(400).json({ error: "Table name is required" });
		return;
	}
	// CLIENT ITEM 6. "12 #2" is the name the server gives the next party at a
	// printed table 12, so a hand-made table may not take that shape — two rows
	// answering to one name would put an order on the wrong bill. Said in words,
	// not folded into the "Table exists" the catch below answers with.
	if (isReservedPartyName(table.name)) {
		res.status(400).json({ error: RESERVED_TABLE_NAME_ERROR, code: "reserved_table_name" });
		return;
	}

	// max_capacity must be a whole number >= 1; AddTable clamps it up to capacity.
	if (table.max_capacity !== undefined && table.max_capacity !== null) {
		const requestedMax = Number(table.max_capacity);
		if (!Number.isFinite(requestedMax) || Math.round(requestedMax) < 1) {
			res.status(400).json({ error: "max_capacity must be a whole number >= 1" });
			return;
		}
	}

	// Adding a table straight into a zone that does not exist yet creates that
	// zone, so it needs the section-admin grant just like PATCH does.
	if (await requireSectionAdminForNewSection(req, res, restaurantId, typeof table.section === "string" ? table.section : null)) {return;}

	let table_name: string | null = null;
	let max_capacity: number | null = null;
	let section: string | null = null;
	try {
		const created = await AddTable(
			restaurantId,
			table.name,
			table.capacity !== undefined ? parseInt(table.capacity) : undefined,
			table.max_capacity !== undefined && table.max_capacity !== null
				? Math.round(Number(table.max_capacity))
				: undefined,
			typeof table.section === "string" ? table.section : undefined,
		);
		table_name = created.table_name;
		max_capacity = created.max_capacity;
		section = created.section;
	} catch (error) {
		logger.info(error);
		table_name = null;
	}
	if (!table_name) {
		res.status(400).json({ error: "Table exists" });
		return;
	}

	try {
		emitRestaurant(restaurantId, "table:added", { table_name, capacity: table.capacity, max_capacity, section });
	} catch (err) {
		logger.warn({ err }, "emit table:added failed");
	}

	try {
		await log_audit(req, "194ce6ee-b867-4be3-b5f0-48c28ce0a81b", `Added table ${table_name}`, Audit_log_category.Tables, {
			capacity: table.capacity,
			max_capacity,
			section,
			// before.existed=false records that the table did not exist; the undo
			// deletes it again, but only while it is still pristine.
			undo: { kind: "table_added", target_id: null, before: { existed: false }, after: { table_name } },
		});
	} catch (err) {
		logger.warn({ err }, 'log_audit add-table failed');
	}

	res.send(table_name);
});

/*
	Edit an existing table's seating numbers and/or floor section (same permission
	as adding one).
	PATCH /table/:name  body { "capacity": 4, "max_capacity": 6, "section": "Garden" }
	— all optional, omitted fields are left alone. max_capacity is clamped up to
	capacity. `section: null` or "" moves the table to "unassigned".
	THIS is the drag-and-drop endpoint: dropping a table into another section is
	one PATCH touching one row — never a bulk floor rewrite.
	Returns { table_name, capacity, max_capacity, section }.
*/
app.patch("/table/:name", validateAction("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawName = req.params.name;
	const tableName = typeof rawName === "string" ? rawName.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "Invalid table name" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const readSeats = (value: unknown): number | null | undefined => {
		if (value === undefined || value === null) {return undefined;}
		const num = Number(value);
		if (!Number.isFinite(num) || Math.round(num) < 1) {return null;}
		return Math.round(num);
	};
	const capacity = readSeats(body?.capacity);
	const maxCapacity = readSeats(body?.max_capacity);
	if (capacity === null || maxCapacity === null) {
		res.status(400).json({ error: "capacity and max_capacity must be whole numbers >= 1" });
		return;
	}
	// `section` absent -> untouched; null or a string (incl. "") -> written.
	// Anything else (number, object) is a client bug, not an "unassign".
	const hasSection = body !== undefined && Object.prototype.hasOwnProperty.call(body, "section");
	if (hasSection && body?.section !== null && typeof body?.section !== "string") {
		res.status(400).json({ error: "section must be a string or null" });
		return;
	}
	const section = hasSection ? ((body?.section as string | null) ?? null) : undefined;
	if (capacity === undefined && maxCapacity === undefined && section === undefined) {
		res.status(400).json({ error: "Nothing to update" });
		return;
	}
	// Dropping a table onto an EXISTING zone is a move (Table Added is enough);
	// typing a brand-new zone name here creates one (Manage Table Sections).
	if (await requireSectionAdminForNewSection(req, res, restaurantId, section)) {return;}

	const scope = zoneScope(req);
	// Read the row first so the audit line can name the move, not just the result.
	const before = scope ? await readTableBeforeUpdate(scope, tableName).catch((err) => {
		logger.warn({ err }, "table_before_snapshot_failed");
		return null;
	}) : null;

	try {
		const updated = await UpdateTable(restaurantId, tableName, { capacity, max_capacity: maxCapacity, section });
		if (!updated) {
			res.status(404).json({ error: "Table not found" });
			return;
		}

		// Typing a zone name that does not exist yet CREATES it (that is what the
		// section-admin check above gates), so record it in the roster too — otherwise
		// the zone would evaporate the moment its last table moved out.
		if (scope && typeof updated.section === "string" && updated.section.trim()) {
			await insertStoredZone(scope, updated.section.trim()).catch((err) => {
				logger.warn({ err }, "table_section_roster_adopt_failed");
				return false;
			});
		}

		try {
			emitRestaurant(restaurantId, "table:updated", updated);
		} catch (err) {
			logger.warn({ err }, "emit table:updated failed");
		}
		try {
			// A drag between zones and a capacity edit are the same PATCH, and the old
			// line printed all three fields either way — so an audit reader could not
			// tell which one the operator actually touched. Report only what moved.
			const zoneLabel = (value: string | null | undefined): string => {
				const trimmed = typeof value === "string" ? value.trim() : "";
				return trimmed ? trimmed : "unassigned";
			};
			const changes: string[] = [];
			if (before) {
				if (updated.capacity !== before.capacity) {
					changes.push(`capacity ${before.capacity} -> ${updated.capacity}`);
				}
				// max_capacity reads as "same as capacity" when unset, so compare the
				// effective ceilings or clearing it looks like a change that never was.
				const beforeMax = before.max_capacity ?? before.capacity;
				if (updated.max_capacity !== beforeMax) {
					changes.push(`max capacity ${beforeMax} -> ${updated.max_capacity}`);
				}
				if (zoneLabel(updated.section) !== zoneLabel(before.section)) {
					changes.push(`moved from ${zoneLabel(before.section)} to ${zoneLabel(updated.section)}`);
				}
			} else {
				// No snapshot (read failed, or the table was created mid-request): fall
				// back to the fields the client actually sent rather than inventing a diff.
				if (capacity !== undefined) {changes.push(`capacity ${updated.capacity}`);}
				if (maxCapacity !== undefined) {changes.push(`max capacity ${updated.max_capacity}`);}
				if (section !== undefined) {changes.push(`section ${zoneLabel(updated.section)}`);}
			}
			const reason = changes.length > 0
				? `Updated table ${updated.table_name}: ${changes.join(", ")}`
				// A PATCH that set every field to what it already was is still an
				// operator action worth a line; say so instead of printing nothing.
				: `Updated table ${updated.table_name} (no values changed)`;
			await log_audit(req, AUDIT_TABLE_UPDATED, reason, Audit_log_category.Tables, { ...updated, before });
		} catch (err) {
			logger.warn({ err }, 'log_audit update-table failed');
		}

		res.json(updated);
	} catch (error: any) {
		logger.error({ err: error }, "update_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update table") });
	}
});

app.get("/table-sections", validateAction(TABLE_SECTION_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		res.json(await buildSectionRoster(req, restaurantId));
	} catch (error: any) {
		logger.error({ err: error }, "table_sections_list_failed");
		res.status(500).json({ error: "Unable to fetch table sections" });
	}
});

/*
	Arrange the outlet's sections (migration 041).

	PUT /table-sections/order  body { "sections": ["Entrance", "Main Hall", ...] }
	  -> the same body GET /table-sections returns, in the new order.

	WHY A WHOLE-LIST PUT and not "move Patio to index 2": a positional edit needs
	the client and the server to agree on what the list currently is, and two
	tablets dragging at the same time do not. Sending the finished list makes the
	write idempotent, makes "last commit wins" a complete and explainable outcome
	rather than a half-applied one, and means a client that is a few seconds stale
	loses only its own drag. See ReorderTableSections for the locking that backs
	that up, and table_sections_order.ts for why a stale list can never DROP a
	section.

	PERMISSION: rearranging the floor plan is section ADMINISTRATION — the same
	gate as creating, renaming and dissolving a zone — not the "Table Added"
	permission the floor holds for re-seating. Moving a table is service work;
	deciding what order the whole restaurant reads its floor in is not.
*/
app.put("/table-sections/order", validateAction(TABLE_SECTION_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	let requested: string[];
	try {
		requested = readSectionOrderRequest(req.body);
	} catch (error) {
		// Only a malformed BODY is answered here. Anything else is a real fault and
		// must not be reported to the client as "your request was wrong".
		if (error instanceof SectionOrderRequestError) { res.status(400).json({ error: error.message }); return; }
		throw error;
	}
	try {
		const { ordered, positioned } = await ReorderTableSections(restaurantId, requested);
		try { emitRestaurant(restaurantId, "table:sections_updated", { action: "reorder", sections: ordered }); } catch { /* ignore realtime errors */ }
		try {
			await log_audit(
				req,
				TABLE_SECTION_PERM,
				`Rearranged table sections (${String(positioned)}): ${ordered.join(" -> ")}`,
				Audit_log_category.Tables,
				{ sections: ordered },
			);
		} catch (err) { logger.warn({ err }, "log_audit reorder-sections failed"); }
		// Answer with the list as it now reads, not with what was sent: the two
		// differ whenever the request was stale, and the client must adopt the
		// server's version rather than keep believing its own.
		res.json(await buildSectionRoster(req, restaurantId));
	} catch (error: any) {
		logger.error({ err: error }, "table_sections_reorder_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to rearrange sections") });
	}
});

/*
	Create an empty zone. This is what the web "Add Section" button was missing:
	without it a new zone was a localStorage entry, so it was never audited and
	never reached a second device.
*/
app.post("/table-sections", validateAction(TABLE_SECTION_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const scope = zoneScope(req);
	if (!scope) { res.status(400).json({ error: "Missing outlet" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const raw = typeof body.name === "string" ? body.name : typeof body.section === "string" ? body.section : "";
	const name = raw.trim();
	// A whitespace-only name is truthy and would create a zone nothing can ever
	// address again — the same trap POST /add-table had to close for table names.
	if (!name) { res.status(400).json({ error: "Section name is required" }); return; }

	try {
		// A zone can already exist as a table label without a roster row (created by a
		// drag, or on a database that predates migration 023), so duplicates have to be
		// checked against BOTH sources or the second create would look like it worked.
		if (await TableSectionExists(restaurantId, name)) {
			res.status(409).json({ error: `A section named "${name}" already exists` });
			return;
		}
		if (!(await insertStoredZone(scope, name))) {
			res.status(409).json({ error: `A section named "${name}" already exists` });
			return;
		}
		const created = { section: name, tables: 0, seats: 0 };
		try { emitRestaurant(restaurantId, "table:sections_updated", { action: "create", section: name, tables: 0 }); } catch { /* ignore realtime errors */ }
		try { await log_audit(req, TABLE_SECTION_PERM, `Created table section ${name}`, Audit_log_category.Tables, created); } catch (err) { logger.warn({ err }, "log_audit create-section failed"); }
		res.status(201).json(created);
	} catch (error: any) {
		logger.error({ err: error }, "table_section_create_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to create section") });
	}
});

app.patch("/table-sections/:name", validateAction(TABLE_SECTION_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const scope = zoneScope(req);
	if (!scope) { res.status(400).json({ error: "Missing outlet" }); return; }
	const from = typeof req.params.name === "string" ? req.params.name.trim() : "";
	const body = (req.body ?? {}) as Record<string, unknown>;
	const to = typeof body.name === "string" ? body.name : typeof body.section === "string" ? body.section : "";
	if (!from || !String(to).trim()) { res.status(400).json({ error: "Both the current and new section name are required" }); return; }
	// Key both names the way the data layer stores them, so "Patio " and "Patio"
	// (and "AC  Hall" / "AC Hall") are recognised as the same zone here too.
	const toName = normalizeTableSection(to);
	if (!toName) { res.status(400).json({ error: "Both the current and new section name are required" }); return; }
	const sameZone = (normalizeTableSection(from) ?? "").toLowerCase() === toName.toLowerCase();
	try {
		/*
			A rename writes TWO sources — "Tables".section and the "Table_sections"
			roster — and they have to move together. They used to be two autocommitted
			statements: when the roster UPDATE hit migration 023's unique index the
			route answered 400, but the floor had ALREADY been relabelled, so the
			caller was told a rename failed that the staff could see had happened.
			Now the collision is decided BEFORE anything is written, and both writes
			share one transaction, so a failure leaves both sources untouched.

			Colliding with an existing zone is a 409 refusal, not a silent merge:
			"rename Patio to Garden" when Garden already exists would otherwise pour
			Patio's tables into Garden and destroy the Patio zone, which is a floor
			reorganisation nobody asked for and nothing can undo.
		*/
		const outcome = await runTenantTransaction(async () => {
			// A pure re-spelling ("patio" -> "Patio") collides with itself; that is a
			// rename, not a conflict.
			if (!sameZone && await TableSectionExists(restaurantId, toName)) {
				return { status: "conflict" as const };
			}
			const r = await RenameTableSection(restaurantId, from, toName);
			const rosterRows = await renameStoredZone(scope, from, r.section);
			// A zone with no tables in it is now a legitimate thing to rename, so 404 only
			// when NEITHER source knew the old name.
			if (r.updated === 0 && rosterRows === 0) { return { status: "not_found" as const }; }
			// Tables carried the name but the roster didn't (pre-023 zone, or one created
			// by a drag): adopt it, or the rename leaves the roster naming a dead zone.
			if (rosterRows === 0) { await insertStoredZone(scope, r.section); }
			return { status: "ok" as const, result: r };
		});
		if (outcome.status === "conflict") { res.status(409).json({ error: `A section named "${toName}" already exists` }); return; }
		if (outcome.status === "not_found") { res.status(404).json({ error: "Section not found" }); return; }
		const r = outcome.result;
		try { emitRestaurant(restaurantId, "table:sections_updated", { action: "rename", from, to: r.section, tables: r.updated }); } catch { /* ignore realtime errors */ }
		try { await log_audit(req, TABLE_SECTION_PERM, `Renamed table section ${from} to ${r.section} (${r.updated} tables)`, Audit_log_category.Tables, r); } catch (err) { logger.warn({ err }, "log_audit rename-section failed"); }
		res.json(r);
	} catch (error: any) {
		logger.error({ err: error }, "table_section_rename_failed");
		// A concurrent rename can still lose the race to the unique index after the
		// pre-check passed. The transaction rolled it back, so nothing half-applied —
		// report it as the collision it is rather than a generic 400.
		if (error?.code === "23505") { res.status(409).json({ error: `A section named "${toName}" already exists` }); return; }
		res.status(400).json({ error: String(error?.message ?? "Unable to rename section") });
	}
});

app.delete("/table-sections/:name", validateAction(TABLE_SECTION_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const scope = zoneScope(req);
	if (!scope) { res.status(400).json({ error: "Missing outlet" }); return; }
	const name = typeof req.params.name === "string" ? req.params.name.trim() : "";
	if (!name) { res.status(400).json({ error: "Section name is required" }); return; }
	try {
		const r = await DeleteTableSection(restaurantId, name);
		const rosterRows = await deleteStoredZone(scope, name);
		if (r.updated === 0 && rosterRows === 0) { res.status(404).json({ error: "Section not found" }); return; }
		try { emitRestaurant(restaurantId, "table:sections_updated", { action: "delete", section: r.section, tables: r.updated }); } catch { /* ignore realtime errors */ }
		try { await log_audit(req, TABLE_SECTION_PERM, `Removed table section ${r.section} (${r.updated} tables unassigned)`, Audit_log_category.Tables, r); } catch (err) { logger.warn({ err }, "log_audit delete-section failed"); }
		res.json(r);
	} catch (error: any) {
		logger.error({ err: error }, "table_section_delete_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to remove section") });
	}
});

/*
	Seating suggestion for a party at a time window — SUGGESTS ONLY, never assigns.
	GET /tables/seating-suggestion?party=8&at=<ISO>&duration=<mins>
	Same permission as assigning tables to bookings (c7699d46…).
	See GetSeatingSuggestion for the shape.
*/
app.get("/tables/seating-suggestion", validateAction("c7699d46-0e2f-4448-b325-8ca490a5296b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const party = Number(Array.isArray(req.query.party) ? req.query.party[0] : req.query.party);
	if (!Number.isFinite(party) || Math.round(party) < 1) {
		res.status(400).json({ error: "party must be a whole number >= 1" });
		return;
	}

	const atRaw = Array.isArray(req.query.at) ? req.query.at[0] : req.query.at;
	const at = typeof atRaw === "string" && atRaw.trim() ? new Date(atRaw) : new Date();
	if (Number.isNaN(at.getTime())) {
		res.status(400).json({ error: "at must be an ISO date-time" });
		return;
	}

	const durationRaw = Array.isArray(req.query.duration) ? req.query.duration[0] : req.query.duration;
	const duration = durationRaw === undefined || durationRaw === "" ? 120 : Number(durationRaw);
	if (!Number.isFinite(duration) || Math.round(duration) < 1) {
		res.status(400).json({ error: "duration must be a whole number of minutes >= 1" });
		return;
	}

	try {
		const suggestion = await GetSeatingSuggestion(restaurantId, Math.round(party), at, Math.round(duration));
		res.json(suggestion);
	} catch (error: any) {
		logger.error({ err: error }, "seating_suggestion_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to build a seating suggestion") });
	}
});

app.delete("/table/:name", validateAction("5777c4aa-29df-4ea1-9c45-c1038d25f746"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawName = req.params.name;
	const tableName = typeof rawName === "string" ? rawName.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "Invalid table name" });
		return;
	}

	const result = await RemoveTable(restaurantId, tableName);
	if (result.status === "not_found") {
		res.status(404).json({ error: "Table not found" });
		return;
	}
	if (result.status === "blocked") {
		res.status(400).json({ error: result.message });
		return;
	}

	try {
		emitRestaurant(restaurantId, "table:deleted", { table_name: tableName });
	} catch (err) {
		logger.warn({ err }, "emit table:deleted failed");
	}

	try {
		await log_audit(req, "5777c4aa-29df-4ea1-9c45-c1038d25f746", `Removed table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
	} catch (err) {
		logger.warn({ err }, 'log_audit delete-table failed');
	}

	res.status(204).send();
});

// Occupy a table (mark as occupied and set number of covers)
app.post("/occupy-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
	const numCovers = typeof body?.num_covers === 'number' && body.num_covers >= 1 ? Math.round(body.num_covers) : null;
	const orderId = typeof body?.order_id === 'string' ? body.order_id.trim() : undefined;

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const result = await OccupyTable(restaurantId, tableName, numCovers, orderId ?? null, extractEmployeeId(req));
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Occupied table ${tableName}${numCovers != null ? ` with ${numCovers} covers` : ""}`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
		} catch (err) {
			logger.warn({ err }, 'log_audit occupy-table failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "occupy_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to occupy table") });
	}
});

// Update number of covers at a table
app.patch("/table-covers", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
	// Covers is the APC denominator, so a missing/garbage value is REJECTED — it
	// used to silently fall back to 1, wiping the real head count (and writing an
	// audit line claiming the caller asked for 1). Numeric strings are accepted.
	const rawCovers = typeof body?.num_covers === 'number' || typeof body?.num_covers === 'string'
		? Number(body.num_covers)
		: Number.NaN;
	const numCovers = Math.round(rawCovers);

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	if (!Number.isFinite(rawCovers) || numCovers < 1) {
		res.status(400).json({ error: "num_covers must be a whole number of 1 or more" });
		return;
	}

	try {
		const result = await UpdateTableCovers(restaurantId, tableName, numCovers);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Updated table ${tableName} covers to ${numCovers}`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
		} catch (err) {
			logger.warn({ err }, 'log_audit table-covers failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "table_covers_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update table covers") });
	}
});

/*
	MOVE A SEATED PARTY — items 10/21.

	POST /tables/move  { "from_table": "T1", "to_table": "T2" }

	One call, one transaction, everything or nothing: the seating, the orders, the
	running bill row, the waiter and the guest's ordering code all arrive at T2
	together. See MoveTableParty for why a half-moved guest is the outcome this is
	built to make unreachable, and for what it deliberately does NOT disturb
	(covers, the seating's start time, and therefore APC and turnaround).

	PERMISSION: the occupancy gate — the same one seating, changing covers and
	releasing a table already carry. Moving a party between tables is floor
	service, not administration; the person who sat them down is the person who
	moves them.

	IF THE DESTINATION IS OCCUPIED this answers 400 and the message names Merge.
	The two acts are not interchangeable and the difference is money: a move keeps
	one party on one bill, a merge puts two parties on one bill.

	A PRINTED PARTY MOVES WITH ITS PAPER (client items 1 and 2 — a waiter moves
	tables now, orange ones included). The print ledger follows them
	(MoveTableParty re-addresses its `<name>-<epoch>` jobs), so the destination is
	orange; and because the destination's number now holds a printed bill, the
	next guests there get a green seat at once — the same nextPartyAfterPrint a
	print calls — rather than on the floor read's backfill. `next_party_table`
	names it. A move into the table's own family ("12" to "12 #2") is refused:
	they are one table.

	NO idempotent() AND NO OFFLINE QUEUE, deliberately, on both counts:

	  * A REPLAY IS ALREADY SAFE. The precondition this write needs — the source
	    seated, the destination free — is exactly the one the first execution
	    consumes, so a duplicate request cannot half-apply anything; it bounces
	    off "T1 is not seated" having changed nothing. A dedup key would turn
	    that confusing-but-harmless error into a clean 200, which is a nicety,
	    not a safety property, and it is not worth widening the 27-route
	    idempotent() opt-in that the app's offline allowlist mirrors exactly
	    (services/outbox.dart) — every route added to that set becomes queueable,
	    and this one must not be.

	  * QUEUEING IT WOULD BE WRONG. A move held on a till for twenty minutes and
	    replayed against a floor that has moved on lands on a destination someone
	    else has since seated — and by then the waiter who pressed it is long
	    gone and believes the guests were moved. Same reason settle and KOT stay
	    online-only. Offline, this refuses and says so.
*/
app.post("/tables/move", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
	const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
	if (!fromTable || !toTable) { res.status(400).json({ error: "from_table and to_table are required" }); return; }

	try {
		const result = await MoveTableParty(restaurantId, fromTable, toTable);
		// The printed party's number needs its green seat (see the header). Never
		// throws and never fails the move: the party has already moved.
		const nextPartyTable = result.printed ? await nextPartyAfterPrint(req, restaurantId, result.to_table) : null;
		// CLIENT ITEM 4 — the tickets that travelled, by the numbers the pass
		// calls them and by their dishes, in the audit details. Read after the
		// commit; an unreadable number costs the detail, never the move.
		const movedKots = await GetOrderKotNumbers(restaurantId, result.moved_order_ids)
			.then((m) => [...new Set(result.moved_order_ids.flatMap((id) => m.get(id) ?? []))])
			.catch(() => [] as number[]);
		// BOTH tables changed, so both floor plans have to. One event naming both
		// ends rather than two, so a client cannot repaint half a move.
		try {
			emitRestaurant(restaurantId, "table:moved", {
				from_table: result.from_table,
				to_table: result.to_table,
				covers: result.covers,
				moved_orders: result.moved_orders,
			});
		} catch { /* ignore realtime errors */ }
		try {
			await log_audit(
				req,
				"090ea8d4-e348-4e1b-9723-11131a73a085",
				`Moved the party at ${result.from_table} to ${result.to_table} (${String(result.covers)} covers, ${String(result.moved_orders)} order${result.moved_orders === 1 ? "" : "s"}, ${result.moved_bill ? "bill carried" : "no bill yet"}${result.printed ? `, printed bill carried${result.printed_as ? ` — the paper says ${result.printed_as}` : ""}` : ""})`,
				Audit_log_category.Tables,
				{ ...result, next_party_table: nextPartyTable, kot_nos: movedKots, items: voidItemsText(result.moved_items) },
			);
		} catch (err) { logger.warn({ err }, "log_audit move-table failed"); }
		res.json({ ...result, next_party_table: nextPartyTable, next_party_message: nextPartyPrintMessage(nextPartyTable) });
	} catch (error: any) {
		logger.error({ err: error }, "move_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to move the table") });
	}
});

/*
	MOVE ONE KOT TO ANOTHER TABLE — item 22.

	POST /tables/move-order  { "order_id": "...", "to_table": "T7" }

	The mis-key correction: the order was rung in on the wrong table. The order,
	and only that order, moves; the party at the source table stays seated (see
	MoveOrderToTable).

	AND THEN THE KITCHEN IS TOLD. This is the half that cannot be skipped. The
	screens update themselves, but the pass may already be holding printed paper
	that says the old table, and a move that leaves it there makes the system and
	the paper disagree about where food is going — which is worse than the
	original mistake, because now nobody is looking for it. printKotTableChange
	prints a correction carrying the SAME KOT number so the pass can pair it with
	the docket it replaces, and prints NOTHING when the order was never ticketed
	(there is no paper to correct, and the ordinary trigger will print it at the
	right table later). Its outcome rides back in the response, so the till can
	say "KOT-26 reprinted for T7" or "nothing was printed — the kitchen never had
	this ticket" instead of leaving staff to guess.

	The print is deliberately AFTER the move has committed and can never fail it:
	the order really is on T7 by then, and a jammed printer must not undo that.

	PERMISSION: the order/print gate the KOT reprint route already uses — moving a
	ticket is the same class of act as reprinting one.

	CLIENT ITEM 4 — WHAT MOVED, BY NAME, AND BOTH BILLS. The answer and the
	audit line name the KOT and every dish on it ("Moved KOT-65 (KUNAFA BIRDS
	NEST x1; …) from 12 to 15"), where they used to name a UUID. And a move
	changes two bills, so both are held to the printed-bill rule BEFORE anything
	is written: a waiter-only login is refused (423) when either table's bill has
	been printed — the destination's paper would be short, the source's would
	charge for food that has left — and a senior role is allowed and told which
	papers to reprint (moveReprintFields).

	NOT idempotent() AND NOT QUEUEABLE, for the reasons POST /tables/move gives
	above, plus one of its own: this route PRINTS. A replay stops at "that order
	is already on this table" before it reaches the printer, so the pass gets one
	correction docket and not two — which a dedup key would also achieve, but
	only for the window it retains the key, whereas the precondition holds for
	ever.
*/
app.post("/tables/move-order", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const orderId = typeof body.order_id === "string" ? body.order_id.trim() : "";
	const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
	if (!orderId || !toTable) { res.status(400).json({ error: "order_id and to_table are required" }); return; }

	try {
		// Where the order is now, read before the move so the SOURCE's print
		// state can be judged. An unknown order skips the source check and meets
		// MoveOrderToTable's own "Order not found".
		const before = await GetOrderKotContext(restaurantId, orderId).catch(() => null);
		const sourceTable = before?.table_name ?? "";
		const destinationGuard = await refuseOrderOnPrintedBill(req, res, { restaurantId, tableName: toTable, guest: false, write: "move" });
		if (destinationGuard.refused) {return;}
		const noGuard: PrintedBillGuard = { refused: false, reprintNeeded: false, table: null, parentTable: null };
		const sourceGuard = sourceTable && sourceTable.toLowerCase() !== toTable.toLowerCase()
			? await refuseOrderOnPrintedBill(req, res, { restaurantId, tableName: sourceTable, guest: false, write: "move_off" })
			: noGuard;
		if (sourceGuard.refused) {return;}

		const moved = await MoveOrderToTable(restaurantId, orderId, toTable, { by: extractEmployeeUsername(req) });
		const print = await printKotTableChange({
			restaurantId,
			orderId: moved.order_id,
			previousTableId: moved.from_table_id,
			previousTableName: moved.from_table,
		});
		// The number the pass calls this ticket by: the correction's, else the
		// ones already printed for it.
		const kotNos = print.kot_no ? [print.kot_no] : moved.kot_nos;
		try {
			emitRestaurant(restaurantId, "table:order_moved", {
				order_id: moved.order_id,
				from_table: moved.from_table,
				to_table: moved.to_table,
				kot_no: print.kot_no ?? kotNos[0] ?? null,
			});
		} catch { /* ignore realtime errors */ }
		try {
			await log_audit(
				req,
				"4ad474d4-5230-449c-874f-6a238b833bca",
				moveOrderAuditSentence({
					kotNos,
					dishes: moved.items,
					fromTable: moved.from_table,
					toTable: moved.to_table,
					printed: print.printed,
					printReason: print.reason ?? null,
				}),
				Audit_log_category.Tables,
				{
					...moved, print,
					// What the Bill Edit report reads (classifyBillEdit's base).
					table: moved.to_table, from: moved.from_table, to: moved.to_table,
					item: voidItemsText(moved.items), kot_no: kotNos[0] ?? null,
				},
			);
		} catch (err) { logger.warn({ err }, "log_audit move-order failed"); }
		// Client items 1-2: every door the printed-bill guard judges files the
		// addition line after its write. The destination grew; the source did not.
		await noteAdditionToPrintedBill(req, destinationGuard);
		// The destination's running total rides MoveOrderToTable's result; a
		// waiter-only session is not told it (redactMoveAnswer).
		const answer = {
			...moved, print,
			kot_no: kotNos[0] ?? null,
			...moveReprintFields(destinationGuard, sourceGuard),
		};
		res.json(hidesPrices(req.auth) ? redactMoveAnswer(answer) : answer);
	} catch (error: any) {
		logger.error({ err: error }, "move_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to move that order") });
	}
});

/*
	RELEASE/UNOCCUPY A TABLE — and the side door C2 left open.

	THE HOLE. C2 put all five settle paths behind PERM_CLOSE_BILL. This route was
	not one of them, and ReleaseTable voids every active order on the table AND
	closes its open bill at total_amt = 0 (see its money-guard comments). Its
	permission, 090ea8d4, is held by the CORE WAITER ROLE. So the front door was
	bolted and the side door was open: a waiter could not settle a bill for what
	it was worth, and could still make it disappear for nothing — which is worse
	than not restricting settle at all, because the restriction is visible and is
	therefore trusted.

	THE GATE DEPENDS ON THE BILL, NOT ON THE ROUTE. Releasing an EMPTY table is
	the commonest floor action there is and stays on 090ea8d4 for every waiter:
	moving the whole route to PERM_CLOSE_BILL would mean fetching a manager to
	free a table nobody ordered at, and a floor that cannot recycle its own
	tables is a worse outage than the bug. Releasing a table that still carries
	VALUE is a write-off and needs the authority to settle that value — the SAME
	uuid enforceSettleAuthority checks, never a new one (migration 025's rule).
	release_authority.ts holds the rule and argues where the line sits.

	THE PREFLIGHT IS SKIPPED ENTIRELY FOR ANYONE WHO ALREADY HOLDS Close Bill,
	so an owner, a manager or a cashier pays no extra query, meets no new failure
	mode, and cannot be locked out of their own floor by a read that went wrong.
	For everyone else the preflight is REQUIRED to succeed: if we cannot see what
	a release would destroy we refuse it, because a refused release costs one
	escalation and an un-refused one can cost a service's takings.
*/
app.post("/release-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	const actions = req.auth?.actions ?? [];
	const mayWriteOff = actions.includes("*") || actions.includes(PERM_CLOSE_BILL);
	let writeOffValue = 0;
	{
		let impact: Awaited<ReturnType<typeof GetTableReleaseImpact>> = null;
		let impactFailed = false;
		try {
			impact = await GetTableReleaseImpact(restaurantId, tableName);
		} catch (err) {
			impactFailed = true;
			logger.error({ err, table: tableName }, "release_table_impact_read_failed");
		}
		// THE READ FAILING MEANS DIFFERENT THINGS TO DIFFERENT CALLERS, and that
		// asymmetry is the point. To somebody who may already write a bill off it
		// costs one line of audit detail and nothing else — they are not blocked by
		// a read they never needed. To everybody else it is the whole gate, and an
		// ungated release is the bug, so it is a refusal.
		if (impactFailed && !mayWriteOff) {
			res.status(503).json({
				error: "Forbidden",
				details: "Could not check whether releasing this table would write off an unpaid bill. Try again, or ask a manager to release it.",
				requiredPermission: PERM_CLOSE_BILL,
			});
			return;
		}
		// A table that does not exist is ReleaseTable's 400 to give, not ours.
		if (impact) {
			const verdict = mayReleaseTable({ actions, impact, closeBillPermission: PERM_CLOSE_BILL, tableName });
			if (!verdict.allowed) {
				// AUDITED EVEN THOUGH NOTHING HAPPENED. An attempt to walk a table's
				// money out of the system is exactly the event a manager wants to see,
				// and a refusal that leaves no trace is indistinguishable from one that
				// was never made. Best-effort: a failed audit write must not turn a
				// 403 into a 500.
				try {
					await log_audit(
						req, "090ea8d4-e348-4e1b-9723-11131a73a085",
						`REFUSED release of table ${tableName} — would have written off ${verdict.write_off_value.toFixed(2)} without Close Bill`,
						Audit_log_category.Tables,
						{ table_name: tableName, refused: true, write_off_value: verdict.write_off_value, ...impact },
					);
				} catch (err) { logger.warn({ err }, "log_audit release-table refusal failed"); }
				res.status(403).json({
					error: "Forbidden",
					details: verdict.details,
					requiredPermission: PERM_CLOSE_BILL,
					write_off_value: verdict.write_off_value,
				});
				return;
			}
			writeOffValue = verdict.write_off_value;
		}
	}

	try {
		const result = await ReleaseTable(restaurantId, tableName);
		try {
			// The audit line SAYS WHAT WAS DESTROYED when something was. A release of
			// an empty table reads exactly as it always has.
			const note = writeOffValue > 0 ? ` (wrote off ${writeOffValue.toFixed(2)} of unpaid orders)` : "";
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Released table ${tableName}${note}`, Audit_log_category.Tables, { table_name: tableName, write_off_value: writeOffValue });
		} catch (err) {
			logger.warn({ err }, 'log_audit release-table failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "release_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to release table") });
	}
});

// Get table status
app.get("/table-status", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableName = typeof req.query.table_name === 'string' ? req.query.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name query parameter is required" });
		return;
	}

	try {
		const result = await GetTableStatus(restaurantId, tableName);
		if (!result) {
			res.status(404).json({ error: "Table not found" });
			return;
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "get_table_status_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to get table status") });
	}
});

// Get bill for a table (returns the current open bill and all associated orders)
app.get("/bill-for-table", validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableName = typeof req.query.table_name === 'string' ? req.query.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name query parameter is required" });
		return;
	}

	try {
		const result = await GetBillForTable(restaurantId, tableName);
		if (!result) {
			res.status(404).json({ error: "No open bill found for this table" });
			return;
		}
		// C4 — THE PRIMARY SURFACE. This is the payload the order pad's "what is
		// already on this table" strip and the bill sheet's line list are built
		// from, which is the list the requirement names ("the list of ordered
		// dishes displayed on the right side"). The REDACTION HAPPENS HERE AND
		// NOT IN GetBillForTable: the same reader renders the guest's printed
		// bill, the split, the KOT and every settle path, and taking prices off
		// there would take them off a guest's receipt. See price_scope.ts.
		//
		// A manager, cashier, captain or admin takes the `result` branch and gets
		// a byte-identical response to the one they got before this existed.
		// CLIENT ITEMS 1 AND 2 — IS THE PAPER THE GUEST IS HOLDING STILL RIGHT?
		// Asked through the SAME fingerprint the print files and the print gate
		// compares (currentPaperDigest), and only for a printed table. `true` puts
		// "Print updated bill" in front of a waiter and the stale-paper warning in
		// front of whoever settles; null (nothing printed, or printed before 055)
		// changes nothing. The digest itself is the data layer's and is not sent.
		const { last_paper_digest: _lastPaperDigest, ...bill } = result;
		void _lastPaperDigest;
		const payload = { ...bill, paper_stale: await billPaperStale(restaurantId, tableName, result) };
		res.json(hidesPrices(req.auth) ? redactBillForTable(payload as unknown as Record<string, unknown>) : payload);
	} catch (error: any) {
		logger.error({ err: error }, "get_bill_for_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to get bill for table") });
	}
});
}


export function registerTableListRoute(app: Express): void {

/*
Returns tables in a 2d array in ascending order of capacity.
[
	[
		{
			"table_name": "T1",
			"capacity": 1,
			"booked": true
		},
		{
			"table_name": "T2",
			"capacity": 1
			"booked": true
		},
	],
	[
		{
			"table_name": "T6",
			"capacity": 3
			"booked": true
		},
		{
			"table_name": "T7",
			"capacity": 3
			"booked": true
		}
	],
	[
		{
			"table_name": "T10",
			"capacity": 6
			"booked": true
		}
	]
]
*/

app.get("/get-tables", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
	const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;
	try {
		const tables = await GetTables(restaurantId, requestedTime);
		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit get-tables failed');
		}
		// C4 — THE FLOOR GRID CARRIES THE SAME MONEY UNDER DIFFERENT NAMES.
		// `table_total` / `table_apc` / `target_apc` are what the tile's
		// "₹1,200 · bill · apc ₹300" line and its APC traffic-light are drawn
		// from, and `RoleScope.showsMoney` already takes both off a waiter's grid
		// (modules.dart:7929). Redacting /bill-for-table and leaving this one
		// would have left the running total of every table on the floor one poll
		// away — and this is the MOST-polled endpoint in the product, so it is
		// the easiest of the three to read off the wire.
		//
		// `apc_status`, `payment_pending`, `occupied` and the three C3 print
		// fields all survive: they are how a waiter still sees WHICH tables owe
		// money and which have been billed, without being told how much.
		res.send(hidesPrices(req.auth) ? redactTableList(tables ?? []) : (tables ?? []));
	} catch (e) {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
});
}
