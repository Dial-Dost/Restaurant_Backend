// WHAT AN UNAUTHENTICATED GUEST IS TOLD ABOUT THEIR OWN BILL.
//
// GET /qr/:slug/bill answers anyone holding a table's QR token. It used to hand
// back GetBillForTable's entire result — an object built for the till — so the
// guest's browser received the kitchen note on every line (the QR menu's own
// placeholder asks for "allergies"), the restaurant's APC and its targets, the
// coaching sentences written for its managers, what the house had comped, and a
// set of internal ids.
//
// The projection is an ALLOWLIST, so the property worth pinning is not "these
// six fields are gone" — it is "ONLY the listed fields survive". A delete-list
// test passes forever while a newly added till-side field leaks; this one fails
// the moment one does, which is the point.
import { describe, test, expect } from "@jest/globals";
import { guestBillView } from "../guest_bill_view";

// A bill with every till-side field populated, so anything that leaks, leaks
// visibly. Cast because the real return type is enormous and this is a fixture
// for a projector, not for GetBillForTable.
const tillBill = {
  bill_id: "bill-77", table_id: "tbl-3", total_amt: 1180, subtotal: 1000,
  discount: 0, discount_type: null, discount_value: 0,
  service_charge: 50, service_charge_percent: 5, service_charge_waived: false,
  service_charge_waiver: null, taxes: [{ name: "GST", percentage: 5, amount: 50 }],
  tax_total: 50, grand_total: 1180, nc_total: 250, covers: 4, apc: 250,
  order_ids: ["o-1", "o-2"], order_notes: ["allergy: peanuts"],
  items: [
    { name: "Paneer Tikka", price: 250, quantity: 2, note: "allergy: peanuts", variation: "Half" },
    { name: "Gulab Jamun", price: 120, quantity: 1, nc: true as const, nc_kind: "staff_meal" },
  ],
  target_apc: 400, apc_status: "below",
  apc_suggestions: ["Push the tasting menu to raise APC by 12%"],
  payment_method: "Cash", payment_status: "Paid", screenshot_url: "https://x/y.png",
  bill_no: "INV-9", customer: "Rahul", coupon_code: null,
  bill_created_at: null, waiter_confirmed_at: null, admin_approved_at: null,
  discount_applied_at: null, first_order_at: null, last_order_at: null,
} as unknown as Parameters<typeof guestBillView>[0];

describe("guestBillView", () => {
  test("returns ONLY the allowlisted keys — a new till-side field must not leak", () => {
    expect(Object.keys(guestBillView(tillBill)).sort()).toEqual([
      "bill_no", "coupon_code", "covers", "discount", "grand_total", "items",
      "payment_method", "payment_status", "service_charge", "service_charge_percent",
      "subtotal", "tax_total", "taxes", "total_amt",
    ]);
  });

  test("the kitchen note never reaches the guest, on any line", () => {
    const view = guestBillView(tillBill);
    expect(JSON.stringify(view)).not.toContain("peanuts");
    for (const it of view.items) { expect(it).not.toHaveProperty("note"); }
  });

  test("the house's own numbers stay in the house", () => {
    const wire = JSON.stringify(guestBillView(tillBill));
    // APC, the target it is judged against, the coaching line, what was comped,
    // and the internal handles.
    for (const leak of ["apc", "target_apc", "apc_status", "tasting menu", "nc_total", "o-1", "bill-77", "tbl-3"]) {
      expect(wire).not.toContain(leak);
    }
  });

  test("what the guest is owed to see is all still there, unchanged", () => {
    const view = guestBillView(tillBill);
    expect(view.grand_total).toBe(1180);
    expect(view.subtotal).toBe(1000);
    expect(view.taxes).toEqual([{ name: "GST", percentage: 5, amount: 50 }]);
    expect(view.service_charge).toBe(50);
    expect(view.payment_status).toBe("Paid");
    // The dish, the price point they were actually sold, and the quantity.
    expect(view.items[0]).toEqual({ name: "Paneer Tikka", price: 250, quantity: 2, variation: "Half" });
  });

  test("a line with no variation carries no variation key, as before", () => {
    // Keeps the response byte-identical for every restaurant that has
    // configured no price points.
    expect(guestBillView(tillBill).items[1]).toEqual({ name: "Gulab Jamun", price: 120, quantity: 1 });
  });
});
