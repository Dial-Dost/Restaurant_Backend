// Reordering the floor, against the REAL ReorderTableSections and
// GetTableSections in database_supabase.ts over a fake Pool. The pure ordering
// rules are covered in table_section_order.test.ts; what is under test HERE is
// the part of the feature that is made of SQL statements and the order they run
// in — specifically the one that can lose an owner's data:
//
//   A section can exist WITHOUT a roster row, as nothing but a "Tables".section
//   string. Positions can only live on roster rows. So unless the reorder
//   materialises those sections BEFORE it hands out positions, every zone that
//   was never written to "Table_sections" is left unpositioned — and any
//   implementation that then reads its ordered list back from the roster drops
//   them off the floor plan entirely.
//
// See table_section_order_fixtures.ts for what the fake models and what it
// deliberately does not.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  RESTAURANT_SLUG,
  addTable,
  addZone,
  resetStore,
  statements,
  zoneByName,
  zones,
} from "./table_section_order_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __tableSectionOrderFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__tableSectionOrderFixtureConnect;
    if (!make) {throw new Error("table section order fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  resetStore();
  // The probe that remembers whether migration 041's column answered is
  // process-wide by design; reset it so each test starts from "not asked".
  db.__resetSectionOrderProbe();
});

/**
 * The zone names the data layer renders, in order.
 *
 * This is the zones the TABLES carry. EMPTY zones — roster rows with no table in
 * them — are unioned on top of this by the route, which is why the tests that
 * use this helper give every zone a table: a zone with no table is not a thing
 * GetTableSections is supposed to list, and asserting that it does not would be
 * asserting the wrong contract. `roster.order` is checked separately; that map
 * is what the route positions the empty ones with.
 */
async function listedSections(): Promise<string[]> {
  const roster = await db.GetTableSections(RESTAURANT_SLUG);
  return roster.sections.map((s) => s.section);
}

describe("reorder — the implicit-section trap", () => {
  test("a section that exists only as a Tables.section string gets a roster row", () => {
    // "Bar" was never written to "Table_sections": some table simply carries the
    // label. Before the reorder there is nowhere to put its position.
    addTable({ table_name: "T1", section: "Bar" });
    addTable({ table_name: "T2", section: "Terrace" });
    addZone("Terrace");
    expect(zoneByName("Bar")).toBeUndefined();

    return db.ReorderTableSections(RESTAURANT_SLUG, ["Terrace", "Bar"]).then((r) => {
      expect(r.ordered).toEqual(["Terrace", "Bar"]);
      expect(zoneByName("Bar")?.sort_order).toBe(2);
      expect(zoneByName("Terrace")?.sort_order).toBe(1);
    });
  });

  test("an implicit section the request never mentions still survives, positioned", () => {
    // The failure this whole design exists to prevent: the owner drags Terrace
    // above Main Hall on a client that predates "Bar", and Bar disappears.
    addTable({ table_name: "T1", section: "Bar" });
    addTable({ table_name: "T2", section: "Main Hall" });
    addTable({ table_name: "T3", section: "Terrace" });
    addZone("Main Hall");
    addZone("Terrace");

    return db.ReorderTableSections(RESTAURANT_SLUG, ["Terrace", "Main Hall"]).then(async (r) => {
      expect(r.ordered).toEqual(["Terrace", "Main Hall", "Bar"]);
      expect(zoneByName("Bar")?.sort_order).toBe(3);
      // And it is still on the floor plan afterwards, with its table.
      expect(await listedSections()).toEqual(["Terrace", "Main Hall", "Bar"]);
    });
  });

  test("materialising does not resurrect a deleted or virtual table's zone", () => {
    // The INSERT carries the same predicates GetTableSections does, so the two
    // can never disagree about which zones exist. A zone that only a soft-deleted
    // table remembers is not a zone.
    addTable({ table_name: "T1", section: "Live" });
    addTable({ table_name: "T2", section: "Ghost", is_deleted: true });
    addTable({ table_name: "T3", section: "Virtual", is_virtual: true });
    addTable({ table_name: "T4", section: "   " });

    return db.ReorderTableSections(RESTAURANT_SLUG, ["Live"]).then((r) => {
      expect(r.ordered).toEqual(["Live"]);
      expect(zones().map((z) => z.name)).toEqual(["Live"]);
    });
  });

  test("materialising is idempotent — it never doubles an existing roster row", () => {
    addTable({ table_name: "T1", section: "Patio" });
    addZone("patio"); // stored under a different spelling, as 023's index allows

    return db.ReorderTableSections(RESTAURANT_SLUG, ["Patio"]).then(() => {
      expect(zones()).toHaveLength(1);
      // The stored spelling is what keeps its position; the request's casing is
      // only used to match.
      expect(zoneByName("PATIO")?.sort_order).toBe(1);
    });
  });
});

describe("reorder — what gets written", () => {
  test("positions are 1..N over the WHOLE outlet, not just the request", () => {
    addZone("Alpha");
    addZone("Beta");
    addZone("Gamma");

    return db.ReorderTableSections(RESTAURANT_SLUG, ["Gamma"]).then(() => {
      const byName = Object.fromEntries(zones().map((z) => [z.name, z.sort_order]));
      expect(byName).toEqual({ Gamma: 1, Alpha: 2, Beta: 3 });
    });
  });

  test("a second reorder replaces the whole order — the previous one does not bleed through", () => {
    // This is what makes "the last commit wins" a complete outcome rather than a
    // half-applied one when two devices drag at once.
    addZone("Alpha");
    addZone("Beta");
    addZone("Gamma");

    return db
      .ReorderTableSections(RESTAURANT_SLUG, ["Alpha", "Beta", "Gamma"])
      .then(() => db.ReorderTableSections(RESTAURANT_SLUG, ["Gamma", "Beta", "Alpha"]))
      .then(() => {
        const byName = Object.fromEntries(zones().map((z) => [z.name, z.sort_order]));
        expect(byName).toEqual({ Gamma: 1, Beta: 2, Alpha: 3 });
        // Every position is used exactly once — no duplicates, no gaps.
        const positions = zones().map((z) => z.sort_order).sort((a, b) => Number(a) - Number(b));
        expect(positions).toEqual([1, 2, 3]);
      });
  });

  test("a section created AFTER a reorder has no position and lists last", () => {
    addTable({ table_name: "T1", section: "Entrance" });
    addTable({ table_name: "T2", section: "Terrace" });
    addZone("Entrance");
    addZone("Terrace");

    return db
      .ReorderTableSections(RESTAURANT_SLUG, ["Terrace", "Entrance"])
      .then(async () => {
        // POST /table-sections mints a name; it never assigns a position.
        addZone("Annexe");
        addTable({ table_name: "T9", section: "Annexe" });
        expect(zoneByName("Annexe")?.sort_order).toBeNull();
        expect(await listedSections()).toEqual(["Terrace", "Entrance", "Annexe"]);
      });
  });

  test("the whole write is ONE transaction that takes its lock first", () => {
    // The lock is what serialises two devices; it is worth nothing if it is
    // taken after the roster has already been read, or in its own transaction.
    addZone("Alpha");
    addZone("Beta");

    return db.ReorderTableSections(RESTAURANT_SLUG, ["Beta", "Alpha"]).then(() => {
      const log = statements();
      const begins = log.filter((s) => s.startsWith("begin"));
      const commits = log.filter((s) => s.startsWith("commit"));
      expect(begins).toHaveLength(1);
      expect(commits).toHaveLength(1);

      const at = (pred: (s: string) => boolean): number => log.findIndex(pred);
      const begin = at((s) => s.startsWith("begin"));
      const lock = at((s) => s.includes('select id from "table_sections"') && s.includes("for update"));
      const materialise = at((s) => s.includes('insert into "table_sections" (res_id, outlet_id, name)'));
      const read = at((s) => s.includes('select id, btrim(name) as name from "table_sections"'));
      const write = at((s) => s.includes('update "table_sections" t set sort_order'));
      const commit = at((s) => s.startsWith("commit"));

      expect(begin).toBeGreaterThanOrEqual(0);
      expect(begin).toBeLessThan(lock);
      expect(lock).toBeLessThan(materialise);
      expect(materialise).toBeLessThan(read);
      expect(read).toBeLessThan(write);
      expect(write).toBeLessThan(commit);

      // One renumbering statement, not one per section — a per-row loop would
      // leave the outlet half-ordered if the connection dropped mid-way.
      expect(log.filter((s) => s.includes('update "table_sections" t set sort_order'))).toHaveLength(1);
    });
  });

  test("an outlet with no sections at all is a no-op, not an error", () => {
    return db.ReorderTableSections(RESTAURANT_SLUG, ["Nothing"]).then((r) => {
      expect(r.ordered).toEqual([]);
      expect(r.positioned).toBe(0);
      expect(zones()).toEqual([]);
    });
  });
});

describe("GetTableSections — what the floor plan reads back", () => {
  test("before any reorder the list is alphabetical, exactly as on 1.8.5", () => {
    addTable({ table_name: "T1", section: "Terrace" });
    addTable({ table_name: "T2", section: "Bar" });
    addTable({ table_name: "T3", section: "Garden" });
    addTable({ table_name: "T4", section: null });

    return db.GetTableSections(RESTAURANT_SLUG).then((roster) => {
      expect(roster.sections.map((s) => s.section)).toEqual(["Bar", "Garden", "Terrace"]);
      expect(roster.sections.every((s) => s.sort_order === null)).toBe(true);
      expect(roster.unassigned).toBe(1);
      expect(roster.order).toEqual({});
    });
  });

  test("after a reorder the list is in the chosen order, with counts intact", () => {
    addTable({ table_name: "T1", section: "Terrace", capacity: 2 });
    addTable({ table_name: "T2", section: "Bar", capacity: 6 });
    addTable({ table_name: "T3", section: "Bar", capacity: 4 });

    return db
      .ReorderTableSections(RESTAURANT_SLUG, ["Terrace", "Bar"])
      .then(() => db.GetTableSections(RESTAURANT_SLUG))
      .then((roster) => {
        expect(roster.sections.map((s) => s.section)).toEqual(["Terrace", "Bar"]);
        expect(roster.sections.map((s) => s.sort_order)).toEqual([1, 2]);
        const bar = roster.sections.find((s) => s.section === "Bar");
        expect(bar?.tables).toBe(2);
        expect(bar?.seats).toBe(10);
        // The raw map is what the route positions EMPTY zones with — they have no
        // table to be summarised from.
        expect(roster.order).toEqual({ terrace: 1, bar: 2 });
      });
  });

  test("a section whose position never landed still renders, in the tail", () => {
    // Belt and braces for the read side: even if materialisation were skipped,
    // the union is not a join, so an unpositioned zone is listed rather than
    // dropped.
    addTable({ table_name: "T1", section: "Terrace" });
    addTable({ table_name: "T2", section: "Bar" });
    addZone("Terrace", 1);

    return db.GetTableSections(RESTAURANT_SLUG).then((roster) => {
      expect(roster.sections.map((s) => s.section)).toEqual(["Terrace", "Bar"]);
      expect(roster.sections.map((s) => s.sort_order)).toEqual([1, null]);
    });
  });
});
