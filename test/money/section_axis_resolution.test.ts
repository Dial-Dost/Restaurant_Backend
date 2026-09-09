// WHICH SECTION A SOLD LINE LANDS IN — the classification half of the section
// split, tested on its own.
//
// The money half (does it add up) is jest-tests/bill_section_split.test.ts and
// money_invariants.test.ts. This is the other half, and it is the half with a
// person in it: the section a line is filed under decides WHO IS ASKED TO PAY
// FOR IT. Putting a bottle of whisky in "Starters" is not a display bug when the
// table has agreed that one guest covers the bar.
//
// resolveBillSection is exported from the data layer precisely so this rule is
// reachable without a table, a bill or a database. `pg` is mocked to a pool that
// refuses every query, so nothing here can accidentally reach one.

import { describe, test, expect, jest } from "@jest/globals";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("axis fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("axis fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

process.env.SUPABASE_DIRECT_URL =
  process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";

import {
  attributeOrderLine,
  buildMenuAttributionIndex,
  resolveBillSection,
  UNCLASSIFIED_GROUP,
  UNATTRIBUTED_GROUP,
  type MenuAttributionRow,
} from "../../database_supabase";

// A menu shaped like a real one: two dishes in a revenue group, one on the menu
// but in no group at all, and one whose category is blank.
const MENU: MenuAttributionRow[] = [
  { id: "m-paneer", name: "Paneer Tikka", group_id: "g-food", group_name: "Food" },
  { id: "m-whisky", name: "Single Malt", group_id: "g-liquor", group_name: "Liquor" },
  { id: "m-rice", name: "Steamed Rice", group_id: null, group_name: null },
  { id: "m-blank", name: "Mystery Dish", group_id: "g-food", group_name: "Food" },
];
const INDEX = buildMenuAttributionIndex(MENU);

const CATEGORIES = new Map<string, string>([
  ["m-paneer", "Starters"],
  ["m-whisky", "Bar"],
  ["m-rice", "Mains"],
  ["m-blank", ""],
]);

const section = (line: Record<string, unknown>, axis: "category" | "revenue_group" | "production_group") =>
  resolveBillSection(attributeOrderLine(line, INDEX), axis, CATEGORIES);

describe("the category axis — starters, mains, bar", () => {
  test("a line stamped with its menu id lands in that dish's category", () => {
    expect(section({ name: "Paneer Tikka", menu_id: "m-paneer" }, "category"))
      .toEqual({ key: "category:starters", label: "Starters", gap: false });
    expect(section({ name: "Single Malt", menu_id: "m-whisky" }, "category"))
      .toEqual({ key: "category:bar", label: "Bar", gap: false });
  });

  test("a PRE-039 line with no menu id still lands in the right category, by name", () => {
    // Every line written before migration 039 has no menu_id. They resolve by
    // name — the same lookup applyMenuPriceFloor trusts enough to price with — so
    // a bill that was open across the upgrade splits correctly.
    expect(section({ id: "some-random-uuid", name: "  single MALT " }, "category").label).toBe("Bar");
  });

  test("two categories that differ only in case are ONE section, not two", () => {
    const upper = new Map([["m-paneer", "STARTERS"]]);
    const lower = new Map([["m-paneer", "starters"]]);
    const a = resolveBillSection(attributeOrderLine({ name: "Paneer Tikka", menu_id: "m-paneer" }, INDEX), "category", upper);
    const b = resolveBillSection(attributeOrderLine({ name: "Paneer Tikka", menu_id: "m-paneer" }, INDEX), "category", lower);
    expect(a.key).toBe(b.key);
    // The label is whatever the menu says; only the grouping is case-blind.
    expect(a.label).toBe("STARTERS");
  });

  test("a dish on the menu with no category is UNCLASSIFIED — a configuration gap", () => {
    expect(section({ name: "Mystery Dish", menu_id: "m-blank" }, "category"))
      .toEqual({ key: `~${UNCLASSIFIED_GROUP}`, label: UNCLASSIFIED_GROUP, gap: true });
  });

  test("an off-menu line is UNATTRIBUTED — a history gap, and never the same bucket as the other one", () => {
    for (const name of ["Valet fee", "Zomato charge", "Deleted dish", "Open item"]) {
      const s = section({ name }, "category");
      expect(s).toEqual({ key: `~${UNATTRIBUTED_GROUP}`, label: UNATTRIBUTED_GROUP, gap: true });
      expect(s.key).not.toBe(`~${UNCLASSIFIED_GROUP}`);
    }
  });

  test("nothing is ever guessed into a real section", () => {
    // A near-miss name is not evidence of anything. It goes to the gap.
    expect(section({ name: "Paneer Tikka (Half)" }, "category").gap).toBe(true);
  });
});

describe("the group axes — food, liquor, and the accountant's cut", () => {
  test("a classified dish lands in its group, keyed on the group id", () => {
    expect(section({ name: "Single Malt", menu_id: "m-whisky" }, "revenue_group"))
      .toEqual({ key: "g-liquor", label: "Liquor", gap: false });
  });

  test("food and liquor separate — the split the question was actually asking for", () => {
    const food = section({ name: "Paneer Tikka", menu_id: "m-paneer" }, "revenue_group");
    const bar = section({ name: "Single Malt", menu_id: "m-whisky" }, "revenue_group");
    expect(food.key).not.toBe(bar.key);
    expect([food.label, bar.label]).toEqual(["Food", "Liquor"]);
  });

  test("a dish on the menu in no group is UNCLASSIFIED, and an off-menu line is UNATTRIBUTED", () => {
    expect(section({ name: "Steamed Rice", menu_id: "m-rice" }, "revenue_group"))
      .toEqual({ key: `~${UNCLASSIFIED_GROUP}`, label: UNCLASSIFIED_GROUP, gap: true });
    expect(section({ name: "Valet fee" }, "revenue_group"))
      .toEqual({ key: `~${UNATTRIBUTED_GROUP}`, label: UNATTRIBUTED_GROUP, gap: true });
  });

  test("THE GROUP AXES ARE THE GROUP SUMMARY REPORT'S OWN BUCKETS — same key, same name, same gap flag", () => {
    // The whole point of routing through attributionBucket rather than a
    // lookalike: an owner reconciling a split against Insights > Group Summary
    // must find the same buckets under the same names.
    const { attributionBucket } = jest.requireActual("../../mis_report_math") as {
      attributionBucket: (a: { group_id: string | null; group_name: string; source: string }) => { key: string; name: string; gap: boolean };
    };
    for (const line of [
      { name: "Paneer Tikka", menu_id: "m-paneer" },
      { name: "Steamed Rice", menu_id: "m-rice" },
      { name: "Valet fee" },
    ]) {
      const a = attributeOrderLine(line, INDEX);
      const bucket = attributionBucket(a);
      expect(resolveBillSection(a, "revenue_group", CATEGORIES))
        .toEqual({ key: bucket.key, label: bucket.name, gap: bucket.gap });
    }
  });

  test("the category map is ignored on a group axis — the axes cannot leak into each other", () => {
    expect(resolveBillSection(attributeOrderLine({ name: "Paneer Tikka", menu_id: "m-paneer" }, INDEX), "production_group", CATEGORIES).label)
      .toBe("Food");
  });
});
