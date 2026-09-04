// THE CLASSIFICATION RULES OF THE SIX DATA-CAPTURE MIGRATIONS (034-039).
//
// The money half is proved in test/money/mis_capture_money.test.ts. This file
// proves the two rules that are decided by CLASSIFICATION rather than by
// arithmetic, and both of them are load-bearing for a different reason:
//
//   THE VOID STAGE (035) is a FRAUD SIGNAL, so it must be derived from facts the
//   server holds and it must land on the furthest point the order actually
//   reached — never on the first fact that happens to be checked.
//
//   MENU ATTRIBUTION (039) has to make order lines reportable by group and
//   variation WITHOUT changing what any existing order reports. An order written
//   before these migrations existed must come back with the same money, the same
//   items and an honest "Unclassified" — never a guess.

import { describe, test, expect } from "@jest/globals";
import {
  deriveVoidStage,
  buildMenuAttributionIndex,
  attributeOrderLine,
  normalizeVocabulary,
  normalizeReason,
  UNCLASSIFIED_GROUP,
  NON_CHARGEABLE_KINDS,
  VOID_KINDS,
  TIP_MODES,
  type MenuAttributionRow,
} from "../mis_capture";

// ============================================================================
// 035 — THE VOID STAGE
// ============================================================================

const BILL = { id: "b-1", bill_no: "42", created_at: "2026-09-02T12:30:00.000Z" };
const KOT = { id: "p-1", created_at: "2026-09-02T12:10:00.000Z" };
const BARKED = "2026-09-02T12:05:00.000Z";

describe("035 void stage: derived from server-held facts, at each of the three stages", () => {
  test("before_print — nothing was barked, nothing printed, no bill exists", () => {
    const d = deriveVoidStage({ bill: null, barked_at: null, kot_print: null });
    expect(d.stage).toBe("before_print");
    // An EMPTY evidence object is the honest answer: it says "no fact was found",
    // not "three checks were run and all returned false".
    expect(d.evidence).toEqual({});
  });

  test("after_print — the expo barked it to the kitchen", () => {
    const d = deriveVoidStage({ bill: null, barked_at: BARKED, kot_print: null });
    expect(d.stage).toBe("after_print");
    expect(d.evidence).toEqual({ barked_at: BARKED });
  });

  test("after_print — a KOT print job exists even when the floor never barks", () => {
    const d = deriveVoidStage({ bill: null, barked_at: null, kot_print: KOT });
    expect(d.stage).toBe("after_print");
    expect(d.evidence).toEqual({ kot_print_job_id: KOT.id, kot_printed_at: KOT.created_at });
  });

  test("after_bill — a bill existed, and it carries its own evidence", () => {
    const d = deriveVoidStage({ bill: BILL, barked_at: null, kot_print: null });
    expect(d.stage).toBe("after_bill");
    expect(d.evidence).toEqual({
      bill_id: BILL.id, bill_no: BILL.bill_no, bill_created_at: BILL.created_at,
    });
  });

  test("THE PRIORITY: the furthest point reached wins, not the first fact found", () => {
    // A real after_bill void is ALSO barked and ALSO printed. Reporting it as
    // after_print because the bark was checked first would hide the one stage an
    // auditor actually looks for.
    const d = deriveVoidStage({ bill: BILL, barked_at: BARKED, kot_print: KOT });
    expect(d.stage).toBe("after_bill");
    // ...and every fact is still recorded, so the classification is re-checkable.
    expect(d.evidence).toEqual({
      bill_id: BILL.id,
      bill_no: BILL.bill_no,
      bill_created_at: BILL.created_at,
      barked_at: BARKED,
      kot_print_job_id: KOT.id,
      kot_printed_at: KOT.created_at,
    });
  });

  test("a bill with no number still lands on after_bill and omits the key", () => {
    const d = deriveVoidStage({ bill: { ...BILL, bill_no: null }, barked_at: null, kot_print: null });
    expect(d.stage).toBe("after_bill");
    expect(d.evidence).not.toHaveProperty("bill_no");
    expect(d.evidence).toHaveProperty("bill_id");
  });

  test("a blank barked_at is not evidence of a bark", () => {
    for (const blank of ["", "   ", null, undefined]) {
      const d = deriveVoidStage({ bill: null, barked_at: blank, kot_print: null });
      expect(d.stage).toBe("before_print");
      expect(d.evidence).toEqual({});
    }
  });

  test("the derivation never returns null — before_print is the floor", () => {
    expect(deriveVoidStage({}).stage).toBe("before_print");
  });
});

// ============================================================================
// 039 — MENU ATTRIBUTION, AND THE OLD ROWS IT MUST NOT DISTURB
// ============================================================================

const MENU: MenuAttributionRow[] = [
  {
    id: "m-paneer", name: "Paneer Tikka", group_id: "g-food", group_name: "Food",
    variations: [
      { id: "v-half", name: "Half", price: 250 },
      { id: "v-full", name: "Full", price: 390 },
    ],
  },
  { id: "m-lime", name: "Fresh Lime Soda", group_id: "g-bev", group_name: "Beverage", variations: [] },
  // A dish nobody has classified yet — the state every menu is in on day one.
  { id: "m-rice", name: "Steamed Rice", group_id: null, group_name: null, variations: [] },
  { id: "m-mocktail", name: "Virgin Mojito", group_id: "g-bev", group_name: "Beverage" },
];
const INDEX = buildMenuAttributionIndex(MENU);

describe("039 attribution: lines written SINCE the migration", () => {
  test("a stamped menu_id attributes to its group", () => {
    const a = attributeOrderLine({ id: "line-1", name: "Paneer Tikka", menu_id: "m-paneer" }, INDEX);
    expect(a.source).toBe("stamped");
    expect(a.menu_id).toBe("m-paneer");
    expect(a.group_name).toBe("Food");
    expect(a.variation_id).toBeNull();
  });

  test("a stamped variation attributes to the variation AND the group", () => {
    const a = attributeOrderLine(
      { id: "line-2", name: "Paneer Tikka", menu_id: "m-paneer", variation_id: "v-half" }, INDEX,
    );
    expect(a.variation_id).toBe("v-half");
    expect(a.variation_name).toBe("Half");
    expect(a.group_name).toBe("Food");
  });

  test("a variation belonging to a DIFFERENT dish is ignored, not honoured", () => {
    // A cross-item variation id is a client bug. Honouring it would move a sale
    // between menu rows — and, on the write side, would let a ₹390 dish take a
    // different dish's cheaper variation price through the floor.
    const a = attributeOrderLine(
      { id: "line-3", name: "Fresh Lime Soda", menu_id: "m-lime", variation_id: "v-half" }, INDEX,
    );
    expect(a.menu_id).toBe("m-lime");
    expect(a.variation_id).toBeNull();
    expect(a.group_name).toBe("Beverage");
  });

  test("the LIVE variation label wins over the snapshot on the line", () => {
    // A renamed variation is the same price point; showing two names for it would
    // split one bucket in two on every report.
    const a = attributeOrderLine(
      { name: "Paneer Tikka", menu_id: "m-paneer", variation_id: "v-full", variation_name: "Regular" }, INDEX,
    );
    expect(a.variation_name).toBe("Full");
  });
});

describe("039 attribution: EVERY EXISTING ORDER KEEPS WORKING", () => {
  test("a pre-039 line whose id happens to be the menu id still resolves", () => {
    const a = attributeOrderLine({ id: "m-paneer", name: "Paneer Tikka" }, INDEX);
    expect(a.source).toBe("legacy_id");
    expect(a.menu_id).toBe("m-paneer");
    expect(a.group_name).toBe("Food");
  });

  test("a pre-039 line with a re-minted uuid resolves BY NAME", () => {
    // AddOrder mints a fresh uuid for every added quantity, which is exactly what
    // destroys the id link. The name is the only route left, and it is the same
    // lookup applyMenuPriceFloor already trusts to enforce a price floor.
    const a = attributeOrderLine({ id: "3f1a-not-a-menu-id", name: "Fresh Lime Soda" }, INDEX);
    expect(a.source).toBe("legacy_name");
    expect(a.menu_id).toBe("m-lime");
    expect(a.group_name).toBe("Beverage");
  });

  test("name matching is case- and whitespace-insensitive, like the price floor", () => {
    const a = attributeOrderLine({ id: "x", name: "  fresh lime SODA  " }, INDEX);
    expect(a.menu_id).toBe("m-lime");
  });

  test("A PRE-039 LINE NEVER GAINS A VARIATION", () => {
    // "Paneer Tikka (Half)" typed as an off-menu line is not evidence that a Half
    // variation was sold, and inferring one would invent a sale that never
    // happened against a price point that may not have existed.
    const a = attributeOrderLine({ id: "x", name: "Paneer Tikka" }, INDEX);
    expect(a.variation_id).toBeNull();
    expect(a.variation_name).toBeNull();
    const b = attributeOrderLine({ id: "x", name: "Paneer Tikka (Half)" }, INDEX);
    expect(b.source).toBe("unresolved");
    expect(b.menu_id).toBeNull();
  });

  test("an unclassified dish reports Unclassified — never a nearest match", () => {
    const a = attributeOrderLine({ id: "x", name: "Steamed Rice" }, INDEX);
    expect(a.menu_id).toBe("m-rice");
    expect(a.group_id).toBeNull();
    expect(a.group_name).toBe(UNCLASSIFIED_GROUP);
  });

  test("an off-menu line (valet fee, aggregator charge, open item) is Unclassified", () => {
    for (const name of ["Valet Fee", "Zomato packaging", "Open item", ""]) {
      const a = attributeOrderLine({ id: "x", name }, INDEX);
      expect(a.source).toBe("unresolved");
      expect(a.menu_id).toBeNull();
      expect(a.group_name).toBe(UNCLASSIFIED_GROUP);
      expect(a.variation_id).toBeNull();
    }
  });

  test("a null/garbage line does not throw — a control report must still open", () => {
    for (const bad of [null, undefined, {}, { name: 42 as unknown as string }]) {
      const a = attributeOrderLine(bad as never, INDEX);
      expect(a.group_name).toBe(UNCLASSIFIED_GROUP);
      expect(a.source).toBe("unresolved");
    }
  });

  test("an index built from a pre-039 menu (no groups, no variations) still resolves items", () => {
    // The degradation path: migration 039 unapplied, so GetMenuAttributionIndex
    // falls back to the plain menu. Every line still finds its dish; every group
    // is honestly Unclassified.
    const bare = buildMenuAttributionIndex(
      MENU.map((m) => ({ id: m.id, name: m.name, group_id: null, group_name: null })),
    );
    const a = attributeOrderLine({ id: "x", name: "Paneer Tikka", menu_id: "m-paneer" }, bare);
    expect(a.menu_id).toBe("m-paneer");
    expect(a.group_name).toBe(UNCLASSIFIED_GROUP);
    expect(a.variation_id).toBeNull();
  });

  test("duplicate names resolve deterministically to the first row", () => {
    const dup = buildMenuAttributionIndex([
      { id: "m-1", name: "Masala Chai", group_id: "g-bev", group_name: "Beverage" },
      { id: "m-2", name: "Masala Chai", group_id: "g-food", group_name: "Food" },
    ]);
    expect(attributeOrderLine({ id: "x", name: "Masala Chai" }, dup).menu_id).toBe("m-1");
    // The stamped id is unambiguous and is still honoured over the name.
    expect(attributeOrderLine({ id: "x", name: "Masala Chai", menu_id: "m-2" }, dup).menu_id).toBe("m-2");
  });
});

// ============================================================================
// THE CONTROLLED VOCABULARIES
// ============================================================================

describe("vocabularies: a bad value is REFUSED, never defaulted", () => {
  test("a typo returns null rather than the first legal value", () => {
    // A giveaway recorded as "complimentary" because the client sent a typo is a
    // fabricated reason in a fraud-control document.
    expect(normalizeVocabulary("complimentry", NON_CHARGEABLE_KINDS)).toBeNull();
    expect(normalizeVocabulary("", NON_CHARGEABLE_KINDS)).toBeNull();
    expect(normalizeVocabulary(null, VOID_KINDS)).toBeNull();
    expect(normalizeVocabulary(7, TIP_MODES)).toBeNull();
  });

  test("case, spaces and hyphens are normalised — a UI label is still accepted", () => {
    expect(normalizeVocabulary("Staff Meal", NON_CHARGEABLE_KINDS)).toBe("staff_meal");
    expect(normalizeVocabulary("guest-changed-mind", VOID_KINDS)).toBe("guest_changed_mind");
    expect(normalizeVocabulary("  UPI ", TIP_MODES)).toBe("upi");
  });

  test("a reason must actually say something", () => {
    expect(normalizeReason("   ")).toBeNull();
    expect(normalizeReason("")).toBeNull();
    expect(normalizeReason(null)).toBeNull();
    expect(normalizeReason("  chef   sent   it   out  ")).toBe("chef sent it out");
    expect(normalizeReason("x".repeat(500))?.length).toBe(300);
  });
});
