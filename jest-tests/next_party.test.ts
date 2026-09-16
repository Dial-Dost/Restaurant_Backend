// next_party.ts — THE RULES of client item 6, pinned without a database.
//
// The name and its reserved shape; which seat the next party gets; which idle
// rows go; who may add to a printed bill and what they are told; the words
// both clients say. Plus two facts about neighbouring modules the design leans
// on: the print ledger's prefix match cannot confuse "12" with "12 #2", and the
// kitchen docket prints the sibling's full name under "Running Table". And the
// migration file says exactly what the runtime issues.

import { describe, test, expect } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BILL_PRINTED_CODE,
  FIRST_NEXT_PARTY_SEQ,
  MAX_NEXT_PARTY_SEQ,
  NEXT_PARTY_CHIP,
  RESERVED_TABLE_NAME_ERROR,
  billPrintedRefusal,
  freeFamilySeat,
  isReservedPartyName,
  nextFreePartySeq,
  nextPartyAfterPrintMessage,
  nextPartyLabel,
  nextPartyName,
  orderLinesMeasure,
  orderOnPrintedBillVerdict,
  orderUpsertAddsToBill,
  parseNextPartyName,
  planNextPartyRetirement,
  tableDisplayName,
  tableSentenceName,
  takeItOnNextPartyLabel,
  type NextPartyFamilyMember,
} from "../next_party";
import { billPrintFallbackPrefix, billPrintJobBelongsToSeating, seatingStartOf } from "../bill_print_state";
import { buildReceiptBase64 } from "../escpos";

describe("the name", () => {
  test("'<root> #<n>', n from 2", () => {
    expect(nextPartyName("12", 2)).toBe("12 #2");
    expect(nextPartyName("  Patio 4 ", 13)).toBe("Patio 4 #13");
    expect(FIRST_NEXT_PARTY_SEQ).toBe(2);
    expect(() => nextPartyName("12", 1)).toThrow();
    expect(() => nextPartyName("12", Number.NaN)).toThrow();
  });

  test("the reserved shape is ' #<digits>' at the END, and nothing else", () => {
    for (const n of ["12 #2", "12 #13", "Patio 4 #2", " 7 #2 ", "12\t#2"]) {
      expect({ n, reserved: isReservedPartyName(n) }).toEqual({ n, reserved: true });
    }
    // The production lookalikes (31A/32A/33A at Gaia and GGV), and the near misses.
    for (const n of ["12", "31A", "32A", "12#2", "12 #", "#2", "12 #2a", "Table #2 inside", "12-2", null, undefined]) {
      expect({ n, reserved: isReservedPartyName(n) }).toEqual({ n, reserved: false });
    }
  });

  test("parse is the inverse, and refuses a party number below 2", () => {
    expect(parseNextPartyName("12 #2")).toEqual({ root: "12", seq: 2 });
    expect(parseNextPartyName("Patio 4 #13")).toEqual({ root: "Patio 4", seq: 13 });
    expect(parseNextPartyName("12 #1")).toBeNull();
    expect(parseNextPartyName("12 #0")).toBeNull();
    expect(parseNextPartyName("12")).toBeNull();
    expect(parseNextPartyName(" #2")).toBeNull();
    for (const [root, seq] of [["12", 2], ["A 1", 7], ["VIP-3", 99]] as const) {
      expect(parseNextPartyName(nextPartyName(root, seq))).toEqual({ root, seq });
    }
  });

  test("WHY NOT '-': the print ledger's fallback prefix never crosses between 12 and '12 #2'", () => {
    const seating = (table_name: string) => ({ open_bill_id: null, table_name, seating_start: null });
    expect(billPrintFallbackPrefix("12")).toBe("12-");
    expect(billPrintJobBelongsToSeating({ bill_id: "12 #2-1789545774907", created_at: null }, seating("12"))).toBe(false);
    expect(billPrintJobBelongsToSeating({ bill_id: "12-1789545774907", created_at: null }, seating("12 #2"))).toBe(false);
    expect(billPrintJobBelongsToSeating({ bill_id: "12 #2-1789545774907", created_at: null }, seating("12 #2"))).toBe(true);
    // The separator that was rejected: "12-2"'s prints would read as 12's.
    expect(billPrintJobBelongsToSeating({ bill_id: "12-2-1789545774907", created_at: null }, seating("12"))).toBe(true);
  });

  test("the add-table refusal is a sentence that names the shape", () => {
    expect(RESERVED_TABLE_NAME_ERROR).toContain("12 #2");
    expect(RESERVED_TABLE_NAME_ERROR).toMatch(/next party/);
  });
});

describe("the words both clients say", () => {
  test("chip, label, sentence name, display name, the action and the after-print line", () => {
    expect(NEXT_PARTY_CHIP).toBe("Next party");
    expect(nextPartyLabel("12")).toBe("12 (next party)");
    expect(tableSentenceName("12 #2", "12")).toBe("12 (next party)");
    expect(tableSentenceName("12", null)).toBe("12");
    expect(tableDisplayName("12 #2", "12")).toBe("12");
    expect(tableDisplayName("15", undefined)).toBe("15");
    expect(takeItOnNextPartyLabel("12 #2")).toBe("Take it on 12 (next party)");
    expect(takeItOnNextPartyLabel("12")).toBe("Take it on 12");
    expect(nextPartyAfterPrintMessage("12 #2")).toBe("Seat the next party at 12 (next party).");
    expect(nextPartyAfterPrintMessage("12")).toBe("Seat the next party at 12.");
    expect(nextPartyAfterPrintMessage(null)).toBeNull();
    expect(nextPartyAfterPrintMessage("  ")).toBeNull();
  });
});

describe("which seat the next party gets", () => {
  const m = (table_name: string, party_seq: number | null, free: boolean): NextPartyFamilyMember =>
    ({ id: table_name, table_name, party_seq, free });

  test("the root when it is free, then the LOWEST free sibling, else none", () => {
    expect(freeFamilySeat([m("12", null, true), m("12 #2", 2, true)])?.table_name).toBe("12");
    expect(freeFamilySeat([m("12", null, false), m("12 #3", 3, true), m("12 #2", 2, true)])?.table_name).toBe("12 #2");
    expect(freeFamilySeat([m("12", null, false), m("12 #2", 2, false)])).toBeNull();
    expect(freeFamilySeat([])).toBeNull();
  });

  test("the next number skips live siblings and names already taken, and stops at the cap", () => {
    expect(nextFreePartySeq([])).toBe(2);
    expect(nextFreePartySeq([2, 3])).toBe(4);
    expect(nextFreePartySeq([3])).toBe(2);
    expect(nextFreePartySeq([2], (n) => n === 3)).toBe(4);
    const all = Array.from({ length: MAX_NEXT_PARTY_SEQ - 1 }, (_, i) => i + 2);
    expect(nextFreePartySeq(all)).toBeNull();
  });
});

describe("the retirement rule — at most one free seat per family, preferring the root", () => {
  const m = (id: string, party_seq: number | null, free: boolean): NextPartyFamilyMember =>
    ({ id, table_name: id, party_seq, free });

  test.each([
    ["root free, sibling free -> the sibling goes", [m("r", null, true), m("s2", 2, true)], ["s2"]],
    ["root free, sibling busy -> nothing", [m("r", null, true), m("s2", 2, false)], []],
    ["root busy, sibling free -> it stays (the one free seat)", [m("r", null, false), m("s2", 2, true)], []],
    ["root busy, sibling busy -> nothing", [m("r", null, false), m("s2", 2, false)], []],
    ["root busy, two free -> the higher number goes", [m("r", null, false), m("s3", 3, true), m("s2", 2, true)], ["s3"]],
    ["root free, two free, one busy -> both free ones go", [m("r", null, true), m("s2", 2, true), m("s3", 3, false), m("s4", 4, true)], ["s2", "s4"]],
    ["no root in sight -> keep one free seat anyway", [m("s2", 2, true), m("s3", 3, true)], ["s3"]],
    ["just the root -> nothing", [m("r", null, true)], []],
  ])("%s", (_label, family, retired) => {
    expect(planNextPartyRetirement(family as NextPartyFamilyMember[])).toEqual(retired);
  });

  test("a busy sibling is NEVER in the answer, whatever else is true", () => {
    for (const rootFree of [true, false]) {
      for (let n = 0; n < 4; n += 1) {
        const family = [m("r", null, rootFree), ...Array.from({ length: 4 }, (_, i) => m(`s${String(i + 2)}`, i + 2, i !== n))];
        const retired = planNextPartyRetirement(family);
        expect(retired).not.toContain(`s${String(n + 2)}`);
      }
    }
  });
});

describe("who may add to a printed bill", () => {
  test.each([
    [0, false, false, "allow"],
    [0, true, false, "allow"],
    [0, false, true, "allow"],
    [1, true, false, "refuse"],
    [3, false, true, "refuse"],
    [1, false, false, "reprint_needed"],
    [Number.NaN, true, false, "allow"],
  ] as const)("print_count %p, waiterOnly %p, guest %p -> %p", (printCount, waiterOnly, guest, verdict) => {
    expect(orderOnPrintedBillVerdict({ printCount, waiterOnly, guest })).toBe(verdict);
  });

  test("a write that adds nothing to the bill is never refused and never told to reprint", () => {
    for (const waiterOnly of [true, false]) {
      for (const guest of [true, false]) {
        expect(orderOnPrintedBillVerdict({ printCount: 2, waiterOnly, guest, addsToBill: false })).toBe("allow");
      }
    }
    // Absent means "it adds" — every new order and every new line.
    expect(orderOnPrintedBillVerdict({ printCount: 1, waiterOnly: true, guest: false })).toBe("refuse");
    expect(orderOnPrintedBillVerdict({ printCount: 1, waiterOnly: true, guest: false, addsToBill: true })).toBe("refuse");
  });

  test("an order's lines are measured the same in both stored shapes", () => {
    const lines = [
      { id: "a", name: "Thali", price: 525, quantity: 2 },
      { id: "b", name: "Lassi", price: 90, quantity: 1, nc: true },
    ];
    expect(orderLinesMeasure(lines)).toEqual({ quantity: 3, amount: 1140 });
    expect(orderLinesMeasure([["Served", [lines[0]]], ["Preparing", [lines[1]]]])).toEqual({ quantity: 3, amount: 1140 });
    expect(orderLinesMeasure([])).toEqual({ quantity: 0, amount: 0 });
    expect(orderLinesMeasure(null)).toEqual({ quantity: 0, amount: 0 });
    // Junk lines count for nothing rather than throwing on the order path.
    expect(orderLinesMeasure([null, "x", { price: "abc", quantity: -2 }, { price: 10 }])).toEqual({ quantity: 1, amount: 10 });
  });

  test("an UPSERT adds to the bill only when it brings more portions or more money", () => {
    const stored = orderLinesMeasure([{ price: 525, quantity: 2 }]);
    // The dashboard's status change resends the same lines: nothing added.
    expect(orderUpsertAddsToBill([{ price: 525, quantity: 2 }], stored)).toBe(false);
    // Its edit dialog with a dessert on: added.
    expect(orderUpsertAddsToBill([{ price: 525, quantity: 2 }, { price: 120, quantity: 1 }], stored)).toBe(true);
    // One more of the same: added.
    expect(orderUpsertAddsToBill([{ price: 525, quantity: 3 }], stored)).toBe(true);
    // Swapped for something dearer at the same count: added.
    expect(orderUpsertAddsToBill([{ price: 525, quantity: 1 }, { price: 700, quantity: 1 }], stored)).toBe(true);
    // Fewer lines (a removal has its own authority): not an addition.
    expect(orderUpsertAddsToBill([{ price: 525, quantity: 1 }], stored)).toBe(false);
    // No such order: a new one, which always adds.
    expect(orderUpsertAddsToBill([], null)).toBe(true);
  });

  test("the staff refusal says where the new party goes AND what a same-party addition needs", () => {
    const body = billPrintedRefusal({ table: "12", nextPartyTable: "12 #2", printCount: 1, guest: false });
    expect(body).toEqual({
      error: "12's bill has already been printed, so nothing more can be added to it. Take a new party's order on 12 (next party). If it is for the same guests, ask a manager to add it and reprint the bill.",
      code: BILL_PRINTED_CODE,
      table: "12",
      next_party_table: "12 #2",
      next_party_action: "Take it on 12 (next party)",
      print_count: 1,
    });
  });

  test("with no seat to point at (or the root itself free again), it does not point at itself", () => {
    const none = billPrintedRefusal({ table: "12", nextPartyTable: null, printCount: 2, guest: false });
    expect(none.error).toBe("12's bill has already been printed, so nothing more can be added to it. Ask a manager to add it and reprint the bill.");
    expect(none.next_party_table).toBeNull();
    expect(none.next_party_action).toBeNull();
    const self = billPrintedRefusal({ table: "12", nextPartyTable: "12", printCount: 1, guest: false });
    expect(self.error).not.toContain("Take a new party");
    expect(self.next_party_action).toBeNull();
  });

  test("the guest is told to ask staff — never a table name to walk to", () => {
    const body = billPrintedRefusal({ table: "12", nextPartyTable: "12 #2", printCount: 1, guest: true });
    expect(body.error).toBe("This table's bill has already been printed, so nothing more can be ordered on it here. Please ask a member of staff.");
    expect(body.error).not.toContain("12");
    expect(body.code).toBe(BILL_PRINTED_CODE);
    expect(body.next_party_action).toBeNull();
  });

  test("a printed SIBLING is named in its root's words", () => {
    const body = billPrintedRefusal({ table: "12 #2", nextPartyTable: "12 #3", printCount: 1, guest: false, parentTable: "12" });
    expect(body.error.startsWith("12 (next party)'s bill has already been printed")).toBe(true);
    expect(body.error).toContain("Take a new party's order on 12 (next party).");
  });
});

describe("the seating start — the earlier of the bill row and the first owing order", () => {
  test.each([
    ["bill after the print (a discount made the row)", "2026-09-16T08:05:00Z", "2026-09-16T07:58:00Z", "2026-09-16T07:58:00.000Z"],
    ["bill first", "2026-09-16T07:50:00Z", "2026-09-16T07:58:00Z", "2026-09-16T07:50:00.000Z"],
    ["no bill row", null, "2026-09-16T07:58:00Z", "2026-09-16T07:58:00.000Z"],
    ["no owing order", "2026-09-16T08:05:00Z", null, "2026-09-16T08:05:00.000Z"],
  ])("%s", (_l, bill, order, start) => {
    expect(seatingStartOf(bill, order)?.toISOString()).toBe(start);
  });

  test("neither -> null; an epoch number is an instant, not a date string", () => {
    expect(seatingStartOf(null, undefined)).toBeNull();
    const at = Date.parse("2026-09-16T07:58:00Z");
    expect(seatingStartOf(null, at)?.toISOString()).toBe("2026-09-16T07:58:00.000Z");
    expect(seatingStartOf(new Date(at + 60_000), at)?.getTime()).toBe(at);
  });

  test("THE PRODUCTION CASE: a fallback print at 08:02 counts under a bill row made at 08:05", () => {
    const seating = {
      open_bill_id: "bill-made-by-the-waiver",
      table_name: "12",
      seating_start: seatingStartOf("2026-09-16T08:05:00.429Z", "2026-09-16T07:58:00Z"),
    };
    expect(billPrintJobBelongsToSeating({ bill_id: "12-1789545774907", created_at: "2026-09-16T08:02:54Z" }, seating)).toBe(true);
  });
});

describe("the kitchen docket names the next party in full", () => {
  test("'Table No: 12 #2' in the big type, under 'Running Table'", () => {
    const b64 = buildReceiptBase64({
      restaurantName: "GGV",
      currency: "₹",
      table: "12 #2",
      covers: 2,
      items: [{ name: "Thali", quantity: 2, price: 300 }],
      total: 600,
      kind: "kot",
      kotNo: 31,
      printedAt: "16/09/26 08:20",
      // kot_numbers.kotOrderContext(isVirtual=false) — a sibling is NOT virtual.
      // (Not imported: that module loads the data layer.)
      orderContext: "Running Table",
      serviceMode: "Dine In",
      section: "Garden",
    });
    const raw = Buffer.from(b64, "base64").toString("latin1");
    expect(raw).toContain("Running Table");
    expect(raw).toContain("Table No: 12 #2");
    expect(raw).not.toMatch(/Table No: 12\s*\n/);
  });
});

describe("migration 053 says exactly what the runtime issues", () => {
  const norm = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim().toLowerCase();

  test("every runtime statement is in the file, word for word", () => {
    const file = join(__dirname, "..", "migrations", "053_table_next_party.sql");
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    const sql = norm(readFileSync(file, "utf8"));
    const src = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");
    const block = /export const TABLE_NEXT_PARTY_DDL: readonly string\[\] = \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? "";
    const statements = [...block.matchAll(/`([\s\S]*?)`/g)].map((m) => norm(m[1]!));
    expect(statements).toHaveLength(5);
    for (const stmt of statements) {
      // The DO blocks differ only in line breaks, bracket spacing and semicolons.
      const loose = stmt.replace(/;/g, "");
      expect({ stmt: loose.slice(0, 80), inFile: sql.replace(/;/g, "").includes(loose) }).toEqual({ stmt: loose.slice(0, 80), inFile: true });
    }
  });
});
