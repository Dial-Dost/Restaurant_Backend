import { describe, test, expect } from "@jest/globals";
import { buildReceiptBase64, buildKotBase64, groupKotItemsByStation, type ReceiptOptions } from "../escpos";

const decode = (b64: string) => Buffer.from(b64, "base64").toString("latin1");
const bytes = (b64: string) => Buffer.from(b64, "base64");

const baseBill: ReceiptOptions = {
  restaurantName: "Café Niçoise", // diacritics -> should be ASCII-folded
  address: "12 Main St",
  table: "5",
  covers: 2,
  customer: "Alice",
  billNo: "INV-1",
  cashier: "Bob",
  items: [{ name: "Tea — Earl Grey", quantity: 2, price: 50 }], // em-dash -> '-'
  total: 100, // gross subtotal
  currency: "₹",
  discount: { amount: 20, label: "Coupon SAVE20" },
  serviceCharge: { percent: 5, amount: 4 }, // 5% of discounted 80
  taxes: [{ name: "GST", percentage: 5, amount: 4.2 }], // 5% of 84
  kind: "bill",
};

describe("buildReceiptBase64 — bill", () => {
  test("returns valid base64 and ends with a cut command", () => {
    const b64 = buildReceiptBase64(baseBill);
    expect(typeof b64).toBe("string");
    const buf = bytes(b64);
    expect(buf.length).toBeGreaterThan(0);
    // GS V 0 (full cut) = 0x1d 0x56 0x00 near the end
    expect(buf.includes(Buffer.from([0x1d, 0x56, 0x00]))).toBe(true);
  });

  test("ASCII-folds non-Latin text and never emits control bytes from typography", () => {
    const out = decode(buildReceiptBase64(baseBill));
    expect(out).toContain("Cafe Nicoise"); // diacritics stripped
    expect(out).not.toContain("Café");
    expect(out).toContain("Tea - Earl Grey"); // em-dash folded to hyphen
    expect(out).not.toContain("—");
    // em-dash U+2014 truncated to latin1 would be byte 0x14 (DC4) — must NOT appear
    expect(bytes(buildReceiptBase64(baseBill)).includes(0x14)).toBe(false);
  });

  test("renders the full header + meta block", () => {
    const out = decode(buildReceiptBase64(baseBill));
    expect(out).toContain("Customer Name: Alice");
    expect(out).toContain("Bill No.: INV-1");
    expect(out).toContain("Cashier: Bob");
    expect(out).toContain("Dine In: 5");
  });

  test("totals: subtotal, discount, service charge, tax, and rounded grand total", () => {
    const out = decode(buildReceiptBase64(baseBill));
    // ₹ maps to the ASCII token "Rs"
    expect(out).toContain("Coupon SAVE20"); // discount label
    expect(out).toContain("Service Charge (5%)");
    expect(out).toContain("GST (5%)");
    // grand = 100 - 20 + 4 + 4.2 = 88.2 -> rounded 88
    expect(out).toContain("Grand Total:");
    expect(out).toContain("Rs 88.00");
    // round-off line shows the -0.20 correction
    expect(out).toContain("Round off");
  });

  test("service charge waiver prints 'Opted-out'", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, serviceCharge: { percent: 10, amount: 0, optedOut: true } }));
    expect(out).toContain("Service Charge (10%)");
    expect(out).toContain("Opted-out");
  });

  test("per-item note is printed under the item", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, items: [{ name: "Soup", quantity: 1, price: 30, note: "no salt" }] }));
    expect(out).toContain("no salt");
  });
});

describe("buildReceiptBase64 — KOT", () => {
  test("kitchen ticket has no prices/totals", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, kind: "kot" }));
    expect(out).toContain("KITCHEN ORDER");
    expect(out).toContain("2 x Tea - Earl Grey");
    expect(out).not.toContain("Grand Total");
    expect(out).not.toContain("Rs ");
  });
});

describe("buildKotBase64 — per-station split", () => {
  const mixed: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200, station: "Tandoor" },
      { name: "Cold Coffee", quantity: 1, price: 120, station: "Beverages" },
      { name: "Naan", quantity: 3, price: 40, station: "Tandoor" },
      { name: "Water", quantity: 1, price: 20 }, // no station -> General
    ],
  };

  test("groups items by station in first-seen order, unstationed -> General", () => {
    const groups = groupKotItemsByStation(mixed.items);
    expect(groups.map((g) => g.station)).toEqual(["Tandoor", "Beverages", "General"]);
    expect(groups[0].items.map((i) => i.name)).toEqual(["Paneer Tikka", "Naan"]);
    expect(groups[2].items.map((i) => i.name)).toEqual(["Water"]);
  });

  test("emits one cut-terminated ticket per station, each headed with its name", () => {
    const tickets = buildKotBase64(mixed);
    expect(tickets.map((t) => t.station)).toEqual(["Tandoor", "Beverages", "General"]);
    const tandoor = decode(tickets[0].escBase64);
    expect(tandoor).toContain("KITCHEN ORDER");
    expect(tandoor).toContain("[ TANDOOR ]");
    expect(tandoor).toContain("2 x Paneer Tikka");
    expect(tandoor).toContain("3 x Naan");
    // The Tandoor ticket must NOT carry the beverage item.
    expect(tandoor).not.toContain("Cold Coffee");
    // Each ticket ends with a full cut.
    expect(bytes(tickets[0].escBase64).includes(Buffer.from([0x1d, 0x56, 0x00]))).toBe(true);
    const bev = decode(tickets[1].escBase64);
    expect(bev).toContain("[ BEVERAGES ]");
    expect(bev).toContain("1 x Cold Coffee");
    expect(bev).not.toContain("Paneer Tikka");
  });

  test("no items -> a single General ticket (never zero tickets)", () => {
    const tickets = buildKotBase64({ ...baseBill, kind: "kot", items: [] });
    expect(tickets.length).toBe(1);
    expect(tickets[0].station).toBe("General");
  });
});

describe("buildReceiptBase64 — widths", () => {
  test("produces output for both 80mm (48) and 58mm (32) layouts", () => {
    expect(buildReceiptBase64(baseBill, 48).length).toBeGreaterThan(0);
    expect(buildReceiptBase64(baseBill, 32).length).toBeGreaterThan(0);
  });
});
