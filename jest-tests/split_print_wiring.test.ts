// F3 — THE SPLIT THAT NEVER REACHED PAPER.
//
// ============================================================================
// THE SHAPE OF THIS BUG, FOR THE SIXTH TIME
// ============================================================================
// V3: "Ensure the system successfully generates and PRINTS TWO SEPARATE BILLS
// when an order is split, and that this split registers correctly on the
// dashboard."
//
// `buildSplitReceiptsBase64` was written for exactly that. It is careful code —
// it ladders each part, it keeps a waiver visible, it falls back to printing
// the whole bill rather than printing nothing — and it has its own test suite.
//
// Its only importer was that suite. `POST /bills/split` computed the parts and
// returned them as JSON for the screen; no route ever turned them into paper.
// The dashboard half worked and the printing half did not exist.
//
// That is this codebase's single most repeated defect — a migration nothing
// wrote to, a renderer field no caller passed, capability flags nobody parsed,
// a floor grid reading print state off a payload that never carried it — so
// this suite is deliberately about the WIRING. The bytes are already covered by
// bill_split_print.test.ts; what was missing was anybody calling it.

import { describe, test, expect } from "@jest/globals";

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

/** Every non-test file in the backend that mentions a symbol. */
function productionImporters(symbol: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const root = [process.cwd(), path.join(__dirname, "..")].find((b) => fs.existsSync(path.join(b, "escpos.ts")));
  if (!root) { throw new Error("backend root not found"); }

  const hits: string[] = [];
  const skip = new Set(["node_modules", "build", "dist", ".git", "jest-tests", "test", "migrations", "scripts", "deploy"]);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) { walk(path.join(dir, entry.name)); }
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) { continue; }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      // The file that DEFINES it is not an importer of it.
      if (rel === "escpos.ts") { continue; }
      if (fs.readFileSync(full, "utf8").includes(symbol)) { hits.push(rel); }
    }
  };
  walk(root);
  return hits;
}

describe("the split renderer is actually called by something that ships", () => {
  test("THE TEST THAT WOULD HAVE CAUGHT IT: a production file imports it", () => {
    // Before this fix the only hit was jest-tests/bill_split_print.test.ts, and
    // this walk deliberately excludes test directories for that reason.
    const importers = productionImporters("buildSplitReceiptsBase64");
    expect(importers.length).toBeGreaterThan(0);
    expect(importers).toContain("routes/bills.ts");
  });

  test("and the route that calls it is registered", () => {
    expect(readSource("routes/bills.ts")).toContain("app.post('/print/bill/split'");
  });

  test("it is in the route manifest baseline, so a rename cannot silently drop it", () => {
    expect(readSource("scripts/route_manifest.baseline.txt")).toContain("/print/bill/split");
  });
});

describe("the parts are derived at print time, not taken from the request", () => {
  const route = (): string => {
    const src = readSource("routes/bills.ts");
    const at = src.indexOf("app.post('/print/bill/split'");
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf("\n});", at);
    return src.slice(at, end);
  };

  test("the bill is re-read", () => {
    // Between the preview and the print somebody adds a round, applies a coupon,
    // or a waiver lands. Printing the parts the CLIENT is holding hands a guest
    // a bill that sums to a total nobody owes.
    expect(route()).toMatch(/GetBillForTable\(restaurantId, tableName\)/);
  });

  test("and the split is recomputed by the same functions the preview used", () => {
    const body = route();
    expect(body).toMatch(/SplitBillForTableBySection\(/);
    expect(body).toMatch(/computeSectionSplit\(/);
    expect(body).toMatch(/SplitBillForTable\(restaurantId, tableName, "even"/);
  });

  test("NOTHING reads a parts array off the body", () => {
    // The specific mistake this rules out.
    const body = route();
    expect(body).not.toMatch(/body\.parts\s*as/);
    expect(body).not.toMatch(/parts = \(?body\.parts/);
  });

  test("the charge figures come from the BILL, never recomputed from settings", () => {
    const body = route();
    expect(body).toMatch(/grandTotal: bill\.grand_total/);
    expect(body).toMatch(/taxes: bill\.taxes/);
    expect(body).not.toMatch(/computeBillCharges\(/);
  });
});

describe("and a screen actually calls it", () => {
  // The other half of the same defect. A print route with no button is the
  // identical failure one layer up, and the dashboard lives in a sibling repo
  // so this is skipped rather than failed when that checkout is not here —
  // the backend's own CI must not depend on another repo being present.
  const ui = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const c of [
      path.join(process.cwd(), "..", "Restaurant_Dashboard_UI", "src", "app", "dashboard", "orders", "bill-actions.tsx"),
      path.join(__dirname, "..", "..", "Restaurant_Dashboard_UI", "src", "app", "dashboard", "orders", "bill-actions.tsx"),
    ]) { if (fs.existsSync(c)) { return fs.readFileSync(c, "utf8"); } }
    return "";
  };

  test("the split dialog offers a Print button", () => {
    const src = ui();
    if (!src) { return; }
    expect(src).toMatch(/printSplitBills\(restaurantId, tableName/);
    expect(src).toMatch(/Print \$\{String\(splitResult\.length\)\} bills/);
  });

  test("and it sends the INPUTS, not the parts on screen", () => {
    const src = ui();
    if (!src) { return; }
    expect(src).toMatch(/printSplitBills\(restaurantId, tableName, \{ mode: "even", parts:/);
    expect(src).not.toMatch(/printSplitBills\([^)]*splitResult/);
  });
});

describe("what the paper does and does not carry", () => {
  const route = (): string => {
    const src = readSource("routes/bills.ts");
    const at = src.indexOf("app.post('/print/bill/split'");
    return src.slice(at, src.indexOf("\n});", at));
  };

  test("no feedback QR on a split part", () => {
    // The QR is signed for the SEATING, so every part would carry the same link
    // and the first guest to scan it rates the meal for the whole table.
    expect(route()).toMatch(/feedbackUrl: null/);
  });

  test("a waived service charge stays visible on every part", () => {
    // A waived bill that simply omits the line leaves the guest no way to see
    // the charge was dropped rather than never applied.
    expect(route()).toMatch(/optedOut: true/);
  });

  test("each part is its own print job, so one failure does not reprint the rest", () => {
    expect(route()).toMatch(/bill_id: `\$\{bill\.bill_id \?\? tableName\}-split-/);
  });

  test("the jobs are dispatched SEQUENTIALLY, not fired in parallel", () => {
    // Firing N at once lets them interleave on the roll: "part 2 of 3" printed
    // between the two halves of part 1 is worse than slow.
    const body = route();
    expect(body).toMatch(/for \(const r of receipts\) \{/);
    expect(body).not.toMatch(/Promise\.all\(receipts/);
  });

  test("the audit line records how many parts and what they came to", () => {
    expect(route()).toMatch(/Printed \$\{String\(receipts\.length\)\} split bill\(s\)/);
  });
});
