// The floor-section ordering RULES (migration 041) — every decision the feature
// makes, asserted directly, because every one of them lives in a pure function
// on purpose. See table_sections_order.ts's header for why the ordering is not
// in SQL.
//
// The claim these tests exist to back is the one an owner would notice being
// wrong: REORDERING CANNOT MAKE A SECTION DISAPPEAR. A section exists either as
// a roster row or, invisibly, as a "Tables".section string on a table with no
// roster row; positions can only live on roster rows; so the naive
// implementation silently drops the string-only ones, and to the owner that
// reads as "reordering deleted my Bar section". planSectionOrder is written so
// that its output is a PERMUTATION of the sections it is handed, and the first
// block below proves exactly that, including for inputs it has never seen.

import { describe, test, expect } from "@jest/globals";
import {
  SECTION_ORDER_MAX,
  SectionOrderRequestError,
  compareTableSections,
  planSectionOrder,
  readSectionOrderRequest,
  sectionOrderKey,
  type OrderableSection,
} from "../table_sections_order";

const key = sectionOrderKey;
const keysOf = (names: readonly string[]): string[] => names.map(key).sort();

describe("planSectionOrder — nothing can vanish", () => {
  test("the result is a permutation of the sections that exist", () => {
    const existing = ["Terrace", "Bar", "Main Hall", "Garden"];
    const out = planSectionOrder(["Bar", "Terrace"], existing);
    expect(out).toHaveLength(existing.length);
    expect(keysOf(out)).toEqual(keysOf(existing));
  });

  test("a STALE request cannot delete the section it never heard of", () => {
    // Another device created "Rooftop" after this client last read the list.
    // The owner's drag must not take it off the floor.
    const out = planSectionOrder(["Bar", "Terrace"], ["Terrace", "Bar", "Rooftop"]);
    expect(out).toEqual(["Bar", "Terrace", "Rooftop"]);
  });

  test("an IMPLICIT section — one that was only ever a Tables.section string — is kept", () => {
    // The trap this feature is built around: the roster knows Terrace and Bar;
    // "Patio" exists solely because some table is labelled Patio. Once the
    // caller has materialised it, it is just another existing name here, and it
    // comes back positioned or, failing that, appended — never dropped.
    const out = planSectionOrder(["Terrace", "Bar"], ["Terrace", "Bar", "Patio"]);
    expect(out).toContain("Patio");
    expect(keysOf(out)).toEqual(keysOf(["Terrace", "Bar", "Patio"]));
  });

  test("naming a section that no longer exists positions nothing and invents nothing", () => {
    // Someone dissolved "Garden" mid-drag. The request still lands for the rest.
    const out = planSectionOrder(["Garden", "Bar", "Terrace"], ["Terrace", "Bar"]);
    expect(out).toEqual(["Bar", "Terrace"]);
  });

  test("every existing section appears exactly once, for any request", () => {
    // A small exhaustive sweep rather than one hand-picked case: every subset of
    // the floor, in both directions, plus two names that do not exist.
    const existing = ["Bar", "Garden", "Terrace"];
    const extras = ["Ghost", "Rooftop"];
    const pool = [...existing, ...extras];
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const requested = pool.filter((_, i) => (mask >> i) & 1);
      for (const req of [requested, [...requested].reverse()]) {
        const out = planSectionOrder(req, existing);
        expect(keysOf(out)).toEqual(keysOf(existing));
      }
    }
  });
});

describe("planSectionOrder — where sections land", () => {
  test("requested sections come first, in the order they were sent", () => {
    const out = planSectionOrder(["Terrace", "Bar", "Garden"], ["Bar", "Garden", "Terrace"]);
    expect(out).toEqual(["Terrace", "Bar", "Garden"]);
  });

  test("the remainder is appended ALPHABETICALLY — the order it already had", () => {
    const out = planSectionOrder(["Terrace"], ["Terrace", "zeta", "Alpha", "middle"]);
    expect(out).toEqual(["Terrace", "Alpha", "middle", "zeta"]);
  });

  test("a request is matched case-insensitively and the STORED spelling is kept", () => {
    // The client renders what the server sent; a round-trip through a lowercase
    // client must not rewrite the label the floor shows.
    const out = planSectionOrder(["bar", "TERRACE"], ["Bar", "Terrace"]);
    expect(out).toEqual(["Bar", "Terrace"]);
  });

  test("a name repeated in the request takes its FIRST slot, not two", () => {
    const out = planSectionOrder(["Bar", "Terrace", "Bar"], ["Bar", "Terrace", "Garden"]);
    expect(out).toEqual(["Bar", "Terrace", "Garden"]);
  });

  test("two spellings of one zone are one entry — the first spelling wins", () => {
    // 023's unique index folds these, but a hand-edited row could hold both, and
    // handing one zone two positions would make the list unstable.
    const out = planSectionOrder([], ["Patio", "patio", "Bar"]);
    expect(out).toEqual(["Bar", "Patio"]);
  });

  test("blank names in the roster are ignored, not positioned", () => {
    expect(planSectionOrder([], ["Bar", "   ", ""])).toEqual(["Bar"]);
  });
});

describe("compareTableSections — the read order", () => {
  const sort = (rows: OrderableSection[]): string[] =>
    [...rows].sort(compareTableSections).map((r) => r.section);

  test("an outlet that has NEVER reordered is purely alphabetical", () => {
    // The whole point of leaving migration 041 unbackfilled: on the day it lands
    // every floor plan reads exactly as it did on 1.8.5.
    const rows: OrderableSection[] = [
      { section: "Terrace", sort_order: null },
      { section: "bar", sort_order: null },
      { section: "Garden", sort_order: null },
    ];
    expect(sort(rows)).toEqual(["bar", "Garden", "Terrace"]);
  });

  test("positioned sections come first, in their positions", () => {
    const rows: OrderableSection[] = [
      { section: "Garden", sort_order: 3 },
      { section: "Entrance", sort_order: 1 },
      { section: "Main Hall", sort_order: 2 },
    ];
    expect(sort(rows)).toEqual(["Entrance", "Main Hall", "Garden"]);
  });

  test("a NEW section lands at the END, not in the middle of a chosen order", () => {
    // A section created after a reorder has no position (null), and appending is
    // the only placement that moves nothing the owner already arranged.
    const rows: OrderableSection[] = [
      { section: "Entrance", sort_order: 1 },
      { section: "Terrace", sort_order: 2 },
      { section: "Annexe", sort_order: null },
    ];
    expect(sort(rows)).toEqual(["Entrance", "Terrace", "Annexe"]);
  });

  test("several new sections share the tail alphabetically", () => {
    const rows: OrderableSection[] = [
      { section: "Zulu", sort_order: null },
      { section: "Entrance", sort_order: 1 },
      { section: "Alpha", sort_order: null },
    ];
    expect(sort(rows)).toEqual(["Entrance", "Alpha", "Zulu"]);
  });

  test("a section with no position never sorts ABOVE a positioned one", () => {
    const rows: OrderableSection[] = [
      { section: "Aaa", sort_order: null },
      { section: "Zzz", sort_order: 9 },
    ];
    expect(sort(rows)).toEqual(["Zzz", "Aaa"]);
  });

  test("duplicate positions still yield a total, stable order", () => {
    // There is no unique index on sort_order (see migration 041's header); the
    // name tiebreak is what makes that safe rather than a 500 or a flapping list.
    const rows: OrderableSection[] = [
      { section: "Beta", sort_order: 2 },
      { section: "Alpha", sort_order: 2 },
    ];
    expect(sort(rows)).toEqual(["Alpha", "Beta"]);
    expect(sort([...rows].reverse())).toEqual(["Alpha", "Beta"]);
  });

  test("a non-finite position is treated as no position at all", () => {
    const rows: OrderableSection[] = [
      { section: "Broken", sort_order: Number.NaN },
      { section: "Fine", sort_order: 5 },
    ];
    expect(sort(rows)).toEqual(["Fine", "Broken"]);
  });
});

describe("readSectionOrderRequest", () => {
  test("accepts sections, and order as an alias", () => {
    expect(readSectionOrderRequest({ sections: ["Bar", "Terrace"] })).toEqual(["Bar", "Terrace"]);
    expect(readSectionOrderRequest({ order: ["Bar"] })).toEqual(["Bar"]);
  });

  test("trims, drops blanks, and collapses duplicates to the first slot", () => {
    expect(readSectionOrderRequest({ sections: ["  Bar ", "", "   ", "bar", "Terrace"] }))
      .toEqual(["Bar", "Terrace"]);
  });

  test("rejects a body that is not a list of names", () => {
    expect(() => readSectionOrderRequest({})).toThrow(SectionOrderRequestError);
    expect(() => readSectionOrderRequest({ sections: "Bar" })).toThrow(SectionOrderRequestError);
    expect(() => readSectionOrderRequest({ sections: [1, 2] })).toThrow(SectionOrderRequestError);
    expect(() => readSectionOrderRequest(null)).toThrow(SectionOrderRequestError);
  });

  test("rejects an empty list — that is a bug, not a request", () => {
    // Accepting it would renumber the whole outlet alphabetically on a client
    // that simply failed to send its list.
    expect(() => readSectionOrderRequest({ sections: [] })).toThrow(SectionOrderRequestError);
    expect(() => readSectionOrderRequest({ sections: ["  ", ""] })).toThrow(SectionOrderRequestError);
  });

  test("refuses an unbounded list", () => {
    const many = Array.from({ length: SECTION_ORDER_MAX + 1 }, (_, i) => `Z${String(i)}`);
    expect(() => readSectionOrderRequest({ sections: many })).toThrow(SectionOrderRequestError);
    expect(readSectionOrderRequest({ sections: many.slice(0, SECTION_ORDER_MAX) }))
      .toHaveLength(SECTION_ORDER_MAX);
  });
});

describe("sectionOrderKey — the identity the database uses", () => {
  test("is lower(btrim(name)), and nothing more", () => {
    expect(key("  Patio ")).toBe("patio");
    expect(key("PATIO")).toBe("patio");
    // Deliberately NOT whitespace-collapsing: normalizeTableSection collapses on
    // the way IN, but lower(btrim(...)) is what every WHERE clause matches on,
    // and this function has to agree with the database rather than the writer.
    expect(key("AC  Hall")).toBe("ac  hall");
  });
});
