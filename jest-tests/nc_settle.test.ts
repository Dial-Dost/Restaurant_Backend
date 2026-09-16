// SETTLE AS NC — the pure rules (nc_settle.ts), the NC marker in the payment
// modes (payment_methods.ts), the Bill Edit kinds (mis_report_math.ts) and the
// paper (escpos.ts). Decided by value, so proved without a pool.

import { describe, test, expect } from "@jest/globals";
import {
  NC_BILL_METHOD,
  NC_WHOLE_BILL_ONLY,
  applyBillNonChargeable,
  describeNcSettlement,
  isNcBillMethod,
  ncKindLabel,
  ncSettleRefusal,
  planBillNonChargeable,
  settlesAsNonChargeable,
  type NcSettleFacts,
} from "../nc_settle";
import {
  NC_SETTLE_LABEL,
  NC_SETTLE_METHOD,
  isNcSettleMethod,
  mergePaymentConfig,
  ncPaymentPointer,
  notMoneyKind,
  paymentMethodLabel,
  paymentMethodRefusal,
  planPaymentConfigSave,
  reservedReason,
  resolvePaymentMethod,
} from "../payment_methods";
import { classifyBillEdit, settlementByMethod } from "../mis_report_math";
import { chargeableSubtotal, computeBillCharges, nonChargeableValue } from "../billing_math";
import { buildReceiptBase64, type ReceiptOptions } from "../escpos";

const counter = (): (() => string) => { let n = 0; return () => `minted-${String(++n)}`; };

describe("planBillNonChargeable — what a bill NC comps", () => {
  test("every priced chargeable line, whole, at its own price; the pre-NC subtotal per order, rounded, then summed", () => {
    const plan = planBillNonChargeable([
      { id: "o1", items: [{ id: "a", name: "Paneer", price: 350, quantity: 1 }, { id: "b", name: "Jamun", price: 120, quantity: 2 }] },
      { id: "o2", items: [{ id: "c", name: "Chaas", price: 90.5, quantity: 1.5 }, { id: "d", name: "Tea", price: 33.333, quantity: 3 }] },
    ], counter());
    expect(plan.to_comp.map((p) => [p.order_id, p.index, p.item_id, p.quantity, p.unit_price, p.value])).toEqual([
      ["o1", 0, "a", 1, 350, 350],
      ["o1", 1, "b", 2, 120, 240],
      ["o2", 0, "c", 1.5, 90.5, 135.75],
      // The ledger's unit price is round2(line price), its value round2(qty x unit).
      ["o2", 1, "d", 3, 33.33, 99.99],
    ]);
    // The subtotal is what the orders STORE (round2 of the unrounded sum), which
    // is what the till quoted — a paisa away from Σ rows on the weighed line.
    expect(plan.chargeable_subtotal).toBe(590 + chargeableSubtotal([{ price: 90.5, quantity: 1.5 }, { price: 33.333, quantity: 3 }]));
    expect(plan.chargeable_subtotal).toBe(825.75);
    expect(plan.value_to_comp).toBe(825.74);
    expect(plan.line_count).toBe(4);
    expect(plan.already_comped).toBe(0);
  });

  test("already comped lines are left alone and counted as already given away", () => {
    const plan = planBillNonChargeable([{ id: "o1", items: [
      { id: "a", name: "Paneer", price: 350, quantity: 1, nc: true },
      { id: "b", name: "Jamun", price: 120, quantity: 2 },
    ] }], counter());
    expect(plan.to_comp.map((p) => p.item_id)).toEqual(["b"]);
    expect(plan.already_comped).toBe(350);
    expect(plan.chargeable_subtotal).toBe(240);
  });

  test("an id-less line and a line sharing a stored id get ids of their own; a free line is not comped", () => {
    const plan = planBillNonChargeable([{ id: "o1", items: [
      { id: "x", name: "Roti", price: 30, quantity: 2 },
      { id: "x", name: "Roti", price: 30, quantity: 1 },
      { name: "Water", price: 20, quantity: 1 },
      { id: "p", name: "Pickle", price: 0, quantity: 1 },
    ] }], counter());
    expect(plan.to_comp.map((p) => [p.index, p.item_id, p.minted_id])).toEqual([
      [0, "x", false], [1, "minted-1", true], [2, "minted-2", true],
    ]);
    expect(plan.chargeable_subtotal).toBe(110);
  });

  test("held-and-unfired lines and negative prices are reported for the refusals", () => {
    const plan = planBillNonChargeable([{ id: "o1", items: [
      { id: "a", name: "Soup", price: 200, quantity: 1, course_hold: true },
      { id: "b", name: "Main", price: 400, quantity: 1, course_hold: true, fired_at: "2026-09-16T10:00:00Z" },
      { id: "c", name: "Adjustment", price: -50, quantity: 1 },
    ] }], counter());
    expect(plan.held).toEqual([{ order_id: "o1", name: "Soup" }]);
    expect(plan.negative).toEqual([{ order_id: "o1", name: "Adjustment" }]);
  });
});

describe("ncSettleRefusal — the order is the control", () => {
  const ok: NcSettleFacts = {
    payment_pending: false, live_tender_count: 0, live_tender_total: 0,
    discount_value: 0, coupon_code: null, loyalty_redeemed: false,
    plan: { held: [], negative: [], line_count: 2, chargeable_subtotal: 725.75 },
    expected_value: 725.75,
  };
  const code = (over: Partial<NcSettleFacts>): string | null => ncSettleRefusal({ ...ok, ...over })?.code ?? null;

  test("nothing to refuse", () => { expect(ncSettleRefusal(ok)).toBeNull(); });

  test("each refusal, and the first one wins", () => {
    expect(code({ payment_pending: true, live_tender_count: 1, live_tender_total: 5 })).toBe("payment_pending");
    expect(code({ live_tender_count: 1, live_tender_total: 5, discount_value: 10 })).toBe("tenders_recorded");
    expect(code({ discount_value: 10, plan: { ...ok.plan, held: [{ order_id: "o", name: "Soup" }] } })).toBe("discount_on_bill");
    expect(code({ coupon_code: "  DIWALI " })).toBe("discount_on_bill");
    expect(code({ loyalty_redeemed: true })).toBe("discount_on_bill");
    expect(code({ plan: { ...ok.plan, held: [{ order_id: "o", name: "Soup" }], negative: [{ order_id: "o", name: "X" }] } })).toBe("held_lines");
    expect(code({ plan: { ...ok.plan, negative: [{ order_id: "o", name: "X" }], line_count: 0 } })).toBe("negative_lines");
    expect(code({ plan: { ...ok.plan, line_count: 0 }, expected_value: 1 })).toBe("nothing_to_settle");
    expect(code({ expected_value: 725.74 })).toBe("quote_moved");
    expect(code({ coupon_code: "   " })).toBeNull();
  });

  test("the quote is compared in whole paisa, and an absent quote is not checked", () => {
    expect(code({ expected_value: 725.745 })).toBeNull(); // rounds to 72575 paisa... 72574.5 -> 72575
    expect(code({ expected_value: 725.7549 })).toBeNull();
    expect(code({ expected_value: 725.76 })).toBe("quote_moved");
    expect(code({ expected_value: null })).toBeNull();
  });

  test("the statuses and the sentences a till reads", () => {
    expect(ncSettleRefusal({ ...ok, payment_pending: true })?.status).toBe(409);
    expect(ncSettleRefusal({ ...ok, expected_value: 1 })).toMatchObject({
      status: 400,
      error: "The bill changed while you were deciding: its food now comes to ₹725.75, not ₹1.00. Check it and settle again.",
    });
    expect(ncSettleRefusal({ ...ok, plan: { ...ok.plan, held: [{ order_id: "a", name: "Soup" }, { order_id: "b", name: "Soup" }] } })?.error)
      .toBe("Soup is on course hold and never went to the kitchen. Void or fire it before settling as non-chargeable.");
    expect(ncSettleRefusal({ ...ok, plan: { ...ok.plan, held: ["A", "B", "C", "D", "E"].map((name) => ({ order_id: "o", name })) } })?.error)
      .toBe("A, B, C and 2 more are on course hold and never went to the kitchen. Void or fire them before settling as non-chargeable.");
    expect(NC_WHOLE_BILL_ONLY).toBe("Settle as NC covers the whole bill. To give part of it away, comp dishes individually, then take the rest.");
  });
});

describe("applyBillNonChargeable — flags by position, and the split by the id it carried", () => {
  test("items get the flag and the (possibly minted) id; split lines only by a unique stored id", () => {
    const planned = planBillNonChargeable([{ id: "o1", items: [
      { id: "x", name: "Roti", price: 30, quantity: 2 },
      { name: "Water", price: 20, quantity: 1 },
    ] }], counter()).to_comp.map((p, i) => ({ ...p, nc_id: `nc-${String(i)}`, nc_kind: "staff_meal" }));
    const items = [{ id: "x", name: "Roti", price: 30, quantity: 2 }, { name: "Water", price: 20, quantity: 1 }];
    const split: [string, Record<string, unknown>[]][] = [["Mains", [{ id: "x", name: "Roti" }, { id: "minted-1", name: "Water" }]]];
    const next = applyBillNonChargeable(items, split, planned);
    expect(next.items).toEqual([
      { id: "x", name: "Roti", price: 30, quantity: 2, nc: true, nc_id: "nc-0", nc_kind: "staff_meal" },
      { id: "minted-1", name: "Water", price: 20, quantity: 1, nc: true, nc_id: "nc-1", nc_kind: "staff_meal" },
    ]);
    expect(next.split![0]![1]).toEqual([
      { id: "x", name: "Roti", nc: true, nc_id: "nc-0", nc_kind: "staff_meal" },
      { id: "minted-1", name: "Water" },
    ]);
    // Inputs untouched.
    expect(items[0]).toEqual({ id: "x", name: "Roti", price: 30, quantity: 2 });
    expect(chargeableSubtotal(next.items)).toBe(0);
    expect(nonChargeableValue(next.items)).toBe(80);
  });
});

describe("settlesAsNonChargeable — the ₹0 hardening (decision 6)", () => {
  test("zero to pay, nothing chargeable, something given away", () => {
    expect(settlesAsNonChargeable(0, [{ price: 100, quantity: 1, nc: true }])).toBe(true);
    expect(settlesAsNonChargeable(0, [{ price: 100, quantity: 1, nc: true }, { price: 0, quantity: 1 }])).toBe(true);
    expect(settlesAsNonChargeable(0.004, [{ price: 100, quantity: 1, nc: true }])).toBe(true);
  });
  test("anything else is not an NC bill", () => {
    expect(settlesAsNonChargeable(0.01, [{ price: 100, quantity: 1, nc: true }])).toBe(false);
    // A 100% discount: lines chargeable, total 0.
    expect(settlesAsNonChargeable(0, [{ price: 100, quantity: 1 }])).toBe(false);
    expect(settlesAsNonChargeable(0, [{ price: 100, quantity: 1, nc: true }, { price: 50, quantity: 1 }])).toBe(false);
    expect(settlesAsNonChargeable(0, [])).toBe(false);
    expect(settlesAsNonChargeable(0, [{ price: 0, quantity: 1, nc: true }])).toBe(false);
    // Only a real boolean flag counts (isNonChargeableLine's rule).
    expect(settlesAsNonChargeable(0, [{ price: 100, quantity: 1, nc: "true" }])).toBe(false);
  });
});

describe("describeNcSettlement / labels", () => {
  const row = (over: Partial<Parameters<typeof describeNcSettlement>[0][number]>) => ({
    nc_kind: "complimentary", authorised_by: "manager01", marked_by: "cashier1", reason: "Owner", value: 100, scope: "bill", ...over,
  });
  test("the bill-scope rows decide; item comps count towards the value", () => {
    expect(describeNcSettlement([
      row({ scope: "item", nc_kind: "guest_complaint", authorised_by: "other", value: 50 }),
      row({}), row({ value: 25.5 }),
    ])).toEqual({
      kind: "complimentary", kind_label: "Complimentary", authorised_by: "manager01", marked_by: "cashier1",
      reason: "Owner", lines: 3, value: 175.5,
    });
  });
  test("a hardened NC bill (item comps only) with mixed kinds", () => {
    expect(describeNcSettlement([
      row({ scope: "item", nc_kind: "staff_meal", authorised_by: "m1" }),
      row({ scope: null, nc_kind: "promo", authorised_by: "m2" }),
    ])).toMatchObject({ kind: "mixed", kind_label: "Several reasons", authorised_by: "m1, m2" });
    expect(describeNcSettlement([])).toBeNull();
  });
  test("kind labels are the comp sheets' words", () => {
    expect(["complimentary", "staff_meal", "spoilage", "tasting", "guest_complaint", "promo", "new_kind"].map(ncKindLabel))
      .toEqual(["Complimentary", "Staff meal", "Spoilage", "Tasting", "Guest complaint", "Promotion", "New kind"]);
  });
  test("the marker", () => {
    expect(NC_BILL_METHOD).toBe(NC_SETTLE_METHOD);
    expect([isNcBillMethod(" nc "), isNcBillMethod("NC"), isNcBillMethod("Upi"), isNcBillMethod(null)]).toEqual([true, true, false, false]);
    expect(isNcSettleMethod("Nc")).toBe(true);
  });
});

describe("the NC marker in the payment modes — shown, never paid with", () => {
  const cfg = mergePaymentConfig(null);
  test("every reader shows it as Non-chargeable (NC)", () => {
    expect(NC_SETTLE_LABEL).toBe("Non-chargeable (NC)");
    expect(paymentMethodLabel("NC", cfg)).toBe("Non-chargeable (NC)");
    expect(paymentMethodLabel("nc", cfg)).toBe("Non-chargeable (NC)");
    expect(paymentMethodLabel("Upi", cfg)).toBe("UPI");
  });
  test("it resolves to no mode, so no settle, split or tender can carry it", () => {
    for (const word of ["NC", "nc", "Complimentary", "Non Chargeable", "Staff Meal", "N/C"]) {
      expect(resolvePaymentMethod(word, cfg)).toBeNull();
      expect(paymentMethodRefusal(word, cfg)).toBe(ncPaymentPointer(word));
      expect(paymentMethodRefusal(word, cfg)).toMatch(/is not a way to pay — nothing is collected on a non-chargeable bill\. Use "Non-chargeable \(NC\)" when settling, or comp dishes individually and take the rest\.$/);
    }
    expect(ncPaymentPointer("Bitcoin")).toBeNull();
    expect(ncPaymentPointer("Credit")).toBeNull();
    expect(paymentMethodRefusal("Bitcoin", cfg)).toBe('"Bitcoin" is not a payment mode this restaurant settles with.');
  });
  test("an owner still cannot add it as a custom mode", () => {
    expect(notMoneyKind("NC")).toBe("comp");
    expect(reservedReason("NC")).toMatch(/can't be a payment mode/);
    const plan = planPaymentConfigSave([...cfg, { id: "NC", label: "NC", enabled: true, requires_screenshot: false, custom: true }], null);
    expect(plan.ok).toBe(false);
  });
  test("the cash-up puts an NC bill on its own 0.00 row", () => {
    const cut = settlementByMethod([
      { grand_total: 1050, refund: 0, payment_method: "Cash", splits: [] },
      { grand_total: 0, refund: 0, payment_method: "NC", splits: [] },
    ]);
    expect(cut.rows).toEqual([
      expect.objectContaining({ method: "Cash", bills: 1, amount: 1050 }),
      expect.objectContaining({ method: "NC", bills: 1, amount: 0, share_pct: 0 }),
    ]);
    expect(cut.total_amount).toBe(1050);
  });
});

describe("Bill Edit: the bill NC and its undoing are their own kinds", () => {
  const PERM_NC = "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472";
  test("scope 'bill' is read before reversal; an item comp is unchanged", () => {
    expect(classifyBillEdit(PERM_NC, "whatever", { scope: "bill", bill_id: "b1", table: "T2" }))
      .toMatchObject({ kind: "bill_non_chargeable", label: "Bill settled as non-chargeable", bill_id: "b1", table: "T2" });
    expect(classifyBillEdit(PERM_NC, "whatever", { scope: "bill", reversal: true }))
      .toMatchObject({ kind: "bill_non_chargeable_reversed", label: "Bill NC undone (re-opened)" });
    expect(classifyBillEdit(PERM_NC, "Made 1 x Jamun non-chargeable", { item: "Jamun" })?.kind).toBe("item_non_chargeable");
    expect(classifyBillEdit(PERM_NC, "Reversed", { reversal: true })?.kind).toBe("item_non_chargeable_reversed");
    // The prose is never read: a sentence that says "bill" is still an item comp.
    expect(classifyBillEdit(PERM_NC, "Settled bill as non-chargeable", {})?.kind).toBe("item_non_chargeable");
  });
});

// ============================================================================
// THE PAPER
// ============================================================================

const decode = (b64: string): string => Buffer.from(b64, "base64").toString("latin1");

/** Text lines of a bill, rasters stepped over by their header length. */
function textLines(b64: string): string[] {
  const bytes = Buffer.from(b64, "base64");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    if (b === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const w = bytes[i + 4]! | (bytes[i + 5]! << 8);
      const h = bytes[i + 6]! | (bytes[i + 7]! << 8);
      i += 8 + w * h;
      continue;
    }
    if (b === 0x1b) { i += bytes[i + 1] === 0x40 ? 2 : 3; continue; }
    if (b === 0x1d) { i += bytes[i + 1] === 0x56 ? 3 : 4; continue; }
    if (b === 0x0a) { out.push(cur); cur = ""; i++; continue; }
    cur += String.fromCharCode(b);
    i++;
  }
  if (cur) {out.push(cur);}
  return out;
}

function bill(over: Partial<ReceiptOptions> = {}): ReceiptOptions {
  return {
    restaurantName: "Gaia", table: "T7", covers: 2, currency: "₹", kind: "bill",
    items: [
      { name: "Paneer Tikka", price: 350, quantity: 1 },
      { name: "Gulab Jamun", price: 120, quantity: 2, nc: true },
    ],
    total: 350,
    taxes: [{ name: "SGST", percentage: 2.5, amount: 8.75 }, { name: "CGST", percentage: 2.5, amount: 8.75 }],
    grandTotal: 367.5,
    roundOff: 0,
    billNo: "4521",
    ...over,
  };
}

describe("an NC line on the bill: '(NC)' and 0.00, so the Amount column adds up to the Sub Total", () => {
  test("80mm and 58mm", () => {
    for (const width of [48, 32]) {
      const lines = textLines(buildReceiptBase64(bill(), width));
      // The name wraps inside the 58mm item column; the figures stay on its first line.
      expect(lines.join("\n")).toMatch(width === 48
        ? /\nGulab Jamun \(NC\)\s+2\s+120\.00\s+0\.00\n/
        : /\nGulab\s+2\s+120\.00\s+0\.00\nJamun \(NC\)\n/);
      const jamun = lines.find((l) => /\s2\s+120\.00\s+0\.00$/.test(l));
      const paneer = lines.find((l) => /\s1\s+350\.00\s+350\.00$/.test(l));
      expect(jamun).toBeDefined();
      expect(paneer).toBeDefined();
      // Σ Amount === Sub Total.
      const amounts = [paneer, jamun].map((l) => Number(/(\d+\.\d\d)$/.exec(l ?? "")?.[1]));
      expect(amounts.reduce((a, b) => a + b, 0)).toBe(350);
      expect(lines.some((l) => /Sub Total\s+350\.00$/.test(l))).toBe(true);
      // The given-away value, disclosed under the total and never inside it.
      const nc = lines.findIndex((l) => /NC value \(not charged\)\s+240\.00$/.test(l));
      const grand = lines.findIndex((l) => /Grand Total\s+Rs 367\.50$/.test(l));
      expect(nc).toBeGreaterThan(grand);
    }
  });

  test("a bill with no comped line prints exactly what it did before the flag", () => {
    const plain = bill({ items: [{ name: "Paneer Tikka", price: 350, quantity: 1 }] });
    const flagged = bill({ items: [{ name: "Paneer Tikka", price: 350, quantity: 1, nc: false }], settlement: null });
    expect(buildReceiptBase64(flagged)).toBe(buildReceiptBase64(plain));
    expect(decode(buildReceiptBase64(plain))).not.toContain("NC value");
    expect(decode(buildReceiptBase64(plain))).not.toContain("(NC)");
  });

  test("a line whose figures do not fit still prints 0.00 for an NC line", () => {
    const lines = textLines(buildReceiptBase64(bill({
      items: [{ name: "Tasting Menu", price: 150000, quantity: 1, nc: true }], total: 0, taxes: [], grandTotal: 0,
    }), 32));
    expect(lines.some((l) => l === "Tasting Menu (NC)")).toBe(true);
    expect(lines.some((l) => /1 x 150000\.00\s+0\.00$/.test(l))).toBe(true);
  });
});

describe("a bill SETTLED AS NC prints its settlement under a 0.00 total", () => {
  const settled = (over: Partial<ReceiptOptions> = {}) => bill({
    items: [{ name: "Thali", price: 400, quantity: 3, nc: true }, { name: "Lassi", price: 100, quantity: 2, nc: true }],
    total: 0, taxes: [], grandTotal: 0, roundOff: 0,
    settlement: { kind: "Complimentary", authorisedBy: "manager01", wouldHaveCharged: 1624 },
    ...over,
  });

  test("Grand Total 0.00, the NC value, and who said so", () => {
    const lines = textLines(buildReceiptBase64(settled()));
    const at = (re: RegExp): number => lines.findIndex((l) => re.test(l));
    const grand = at(/Grand Total\s+Rs 0\.00$/);
    expect(grand).toBeGreaterThan(-1);
    expect(at(/Sub Total\s+0\.00$/)).toBeGreaterThan(-1);
    expect(at(/NC value \(not charged\)\s+1400\.00$/)).toBeGreaterThan(grand);
    expect(at(/^Settled: Non-chargeable - Complimentary$/)).toBeGreaterThan(grand);
    expect(at(/^Authorised by: manager01$/)).toBeGreaterThan(at(/^Settled: Non-chargeable/));
    expect(at(/Would have been \(incl\. tax\)\s+1624\.00$/)).toBeGreaterThan(at(/^Authorised by/));
    // No tax line, no service charge line, no round off on a 0.00 bill.
    expect(lines.some((l) => /GST|Service Charge|Round off/.test(l))).toBe(false);
  });

  test("the settlement words are bold; the figure line is omitted when unknown", () => {
    const raw = decode(buildReceiptBase64(settled()));
    expect(raw).toContain("\x1bE\x01Settled: Non-chargeable - Complimentary\n\x1bE\x00");
    const noFigure = textLines(buildReceiptBase64(settled({ settlement: { kind: "Staff meal", authorisedBy: "m1", wouldHaveCharged: null } })));
    expect(noFigure.some((l) => l.includes("Would have been"))).toBe(false);
    expect(noFigure).toContain("Settled: Non-chargeable - Staff meal");
  });

  test("the settled bill's paper equals its drawer: the total printed is the total recorded", () => {
    const charges = computeBillCharges(0, [{ name: "SGST", percentage: 2.5 }], 10, true, null);
    expect(charges.grand_total).toBe(0);
    const lines = textLines(buildReceiptBase64(settled({ grandTotal: charges.grand_total, roundOff: charges.round_off })));
    expect(lines.some((l) => /Grand Total\s+Rs 0\.00$/.test(l))).toBe(true);
  });
});
