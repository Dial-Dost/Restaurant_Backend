// SETTLE AS NC — THE WIRING. Built-but-never-called is this project's most
// repeated defect (six instances, every one green): a correct server capability
// that nothing reaches. These are source guards for the parts jest cannot drive:
// the route is registered, the boot step runs, the DDL never runs inside a
// settle, the migration and the runtime ensure say the same thing, the
// hardening and the reprint are actually on their paths, and both clients call
// the route (when the sibling checkouts are present).

import { describe, test, expect } from "@jest/globals";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const DB = read("database_supabase.ts");
const INDEX = read("index.ts");
const ROUTE = read("routes/nc_settle.ts");
const BILLS = read("routes/bills.ts");

/** A top-level function's source, by name, up to the next top-level declaration. */
function chunk(src: string, name: string): string {
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\s*[(<]`, "m").exec(src);
  expect(start).not.toBeNull();
  const tail = src.slice(start!.index + 1);
  const next = /^(?:export )?(?:async )?(?:function|interface|type|const|let|class) /m.exec(tail);
  return src.slice(start!.index, next ? start!.index + 1 + next.index : src.length);
}

describe("the route exists and something reaches it", () => {
  test("index.ts registers it, after the capture routes it is built from", () => {
    expect(INDEX).toMatch(/import \{ InitBillNonChargeableSchema, registerNcSettleRoutes \} from "\.\/routes\/nc_settle\.js";/);
    expect(ROUTE).toMatch(/^export \{ InitBillNonChargeableSchema \} from "\.\.\/database_supabase\.js";$/m);
    const capture = INDEX.indexOf("registerMisCaptureRoutes(app);");
    const nc = INDEX.indexOf("registerNcSettleRoutes(app);");
    expect(capture).toBeGreaterThan(-1);
    expect(nc).toBeGreaterThan(capture);
  });

  test("the route calls the data layer, and no route puts idempotent() on it", () => {
    expect(ROUTE).toMatch(/await SettleBillAsNonChargeable\(restaurantId, \{/);
    // It mints a bill number, so it is never replayed from a key store (the
    // header says why); comments stripped, so that sentence is not the match.
    const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/idempotent\(|idempotency\.js/);
    const shipping = readdirSync(join(ROOT, "routes")).filter((f) => f.endsWith(".ts"))
      .filter((f) => read(`routes/${f}`).includes("SettleBillAsNonChargeable("));
    expect(shipping).toEqual(["nc_settle.ts"]);
  });

  test("the golden manifest lists it, gated on the comp permission", () => {
    expect(read("scripts/route_manifest.baseline.txt"))
      .toMatch(/POST\s+\/bills\/order\/:orderId\/settle-nc\s+\| validateAction\(PERM_NON_CHARGEABLE\)\s+\|/);
  });

  test("the paper goes through the settled bill's own options builder, as the reprint's does", () => {
    expect(ROUTE).toMatch(/buildReceiptBase64\(settledBillReceiptOptions\(bill, \{/);
    expect(ROUTE).toMatch(/reprint: false/);
    expect(BILLS).toMatch(/buildReceiptBase64\(settledBillReceiptOptions\(bill, \{ settings, profile, logo, reprint: true \}\), cols\)/);
    // The settled reprint carries the NC flag through to the paper.
    expect(chunk(BILLS, "settledBillReceiptOptions")).toMatch(/\.\.\.\(i\.nc \? \{ nc: true \} : \{\}\)/);
  });
});

describe("migration 052's DDL: at boot and before the settle — never inside it", () => {
  test("the boot step runs before the server listens", () => {
    const boot = INDEX.indexOf("await InitBillNonChargeableSchema()");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(INDEX.indexOf("httpServer.listen("));
  });

  test("the settle ensures the columns BEFORE its transaction opens", () => {
    const settle = chunk(DB, "SettleBillAsNonChargeable");
    const ensure = settle.indexOf("await ensureBillNcColumns()");
    // `return withTransaction(` or, once the settle tidies next-party seats after
    // its commit, `const out = await withTransaction<…>(` — either way, the one
    // transaction the settle opens.
    const tx = settle.search(/withTransaction(<[^>]*>)?\(/);
    expect(ensure).toBeGreaterThan(-1);
    expect(tx).toBeGreaterThan(ensure);
    expect(settle.slice(tx)).not.toMatch(/ensureBillNcColumns\(/);
  });

  test("the settle tidies next-party seats AFTER its commit, as every other settle path does", () => {
    // test/money/next_party_nc.test.ts drives it; this pins where it runs. Inside
    // the transaction a failed tidy would undo a settled bill.
    const settle = chunk(DB, "SettleBillAsNonChargeable");
    const tx = settle.search(/withTransaction(<[^>]*>)?\(/);
    const tidy = settle.indexOf("await afterTableFreed(freed);");
    expect(tidy).toBeGreaterThan(tx);
    expect(settle.slice(tidy)).toMatch(/^await afterTableFreed\(freed\);\n\s+return out;\n\}/);
    expect(settle).toMatch(/freed\.tableId = tableId;/);
  });

  test("the NC paper is filed under `<bill>-nc`, never the bill's own id — the original and the reprint", () => {
    expect(ROUTE).toMatch(/bill_id: ncSettlementPrintJobId\(result\.bill_id\)/);
    expect(BILLS).toMatch(/bill_id: isNcSettleMethod\(bill\.payment_method\) \? ncSettlementPrintJobId\(bill\.id\) : bill\.id,/);
  });

  test("nothing else issues it", () => {
    const callers = [...DB.matchAll(/ensureBillNcColumns\(\)/g)].length;
    // Its own definition line does not match `()` followed by nothing: count the calls.
    expect(callers).toBe(3); // the definition, the boot step, the settle
    expect(chunk(DB, "InitBillNonChargeableSchema")).toMatch(/await ensureBillNcColumns\(\)/);
  });

  test("every reader asks the catalogue instead of catching a 42703 inside a transaction", () => {
    const nc = chunk(DB, "GetNcSummaryReport");
    expect(nc.indexOf("billNcColumnsPresent()")).toBeGreaterThan(-1);
    expect(nc.indexOf("billNcColumnsPresent()")).toBeLessThan(nc.indexOf("runQuery<NcSummarySqlRow>("));
    expect(chunk(DB, "readBillNcSettlement")).toMatch(/billNcColumnsPresent\(\)/);
    expect(chunk(DB, "reverseBillScopeNonChargeables")).toMatch(/if \(!\(await billNcColumnsPresent\(\)\)\)/);
  });

  test("the migration file (when present on this branch) says what the runtime says", () => {
    const file = join(ROOT, "migrations", "052_bill_non_chargeable.sql");
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    const sql = readFileSync(file, "utf8").toLowerCase().replace(/\s+/g, " ");
    const ensure = chunk(DB, "ensureBillNcColumns").toLowerCase().replace(/\s+/g, " ");
    for (const fragment of [
      "add column if not exists scope text not null default 'item'",
      "add column if not exists bill_id uuid",
      "add column if not exists settle_group uuid",
      "conname = 'orderitemnc_scope_check'",
      "check (scope in ('item', 'bill'))",
      "conname = 'orderitemnc_bill_scope_linked'",
      "check (scope = 'item' or (bill_id is not null and settle_group is not null))",
      "create index if not exists orderitemnc_bill_idx on \"orderitemnonchargeable\" (res_id, bill_id) where bill_id is not null",
    ]) {
      expect(sql).toContain(fragment);
      expect(ensure.replace("('item','bill')", "('item', 'bill')")).toContain(fragment);
    }
  });
});

describe("migration 052, applied by hand during service", () => {
  test("waits at most 5s for its locks — the first thing the file does", () => {
    // ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS lock before they
    // look. migrate.ts runs each file in its own transaction; LOCAL ends with it.
    const file = join(ROOT, "migrations", "052_bill_non_chargeable.sql");
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    const code = read("migrations/052_bill_non_chargeable.sql").split("\n")
      .filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });
});

describe("the other paths that meet an NC bill are wired", () => {
  test("the ordinary settle stores a fully comped ₹0 bill as NC", () => {
    const confirm = chunk(DB, "ConfirmBillPaymentByWaiter");
    expect(confirm).toMatch(/settlesAsNonChargeable\(charges\.grand_total, linesNow\)/);
    expect(confirm).toMatch(/storedMethod,\n\s+storedMethod === paymentMethod \? \(paymentProofScreenshotUrl \|\| null\) : null,/);
    expect(confirm).toMatch(/payment_method: storedMethod/);
    expect(confirm).toMatch(/ncPaymentPointer\(paymentMethodRaw\) \?\? "Invalid payment method"/);
  });

  test("approval refuses an NC bill that owes money; refund refuses an NC bill; re-open undoes one", () => {
    expect(chunk(DB, "ApproveBillPaymentByAdmin")).toMatch(/isNcSettleMethod\(bill\.payment_method\) && Math\.round\(chargesAtApproval\.grand_total \* 100\) !== 0/);
    expect(chunk(DB, "RefundBill")).toMatch(/if \(isNcSettleMethod\(billRow\.payment_method\)\)/);
    const reopen = chunk(DB, "ReopenBill");
    expect(reopen).toMatch(/await reverseBillScopeNonChargeables\(/);
    expect(BILLS).toMatch(/ReopenBill\(restaurantId, billId, extractEmployeeId\(req\), extractEmployeeUsername\(req\)\)/);
    // …and says so only when a settle's comps were actually undone.
    expect(reopen).toMatch(/\.\.\.\(wasNc && ncReversed && ncReversed\.lines > 0 \? \{ nc_reversed: ncReversed \} : \{\}\)/);
    expect(BILLS).toMatch(/if \(result\.nc_reversed && result\.nc_reversed\.lines > 0\) \{/);
  });

  test("the closed bill carries the NC flag per line and the settlement", () => {
    expect(chunk(DB, "aggregateClosedBillOrders")).toMatch(/\$\{nc \? "@@nc" : ""\}/);
    expect(chunk(DB, "GetClosedBill")).toMatch(/nc_settlement: ncSettlement/);
  });

  test("the ticket drill-down marks a comped line, as the bill drill-down does", () => {
    expect(chunk(DB, "GetMisOrderDetail")).toMatch(/\.\.\.\(isNonChargeableLine\(it\) \? \{ nc: true as const \} : \{\}\)/);
  });
});

describe("the writers that rewrite an order price chargeable lines, and keep the server's comps", () => {
  const split = chunk(DB, "UpdateOrderItemsSplit");

  test("the items-split writer strips and carries the comps BEFORE it prices or gates anything", () => {
    const carry = split.indexOf("carryServerNonChargeable(");
    expect(carry).toBeGreaterThan(-1);
    expect(split).toMatch(/if \(carried\.refusal\) \{throw new Error\(carried\.refusal\);\}/);
    expect(split).toMatch(/const flattened = safeSplit\.flatMap\(/);
    // Nothing reads the client's payload once the carry has answered.
    const after = split.indexOf("const safeSplit = carried.split");
    expect(after).toBeGreaterThan(carry);
    expect(split.slice(after)).not.toMatch(/\bitems_split\b(?!:)/);
    expect(split.indexOf("const repricedSubtotal = chargeableSubtotal(moneyLines);")).toBeGreaterThan(carry);
    expect(split.indexOf("const nextChargeable = chargeableOf(flattened as unknown[]);")).toBeGreaterThan(carry);
    expect(split).toMatch(/items_split: safeSplit,/);
    expect(split).toMatch(/\.\.\.\(repricedNc > 0 \? \{ nc_subtotal: repricedNc \} : \{\}\),/);
  });

  test("its write is guarded by the state it was built on, and a miss is said, never swallowed", () => {
    expect(split).toMatch(/and \$\{stillOwesStatusSql\(\)\}\n\s+and coalesce\(status::text, '1'\) <> '6'/);
    expect(split).toMatch(/\), ''\) = \$6\n\s+returning id`/);
    // …then client item 3's pin ($7): a waiter's strip lands only on the Pending
    // order it was judged on.
    expect(split).toMatch(/ncFlagSignature\(previousLines\),\n\s+waiterStrip \? String\(PENDING_ORDER_STATUS_CODE\) : null\],/);
    expect(split).toMatch(/if \(!written\[0\]\) \{/);
  });

  test("the admin remove-item path skips comped lines when it prices", () => {
    const remove = chunk(DB, "removeItemFromTableOrders");
    expect(remove).toMatch(/keep\.reduce\(\(s, it\) => \(isNonChargeableLine\(it\)\n\s+\? s/);
    expect(remove).toMatch(/const ncLeft = nonChargeableValue\(keep\);/);
  });

  test("the settle checks the till's STORED quote and re-prices every owing order that has lines", () => {
    const settle = chunk(DB, "SettleBillAsNonChargeable");
    expect(settle).toMatch(/quoted_subtotal: activeOrderSubtotal\(owing\)\.subtotal,/);
    expect(settle).toMatch(/if \(mine\.length === 0\) \{\n\s+if \(o\.lines\.items\.length > 0\) \{/);
  });
});

describe("both clients call the route (skipped when a sibling checkout is absent)", () => {
  const sibling = (repo: string, rel: string): string => {
    for (const base of [join(ROOT, ".."), join(process.cwd(), "..")]) {
      const f = join(base, repo, rel);
      if (existsSync(f)) { return readFileSync(f, "utf8"); }
    }
    return "";
  };

  test("the dashboard", () => {
    const db = sibling("Restaurant_Dashboard_UI", join("src", "lib", "db.ts"));
    if (!db) { return; }
    expect(db).toMatch(/\/bills\/order\/\$\{encodeURIComponent\(orderId\)\}\/settle-nc/);
  });

  test("the app", () => {
    const sheet = sibling("restaurant_owner_app", join("lib", "screens", "mis_capture.dart"));
    if (!sheet) { return; }
    expect(sheet).toMatch(/\/bills\/order\/\$oid\/settle-nc/);
  });
});
