/**
 * Floor plan: tables, table sections/zones, seating suggestions, occupancy and
 * covers.
 */
import type { Express, Request, Response } from "express";
import { AddTable, Audit_log_category, DeleteTableSection, GetBillForTable, GetSeatingSuggestion, GetTableSections, GetTableStatus, GetTables, OccupyTable, ReleaseTable, RemoveTable, RenameTableSection, TableSectionExists, UpdateTable, UpdateTableCovers, normalizeTableSection, runTenantQuery, runTenantTransaction } from "../database_supabase.js";
import { idempotent } from "../idempotency.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { AUDIT_TABLE_UPDATED, PERM_TABLE_SECTIONS, extractEmployeeId, extractRestaurantId, log_audit, validateAction } from "./_shared.js";


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

	GET    /table-sections            -> { sections: [{ section, tables, seats }], unassigned }
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
		const roster = await GetTableSections(restaurantId);
		const scope = zoneScope(req);
		if (scope) {
			// Union the two sources: zones derived from "Tables".section already carry
			// their counts, and any roster row they don't cover is an EMPTY zone (0/0).
			// Keyed case-insensitively, the same way rename/delete resolve a zone, so a
			// stored "patio" never renders a second time next to a table's "Patio".
			const seen = new Set(roster.sections.map((s) => s.section.trim().toLowerCase()));
			for (const name of await listStoredZones(scope)) {
				const key = name.toLowerCase();
				if (seen.has(key)) { continue; }
				seen.add(key);
				roster.sections.push({ section: name, tables: 0, seats: 0 });
			}
			roster.sections.sort((a, b) => a.section.localeCompare(b.section, undefined, { sensitivity: "base" }));
		}
		res.json(roster);
	} catch (error: any) {
		logger.error({ err: error }, "table_sections_list_failed");
		res.status(500).json({ error: "Unable to fetch table sections" });
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

// Release/unoccupy a table
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

	try {
		const result = await ReleaseTable(restaurantId, tableName);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Released table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
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
		res.json(result);
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
		res.send(tables ?? []);
	} catch (e) {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
});
}
