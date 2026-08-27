// The QUEUE PRE-ORDER MENU rules (queue_menu.ts): which dishes a walk-in still
// standing in the waitlist may pick, and how that list presents itself.
//
// WHY THIS SUITE EXISTS — two invariants that a live tenant depends on:
//
//  1. ABSENT = TODAY. Every restaurant on production has a NULL config. If the
//     resolver's defaults drift by one field, every queue page in the estate
//     changes overnight without anyone asking for it. The first describe block
//     pins the shipped behaviour bit-for-bit against an absent config.
//
//  2. THE GATE IS ONE FUNCTION. isQueueMenuItemAllowed decides both what the
//     guest endpoint SHOWS and what the pre-order write ACCEPTS. If those two
//     ever disagree, a dish the kitchen removed from the queue menu becomes
//     orderable by anyone who kept the old page open — which is the exact hole
//     client-side filtering would leave.
//
// Pure module: no pg, no fixture harness, no mock. Same shape as
// brand_theme.test.ts.

import { describe, test, expect } from "@jest/globals";
import {
  buildQueueMenu,
  isQueueMenuConfigured,
  isQueueMenuItemAllowed,
  orderQueueMenuCategories,
  queueMenuClearKeys,
  resolveQueueMenuConfig,
  sanitizeQueueMenuConfigInput,
  QUEUE_MENU_HEADLINE_MAX,
  QUEUE_MENU_INTRO_MAX,
  type QueueMenuItemLike,
} from "../queue_menu";

const item = (id: string, name: string, category: string, available = true): QueueMenuItemLike =>
  ({ id, name, category, available });

/** A small menu spanning three categories, in GetMenuItems' order (newest first). */
const MENU: QueueMenuItemLike[] = [
  item("m-biryani", "Dum Biryani", "Mains"),
  item("m-paneer", "Paneer Tikka", "Starters"),
  item("m-papad", "Masala Papad", "Starters"),
  item("m-lassi", "Sweet Lassi", "Drinks"),
];

// ---------------------------------------------------------------------------
describe("ABSENT config resolves to exactly the behaviour that shipped", () => {
  test("null / undefined / garbage all resolve to the same shipped defaults", () => {
    const shipped = { mode: "all", items: [], categories: [], category_order: [], headline: "", intro: "", show_prices: true };
    for (const stored of [null, undefined, {}, "not an object", 42, []]) {
      expect(resolveQueueMenuConfig(stored)).toEqual(shipped);
    }
  });

  test("the whole menu comes through, categories alphabetical — the queue page's own order", () => {
    const cfg = resolveQueueMenuConfig(null);
    const built = buildQueueMenu(cfg, MENU);
    // Every item, in the menu's own order: nothing is reordered or dropped.
    expect(built.items).toEqual(MENU);
    // Object.keys(byCategory).sort() is what the queue page did before this
    // feature existed; an empty category_order must reproduce it exactly.
    expect(built.categories).toEqual(["Drinks", "Mains", "Starters"]);
  });

  test("a tenant that never touched it does not read as configured", () => {
    expect(isQueueMenuConfigured(null)).toBe(false);
    expect(isQueueMenuConfigured({})).toBe(false);
    // ...but one that set a single knob does — the page needs to tell "no menu
    // loaded" (apologise) apart from "nothing offered on purpose" (say nothing).
    expect(isQueueMenuConfigured({ mode: "exclude", items: ["m-biryani"] })).toBe(true);
    expect(isQueueMenuConfigured({ show_prices: false })).toBe(true);
  });

  test("an absent config still refuses a SOLD-OUT dish", () => {
    // The queue page always filtered `available === false` client-side; the gate
    // has to agree, or an API caller could pre-order an 86'd dish.
    const cfg = resolveQueueMenuConfig(null);
    expect(isQueueMenuItemAllowed(cfg, item("m-x", "Sold Out", "Mains", false))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the selection rule (mode + items + categories, unioned)", () => {
  test('exclude: the kitchen keeps ONE slow dish off the queue menu', () => {
    const cfg = resolveQueueMenuConfig({ mode: "exclude", items: ["m-biryani"] });
    expect(isQueueMenuItemAllowed(cfg, MENU[0]!)).toBe(false); // the biryani
    expect(isQueueMenuItemAllowed(cfg, MENU[1]!)).toBe(true);
    const built = buildQueueMenu(cfg, MENU);
    expect(built.items.map((i) => i.id)).toEqual(["m-paneer", "m-papad", "m-lassi"]);
    // Mains had exactly one item, so the category disappears with it — the page
    // must not render an empty tab.
    expect(built.categories).toEqual(["Drinks", "Starters"]);
  });

  test("exclude by CATEGORY takes the whole section out", () => {
    const cfg = resolveQueueMenuConfig({ mode: "exclude", categories: ["Starters"] });
    expect(buildQueueMenu(cfg, MENU).items.map((i) => i.id)).toEqual(["m-biryani", "m-lassi"]);
  });

  test("include: an allowlist — only what the owner ticked", () => {
    const cfg = resolveQueueMenuConfig({ mode: "include", categories: ["Drinks"], items: ["m-papad"] });
    // The union: the whole Drinks category PLUS the one item named directly.
    expect(buildQueueMenu(cfg, MENU).items.map((i) => i.id)).toEqual(["m-papad", "m-lassi"]);
  });

  test("include with EMPTY lists offers nothing — and that is not the same as no config", () => {
    // A deliberate "no pre-orders from the queue today". The page uses
    // `configured` to stay silent instead of apologising for a missing menu.
    const stored = { mode: "include", items: [], categories: [] };
    expect(buildQueueMenu(resolveQueueMenuConfig(stored), MENU).items).toEqual([]);
    expect(isQueueMenuConfigured(stored)).toBe(true);
  });

  test("names and ids match case-insensitively — an owner types 'starters', the menu says 'Starters'", () => {
    const cfg = resolveQueueMenuConfig({ mode: "exclude", categories: ["  STARTERS "] });
    expect(buildQueueMenu(cfg, MENU).items.map((i) => i.id)).toEqual(["m-biryani", "m-lassi"]);
  });

  test("a sold-out dish is refused whatever the mode says", () => {
    const sold = item("m-sold", "Sold Out", "Drinks", false);
    for (const stored of [{ mode: "all" }, { mode: "include", items: ["m-sold"] }, { mode: "exclude" }]) {
      expect(isQueueMenuItemAllowed(resolveQueueMenuConfig(stored), sold)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("category order", () => {
  const cats = ["Drinks", "Mains", "Starters"];

  test("no order set = alphabetical (unchanged)", () => {
    expect(orderQueueMenuCategories(resolveQueueMenuConfig(null), cats)).toEqual(["Drinks", "Mains", "Starters"]);
  });

  test("pinned categories lead, in the owner's order; the rest stay alphabetical", () => {
    const cfg = resolveQueueMenuConfig({ category_order: ["Starters", "Drinks"] });
    expect(orderQueueMenuCategories(cfg, cats)).toEqual(["Starters", "Drinks", "Mains"]);
  });

  test("a pinned name that no longer exists is ignored, not rendered as an empty tab", () => {
    // The owner arranged the order, then renamed/deleted "Desserts". The queue
    // menu degrades to the remaining order rather than showing a dead category.
    const cfg = resolveQueueMenuConfig({ category_order: ["Desserts", "Mains"] });
    expect(orderQueueMenuCategories(cfg, cats)).toEqual(["Mains", "Drinks", "Starters"]);
  });

  test("buildQueueMenu applies the order to the categories it derived", () => {
    const cfg = resolveQueueMenuConfig({ category_order: ["Mains"] });
    expect(buildQueueMenu(cfg, MENU).categories).toEqual(["Mains", "Drinks", "Starters"]);
  });
});

// ---------------------------------------------------------------------------
describe("presentation knobs", () => {
  test("headline and intro are trimmed, collapsed and capped", () => {
    const c = sanitizeQueueMenuConfigInput({
      headline: "   Order   while   you   wait  ",
      intro: "x".repeat(QUEUE_MENU_INTRO_MAX + 50),
    });
    expect(c.headline).toBe("Order while you wait");
    expect(c.intro).toHaveLength(QUEUE_MENU_INTRO_MAX);
    expect(sanitizeQueueMenuConfigInput({ headline: "y".repeat(200) }).headline).toHaveLength(QUEUE_MENU_HEADLINE_MAX);
  });

  test("a blank headline is NOT stored as an empty string", () => {
    // "" would render as a blank heading. Absent means "use the page's own
    // localised copy", which is the only sensible fallback on an EN/HI page.
    expect(sanitizeQueueMenuConfigInput({ headline: "   " }).headline).toBeUndefined();
    expect(resolveQueueMenuConfig({ headline: "   " }).headline).toBe("");
    // ...and typing it back to blank is a CLEAR, so custom copy can be removed.
    expect(queueMenuClearKeys({ headline: "  " })).toEqual(["headline"]);
  });

  test("show_prices defaults to on and only a real boolean turns it off", () => {
    expect(resolveQueueMenuConfig({}).show_prices).toBe(true);
    expect(resolveQueueMenuConfig({ show_prices: false }).show_prices).toBe(false);
    // "false" the string is a client bug, not an instruction — ignored, so the
    // tenant keeps the default rather than silently losing their prices.
    expect(resolveQueueMenuConfig({ show_prices: "false" }).show_prices).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the write sanitizer (only valid, PROVIDED keys survive)", () => {
  test("an unknown mode, a non-array list and a stray key are all dropped", () => {
    expect(sanitizeQueueMenuConfigInput({
      mode: "everything",
      items: "m-biryani",
      categories: { a: 1 },
      colour: "#fff",
    })).toEqual({});
  });

  test("lists are trimmed, de-duplicated and blank rows dropped", () => {
    expect(sanitizeQueueMenuConfigInput({ items: [" m-a ", "m-a", "M-A", "", "   ", "m-b"] }).items)
      .toEqual(["m-a", "m-b"]);
  });

  test("omitted keys stay omitted, so the storage layer can merge-on-omit", () => {
    // The Flutter editor saves only the tab the owner touched; a key it never
    // sends must not be reset to a default by the round trip.
    expect(sanitizeQueueMenuConfigInput({ show_prices: false })).toEqual({ show_prices: false });
  });

  test("null means CLEAR — the only way back to a shipped default", () => {
    expect(queueMenuClearKeys({ mode: null, items: null, show_prices: null })).toEqual(["mode", "items", "show_prices"]);
    // A key that is merely absent is not a clear, and neither is a stray one.
    expect(queueMenuClearKeys({ show_prices: false, nonsense: null })).toEqual([]);
  });
});
