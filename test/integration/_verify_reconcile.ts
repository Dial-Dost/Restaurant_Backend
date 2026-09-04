// ADVERSARIAL VERIFIER — step 2. Re-prove the reconciliation on REAL Postgres,
// over a window that holds a comp, a waiver, a split tender with a tip, a
// refund and a cancelled order, AFTER the NC columns landed on
// Sales / Executive / Item Wise.
//
//   sales.grand_total === Sum(Order Summary rows) === Sum(Settlement rows)
//                     === Sum(Counter Summary rows)
//
// Throwaway DB only. Same local-only guard as money_integration_test.ts.
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.SUPABASE_DIRECT_URL ?? "";
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(DB) || /[?&]sslmode=disable/i.test(DB);
if (!DB || !isLocal) { console.error("refusing: point SUPABASE_DIRECT_URL at the throwaway local DB"); process.exit(1); }

const db: any = await import("../../database_supabase.js");
const {
  EnsureRestaurantSeed, closePools,
  OccupyTable, AddOrder, SetOrderStatus, GetBillForTable,
  ConfirmBillPaymentByWaiter, ApproveBillPaymentByAdmin, RefundBill,
  MarkOrderItemNonChargeable, WaiveServiceCharge, RecordBillTenders,
  UpsertBillingCounter, SetBillCounter,
  UpsertMenuItem, UpsertMenuGroup, UpsertMenuVariation, SetMenuGroupAssignment,
  GetSalesSummaryReport, GetOrderSummaryReport, GetSettlementSummaryReport,
  GetCounterSummaryReport, GetItemWiseReport, GetGroupSummaryReport,
  GetVariationSummaryReport, GetNcSummaryReport, GetServiceChargeDenyReport,
  GetTipSummaryReport, GetExecutiveSummaryReport, GetCoverSizeSummaryReport,
} = db;

const raw = new pg.Pool({ connectionString: DB, ssl: false, max: 3 });
let RES_ID = "";
let pass = 0; const fails: string[] = [];
function check(label: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}   ${extra}`); }
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + Number(b || 0), 0));
const near = (a: number, b: number) => Math.abs(Number(a) - Number(b)) < 0.005;
const ITEM = (id: string, name: string, price: number, qty = 1) => ({ id, name, price, quantity: qty });

async function tableId(name: string): Promise<string> {
  return (await raw.query(`select id from "Tables" where res_id=$1 and lower(table_name)=lower($2) limit 1`, [RES_ID, name])).rows[0].id;
}
async function lastOrderId(t: string): Promise<string> {
  return (await raw.query(`select id from "Orders" where res_id=$1 and table_id=$2 order by created_at desc limit 1`, [RES_ID, await tableId(t)])).rows[0].id;
}

async function main() {
  const tables = Array.from({ length: 14 }, (_, i) => ({ name: `R${i + 1}`, capacity: 6 }));
  await EnsureRestaurantSeed({
    name: `Reconcile ${randomUUID().slice(0, 8)}`,
    admin: { employeeId: "admin", name: "Admin", password: "test1234" },
    tables,
  });
  RES_ID = (await raw.query(`select id from "Restaurant" order by created_at desc limit 1`)).rows[0].id;
  const outletId = (await raw.query(`select id from "Outlets" where res_id=$1 order by created_at limit 1`, [RES_ID])).rows[0].id;
  console.log(`restaurant ${RES_ID}`);

  // A service charge so the waiver has something to bite, and GST so the
  // tax-inclusive grand total is not the same number as the net.
  await raw.query(`update "Restaurant" set service_charge=10 where id=$1`, [RES_ID]);
  await raw.query(`update "Outlets" set default_tax=$2::jsonb where id=$1`,
    [outletId, JSON.stringify([{ name: "CGST", percentage: 2.5 }, { name: "SGST", percentage: 2.5 }])]);

  async function attachTill(t: string, counterId: string) {
    try { await SetBillCounter(RES_ID, { table_name: t, counter_id: counterId, actor: { username: "admin" } }); }
    catch (e: any) { console.log(`  (till attach on ${t}: ${e?.message})`); }
  }

  // --- menu, one group, one variation, two tills --------------------------
  const feast = await UpsertMenuItem(RES_ID, { name: "Feast", price: 1000, category: "Mains", is_available: true });
  await UpsertMenuItem(RES_ID, { name: "Tea", price: 100, category: "Beverages", is_available: true });
  const grp = await UpsertMenuGroup(RES_ID, { name: "Food", sort_order: 1 });
  await SetMenuGroupAssignment(RES_ID, { menu_id: feast.id, group_id: grp.id });
  const half = await UpsertMenuVariation(RES_ID, { menu_id: feast.id, name: "Half", price: 600, sort_order: 1 });
  const till1 = await UpsertBillingCounter(RES_ID, { code: "T1", name: "Front till" });
  const till2 = await UpsertBillingCounter(RES_ID, { code: "T2", name: "Bar till" });

  // ===================== THE WINDOW =====================
  // R1 — plain settled bill, cash, on till 1.
  await OccupyTable(RES_ID, "R1", 2, null, null);
  await AddOrder(RES_ID, { table: "R1", customer: "A", status: "Preparing", items: [ITEM("a1", "Feast", 1000)], subtotal: 1000, total: 1000 });
  const oA = await lastOrderId("R1");
  await GetBillForTable(RES_ID, "R1");
  await ConfirmBillPaymentByWaiter(RES_ID, oA, "admin", "Cash");
  await attachTill("R1", till1.id);
  await ApproveBillPaymentByAdmin(RES_ID, oA, "admin");

  // R2 — a COMPED line, then settled.
  await OccupyTable(RES_ID, "R2", 2, null, null);
  const ordB = await AddOrder(RES_ID, { table: "R2", customer: "B", status: "Preparing", items: [ITEM("b1", "Feast", 1000), ITEM("b2", "Tea", 100)], subtotal: 1100, total: 1100 });
  await MarkOrderItemNonChargeable(RES_ID, {
    order_id: ordB.id, item_id: "b2", nc_kind: "guest_complaint", reason: "cold tea",
    actor: { username: "admin", authorised_by_username: "admin" },
  });
  await GetBillForTable(RES_ID, "R2");
  await ConfirmBillPaymentByWaiter(RES_ID, ordB.id, "admin", "Cash");
  await attachTill("R2", till1.id);
  await ApproveBillPaymentByAdmin(RES_ID, ordB.id, "admin");

  // R3 — SERVICE CHARGE WAIVED, then settled.
  await OccupyTable(RES_ID, "R3", 2, null, null);
  const ordC = await AddOrder(RES_ID, { table: "R3", customer: "C", status: "Preparing", items: [ITEM("c1", "Feast", 1000, 2)], subtotal: 2000, total: 2000 });
  await GetBillForTable(RES_ID, "R3");
  await WaiveServiceCharge(RES_ID, {
    table_name: "R3", waiver_kind: "guest_request", reason: "regular guest",
    actor: { username: "admin", authorised_by_username: "admin" },
  });
  await ConfirmBillPaymentByWaiter(RES_ID, ordC.id, "admin", "Upi");
  await attachTill("R3", till2.id);
  await ApproveBillPaymentByAdmin(RES_ID, ordC.id, "admin");

  // R4 — SPLIT TENDER with a TIP, then settled.
  await OccupyTable(RES_ID, "R4", 3, null, null);
  const ordD = await AddOrder(RES_ID, { table: "R4", customer: "D", status: "Preparing", items: [ITEM("d1", "Feast", 1000)], subtotal: 1000, total: 1000 });
  const billD = await GetBillForTable(RES_ID, "R4");
  const cardPart = r2(Math.floor(billD.grand_total * 0.4 * 100) / 100);
  const cashPart = r2(billD.grand_total - cardPart);
  const tenderState = await RecordBillTenders(RES_ID, {
    table_name: "R4", settled_by_username: "admin", require_full: true,
    tenders: [
      { method: "Card", amount: cardPart, txn_ref: "auth-9", tip_amount: 75, tip_mode: "card", tip_credited_to_username: "admin" },
      { method: "Cash", amount: cashPart, tip_amount: 25, tip_mode: "cash", tip_credited_to_username: "admin" },
    ],
  });
  // Exactly what routes/bills.ts does on the tender path.
  await ConfirmBillPaymentByWaiter(RES_ID, ordD.id, "admin",
    tenderState.payment_method, null,
    tenderState.payment_splits.length > 0 ? tenderState.payment_splits : undefined);
  await attachTill("R4", till2.id);
  await ApproveBillPaymentByAdmin(RES_ID, ordD.id, "admin");

  // R5 — settled then REFUNDED.
  await OccupyTable(RES_ID, "R5", 2, null, null);
  const ordE = await AddOrder(RES_ID, { table: "R5", customer: "E", status: "Preparing", items: [ITEM("e1", "Tea", 100, 3)], subtotal: 300, total: 300 });
  await GetBillForTable(RES_ID, "R5");
  await ConfirmBillPaymentByWaiter(RES_ID, ordE.id, "admin", "Card");
  await attachTill("R5", till1.id);
  await ApproveBillPaymentByAdmin(RES_ID, ordE.id, "admin");
  await RefundBill(RES_ID, { tableName: "R5", reason: "verifier", byUsername: "admin" });

  // R6 — a CANCELLED order. Never revenue.
  await OccupyTable(RES_ID, "R6", 2, null, null);
  const ordF = await AddOrder(RES_ID, { table: "R6", customer: "F", status: "Preparing", items: [ITEM("f1", "Feast", 1000, 5)], subtotal: 5000, total: 5000 });
  await SetOrderStatus(RES_ID, ordF.id, "Cancelled");

  // R7 — a variation line, settled, on NO till (the "(none)" bucket).
  await OccupyTable(RES_ID, "R7", 2, null, null);
  const ordG = await AddOrder(RES_ID, {
    table: "R7", customer: "G", status: "Preparing",
    items: [{ id: "g1", name: "Feast", price: 600, quantity: 1, menu_id: feast.id, variation_id: half.id }],
    subtotal: 600, total: 600,
  });
  await ConfirmBillPaymentByWaiter(RES_ID, ordG.id, "admin", "Cash");
  await ApproveBillPaymentByAdmin(RES_ID, ordG.id, "admin");

  // R8 — an OPEN bill, never settled. Not revenue.
  await OccupyTable(RES_ID, "R8", 2, null, null);
  await AddOrder(RES_ID, { table: "R8", customer: "H", status: "Preparing", items: [ITEM("h1", "Feast", 1000, 9)], subtotal: 9000, total: 9000 });

  // ===================== THE READS =====================
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const W: any = { from: iso(new Date(today.getTime() - 2 * 86400000)), to: iso(new Date(today.getTime() + 1 * 86400000)) };

  const sales = await GetSalesSummaryReport(RES_ID, W);
  const orders = await GetOrderSummaryReport(RES_ID, { ...W, limit: 500 });
  const settle = await GetSettlementSummaryReport(RES_ID, W);
  const counter = await GetCounterSummaryReport(RES_ID, { ...W, limit: 500 });
  const item = await GetItemWiseReport(RES_ID, { ...W, limit: 500 });
  const group = await GetGroupSummaryReport(RES_ID, { ...W, limit: 500 });
  const varia = await GetVariationSummaryReport(RES_ID, { ...W, limit: 500 });
  const nc = await GetNcSummaryReport(RES_ID, { ...W, limit: 500 });
  const scd = await GetServiceChargeDenyReport(RES_ID, { ...W, limit: 500 });
  const tips = await GetTipSummaryReport(RES_ID, { ...W, limit: 500 });
  const exec = await GetExecutiveSummaryReport(RES_ID, W);
  const cover = await GetCoverSizeSummaryReport(RES_ID, { ...W, limit: 500 });

  console.log("\n--- the window as the reports see it ---");
  console.log(`sales.grand_total     = ${sales.totals.grand_total}`);
  console.log(`Sum order rows        = ${sum(orders.rows.map((r: any) => r.grand_total))}   (${orders.rows.length} rows)`);
  console.log(`Sum settlement rows   = ${sum(settle.rows.map((r: any) => r.amount))}   [${settle.rows.map((r: any) => `${r.method}=${r.amount}`).join(", ")}]`);
  console.log(`Sum counter rows      = ${sum(counter.rows.map((r: any) => r.grand_total))}   [${counter.rows.map((r: any) => `${r.counter_name ?? r.counter_code ?? "(none)"}=${r.grand_total}`).join(", ")}]`);
  console.log(`nc_value=${sales.totals.nc_value}  nc.loss=${nc.totals.loss}  waived=${scd.totals.amount_waived}  tips=${tips.totals.tip_amount}  refunds=${sum(settle.rows.map((r: any) => r.refund))}`);
  console.log(`net=${sales.totals.net} sc=${sales.totals.service_charge} tax=${sales.totals.tax} round=${sales.totals.round_off} covers=${sales.totals.covers} bills=${sales.totals.bills}`);
  console.log(`itemwise gross=${item.totals.gross_amount} nc=${item.totals.nc_value}  group gross=${sum(group.rows.map((r: any) => r.gross_amount))}  variation gross=${varia.totals.gross_amount}`);

  console.log("\n== 2. THE RECONCILIATION ==");
  const G = sales.totals.grand_total;
  check("Sum Order Summary rows === sales.grand_total", near(sum(orders.rows.map((r: any) => r.grand_total)), G), `${sum(orders.rows.map((r: any) => r.grand_total))} vs ${G}`);
  check("Sum Settlement rows === sales.grand_total", near(sum(settle.rows.map((r: any) => r.amount)), G), `${sum(settle.rows.map((r: any) => r.amount))} vs ${G}`);
  check("settle.totals.amount === sales.grand_total", near(settle.totals.amount, G), `${settle.totals.amount} vs ${G}`);
  check("Sum Counter Summary rows === sales.grand_total", near(sum(counter.rows.map((r: any) => r.grand_total)), G), `${sum(counter.rows.map((r: any) => r.grand_total))} vs ${G}`);
  check("Sum Cover Size rows === sales.grand_total", near(sum(cover.rows.map((r: any) => r.grand_total)), G), `${sum(cover.rows.map((r: any) => r.grand_total))} vs ${G}`);
  check("the ladder closes: net + sc + tax + round === grand", near(r2(sales.totals.net + sales.totals.service_charge + sales.totals.tax + sales.totals.round_off), G),
    `${r2(sales.totals.net + sales.totals.service_charge + sales.totals.tax + sales.totals.round_off)} vs ${G}`);
  check("the day series sums to the window total", near(sum(sales.series.map((s: any) => s.grand_total)), G));

  console.log("\n== the window really holds all five events ==");
  check("a comp is in it", nc.rows.length >= 1 && nc.totals.loss > 0, `rows=${nc.rows.length} loss=${nc.totals.loss}`);
  check("a waiver is in it", scd.rows.length >= 1 && scd.totals.amount_waived > 0, `rows=${scd.rows.length} waived=${scd.totals.amount_waived}`);
  check("a split tender with a tip is in it", tips.rows.length >= 2 && near(tips.totals.tip_amount, 100), `rows=${tips.rows.length} tips=${tips.totals.tip_amount}`);
  check("a refund is in it", sum(settle.rows.map((r: any) => r.refund)) > 0, `refunds=${sum(settle.rows.map((r: any) => r.refund))}`);
  const feastQty = item.rows.find((r: any) => r.name === "Feast")?.qty ?? -1;
  check("a cancelled order is in the window and its 5 x Feast are NOT counted", feastQty === 15,
    `feast qty=${feastQty} (20 placed, 5 cancelled -> 15)`);

  console.log("\n== the NC column sits BESIDE the ladder ==");
  check("sales carries nc_value as a column", typeof sales.totals.nc_value === "number");
  check("nc_value === the NC Summary's loss", near(sales.totals.nc_value, nc.totals.loss), `${sales.totals.nc_value} vs ${nc.totals.loss}`);
  check("the comp gave real money away", sales.totals.nc_value > 0);
  check("Item Wise counts the comped food as SOLD (the food was made)", (item.rows.find((r: any) => r.name === "Tea")?.qty ?? 0) >= 4,
    `tea qty=${item.rows.find((r: any) => r.name === "Tea")?.qty}`);
  check("Item Wise reports what it gave away", (item.totals.nc_value ?? 0) > 0, `${item.totals.nc_value}`);
  check("Executive Summary carries nc_value", typeof exec.totals.nc_value === "number", `${exec.totals.nc_value}`);
  check("Executive per-outlet rows sum to the group's nc_value", near(sum((exec.outlets ?? exec.rows ?? []).map((r: any) => r.nc_value)), exec.totals.nc_value),
    `rows=${JSON.stringify((exec.outlets ?? exec.rows ?? []).map((r: any) => r.nc_value))} vs ${exec.totals.nc_value}`);

  console.log("\n== a tip is in NO sales figure ==");
  check("tips were actually recorded", near(tips.totals.tip_amount, 100), `${tips.totals.tip_amount}`);
  const rowR4 = orders.rows.find((r: any) => String(r.table ?? r.table_name ?? "") === "R4");
  check("the tipped bill's Order Summary row excludes the tip", rowR4 ? near(rowR4.grand_total, billD.grand_total) : false,
    rowR4 ? `${rowR4.grand_total} vs bill ${billD.grand_total}` : "R4 row not found");
  check("no settlement row is the tip", !settle.rows.some((r: any) => near(r.amount, 100)));
  check("settlement Unallocated is zero even with a tipped split", near(settle.totals.unallocated ?? 0, 0), `unallocated=${settle.totals.unallocated}`);
  check("APC is net/covers — the tip is not in it", near(sales.totals.apc, r2(sales.totals.net / Math.max(1, sales.totals.covers))),
    `apc=${sales.totals.apc} net/covers=${r2(sales.totals.net / Math.max(1, sales.totals.covers))}`);
  check("ABV is grand/bills — the tip is not in it", near(sales.totals.abv, r2(G / Math.max(1, sales.totals.bills))),
    `abv=${sales.totals.abv} grand/bills=${r2(G / Math.max(1, sales.totals.bills))}`);

  console.log("\n== Group Summary ties to Item Wise ==");
  check("Sum Group rows gross === Item Wise gross", near(sum(group.rows.map((r: any) => r.gross_amount)), item.totals.gross_amount),
    `${sum(group.rows.map((r: any) => r.gross_amount))} vs ${item.totals.gross_amount}`);
  check("Variation Summary is an honest SUBSET of Item Wise", varia.totals.gross_amount <= r2(item.totals.gross_amount) + 0.005,
    `${varia.totals.gross_amount} vs ${item.totals.gross_amount}`);
  check("Variation Summary names the whole-menu gross it is a subset of", near(varia.window_gross ?? item.totals.gross_amount, item.totals.gross_amount),
    `${varia.window_gross} vs ${item.totals.gross_amount}`);

  console.log("\n== Counter Summary ==");
  const noneRow = counter.rows.find((r: any) => r.counter_id == null);
  check("the till-less bill lands in an explicit row, never nowhere", noneRow != null && noneRow.grand_total > 0,
    `rows=${counter.rows.map((r: any) => `${r.counter_name}:${r.counter_id == null ? "null" : "id"}`).join("|")}`);
  check("covers are counted once ACROSS tills", counter.rows.reduce((s: number, r: any) => s + Number(r.covers || 0), 0) === sales.totals.covers,
    `${counter.rows.reduce((s: number, r: any) => s + Number(r.covers || 0), 0)} vs ${sales.totals.covers}`);

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); }
  await raw.end(); await closePools?.();
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
