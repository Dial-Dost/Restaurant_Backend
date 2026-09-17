// THE SECTION SPLIT, ASSEMBLED — the real SplitBillForTableBySection over a
// stubbed `pg`, from the table name to the amounts a guest is asked for.
//
// WHY THIS FILE EXISTS ON TOP OF THE OTHER THREE. The allocation is proved pure
// (jest-tests/bill_section_split.test.ts), the classification is proved pure
// (section_axis_resolution.test.ts) and the handler is proved (
// section_split_routes.test.ts). None of them proves the ASSEMBLY, and the
// assembly is where a money bug of this shape actually lands: reading the bill's
// GROSS subtotal into the rung that expects the DISCOUNTED one, or weighting the
// sections off the printed item list (which merges away `menu_id` and rounds a
// weighed line up) instead of off the order lines. Both of those type-check,
// both pass every test above, and both hand a guest the wrong number.
//
// So this drives the shipped function with a fake Pool that answers only the
// queries this path issues and THROWS on anything else — a version that started
// reading a new table would fail here rather than quietly receiving no rows.
//
// The numbers below are arithmetic anyone can check by hand, and they are
// checked by hand rather than by re-running the same functions the code runs:
// 1,000 of food and drink, 10% service charge, 2.5 + 2.5 GST = 1,155.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-4111-8111-111111111111";
const OUT = "22222222-2222-4222-8222-222222222222";

interface FixtureLine { name: string; price: number; quantity: number; menu_id?: string; nc?: true; nc_kind?: string; variation_name?: string }

/** Everything the fake database answers with. Rewritten per test. */
const fixture: {
  items: FixtureLine[];
  subtotal: number;
  taxes: Record<string, number>;
  serviceChargePercent: number;
  discount: { discount_type: string | null; discount_value: number } | null;
  /** false = the table has no active orders at all. */
  hasOrders: boolean;
  /** true = a bill row exists even though every order behind it is gone. */
  hasBillRow: boolean;
  /** "Menu" rows: id, name, category, and the revenue group they resolve to. */
  menu: { id: string; name: string; category: string; group_id: string | null; group_name: string | null }[];
  unknownSql: string[];
} = {
  items: [], subtotal: 0, taxes: {}, serviceChargePercent: 0, discount: null,
  hasOrders: true, hasBillRow: false, menu: [], unknownSql: [],
};

function dispatch(q: string): unknown[] {
  // DDL and session statements from the lazy-column helpers: no-ops, the fixture
  // defines the schema.
  if (/^(alter|create|drop|do|grant|revoke|comment|begin|commit|rollback|set|truncate)\b/i.test(q)) { return []; }
  if (/^select now\(\) as now/i.test(q)) { return [{ now: new Date("2026-09-09T12:00:00Z") }]; }

  if (/from "Restaurant" r/.test(q)) {
    return [{
      res_id: RES, outlet_id: OUT, restaurant_slug: "zz", restaurant_name: "ZZ Fixture",
      restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
    }];
  }
  if (/select service_charge from "Restaurant"/i.test(q)) { return [{ service_charge: fixture.serviceChargePercent }]; }
  if (/select default_tax from "Outlets"/i.test(q)) { return [{ default_tax: fixture.taxes }]; }
  if (/from "Tables"/.test(q) && /num_covers/.test(q)) { return [{ id: "tbl-1", num_covers: 4 }]; }

  // The open bill: none has been generated, which is the normal state of a table
  // that is still ordering. GetBillForTable bills off the orders either way.
  if (/select discount_type, discount_value from "Bills"/i.test(q)) { return fixture.discount ? [fixture.discount] : []; }
  if (/from "Bills"/i.test(q)) {
    return fixture.hasBillRow
      ? [{ id: "bill-1", bill_no: "B1", coupon_code: null, payment_method: null, payment_proof_screenshot_url: null,
          created_at: new Date("2026-09-09T09:00:00Z"), waiter_confirmed_at: null, admin_approved_at: null, discount_applied_at: null }]
      : [];
  }

  const food = { subtotal: fixture.subtotal, total: fixture.subtotal, items: fixture.items };
  if (/select id, food, created_at from "Orders"/i.test(q)) {
    return fixture.hasOrders ? [{ id: "o1", food, created_at: new Date("2026-09-09T10:00:00Z") }] : [];
  }
  if (/select food, status from "Orders"/i.test(q)) { return fixture.hasOrders ? [{ food, status: 1 }] : []; }
  if (/select food from "Orders"/i.test(q)) { return fixture.hasOrders ? [{ food }] : []; }
  // getTargetApc's benchmark read: no history, so no APC suggestions are built.
  if (/o\.id as order_id/i.test(q)) { return []; }

  // GetMenuItems — the category axis's one menu read.
  if (/from "Menu" m/.test(q) && /sub_category/.test(q)) {
    return fixture.menu.map((m) => ({
      id: m.id, name: m.name,
      description: JSON.stringify({ price: 0 }),
      sub_category: m.category, main_category: m.category,
    }));
  }
  // GetMenuAttributionIndex — the group axes' read, with the group already
  // resolved by COALESCE(item override, category default).
  if (/from "Menu" m/.test(q) && /group_name/.test(q)) {
    return fixture.menu.map((m) => ({ id: m.id, name: m.name, group_id: m.group_id, group_name: m.group_name }));
  }
  if (/from "MenuVariations"/i.test(q)) { return []; }
  // C3's print count (billPrintHistoryForTable). Nothing has been printed on
  // this fixture, and nothing here depends on it — the money this suite asserts
  // on must be identical whether the bill has been on paper or not.
  if (/from "PrintJobs"/i.test(q)) { return [{ n: "0", first_at: null, last_at: null }]; }
  // Migration 055's latch (printed-bill fingerprints): modelled as applied, so
  // the print read above is asked with its paper columns and nothing else runs.
  if (/from information_schema\.columns/i.test(q) && /'PrintJobs'/.test(q)) { return [{ n: 4 }]; }
  // liveServiceChargeWaiver (migration 036), reached once a bill row exists: no
  // waiver is live on this fixture, so the charge stands.
  if (/waived_at/i.test(q)) { return []; }
  // The open seating the print bound reads (openSeatingStarts): the relation is
  // there and this table has no open row, so the bound is the orders'.
  if (/^select to_regclass\('public\."TableSessions"'\) is not null as present/i.test(q)) { return [{ present: true }]; }
  if (/from "TableSessions" s join "Tables" t/i.test(q)) { return []; }

  fixture.unknownSql.push(q);
  throw new Error(`section split fixture: unstubbed query — ${q.slice(0, 160)}`);
}

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(sql: unknown): Promise<{ rows: unknown[] }> {
      const q = String((sql as { text?: string } | string as { text?: string })?.text ?? sql).replace(/\s+/g, " ").trim();
      try { return Promise.resolve({ rows: dispatch(q) }); } catch (e) { return Promise.reject(e as Error); }
    }
    connect(): Promise<unknown> {
      return Promise.resolve({ query: (sql: unknown) => this.query(sql), release: () => undefined });
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

process.env.SUPABASE_DIRECT_URL = "postgres://fixture:fixture@localhost:5432/fixture";

const MENU = [
  { id: "m-paneer", name: "Paneer Tikka", category: "Starters", group_id: "g-food", group_name: "Food" },
  { id: "m-whisky", name: "Single Malt", category: "Bar", group_id: "g-liquor", group_name: "Liquor" },
  { id: "m-rice", name: "Steamed Rice", category: "Mains", group_id: null, group_name: null },
];

// 700 of starters + 300 of bar. With 10% service charge and 5% GST that is a
// 1,155 bill: 1,000 + 100 + 55.
const FOOD_AND_DRINK: FixtureLine[] = [
  { name: "Paneer Tikka", price: 350, quantity: 2, menu_id: "m-paneer" },
  { name: "Single Malt", price: 150, quantity: 2, menu_id: "m-whisky" },
];

type SplitFn = (res: string, table: string, axis: "category" | "revenue_group" | "production_group") => Promise<{
  axis: string; grand_total: number; payable_parts: number; notes: string[];
  parts: { key: string; label: string; gap: boolean; subtotal: number; discount: number; service_charge: number;
    taxes: { name: string; amount: number }[]; tax_total: number; round_off: number; grand_total: number; total: number;
    qty: number; nc_value: number; items: { name: string; price: number; quantity: number; nc?: true }[] }[];
}>;
let splitBySection: SplitFn;

beforeEach(async () => {
  const db = await import("../../database_supabase");
  splitBySection = db.SplitBillForTableBySection as unknown as SplitFn;
  fixture.items = FOOD_AND_DRINK;
  fixture.subtotal = 1000;
  fixture.taxes = { CGST: 2.5, SGST: 2.5 };
  fixture.serviceChargePercent = 10;
  fixture.discount = null;
  fixture.hasOrders = true;
  fixture.hasBillRow = false;
  fixture.menu = MENU;
  fixture.unknownSql = [];
});

describe("the category axis, end to end", () => {
  test("THE HEADLINE: starters and bar each get their own food, their own service charge and their own GST", async () => {
    const r = await splitBySection(RES, "T1", "category");

    expect(r.axis).toBe("category");
    expect(r.grand_total).toBe(1155);
    expect(r.parts.map((p) => p.label)).toEqual(["Starters", "Bar"]);

    const starters = r.parts[0]!;
    expect(starters.subtotal).toBe(700);
    expect(starters.service_charge).toBe(70);
    expect(starters.tax_total).toBe(38.5);
    expect(starters.taxes.map((t) => [t.name, t.amount])).toEqual([["CGST", 19.25], ["SGST", 19.25]]);
    // 808.50 before rounding; every slip asks for whole rupees (migration 048),
    // and the tied fifty paisa go to the heavier section.
    expect(starters.round_off).toBe(0.5);
    expect(starters.grand_total).toBe(809);
    expect(starters.total).toBe(809);
    expect(starters.qty).toBe(2);
    expect(starters.items).toEqual([{ name: "Paneer Tikka", price: 350, quantity: 2 }]);

    const bar = r.parts[1]!;
    expect(bar.subtotal).toBe(300);
    expect(bar.service_charge).toBe(30);
    expect(bar.tax_total).toBe(16.5);
    expect(bar.round_off).toBe(-0.5);
    expect(bar.grand_total).toBe(346);

    // And the whole point: they add back up to the bill.
    expect(starters.grand_total + bar.grand_total).toBe(1155);
    expect(r.payable_parts).toBe(2);
    expect(fixture.unknownSql).toEqual([]);
  });

  test("a line that matches no menu row is UNATTRIBUTED and carries its own money", async () => {
    fixture.items = [...FOOD_AND_DRINK, { name: "Valet fee", price: 100, quantity: 1 }];
    fixture.subtotal = 1100;

    const r = await splitBySection(RES, "T1", "category");
    const gap = r.parts.find((p) => p.gap)!;
    expect(gap.label).toBe("Unattributed");
    expect(gap.subtotal).toBe(100);
    expect(gap.grand_total).toBeGreaterThan(0);
    // It sorts last and it is not folded into a real section.
    expect(r.parts[r.parts.length - 1]!.label).toBe("Unattributed");
    expect(r.parts.map((p) => p.subtotal).reduce((s, x) => s + x, 0)).toBe(1100);
    // The till is told, in words, that some of this could not be classified.
    expect(r.notes.some((n) => n.includes("Unattributed"))).toBe(true);
  });

  test("A COMPED DISH IS LISTED UNDER ITS SECTION AND CHARGED TO NOBODY", async () => {
    fixture.items = [
      ...FOOD_AND_DRINK,
      { name: "Steamed Rice", price: 120, quantity: 1, menu_id: "m-rice", nc: true, nc_kind: "guest_complaint" },
    ];
    // The pre-tax base is unchanged: a non-chargeable contributes nothing to it.
    fixture.subtotal = 1000;

    const r = await splitBySection(RES, "T1", "category");
    expect(r.grand_total).toBe(1155);
    const mains = r.parts.find((p) => p.label === "Mains")!;
    expect(mains.grand_total).toBe(0);
    expect(mains.nc_value).toBe(120);
    expect(mains.items[0]!.nc).toBe(true);
    // Not counted as something anybody has to pay, and it does not distort the
    // sections that ARE being paid for.
    expect(r.payable_parts).toBe(2);
    expect(r.parts.find((p) => p.label === "Starters")!.grand_total).toBe(809);
  });

  test("a bill-level discount is apportioned across the sections, not dropped on one", async () => {
    fixture.discount = { discount_type: "percent", discount_value: 10 };

    const r = await splitBySection(RES, "T1", "category");
    // 1,000 less 10% = 900, +10% service = 990, +5% GST = 1,039.50 -> 1,040.
    expect(r.grand_total).toBe(1040);
    expect(r.parts.map((p) => p.discount)).toEqual([70, 30]);
    expect(r.parts.map((p) => p.subtotal)).toEqual([700, 300]);
    // 727.66 and 311.84 before rounding: the floors are two rupees short of the
    // bill, so both parts round up.
    expect(r.parts.map((p) => p.grand_total)).toEqual([728, 312]);
    expect(r.parts.map((p) => p.round_off)).toEqual([0.34, 0.16]);
    expect(r.parts[0]!.grand_total + r.parts[1]!.grand_total).toBe(1040);
  });

  test("A WEIGHED LINE IS WEIGHTED AT WHAT IT COSTS, not at the whole units the printed bill shows", async () => {
    // 2.5 kg at 200 is 500 — the printed bill rounds the quantity to 3 for
    // display, and splitting off THAT list would have charged this section 600's
    // worth of the bill.
    fixture.items = [
      { name: "Single Malt", price: 500, quantity: 1, menu_id: "m-whisky" },
      { name: "Paneer Tikka", price: 200, quantity: 2.5, menu_id: "m-paneer" },
    ];
    fixture.subtotal = 1000;
    fixture.taxes = {};
    fixture.serviceChargePercent = 0;

    const r = await splitBySection(RES, "T1", "category");
    expect(r.grand_total).toBe(1000);
    expect(r.parts.find((p) => p.label === "Starters")!.subtotal).toBe(500);
    expect(r.parts.find((p) => p.label === "Bar")!.subtotal).toBe(500);
    expect(r.parts.find((p) => p.label === "Starters")!.qty).toBe(2.5);
  });

  test("a three-way split of an odd bill still adds up to the paisa", async () => {
    fixture.items = [
      { name: "Paneer Tikka", price: 33.34, quantity: 1, menu_id: "m-paneer" },
      { name: "Single Malt", price: 33.34, quantity: 1, menu_id: "m-whisky" },
      { name: "Steamed Rice", price: 33.33, quantity: 1, menu_id: "m-rice" },
    ];
    fixture.subtotal = 100.01;

    const r = await splitBySection(RES, "T1", "category");
    const paisa = (n: number) => Math.round(n * 100);
    expect(r.parts.map((p) => p.grand_total).reduce((s, x) => s + paisa(x), 0)).toBe(paisa(r.grand_total));
  });
});

describe("the group axes, end to end", () => {
  test("food and liquor separate — the cut an accountant asks for first", async () => {
    const r = await splitBySection(RES, "T1", "revenue_group");
    expect(r.axis).toBe("revenue_group");
    expect(r.parts.map((p) => p.label)).toEqual(["Food", "Liquor"]);
    expect(r.parts.map((p) => p.key)).toEqual(["g-food", "g-liquor"]);
    expect(r.parts.map((p) => p.grand_total)).toEqual([809, 346]);
    expect(r.notes[0]).toContain("Group Summary");
  });

  test("a dish in no group is UNCLASSIFIED — a configuration gap, and the note says how to close it", async () => {
    fixture.items = [{ name: "Steamed Rice", price: 1000, quantity: 1, menu_id: "m-rice" }];

    const r = await splitBySection(RES, "T1", "revenue_group");
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.label).toBe("Unclassified");
    expect(r.parts[0]!.gap).toBe(true);
    // The whole bill is still there — a split that cannot classify anything must
    // still be a split of the whole bill.
    expect(r.parts[0]!.grand_total).toBe(1155);
    expect(r.notes.some((n) => n.includes("menu editor"))).toBe(true);
  });
});

describe("what it refuses", () => {
  test("a table with no open bill is refused, not answered with an empty split", async () => {
    fixture.hasOrders = false;
    await expect(splitBySection(RES, "T404", "category")).rejects.toThrow("No open bill for this table");
  });

  test("a generated bill with nothing on it yet comes back as ONE part, never as no parts", async () => {
    // A bill row exists (somebody pressed Generate) but every order behind it
    // has been voided since. There is nothing to classify and nothing to charge,
    // and the answer still has to be a split of the whole bill rather than an
    // empty list — an empty list is how a split loses a bill.
    fixture.hasOrders = false;
    fixture.hasBillRow = true;
    const r = await splitBySection(RES, "T7", "category");
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.label).toBe("Table T7");
    expect(r.parts[0]!.grand_total).toBe(0);
    expect(r.grand_total).toBe(0);
    expect(r.payable_parts).toBe(0);
  });
});
