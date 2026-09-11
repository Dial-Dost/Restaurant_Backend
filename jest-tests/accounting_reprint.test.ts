// E5 — THE ACCOUNTING REPRINT, and the one rule that makes it safe.
//
// ============================================================================
// IT PRINTS WHAT WAS RECORDED. IT MUST NEVER RECOMPUTE.
// ============================================================================
// POST /print/bill (the open table) is RIGHT to compute its ladder: that bill is
// still moving, so it asks the charge resolver and derives the totals. This
// route is its opposite. It prints a bill that was SETTLED — a guest paid a
// specific number, that number is in "Bills", and the paper is a tax document.
//
// Recomputing would re-derive the ladder from TODAY's configuration. Between the
// settlement and the reprint an owner may have:
//
//   * changed the GST lines in Outlets.default_tax,
//   * changed "Restaurant".service_charge,
//   * moved the service charge from the restaurant percent to a tax line.
//
// Any one of those silently produces a second copy of a tax document with a
// DIFFERENT total from the one the guest paid. This file has already been
// through that failure twice — F2's grand total, and the print that lowered a
// total the till would not honour — so the tests below are written against the
// specific ways it could come back.
//
// The second half is the BANNER. Off the roll, a second copy is
// indistinguishable from the original, and a bill that looks like an original
// gets paid a second time or filed as a second sale. `reprint: true` is not
// optional on this route: it can only ever produce second copies.

import { describe, test, expect } from "@jest/globals";
import { buildReceiptBase64 } from "../escpos";

function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  for (const base of [process.cwd(), path.join(__dirname, "..")]) {
    const full = path.join(base, relative);
    if (fs.existsSync(full)) { return fs.readFileSync(full, "utf8"); }
  }
  throw new Error(`readSource could not find ${relative} from ${process.cwd()}`);
}

/** The route handler's body, from `app.post('/print/bill/settled'` to its close. */
function settledRoute(): string {
  const src = readSource("routes/bills.ts");
  const at = src.indexOf("app.post('/print/bill/settled'");
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("\n});", at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

const decoded = (b64: string): string => Buffer.from(b64, "base64").toString("latin1");

/** The buildReceiptBase64({ ... }) call inside the settled-bill route. */
function renderCall(): string {
  const body = settledRoute();
  const at = body.indexOf("buildReceiptBase64({");
  expect(at).toBeGreaterThan(-1);
  const end = body.indexOf("}, cols)", at);
  expect(end).toBeGreaterThan(at);
  return body.slice(at, end);
}

describe("a reprint says so, in the largest type the printer has", () => {
  const receipt = (over: Record<string, unknown> = {}) => decoded(buildReceiptBase64({
    restaurantName: "GAIA", table: "T7", covers: 2,
    items: [{ name: "Biryani", price: 390, quantity: 2 }],
    total: 780, grandTotal: 920.4, currency: "₹", kind: "bill",
    ...over,
  } as Parameters<typeof buildReceiptBase64>[0]));

  test("the banner is on the paper", () => {
    expect(receipt({ reprint: true })).toContain("REPRINT");
  });

  test("and it is ABOVE the bill number, not buried in the footer", () => {
    // "At the top" of a bill with a tall raster logo is not "below the logo".
    const out = receipt({ reprint: true, billNo: "0421" });
    const banner = out.indexOf("REPRINT");
    const billNo = out.indexOf("0421");
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(billNo).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(billNo);
  });

  test("an ORIGINAL is byte-identical to what this renderer printed before the flag existed", () => {
    // The flag must be additive. A reprint banner appearing on originals would
    // be a worse bug than the one it fixes.
    expect(receipt()).toBe(receipt({ reprint: false }));
    expect(receipt()).not.toContain("REPRINT");
  });
});

describe("the route prints the settled figures and derives none of them", () => {
  const body = settledRoute();

  test("the grand total is the one recorded on the bill", () => {
    expect(body).toMatch(/grandTotal:\s*bill\.grand_total/);
  });

  test("the tax lines are the ones recorded on the bill", () => {
    expect(body).toMatch(/taxes:\s*bill\.taxes/);
  });

  test("the service charge is the one recorded on the bill", () => {
    expect(body).toMatch(/percent:\s*bill\.service_charge_percent/);
    expect(body).toMatch(/amount:\s*bill\.service_charge/);
  });

  test("THE RULE: it never calls the charge resolver or the ladder calculator", () => {
    // These are the two doors back to today's configuration. Either one appearing
    // in this handler means a reprint can disagree with what the guest paid.
    expect(body).not.toMatch(/computeBillCharges\(/);
    expect(body).not.toMatch(/GetBillChargeConfigForTable\(/);
    expect(body).not.toMatch(/openBillChargeConfig\(/);
  });

  test("…and it reads the settled bill rather than the table's live one", () => {
    expect(body).toMatch(/GetClosedBill\(restaurantId, billId\)/);
    expect(body).not.toMatch(/GetBillForTable\(/);
  });

  test("the banner is hardcoded on, not taken from the request", () => {
    // ASSERTED INSIDE THE RENDERER CALL, not anywhere in the handler.
    //
    // A mutation survey caught the loose version passing: switching the
    // RENDERER to `reprint: false` left the suite green, because the AUDIT
    // metadata a few lines below also carries `reprint: true` and the
    // whole-handler regex matched that instead. The banner is a property of
    // the PAPER, so the assertion has to be about the call that makes it.
    const call = renderCall();
    expect(call).toMatch(/reprint:\s*true/);
    expect(call).not.toMatch(/reprint:\s*(?:false|body|req)\b/);
  });

  test("no feedback QR — a reprint is an accounting document, not a table-side courtesy", () => {
    // The QR is signed for a live seating and would invite a guest who has left
    // to rate a meal they already rated.
    expect(body).toMatch(/feedbackUrl:\s*null/);
  });

  test("a bill with no recorded line items is refused rather than printed empty", () => {
    expect(body).toMatch(/no line items recorded/);
  });

  test("it is gated on the ACCOUNTING permission, not the waiter's Add Orders", () => {
    expect(body).toMatch(/validateAction\(ACCOUNTING_PERM\)/);
    expect(body).not.toMatch(/4ad474d4-5230-449c-874f-6a238b833bca/);
  });

  test("and the audit line names the bill and the money", () => {
    expect(body).toMatch(/Reprinted settled bill/);
    expect(body).toMatch(/bill\.grand_total\.toFixed\(2\)/);
  });
});

describe("the button exists, and says what will come out before it is pressed", () => {
  const ui = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const candidates = [
      path.join(process.cwd(), "..", "Restaurant_Dashboard_UI", "src", "components", "closed-bills.tsx"),
      path.join(__dirname, "..", "..", "Restaurant_Dashboard_UI", "src", "components", "closed-bills.tsx"),
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { return fs.readFileSync(c, "utf8"); } }
    return "";
  };

  test("the accounting module calls the route", () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE USUAL BUG. This project's most repeated
    // defect is a correct thing built on the server that no client ever calls;
    // a reprint endpoint with no button is exactly that shape. Skipped rather
    // than failed when the sibling repo is not checked out beside this one, so
    // the backend's own CI does not depend on another checkout.
    const src = ui();
    if (!src) { return; }
    expect(src).toMatch(/reprintSettledBill\(rid, id\)/);
  });

  test("and it warns that the paper will be marked REPRINT", () => {
    const src = ui();
    if (!src) { return; }
    expect(src).toMatch(/REPRINT/);
  });
});
