// In-memory store + a fake `pg` Pool so the REAL floor-section ordering paths in
// database_supabase.ts — GetTableSections and ReorderTableSections — can be
// exercised without a database. Same shape and reasoning as
// table_assignment_fixtures.ts and platform_fixtures.ts.
//
// WHY A FIXTURE AND NOT ONLY PURE TESTS: the ordering DECISION is already a pure
// function (table_sections_order.ts) and is tested as one. What is NOT pure, and
// what this file exists for, is the thing the feature can actually lose data
// with: a section that exists only as a "Tables".section string with no
// "Table_sections" roster row. Whether such a section survives a reorder is
// decided by two SQL statements — the materialising INSERT ... SELECT and the
// roster read that follows it — and by the order they run in. A test that
// re-implemented those in TypeScript would prove nothing.
//
// THE RULE THAT KEEPS IT HONEST: the materialising INSERT is modelled from its
// STATEMENT TEXT. It applies the predicates the statement actually carries —
// is_deleted, is_virtual, blank labels — and it honours `on conflict do nothing`
// against the case-insensitive key that migration 023's unique index enforces.
// Delete the is_deleted predicate from the shipped SQL and the "a deleted
// table's old zone is not resurrected" test fails, rather than the fixture
// quietly enforcing a rule the database no longer has.
//
// WHAT IT DOES NOT MODEL, stated because an inaccurate promise is worse than
// none: isolation. BEGIN/COMMIT are recorded (so a test can assert the reorder
// runs as ONE transaction and takes its lock inside it) but not enforced — there
// is no second connection here, so `for update` cannot actually block. What can
// be proved without isolation is the shape that makes blocking sufficient:
// exactly one transaction, the lock taken first, and the whole outlet renumbered
// by ONE statement. RLS is not modelled either, so this proves behaviour, never
// permissions.
//
// Dispatch THROWS on any unrecognised statement so a code path that starts
// issuing a new query fails loudly rather than silently receiving zero rows.

export const RES_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const OUTLET_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const RESTAURANT_SLUG = "gaia";

/** One "Tables" row, only the columns the section code reads. */
export interface TableFix {
  id: string;
  table_name: string;
  capacity: number;
  /** The zone LABEL. This is the source of truth for which zone a table is in,
   *  and — when no roster row carries the same name — the only evidence that the
   *  zone exists at all. */
  section: string | null;
  is_deleted: boolean;
  is_virtual: boolean;
}

/** One "Table_sections" roster row (migration 023 + 041's sort_order). */
export interface ZoneFix {
  id: string;
  name: string;
  sort_order: number | null;
}

interface Store {
  tables: TableFix[];
  zones: ZoneFix[];
  /** Every statement issued, normalised, in order — so a test can assert the
   *  transaction shape rather than only the end state. */
  log: string[];
  nextId: number;
}

let store: Store = freshStore();

function freshStore(): Store {
  return { tables: [], zones: [], log: [], nextId: 1 };
}

export function resetStore(): void {
  store = freshStore();
}

export function addTable(t: Partial<TableFix> & { table_name: string }): void {
  store.tables.push({
    id: `t-${String(store.nextId++)}`,
    capacity: 4,
    section: null,
    is_deleted: false,
    is_virtual: false,
    ...t,
  });
}

/** Seed a roster row — a zone that exists as a NAME, with or without tables. */
export function addZone(name: string, sortOrder: number | null = null): void {
  store.zones.push({ id: `z-${String(store.nextId++)}`, name, sort_order: sortOrder });
}

/** The roster as it stands, for assertions. */
export function zones(): ZoneFix[] {
  return store.zones.map((z) => ({ ...z }));
}

export function zoneByName(name: string): ZoneFix | undefined {
  const key = name.trim().toLowerCase();
  const hit = store.zones.find((z) => z.name.trim().toLowerCase() === key);
  return hit ? { ...hit } : undefined;
}

/** Every statement issued since the last reset, normalised to one line. */
export function statements(): string[] {
  return [...store.log];
}

// ---------------------------------------------------------------------------
// SQL dispatch
// ---------------------------------------------------------------------------

const str = (v: unknown): string => String(v ?? "");
const key = (v: unknown): string => str(v).trim().toLowerCase();

function contextRow(): Record<string, unknown> {
  return {
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    restaurant_slug: RESTAURANT_SLUG,
    restaurant_name: "Gaia",
    restaurant_main_office_add: null,
    restaurant_logo_url: null,
    timezone: "Asia/Kolkata",
  };
}

/** The tables the section code counts: on the floor, not virtual, not deleted. */
function liveTables(): TableFix[] {
  return store.tables.filter((t) => !t.is_deleted && !t.is_virtual);
}

function query(sqlRaw: string, params: unknown[] = []): { rows: unknown[] } {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const s = sql.toLowerCase();
  store.log.push(s);

  // Transaction control — recorded (tests assert the shape), not enforced.
  if (/^(begin|commit|rollback|savepoint|release)/.test(s)) {return { rows: [] };}
  if (s.includes("set_config(")) {return { rows: [] };}

  // Lazy DDL — swallowed. `do $$ ... alter table ...` is how migration 041's
  // column is ensured at runtime; there is nothing to model, the store already
  // has the column.
  if (s.startsWith("create table if not exists")) {return { rows: [] };}
  if (s.startsWith("create index") || s.startsWith("create unique index")) {return { rows: [] };}
  if (s.startsWith("create or replace function")) {return { rows: [] };}
  if (s.startsWith("create trigger") || s.startsWith("drop trigger")) {return { rows: [] };}
  if (s.startsWith("alter table")) {return { rows: [] };}
  if (s.startsWith("do $$")) {return { rows: [] };}
  if (s.includes('insert into "actions"')) {return { rows: [] };}

  // --- Context resolution (resolveRestaurantContext) -----------------------
  if (s.includes('from "restaurant" r')) {return { rows: [contextRow()] };}

  // --- readSectionOrderByKey ------------------------------------------------
  // The positions, and ONLY the positioned rows: the `sort_order is not null`
  // predicate is what makes "no section has a position" indistinguishable from
  // "migration 041 has not run", which is the fallback the floor plan relies on.
  if (s.includes('select btrim(name) as name, sort_order from "table_sections"')) {
    return {
      rows: store.zones
        .filter((z) => z.sort_order !== null && z.name.trim() !== "")
        .map((z) => ({ name: z.name.trim(), sort_order: z.sort_order })),
    };
  }

  // --- GetTableSections' group-by over "Tables" -----------------------------
  // Grouped case-INSENSITIVELY with min() picking the display spelling, exactly
  // as the statement says, because that grouping is what stops "Patio"/"patio"
  // rendering as two zones.
  if (s.includes('as section, count(*)::int as tables') && s.includes('from "tables"')) {
    const groups = new Map<string, { section: string | null; tables: number; seats: number }>();
    for (const t of liveTables()) {
      const label = (t.section ?? "").trim();
      const k = label.toLowerCase();
      const g = groups.get(k) ?? { section: null, tables: 0, seats: 0 };
      if (label !== "" && (g.section === null || label < g.section)) {g.section = label;}
      g.tables += 1;
      g.seats += Math.max(t.capacity, 1);
      groups.set(k, g);
    }
    const rows = [...groups.values()].sort((a, b) =>
      (a.section ?? "") < (b.section ?? "") ? -1 : (a.section ?? "") > (b.section ?? "") ? 1 : 0);
    return { rows };
  }

  // --- ReorderTableSections, statement 1: the lock -------------------------
  if (s.includes('select id from "table_sections"') && s.includes("for update")) {
    return { rows: store.zones.map((z) => ({ id: z.id })) };
  }

  // --- ReorderTableSections, statement 2: MATERIALISE ----------------------
  // Behaviour is DERIVED FROM THE STATEMENT. Each predicate the SQL carries is
  // applied only when it is actually present, so removing one from the shipped
  // query changes what this fixture does and fails a test, instead of the
  // fixture keeping a rule the database has stopped enforcing.
  if (s.includes('insert into "table_sections" (res_id, outlet_id, name)') && s.includes('from "tables" t')) {
    const skipDeleted = s.includes("coalesce(t.is_deleted, false) = false");
    const skipVirtual = s.includes("coalesce(t.is_virtual, false) = false");
    const skipBlank = s.includes("nullif(btrim(coalesce(t.section, '')), '') is not null");
    const grouped = new Map<string, string>();
    for (const t of store.tables) {
      if (skipDeleted && t.is_deleted) {continue;}
      if (skipVirtual && t.is_virtual) {continue;}
      const label = (t.section ?? "").trim();
      if (skipBlank && label === "") {continue;}
      const k = label.toLowerCase();
      // min(btrim(t.section)) — a stable display spelling per case-folded group.
      const seen = grouped.get(k);
      if (seen === undefined || label < seen) {grouped.set(k, label);}
    }
    let inserted = 0;
    for (const [k, label] of grouped) {
      // `on conflict do nothing` against 023's unique index on
      // (res_id, outlet_id, lower(btrim(name))).
      if (store.zones.some((z) => key(z.name) === k)) {continue;}
      store.zones.push({ id: `z-${String(store.nextId++)}`, name: label, sort_order: null });
      inserted += 1;
    }
    return { rows: inserted > 0 && s.includes("returning") ? [] : [] };
  }

  // --- ReorderTableSections, statement 3: read the roster back -------------
  if (s.includes('select id, btrim(name) as name from "table_sections"')) {
    return {
      rows: store.zones
        .filter((z) => z.name.trim() !== "")
        .map((z) => ({ id: z.id, name: z.name.trim() })),
    };
  }

  // --- ReorderTableSections, statement 4: the renumber ---------------------
  // One statement for the whole outlet, driven by an ordered id array. Modelled
  // as the set-based UPDATE it is: rows named in the array take their ordinal,
  // rows not named keep what they had.
  if (s.includes('update "table_sections" t set sort_order = o.pos')) {
    const ids = (params[2] as string[] | undefined) ?? [];
    ids.forEach((id, i) => {
      const z = store.zones.find((x) => x.id === id);
      if (z) {z.sort_order = i + 1;}
    });
    return { rows: [] };
  }

  throw new Error(`table_section_order_fixtures: unmodelled SQL: ${sql.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Fake pg wiring — same globalThis pattern as the sibling fixtures, because a
// jest.mock("pg") factory is hoisted above imports and cannot close over them.
// ---------------------------------------------------------------------------

interface FixtureGlobal {
  __tableSectionOrderFixtureConnect?: () => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  };
}

(globalThis as unknown as FixtureGlobal).__tableSectionOrderFixtureConnect = () => ({
  query: (sql: string, params?: unknown[]) => Promise.resolve(query(sql, params ?? [])),
  release: () => {/* pooling is not modelled */},
});
