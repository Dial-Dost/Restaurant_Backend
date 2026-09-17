// bill_paper_digest.ts — WHAT A PRINTED BILL SAID, pinned without a database.
//
// Client items 1 and 2 (migration 055): a waiter may print a seating's bill
// again only when the paper in the guest's hand is out of date. That rests on
// one property — the fingerprint moves when, and only when, what the guest is
// asked to pay moves — and on two sides fingerprinting the same paper the same
// way (the print's merged items; the floor's raw order lines). Both are here.

import { describe, test, expect } from "@jest/globals";
import {
  UPDATED_BILL_MARKER,
  billLinesDigest,
  billPaperDigest,
  billPrintedClock,
  canonicalPaperLines,
  paperStale,
  printedAsName,
  replacesBillLine,
} from "../bill_paper_digest";
import { latestBillPaper } from "../bill_print_state";

const THALI = { name: "Thali", price: 525, quantity: 4 };
const LADDER = {
  subtotal: 2100, discount: 0, service_charge: 210, service_charge_percent: 10,
  taxes: [{ name: "CGST", percentage: 2.5, amount: 57.75 }, { name: "SGST", percentage: 2.5, amount: 57.75 }],
  round_off: 0.5, grand_total: 2426,
};
const paper = (over: Partial<Parameters<typeof billPaperDigest>[0]> = {}) =>
  billPaperDigest({ items: [THALI], charges: LADDER, customerGstin: null, ...over });

describe("the whole-paper fingerprint moves with the money, and only with the money", () => {
  test("stable: the same bill twice is the same fingerprint, and it is a sha256", () => {
    expect(paper()).toBe(paper());
    expect(paper()).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["a new dish", { items: [THALI, { name: "Gulab Jamun", price: 120, quantity: 1 }] }],
    ["one more of the same", { items: [{ ...THALI, quantity: 5 }] }],
    ["a changed price", { items: [{ ...THALI, price: 550 }] }],
    ["a comped line", { items: [{ ...THALI, quantity: 3 }, { ...THALI, quantity: 1, nc: true }] }],
    ["a variation", { items: [{ ...THALI, variation: "Half" }] }],
    ["a discount", { charges: { ...LADDER, discount: 100 } }],
    ["a waived service charge", { charges: { ...LADDER, service_charge: 0 } }],
    ["a tax amount", { charges: { ...LADDER, taxes: [{ name: "CGST", percentage: 2.5, amount: 60 }, LADDER.taxes[1]!] } }],
    ["a tax rate", { charges: { ...LADDER, taxes: [{ name: "CGST", percentage: 5, amount: 57.75 }, LADDER.taxes[1]!] } }],
    ["the round-off", { charges: { ...LADDER, round_off: -0.5 } }],
    ["the grand total", { charges: { ...LADDER, grand_total: 2427 } }],
    ["the customer's GSTIN", { customerGstin: "29ABCDE1234F1Z5" }],
    ["the customer's address (client item 7 prints it)", { customerAddress: "12 MG Road\nBengaluru 560001" }],
  ])("%s changes it", (_label, over) => {
    expect(paper(over as never)).not.toBe(paper());
  });

  test("what the paper does not charge for does not: time, cashier, bill number, notes, holds, menu ids", () => {
    const decorated = [{ ...THALI, note: "no onions", held_qty: 2, menu_id: "m-1", bill_no: "101", cashier: "Atsu", printed_at: "now" }];
    expect(paper({ items: decorated as never })).toBe(paper());
  });

  test("spelling and order do not: case, spaces, '425' vs 425, and line order", () => {
    const a = billPaperDigest({
      items: [{ name: "Thali", price: 525, quantity: 2 }, { name: "Lassi", price: 90, quantity: 1 }],
      charges: LADDER, customerGstin: "29abcde1234f1z5",
    });
    const b = billPaperDigest({
      items: [{ name: " lassi ", price: "90", quantity: "1" }, { name: "THALI", price: "525.00", quantity: 2 }],
      charges: { ...LADDER, taxes: [...LADDER.taxes].reverse(), subtotal: "2100" as never },
      customerGstin: " 29ABCDE1234F1Z5 ",
    });
    expect(b).toBe(a);
  });

  test("an address changes it by its lines, not by how they were typed; no address is the pre-address fingerprint", () => {
    const one = paper({ customerAddress: "12 MG Road\nBengaluru 560001" });
    expect(paper({ customerAddress: " 12 MG Road \r\n\r\n Bengaluru 560001 " })).toBe(one);
    expect(paper({ customerAddress: "12 MG Road\nBengaluru 560002" })).not.toBe(one);
    expect(paper({ customerAddress: "12 MG Road Bengaluru 560001" })).not.toBe(one);
    // Absent, null, empty and blank all read as the paper before the slot existed:
    // the fingerprint waiter-floor's module gave this bill before the merge.
    expect(paper()).toBe("7741b3376dfb054a2419bf51afb6d6b11265fa76e4f29fdcd30d7afbd372bd92");
    for (const none of [undefined, null, "", "  \n "]) { expect(paper({ customerAddress: none })).toBe(paper()); }
  });

  test("a percent with no charge beside it prints nothing, so it is not paper", () => {
    const off = { ...LADDER, service_charge: 0 };
    expect(paper({ charges: { ...off, service_charge_percent: 10 } })).toBe(paper({ charges: { ...off, service_charge_percent: 0 } }));
  });

  test("junk never throws — an unpriceable line is still a fingerprint", () => {
    expect(() => billPaperDigest({ items: null, charges: {} })).not.toThrow();
    expect(() => billPaperDigest({ items: [{ name: null, price: "abc", quantity: null }], charges: { taxes: null } })).not.toThrow();
  });
});

describe("the lines fingerprint: the print's merged items and the floor's raw lines agree", () => {
  test("two rounds of the same dish read as one line of two", () => {
    const raw = [{ name: "Thali", price: 525, quantity: 1 }, { name: "Thali", price: 525, quantity: 3 }];
    expect(billLinesDigest(raw)).toBe(billLinesDigest([THALI]));
    expect(canonicalPaperLines(raw)).toEqual([["thali", "", "525.00", 0, 4]]);
  });

  test("a comped line and a paid one of the same dish stay two lines, as the bill prints them", () => {
    const lines = canonicalPaperLines([{ ...THALI, quantity: 3 }, { ...THALI, quantity: 1, nc: true }]);
    expect(lines).toHaveLength(2);
    expect(billLinesDigest([{ ...THALI, quantity: 3 }, { ...THALI, quantity: 1, nc: true }])).not.toBe(billLinesDigest([THALI]));
  });

  test("a quantity reads as the bill reads it: whole, at least one", () => {
    expect(billLinesDigest([{ ...THALI, quantity: 0 }])).toBe(billLinesDigest([{ ...THALI, quantity: 1 }]));
    expect(billLinesDigest([{ ...THALI, quantity: 2.4 }])).toBe(billLinesDigest([{ ...THALI, quantity: 2 }]));
  });

  test("the lines fingerprint ignores the ladder (the floor cannot price it)", () => {
    expect(billLinesDigest([THALI])).toBe(billLinesDigest([THALI]));
    expect(billLinesDigest([THALI])).not.toBe(paper());
    expect(billLinesDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stale, and the words", () => {
  test("stale is tri-state: unknown on either side is null, never 'matches'", () => {
    expect(paperStale("a", "a")).toBe(false);
    expect(paperStale("a", "b")).toBe(true);
    for (const [now, then] of [[null, "a"], ["a", null], ["", "a"], ["a", undefined], [undefined, undefined]] as const) {
      expect(paperStale(now, then)).toBeNull();
    }
  });

  test("'printed as' only when the name on the paper is not the table's own", () => {
    expect(printedAsName("12", "20")).toBe("12");
    expect(printedAsName("12", "12")).toBeNull();
    expect(printedAsName("t1", "T1")).toBeNull();
    expect(printedAsName(null, "20")).toBeNull();
    expect(printedAsName("  ", "20")).toBeNull();
  });

  test("the banner and the line under it", () => {
    expect(UPDATED_BILL_MARKER).toBe("** UPDATED BILL **");
    expect(replacesBillLine("13:32")).toBe("Replaces the bill printed 13:32");
    expect(replacesBillLine("")).toBe("Replaces an earlier printed bill");
  });

  test("the replaced print's clock is the restaurant's, with the date only when it was another day", () => {
    const now = new Date("2026-09-16T12:00:00.000Z"); // 17:30 in Kolkata
    expect(billPrintedClock("2026-09-16T08:02:00.000Z", "Asia/Kolkata", now)).toBe("13:32");
    expect(billPrintedClock("2026-09-15T08:02:00.000Z", "Asia/Kolkata", now)).toBe("15/09 13:32");
    // 19:00Z on the 15th is 00:30 on the 16th in Kolkata: the same day there.
    expect(billPrintedClock("2026-09-15T19:00:00.000Z", "Asia/Kolkata", now)).toBe("00:30");
    expect(billPrintedClock("2026-09-16T08:02:00.000Z", "Not/AZone", now)).toBe("13:32");
    expect(billPrintedClock(null, "Asia/Kolkata", now)).toBe("");
    expect(billPrintedClock("garbage", "Asia/Kolkata", now)).toBe("");
  });
});

describe("latestBillPaper: the paper the guest is holding is the NEWEST counted print's", () => {
  const seating = { open_bill_id: "bill-12", table_name: "12", seating_start: "2026-09-16T07:58:00.000Z" };
  const job = (bill_id: string, created_at: string, over: Record<string, unknown> = {}) => ({
    bill_id, created_at, bill_digest: `d-${created_at}`, lines_digest: `l-${created_at}`, bill_grand_total: "2100.00", table_name: "12", ...over,
  });

  test("the newest of this seating's prints, bill-id or fallback-addressed, with its total as a number", () => {
    const out = latestBillPaper([
      job("bill-12", "2026-09-16T08:02:00.000Z"),
      job("12-1789545774907", "2026-09-16T08:40:00.000Z", { bill_grand_total: "2220.00" }),
    ], seating);
    expect(out).toEqual({ bill_digest: "d-2026-09-16T08:40:00.000Z", lines_digest: "l-2026-09-16T08:40:00.000Z", bill_grand_total: 2220, table_name: "12" });
  });

  test("another table's print, or the previous party's, is never 'the paper'", () => {
    expect(latestBillPaper([job("12 #2-1", "2026-09-16T09:00:00.000Z"), job("12-1", "2026-09-16T07:00:00.000Z")], seating)).toBeNull();
    expect(latestBillPaper([], seating)).toBeNull();
    expect(latestBillPaper(null, seating)).toBeNull();
  });

  test("a newest print whose content was not recorded is UNKNOWN — an older recorded one does not stand in for it", () => {
    const out = latestBillPaper([
      job("bill-12", "2026-09-16T08:02:00.000Z"),
      job("bill-12", "2026-09-16T08:40:00.000Z", { bill_digest: null, lines_digest: null, bill_grand_total: null, table_name: null }),
    ], seating);
    expect(out).toEqual({ bill_digest: null, lines_digest: null, bill_grand_total: null, table_name: null });
  });

  test("rows read without 055's columns (a pre-055 database) are all unknown", () => {
    expect(latestBillPaper([{ bill_id: "bill-12", created_at: "2026-09-16T08:02:00.000Z" }], seating))
      .toEqual({ bill_digest: null, lines_digest: null, bill_grand_total: null, table_name: null });
  });
});
