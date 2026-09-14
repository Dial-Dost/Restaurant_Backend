// Integration tests against a REAL ephemeral Postgres (not pure functions).
//
// Exercises high-blast-radius money/DB flows end-to-end — the things unit tests
// can't reach: transactions, the atomic waitlist seat, settle-closes-all-orders,
// refund idempotency, coupon single-redeem. Run against a throwaway local
// Postgres (e.g. `docker run postgres:16`), NEVER prod.
//
//   SUPABASE_DIRECT_URL=postgres://postgres:postgres@localhost:55432/itest \
//   MIGRATION_DATABASE_URL=$SUPABASE_DIRECT_URL QR_SIGNING_SECRET=test \
//   ALLOW_DEV_QR_SECRET=true NODE_ENV=test npx tsx test/integration/money_integration_test.ts
//
// (apply migrations first: `npm run migrate`.)
//
// NOTE: each backend fn manages its own transaction, so we call them directly
// (no outer withTenant) and assert via a 2nd connection AFTER each call commits —
// reading the same tables while inside a fn's open txn would deadlock against its
// ensure*Table DDL (ACCESS EXCLUSIVE) locks. As the local superuser, RLS is
// bypassed; isolation under app_runtime is covered by the RLS verification.
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.SUPABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? "";

// SAFETY: only ever run against a local/throwaway DB. Refuse anything remote.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/i.test(DB) || /[?&]sslmode=disable/i.test(DB);
if (!DB) { console.log("money_integration_test: no DB configured — skipping."); process.exit(0); }
if (!isLocal && process.env.ALLOW_REMOTE_INTEGRATION !== "i-know-what-im-doing") {
  console.error("money_integration_test: REFUSING to run against a non-local DB (it mutates data). Point SUPABASE_DIRECT_URL at a throwaway local Postgres.");
  process.exit(1);
}

const db: any = await import("../../database_supabase.js");
const {
  EnsureRestaurantSeed, closePools,
  JoinWaitlist, SeatWaitlistEntry, GetWaitlist, SetWaitlistPreorder,
  OccupyTable, AddOrder, DeleteOrder, ConfirmBillPaymentByWaiter, ApproveBillPaymentByAdmin, RefundBill,
  UpsertCoupon, ApplyCouponToBill,
  ReleaseTable, GetSalesReport, SetBillDiscount,
  // MIS data capture (migrations 034-039).
  GetBillForTable, BarkOrder, SetOrderStatus,
  MarkOrderItemNonChargeable, ReverseNonChargeable, GetNonChargeableEntries,
  RecordOrderVoid, GetOrderVoidRecords,
  WaiveServiceCharge, ReverseServiceChargeWaiver, GetServiceChargeWaivers,
  RecordBillTenders, GetBillTenderState, VoidBillTender,
  UpsertBillingCounter, ListBillingCounters, SetBillCounter,
  UpsertMenuGroup, UpsertMenuVariation, SetMenuGroupAssignment,
  GetMenuAttributionIndex, attributeOrderLine, UpsertMenuItem,
} = db;

const raw = new pg.Pool({ connectionString: DB, ssl: false, max: 3 });
let RES_ID = "";

let passed = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  assert.ok(cond, label);
  passed++;
}
async function tableOccupied(name: string): Promise<boolean> {
  const r = await raw.query(`select coalesce(is_occupied,false) occ from "Tables" where res_id=$1 and lower(table_name)=lower($2) limit 1`, [RES_ID, name]);
  return r.rows[0]?.occ === true;
}
async function tableId(name: string): Promise<string> {
  return (await raw.query(`select id from "Tables" where res_id=$1 and lower(table_name)=lower($2) limit 1`, [RES_ID, name])).rows[0].id;
}
async function orderCounts(name: string): Promise<{ total: number; open: number }> {
  const tid = await tableId(name);
  const total = Number((await raw.query(`select count(*)::int n from "Orders" where res_id=$1 and table_id=$2`, [RES_ID, tid])).rows[0].n);
  const open = Number((await raw.query(`select count(*)::int n from "Orders" where res_id=$1 and table_id=$2 and coalesce(status::text,'1') not in ('4','5','7')`, [RES_ID, tid])).rows[0].n);
  return { total, open };
}
async function billClosed(name: string): Promise<boolean> {
  const tid = await tableId(name);
  const r = await raw.query(`select closed_at from "Bills" where res_id=$1 and table_id=$2 order by created_at desc limit 1`, [RES_ID, tid]);
  return r.rows[0]?.closed_at != null;
}

const ITEM = (id: string, name: string, price: number) => ({ id, name, price, quantity: 1 });

async function main() {
  console.log("Seeding throwaway restaurant...");
  await EnsureRestaurantSeed({
    name: `ITest ${randomUUID().slice(0, 8)}`,
    admin: { employeeId: "admin", name: "Admin", password: "test1234" },
    // T6 included: the release-without-payment section below occupies it, and a
    // missing table surfaces as "Table not found" from OccupyTable — which reads
    // like a product bug rather than a seed that is one row short.
    // T13-T15: the payment-modes section at the end.
    tables: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14", "T15"].map((n) => ({ name: n, capacity: 4 })),
  });
  RES_ID = (await raw.query(`select id from "Restaurant" order by created_at desc limit 1`)).rows[0].id;
  console.log("seeded res_id:", RES_ID);

  // ---- 1) Waitlist: atomic seat + guards ----
  console.log("\n[waitlist] atomic seat + double-seat + occupied-table guards");
  // 10 digits, no country code. These were "+10000000001" — a US-shaped number
  // that normalizeMobile10() rejects: it strips to 11 digits, and "1" is not a
  // peelable prefix (only 0091 / 91 / a trunk 0 are). The product rule is an
  // Indian 10-digit mobile, so the fixture was wrong, not the validator.
  const a = await JoinWaitlist(RES_ID, { name: "Walk-in A", phone: "9000000001", party_size: 2 });
  check("join returns a token + position >= 1", !!a.token && a.position >= 1);
  await SetWaitlistPreorder(RES_ID, a.token, [{ id: "ghost", name: "Free Steak", price: 0, quantity: 3 }]);
  const seat = await SeatWaitlistEntry(RES_ID, a.id, "T1");
  check("seat succeeds", seat.success === true);
  check("menu-less pre-order placed no order (unknown items dropped)", seat.placed_order_id === null);
  check("table T1 is now occupied", await tableOccupied("T1"));
  check("seated entry left the active queue", !(await GetWaitlist(RES_ID)).some((e: any) => e.id === a.id));
  let rejected = false;
  try { await SeatWaitlistEntry(RES_ID, a.id, "T2"); } catch (e: any) { rejected = /no longer in the queue/i.test(String(e?.message)); }
  check("double-seat of the same party is rejected", rejected);
  check("T2 not occupied by the rejected double-seat", !(await tableOccupied("T2")));
  const b = await JoinWaitlist(RES_ID, { name: "Walk-in B", phone: "9000000002", party_size: 2 });
  let blocked = false;
  try { await SeatWaitlistEntry(RES_ID, b.id, "T1"); } catch (e: any) { blocked = /already occupied/i.test(String(e?.message)); }
  check("seating onto occupied T1 is blocked", blocked);
  check("the blocked party stays queued (seat rolled back)", (await GetWaitlist(RES_ID)).some((e: any) => e.id === b.id));

  // ---- 2) Settle closes ALL of a table's orders (the original money bug) ----
  console.log("\n[settle] confirming + approving payment closes ALL orders on the table");
  await OccupyTable(RES_ID, "T3", 2, null, null);
  const o1 = await AddOrder(RES_ID, { table: "T3", customer: "Guest", items: [ITEM("i1", "Tea", 50)], subtotal: 50, total: 50, status: "Preparing" });
  await AddOrder(RES_ID, { table: "T3", customer: "Guest", items: [ITEM("i2", "Cake", 80)], subtotal: 80, total: 80, status: "Preparing" });
  const before = await orderCounts("T3");
  check("two open orders exist before settle", before.total === 2 && before.open === 2);
  await ConfirmBillPaymentByWaiter(RES_ID, o1.id, "admin", "Cash");
  await ApproveBillPaymentByAdmin(RES_ID, o1.id, "admin");
  const after = await orderCounts("T3");
  check("ALL orders on the table are closed after settle (no open siblings)", after.total === 2 && after.open === 0);
  check("the bill is closed", await billClosed("T3"));
  check("the settled table is freed", !(await tableOccupied("T3")));

  // ---- 3) Refund idempotency ----
  console.log("\n[refund] a settled bill refunds once, second attempt rejected");
  const r1 = await RefundBill(RES_ID, { tableName: "T3", reason: "itest", byUsername: "admin" });
  check("refund succeeds with a positive amount", r1.success === true && r1.amount > 0);
  let refundBlocked = false;
  try { await RefundBill(RES_ID, { tableName: "T3", reason: "again", byUsername: "admin" }); } catch (e: any) { refundBlocked = /already been refunded/i.test(String(e?.message)); }
  check("a second refund is rejected (idempotent)", refundBlocked);
  const tid3 = await tableId("T3");
  const refundedRows = Number((await raw.query(`select count(*)::int n from "Bills" where res_id=$1 and table_id=$2 and refunded_at is not null`, [RES_ID, tid3])).rows[0].n);
  check("exactly one bill is marked refunded", refundedRows === 1);

  // ---- 4) Coupon single-redeem (usage_limit enforced) ----
  console.log("\n[coupon] usage_limit=1 allows one redemption, blocks the next");
  await UpsertCoupon(RES_ID, { code: "SAVE10", type: "percent", value: 10, usage_limit: 1, per_customer_limit: 1, active: true });
  await OccupyTable(RES_ID, "T4", 2, null, null);
  const o4 = await AddOrder(RES_ID, { table: "T4", customer: "C4", items: [ITEM("m1", "Meal", 200)], subtotal: 200, total: 200, status: "Preparing" });
  const c1 = await ApplyCouponToBill(RES_ID, "T4", "SAVE10", "+19990001111");
  check("coupon applies: 10% of 200 = 20", c1.success === true && c1.discount === 20);
  await OccupyTable(RES_ID, "T5", 2, null, null);
  await AddOrder(RES_ID, { table: "T5", customer: "C5", items: [ITEM("m2", "Meal", 100)], subtotal: 100, total: 100, status: "Preparing" });
  let couponBlocked = false;
  try { await ApplyCouponToBill(RES_ID, "T5", "SAVE10", "+19990002222"); } catch (e: any) { couponBlocked = /usage limit/i.test(String(e?.message)); }
  check("coupon usage_limit=1 blocks the second redemption", couponBlocked);

  // ---- 5) Refund reverses the coupon redemption (usage freed) ----
  console.log("\n[coupon] refunding a coupon'd bill frees the redemption back");
  const usedBefore = Number((await raw.query(`select used_count from "Coupons" where res_id=$1 and upper(code)='SAVE10'`, [RES_ID])).rows[0].used_count);
  await ConfirmBillPaymentByWaiter(RES_ID, o4.id, "admin", "Cash");
  await ApproveBillPaymentByAdmin(RES_ID, o4.id, "admin");
  await RefundBill(RES_ID, { tableName: "T4", reason: "itest", byUsername: "admin" });
  const usedAfter = Number((await raw.query(`select used_count from "Coupons" where res_id=$1 and upper(code)='SAVE10'`, [RES_ID])).rows[0].used_count);
  check("refund decremented the coupon used_count", usedAfter === usedBefore - 1);
  const redemptions = Number((await raw.query(`select count(*)::int n from "CouponRedemptions" where res_id=$1`, [RES_ID])).rows[0].n);
  check("the coupon redemption row is removed on refund", redemptions === 0);

  // ---- 5b) Releasing a table without payment must NOT book revenue ----
  // This one exists because the unit suite could not fail on it: the fixture
  // hard-coded the post-fix row (total_amt 0), so it only proved that zero sums
  // to zero. The bug lives at the WRITE site -- ReleaseTable used to stamp
  // closed_at on the running bill and leave total_amt holding the pre-tax
  // subtotal, and every revenue reader keys on closed_at. Only a real write can
  // catch a regression there, so it is asserted here against real Postgres.
  console.log("\n[release] a table released without payment is not revenue");
  await OccupyTable(RES_ID, "T6", 2, null, null);
  await AddOrder(RES_ID, { table: "T6", customer: "Walkout", items: [ITEM("w1", "Soup", 300)], subtotal: 300, total: 300, status: "Preparing" });
  // Materialise the running bill, because occupying a table and adding orders
  // does NOT create one: AddOrder syncs "the table's open bill (if one exists)"
  // and GetBillForTable returns `bill_id: string | null`, deriving the running
  // total from the orders themselves. A "Bills" row appears only when some
  // operation needs one — ensureOpenBillIdForTable, reached here by clearing a
  // discount, which is the cheapest product action that materialises it without
  // moving any money (it inserts with sumOrderTotalsForTable already applied).
  //
  // Without this the section asserted a precondition the flow never establishes
  // and died on it, so the release assertion below — the one that actually
  // guards the revenue bug — had never run.
  await SetBillDiscount(RES_ID, "T6", null, 0);

  const tid6 = await tableId("T6");
  const runningBefore = Number((await raw.query(
    `select coalesce(total_amt, 0) as t from "Bills" where res_id=$1 and table_id=$2 and closed_at is null`,
    [RES_ID, tid6],
  )).rows[0]?.t ?? 0);
  check("the open bill carries a non-zero running total before release", runningBefore > 0);

  // Reported sales BEFORE the release is the only baseline that makes the
  // assertion below meaningful: the bug was that releasing ADDED revenue.
  const salesBefore = Number((await GetSalesReport(RES_ID)).total_sales ?? 0);

  await ReleaseTable(RES_ID, "T6");

  const relRow = (await raw.query(
    `select total_amt, tax_breakdown::text as tb, closed_at, admin_approved_at
       from "Bills" where res_id=$1 and table_id=$2 order by created_at desc limit 1`,
    [RES_ID, tid6],
  )).rows[0];
  check("released bill carries no money", Number(relRow?.total_amt ?? -1) === 0);
  check("released bill has an empty tax breakdown", String(relRow?.tb ?? "") === "[]");
  check("released bill was never admin-approved", relRow?.admin_approved_at == null);

  // The assertion that actually matters to the owner: releasing a table nobody
  // paid for must not move reported revenue by a single paisa.
  const salesAfter = Number((await GetSalesReport(RES_ID)).total_sales ?? 0);
  check("releasing an unpaid table does not change reported sales",
    Math.abs(salesAfter - salesBefore) < 0.005);
  const countedReleased = Number((await raw.query(
    `select count(*)::int n from "Bills"
      where res_id=$1 and table_id=$2 and closed_at is not null and coalesce(total_amt,0) <> 0`,
    [RES_ID, tid6],
  )).rows[0].n);
  check("no closed bill on the released table carries money", countedReleased === 0);
  check("the released table is freed", !(await tableOccupied("T6")));

  // ---- 6) DeleteOrder returns true + actually deletes (was always 404) ----
  console.log("\n[orders] DeleteOrder succeeds and removes the row");
  await OccupyTable(RES_ID, "T2", 2, null, null);
  const od = await AddOrder(RES_ID, { table: "T2", customer: "D", items: [ITEM("d1", "Soda", 40)], subtotal: 40, total: 40, status: "Preparing" });
  const del = await DeleteOrder(RES_ID, od.id);
  check("DeleteOrder returns true on success", del === true);
  const stillThere = Number((await raw.query(`select count(*)::int n from "Orders" where id=$1`, [od.id])).rows[0].n);
  check("the deleted order row is gone", stillThere === 0);


  // =========================================================================
  // MIS DATA CAPTURE (migrations 034-039) — the money-critical halves, against
  // the real database rather than against the pure functions alone.
  // =========================================================================

  // ---- 7) NON-CHARGEABLE: a comped line is not charged, and is recoverable --
  console.log("\n[nc] a comped item comes out of the bill and stays counted");
  // The control: the SAME order without the comped line at all.
  await OccupyTable(RES_ID, "T7", 2, null, null);
  await AddOrder(RES_ID, {
    table: "T7", customer: "Control", status: "Preparing",
    items: [ITEM("c1", "Tea", 50), ITEM("c2", "Cake", 80)], subtotal: 130, total: 130,
  });
  const control = await GetBillForTable(RES_ID, "T7");

  await OccupyTable(RES_ID, "T8", 2, null, null);
  const ncOrder = await AddOrder(RES_ID, {
    table: "T8", customer: "Comped", status: "Preparing",
    items: [ITEM("n1", "Tea", 50), ITEM("n2", "Cake", 80), ITEM("n3", "Barfi", 120)],
    subtotal: 250, total: 250,
  });
  const beforeNc = await GetBillForTable(RES_ID, "T8");
  check("the un-comped table is worth more than the control", beforeNc.grand_total > control.grand_total);

  const nc = await MarkOrderItemNonChargeable(RES_ID, {
    order_id: ncOrder.id, item_id: "n3", nc_kind: "guest_complaint",
    reason: "dessert came out cold",
    actor: { username: "waiter1", authorised_by_username: "manager1" },
  });
  check("the NC ledger row snapshots the loss at menu price x qty", nc.record.value === 120);
  check("the NC row records who authorised it", nc.record.authorised_by_username === "manager1");

  const afterNc = await GetBillForTable(RES_ID, "T8");
  // THE HEADLINE ASSERTION: the bill with one NC item equals the bill without it.
  check("BILL WITH AN NC ITEM === BILL WITHOUT THAT ITEM (pre-tax)",
    Math.abs(afterNc.subtotal - control.subtotal) < 0.005);
  check("...and at the grand total, through service charge and tax",
    Math.abs(afterNc.grand_total - control.grand_total) < 0.005);
  check("the comped value is separately recoverable off the bill", afterNc.nc_total === 120);
  check("the comped line is still SHOWN on the bill, flagged",
    afterNc.items.some((i: any) => i.nc === true && i.name === "Barfi"));
  check("...and the chargeable lines are not merged into it",
    afterNc.items.filter((i: any) => i.name === "Barfi").length === 1);

  // THE OPEN BILL ROW MUST BE RE-SYNCED TOO, or the bill on screen and the bill
  // in the database disagree until some unrelated edit happens to refresh it.
  // A "Bills" row only exists once a bill has been generated / discounted /
  // couponed / settled, so mint one deliberately (a discount does it) and then
  // comp a second line against it.
  const t8 = await tableId("T8");
  await SetBillDiscount(RES_ID, "T8", "flat", 10);
  const rowBeforeSecondComp = Number((await raw.query(
    `select total_amt from "Bills" where res_id=$1 and table_id=$2 and closed_at is null order by created_at desc limit 1`,
    [RES_ID, t8],
  )).rows[0].total_amt);
  const nc2 = await MarkOrderItemNonChargeable(RES_ID, {
    order_id: ncOrder.id, item_id: "n2", nc_kind: "staff_meal",
    reason: "shift meal for the chef",
    actor: { username: "waiter1", authorised_by_username: "manager1" },
  });
  const rowAfterSecondComp = Number((await raw.query(
    `select total_amt from "Bills" where res_id=$1 and table_id=$2 and closed_at is null order by created_at desc limit 1`,
    [RES_ID, t8],
  )).rows[0].total_amt);
  check("comping a line RE-SYNCS the open bill row by exactly the comped value",
    Math.abs((rowBeforeSecondComp - rowAfterSecondComp) - 80) < 0.005);
  await ReverseNonChargeable(RES_ID, nc2.record.id, { reason: "wrong line", by_username: "manager1" });
  const rowAfterReverse = Number((await raw.query(
    `select total_amt from "Bills" where res_id=$1 and table_id=$2 and closed_at is null order by created_at desc limit 1`,
    [RES_ID, t8],
  )).rows[0].total_amt);
  check("...and reversing it puts the same money back on the bill row",
    Math.abs(rowAfterReverse - rowBeforeSecondComp) < 0.005);
  await SetBillDiscount(RES_ID, "T8", "flat", 0);

  // A CLIENT CANNOT COMP A DISH BY EDITING ITS OWN PAYLOAD. Re-post the order
  // with nc:true on a line that has no ledger row behind it.
  await AddOrder(RES_ID, {
    table: "T8", id: ncOrder.id, customer: "Comped", status: "Preparing",
    items: [
      { id: "n1", name: "Tea", price: 50, quantity: 1, nc: true },
      { id: "n2", name: "Cake", price: 80, quantity: 1 },
      { id: "n3", name: "Barfi", price: 120, quantity: 1 },
    ],
    subtotal: 250, total: 250,
  });
  const afterForge = await GetBillForTable(RES_ID, "T8");
  check("a client-supplied nc flag is STRIPPED — the tea is still charged",
    !afterForge.items.some((i: any) => i.name === "Tea" && i.nc === true));
  check("...while the SERVER's existing comp survives the same write",
    afterForge.items.some((i: any) => i.name === "Barfi" && i.nc === true));
  check("...so the bill is unchanged by the attempt",
    Math.abs(afterForge.subtotal - afterNc.subtotal) < 0.005);

  // Reversing puts the money back.
  await ReverseNonChargeable(RES_ID, nc.record.id, { reason: "manager overruled", by_username: "manager1" });
  const afterReverse = await GetBillForTable(RES_ID, "T8");
  check("reversing a comp restores the charge",
    Math.abs(afterReverse.subtotal - beforeNc.subtotal) < 0.005);
  check("...and the bill carries no comped value any more", afterReverse.nc_total === 0);
  const ncLedger = await GetNonChargeableEntries(RES_ID, "1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
  check("the reversed row is KEPT, not deleted — the argument stays visible",
    ncLedger.rows.some((r: any) => r.id === nc.record.id && r.reversed_at !== null));
  check("a reversed comp contributes no money to the live NC total", ncLedger.total_value === 0);
  check("...but its value is still reported as reversed", ncLedger.reversed_value === 200);

  // ---- 8) SERVICE CHARGE WAIVER, in BOTH tax shapes ----------------------
  console.log("\n[service charge] waiving works in both tax shapes");
  const OUTLET_ID = (await raw.query(`select id from "Outlets" where res_id=$1 limit 1`, [RES_ID])).rows[0].id;
  const setShapeB = async () => {
    await raw.query(`update "Outlets" set default_tax = $2::json where id=$1`,
      [OUTLET_ID, JSON.stringify({ SGST: 2.5, CGST: 2.5, "Service Charge": 10 })]);
    await raw.query(`update "Restaurant" set service_charge = 0 where id=$1`, [RES_ID]);
  };
  const setShapeA = async () => {
    await raw.query(`update "Outlets" set default_tax = $2::json where id=$1`,
      [OUTLET_ID, JSON.stringify({ SGST: 2.5, CGST: 2.5 })]);
    await raw.query(`update "Restaurant" set service_charge = 10 where id=$1`, [RES_ID]);
  };

  for (const [shape, apply, table] of [["b (tax line)", setShapeB, "T9"], ["a (Restaurant.service_charge)", setShapeA, "T10"]] as const) {
    await apply();
    await OccupyTable(RES_ID, table, 2, null, null);
    await AddOrder(RES_ID, {
      table, customer: "SC", status: "Preparing",
      items: [ITEM(`sc-${table}`, "Thali", 2400)], subtotal: 2400, total: 2400,
    });
    const withSc = await GetBillForTable(RES_ID, table);
    // WHERE THE CHARGE APPEARS DIFFERS BY SHAPE ON AN *OPEN* BILL, and this is
    // pre-existing behaviour that these migrations deliberately do not change:
    // computeBillCharges only knows about "Restaurant".service_charge, so in
    // shape (b) the charge is still sitting inside `taxes` as the line it is
    // configured as. (closedBillCharges lifts it out on the READ side of a
    // SETTLED bill — see its header.) Either way it is money the guest owes, and
    // either way the waiver has to remove it.
    const scOnBill = (b: any) =>
      Number(b.service_charge ?? 0)
      + (b.taxes ?? []).filter((t: any) => /service\s*charge/i.test(String(t.name)))
        .reduce((a: number, t: any) => a + Number(t.amount ?? 0), 0);
    check(`shape ${shape}: the bill carries a service charge before the waiver`,
      Math.abs(scOnBill(withSc) - 240) < 0.005);

    const w = await WaiveServiceCharge(RES_ID, {
      table_name: table, waiver_kind: "guest_request", reason: "guest asked for it to be removed",
      actor: { username: "waiter1", authorised_by_username: "manager1" },
    });
    check(`shape ${shape}: the waiver records 10% of 2400`, w.record.amount_waived === 240);
    check(`shape ${shape}: basis is named correctly`,
      w.record.basis === (table === "T9" ? "tax_line" : "restaurant_percent"));
    // Shape (a) also drops the GST that sat ON the charge; shape (b) cannot.
    check(`shape ${shape}: tax_on_waived is ${table === "T9" ? "structurally 0" : "the tax that sat on the charge"}`,
      table === "T9" ? w.record.tax_on_waived === 0 : w.record.tax_on_waived > 0);

    const waived = await GetBillForTable(RES_ID, table);
    check(`shape ${shape}: the bill now charges no service charge, in either place`,
      scOnBill(waived) === 0);
    check(`shape ${shape}: the bill says WHY it is zero`, waived.service_charge_waived === true);
    check(`shape ${shape}: the grand total dropped by EXACTLY the recorded reduction`,
      Math.abs((withSc.grand_total - waived.grand_total) - w.record.grand_total_reduction) < 0.005);
    check(`shape ${shape}: the reported before/after match the bill view`,
      Math.abs(w.grand_total_before - withSc.grand_total) < 0.005
      && Math.abs(w.grand_total_after - waived.grand_total) < 0.005);

    // THE WHOLE POINT: settling must charge the waived total, not the original.
    const scOrderId = (await raw.query(
      `select id from "Orders" where res_id=$1 and table_id=$2 order by created_at desc limit 1`,
      [RES_ID, await tableId(table)],
    )).rows[0].id;
    await ConfirmBillPaymentByWaiter(RES_ID, scOrderId, "admin", "Cash");
    const confirmedTotal = Number((await raw.query(
      `select total_amt from "Bills" where res_id=$1 and table_id=$2 order by created_at desc limit 1`,
      [RES_ID, await tableId(table)],
    )).rows[0].total_amt);
    check(`shape ${shape}: SETTLE CHARGES THE WAIVED TOTAL, not the original`,
      Math.abs(confirmedTotal - waived.grand_total) < 0.005);
    await ApproveBillPaymentByAdmin(RES_ID, scOrderId, "admin");
  }
  const waivers = await GetServiceChargeWaivers(RES_ID, "1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
  check("both waivers are reportable", waivers.rows.length === 2 && waivers.total_waived === 480);

  // ---- 9) TENDERS: a three-way split of an odd amount, end to end --------
  console.log("\n[tenders] N payments must reconstruct the grand total exactly");
  await setShapeB();
  await OccupyTable(RES_ID, "T11", 3, null, null);
  const tOrder = await AddOrder(RES_ID, {
    table: "T11", customer: "Split", status: "Preparing",
    items: [ITEM("t1", "Feast", 1000)], subtotal: 1000, total: 1000,
  });
  const tBill = await GetBillForTable(RES_ID, "T11");
  const state0 = await GetBillTenderState(RES_ID, { table_name: "T11" });
  check("an open bill starts fully outstanding",
    state0.tenders.length === 0 && Math.abs(state0.outstanding - tBill.grand_total) < 0.005);

  // A PARTIAL settlement is a legal state on an open bill.
  await RecordBillTenders(RES_ID, {
    table_name: "T11", settled_by_username: "cashier1",
    tenders: [{ method: "Cash", amount: 100 }],
  });
  const statePartial = await GetBillTenderState(RES_ID, { table_name: "T11" });
  check("a short tender on an OPEN bill is a partial settlement, not an error",
    statePartial.partial === true && statePartial.exact === false);

  // Over-tendering is refused: change is cash, not a tender.
  let overRefused = false;
  try {
    await RecordBillTenders(RES_ID, {
      table_name: "T11", settled_by_username: "cashier1",
      tenders: [{ method: "Cash", amount: tBill.grand_total }],
    });
  } catch (e: any) { overRefused = /more than the bill/i.test(String(e?.message)); }
  check("over-tendering is refused", overRefused);

  // Finish it off in a three-way split whose parts must land on the paisa.
  const remaining = statePartial.outstanding;
  const third = Math.floor((remaining / 3) * 100) / 100;
  const last = Math.round((remaining - third * 2) * 100) / 100;
  const full = await RecordBillTenders(RES_ID, {
    table_name: "T11", settled_by_username: "cashier1", require_full: true,
    tenders: [
      { method: "Card", amount: third, txn_ref: "auth-1", tip_amount: 50, tip_mode: "card", tip_credited_to_username: "waiter1" },
      { method: "Upi", amount: third, txn_ref: "rrn-2" },
      { method: "Cash", amount: last },
    ],
  });
  check("the four tenders reconstruct the grand total EXACTLY", full.exact === true && full.outstanding === 0);
  check("the tip is recorded on top of the bill, not inside it", full.tips_total === 50);
  check("the compatibility mirror says Split", full.payment_method === "Split");
  const mirrored = (await raw.query(
    `select payment_method, payment_splits::text as ps from "Bills" where res_id=$1 and table_id=$2 order by created_at desc limit 1`,
    [RES_ID, await tableId("T11")],
  )).rows[0];
  check("Bills.payment_method / payment_splits were mirrored for every existing reader",
    String(mirrored.payment_method) === "Split" && String(mirrored.ps).includes("Card"));
  const mirroredSum = JSON.parse(String(mirrored.ps)).reduce((a: number, p: any) => a + Number(p.amount), 0);
  check("the mirrored splits sum back to the bill total",
    Math.abs(mirroredSum - tBill.grand_total) < 0.005);

  // Voiding one tender of a settled split leaves the bill short. TWO guards can
  // catch that and either is a correct refusal: the pre-existing payment_splits
  // check (the mirror is rewritten by the void, so the parts no longer add up)
  // and the tender assertion added for migration 037. Assert the REFUSAL, not
  // which guard won — pinning the message would make this test fail the day the
  // order of two correct checks changes.
  await VoidBillTender(RES_ID, full.tenders.filter((t: any) => t.voided_at === null)[0].id,
    { reason: "keyed twice", by_username: "manager1" });
  let settleRefused = false;
  try { await ApproveBillPaymentByAdmin(RES_ID, tOrder.id, "admin"); }
  catch (e: any) { settleRefused = /recorded tenders add up|split payment no longer matches/i.test(String(e?.message)); }
  check("settling a bill whose tenders no longer add up is refused", settleRefused);
  const stillOpen = Number((await raw.query(
    `select count(*)::int n from "Bills" where res_id=$1 and table_id=$2 and closed_at is null`,
    [RES_ID, await tableId("T11")],
  )).rows[0].n);
  check("...and the bill is still open", stillOpen === 1);

  // DEFENCE 2 ON ITS OWN. A SINGLE short tender leaves payment_splits empty, so
  // the pre-existing split check does not fire at all and only the tender
  // assertion stands between a partially-paid bill and a closed_at. This is the
  // case migration 037's header says the deferred database trigger cannot see:
  // the tenders were written in one transaction and the close happens in a later
  // one that never touches "BillTenders".
  await OccupyTable(RES_ID, "T12", 2, null, null);
  const shortOrder = await AddOrder(RES_ID, {
    table: "T12", customer: "Short", status: "Preparing",
    items: [ITEM("s1", "Platter", 800)], subtotal: 800, total: 800,
  });
  await RecordBillTenders(RES_ID, {
    table_name: "T12", settled_by_username: "cashier1",
    tenders: [{ method: "Cash", amount: 100 }],
  });
  await ConfirmBillPaymentByWaiter(RES_ID, shortOrder.id, "admin", "Cash");
  let defence2 = false;
  try { await ApproveBillPaymentByAdmin(RES_ID, shortOrder.id, "admin"); }
  catch (e: any) { defence2 = /recorded tenders add up/i.test(String(e?.message)); }
  check("SETTLING A SHORT-TENDERED BILL IS REFUSED (defence 2, in code)", defence2);
  const t12Open = Number((await raw.query(
    `select count(*)::int n from "Bills" where res_id=$1 and table_id=$2 and closed_at is null`,
    [RES_ID, await tableId("T12")],
  )).rows[0].n);
  check("...and that bill is still open too", t12Open === 1);

  // Paying the rest lets it settle — the guard blocks a short bill, not every bill.
  const owed = (await GetBillTenderState(RES_ID, { table_name: "T12" })).outstanding;
  await RecordBillTenders(RES_ID, {
    table_name: "T12", settled_by_username: "cashier1", require_full: true,
    tenders: [{ method: "Upi", amount: owed }],
  });
  await ApproveBillPaymentByAdmin(RES_ID, shortOrder.id, "admin");
  check("once the balance is tendered the same bill settles", await billClosed("T12"));

  // ---- 10) VOID STAGE, derived at each of the three stages ---------------
  console.log("\n[void] the stage is derived from server-held facts, not self-reported");
  const voidActor = { username: "waiter1", authorised_by_username: "manager1" };

  // before_print: rung up, never barked, no bill on the table.
  await OccupyTable(RES_ID, "T4", 2, null, null);
  const vBefore = await AddOrder(RES_ID, {
    table: "T4", customer: "V1", status: "Preparing",
    items: [ITEM("v1", "Soup", 90)], subtotal: 90, total: 90,
  });
  const rBefore = await RecordOrderVoid(RES_ID, {
    order_id: vBefore.id, void_kind: "wrong_entry", reason: "wrong table", actor: voidActor,
  });
  check("stage before_print when nothing was barked and no bill exists", rBefore.stage === "before_print");
  check("...and the evidence is honestly empty", Object.keys(rBefore.stage_evidence).length === 0);
  check("...and the voided value was snapshotted", rBefore.value_voided === 90);
  await SetOrderStatus(RES_ID, vBefore.id, "Cancelled");

  // after_print: the expo barked it to the kitchen.
  const vPrint = await AddOrder(RES_ID, {
    table: "T4", customer: "V2", status: "Preparing",
    items: [ITEM("v2", "Naan", 60)], subtotal: 60, total: 60,
  });
  await BarkOrder(RES_ID, vPrint.id, "expo");
  const rPrint = await RecordOrderVoid(RES_ID, {
    order_id: vPrint.id, void_kind: "kitchen_error", reason: "burnt", actor: voidActor,
  });
  check("stage after_print once the order was barked to the kitchen", rPrint.stage === "after_print");
  check("...and the bark instant is the evidence", typeof (rPrint.stage_evidence as any).barked_at === "string");
  await SetOrderStatus(RES_ID, vPrint.id, "Cancelled");

  // after_bill: a bill exists on the table. THE FRAUD SIGNAL.
  await OccupyTable(RES_ID, "T5", 2, null, null);
  const vBill = await AddOrder(RES_ID, {
    table: "T5", customer: "V3", status: "Preparing",
    items: [ITEM("v3", "Biryani", 340)], subtotal: 340, total: 340,
  });
  await BarkOrder(RES_ID, vBill.id, "expo");
  // Applying a discount mints the bill row — i.e. the guest has a bill.
  await SetBillDiscount(RES_ID, "T5", "percent", 5);
  const rBill = await RecordOrderVoid(RES_ID, {
    order_id: vBill.id, void_kind: "other", reason: "guest walked out", actor: voidActor,
  });
  check("stage after_bill once a bill exists — and it OUTRANKS the bark",
    rBill.stage === "after_bill");
  check("...and the bill is named in the evidence, re-checkable",
    typeof (rBill.stage_evidence as any).bill_id === "string"
    && typeof (rBill.stage_evidence as any).barked_at === "string");

  // A double-tapped void keeps the FIRST reason.
  const rAgain = await RecordOrderVoid(RES_ID, {
    order_id: vBill.id, void_kind: "duplicate", reason: "double tap", actor: voidActor,
  });
  check("a repeated void returns the existing record rather than overwriting the reason",
    rAgain.id === rBill.id && rAgain.reason === "guest walked out");

  const voids = await GetOrderVoidRecords(RES_ID, "1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
  check("all three stages are reportable, with their money",
    voids.by_stage.before_print.count === 1
    && voids.by_stage.after_print.count === 1
    && voids.by_stage.after_bill.count === 1);

  // An unauthorised void is refused outright — the whole point of the control.
  let unauthorised = false;
  try {
    await RecordOrderVoid(RES_ID, {
      order_id: vBefore.id, void_kind: "other", reason: "no approver",
      actor: { username: "waiter1", authorised_by_username: "" },
    });
  } catch (e: any) { unauthorised = /authoriser/i.test(String(e?.message)); }
  check("a void with no authoriser is refused", unauthorised);

  // ---- 11) COUNTERS + MENU GROUPS/VARIATIONS -----------------------------
  console.log("\n[counters/menu] tills, groups and variations");
  const counter = await UpsertBillingCounter(RES_ID, { code: "C1", name: "Counter 1", kind: "counter" });
  check("a counter is created", counter.code === "C1" && counter.active === true);
  const sameCode = await UpsertBillingCounter(RES_ID, { code: "c1", name: "Renamed" });
  check("the same code in a different case UPDATES rather than duplicating",
    sameCode.id === counter.id && (await ListBillingCounters(RES_ID)).length === 1);
  const t11Bill = (await raw.query(
    `select id from "Bills" where res_id=$1 and table_id=$2 order by created_at desc limit 1`,
    [RES_ID, await tableId("T11")],
  )).rows[0].id;
  check("a bill can be attributed to the till that rang it",
    await SetBillCounter(RES_ID, t11Bill, counter.id));

  const group = await UpsertMenuGroup(RES_ID, { name: "Beverage", kind: "revenue" });
  const dish = await UpsertMenuItem(RES_ID, { id: "", name: "Masala Chai", price: 60, category: "Hot Drinks" });
  const menuRow = (await raw.query(
    `select id, name, main_cat_id from "Menu" where res_id=$1 and id=$2 limit 1`, [RES_ID, dish.id],
  )).rows[0];
  await SetMenuGroupAssignment(RES_ID, { main_cat_id: menuRow.main_cat_id }, group.id);
  const variation = await UpsertMenuVariation(RES_ID, { menu_id: menuRow.id, name: "Half", price: 35 });
  await UpsertMenuVariation(RES_ID, { menu_id: menuRow.id, name: "Full", price: 60, is_default: true });
  const index = await GetMenuAttributionIndex(RES_ID, "revenue");

  // A line written SINCE 039 carries menu_id and attributes to its group — which
  // is inherited from the CATEGORY here, not set on the item.
  const stamped = attributeOrderLine({ id: "x", name: menuRow.name, menu_id: menuRow.id }, index);
  check("a stamped line attributes to its category's group",
    stamped.group_name === "Beverage" && stamped.source === "stamped");
  check("its variation resolves too",
    attributeOrderLine({ id: "x", name: menuRow.name, menu_id: menuRow.id, variation_id: variation.id }, index)
      .variation_name === "Half");

  // A PRE-039 line — no menu_id, a re-minted uuid — still reports, by name.
  const legacy = attributeOrderLine({ id: randomUUID(), name: menuRow.name }, index);
  check("a pre-039 line still attributes, by name",
    legacy.menu_id === menuRow.id && legacy.source === "legacy_name");
  check("...and never gains a variation it never had", legacy.variation_id === null);
  check("an off-menu line reports Unclassified, never a nearest match",
    attributeOrderLine({ id: "x", name: "Valet Fee" }, index).group_name === "Unclassified");

  // THE MONEY-CRITICAL HALF OF 039: the price floor must use the VARIATION's
  // price, not the base item's, or a Half plate is silently billed as a Full one.
  await OccupyTable(RES_ID, "T2", 2, null, null);
  const varOrder = await AddOrder(RES_ID, {
    table: "T2", customer: "Half", status: "Preparing",
    items: [{ id: menuRow.id, name: "Masala Chai", price: 35, quantity: 1, variation_id: variation.id }],
    subtotal: 35, total: 35,
  });
  const varFood = (await raw.query(`select food::jsonb as f from "Orders" where id=$1`, [varOrder.id])).rows[0].f;
  check("a Half at 35 is NOT floored up to the 60 base price",
    Number(varFood.items[0].price) === 35);
  check("the line was stamped with its menu id, server-side",
    String(varFood.items[0].menu_id) === String(menuRow.id));
  check("...and with the variation it was sold as",
    String(varFood.items[0].variation_id) === String(variation.id)
    && String(varFood.items[0].variation_name) === "Half");
  check("the bill charges the variation price", Number(varFood.subtotal) === 35);

  // ...while a line naming NO variation still floors against the base price, as
  // it always has. An under-rung line is still refused.
  const baseOrder = await AddOrder(RES_ID, {
    table: "T2", customer: "Half", status: "Preparing",
    items: [{ id: randomUUID(), name: "Masala Chai", price: 1, quantity: 1 }],
    subtotal: 1, total: 1,
  });
  const baseFood = (await raw.query(`select food::jsonb as f from "Orders" where id=$1`, [baseOrder.id])).rows[0].f;
  const rung = (baseFood.items as any[]).find((i: any) => Number(i.price) !== 35);
  check("a line with no variation is still floored to the MENU price (1 -> 60)",
    Number(rung.price) === 60);
  check("...and it is stamped too, so old and new lines report the same way",
    String(rung.menu_id) === String(menuRow.id) && rung.variation_id === undefined);

  // ---- 12) EVERY PRE-034 ORDER IS UNCHANGED -------------------------------
  console.log("\n[compat] orders written before these migrations are untouched");
  const legacyBlobs = Number((await raw.query(
    `select count(*)::int n from "Orders"
      where res_id=$1 and (food::jsonb ? 'nc_subtotal')`, [RES_ID],
  )).rows[0].n);
  check("only the orders that were actually comped carry an nc_subtotal key", legacyBlobs === 0);
  const noNcFlags = Number((await raw.query(
    `select count(*)::int n from "Orders" o,
            lateral jsonb_array_elements(case when jsonb_typeof(o.food::jsonb -> 'items') = 'array'
                                              then o.food::jsonb -> 'items' else '[]'::jsonb end) it
      where o.res_id=$1 and (it ? 'nc')`, [RES_ID],
  )).rows[0].n);
  check("no order line carries a stray nc flag after the reversal", noNcFlags === 0);

  // ---- 13) PAYMENT MODES: an owner-added mode is real money, end to end ----
  // "There has to be an option to add mode of payments." What a unit test cannot
  // prove is the TRANSACTIONS: the save's merge against the stored row, the
  // settle and the tender resolving against the tenant's own config inside
  // their own transactions, and a switched-off mode being refused for NEW money
  // while a bill already part-paid in it still closes.
  console.log("\n[payment modes] an owner-added mode settles; a switched-off one takes no new money");
  const { SetRestaurantSettings, GetRestaurantSettings, GetBillPaymentLedger, PaymentConfigError } = db;
  await SetRestaurantSettings(RES_ID, {
    payment_methods: [{ id: "Swiggy Dineout", label: "Swiggy Dineout", custom: true, requires_screenshot: false }],
  });
  const modesAfterAdd = (await GetRestaurantSettings(RES_ID)).payment_methods as any[];
  check("the added mode is stored after the eight built-ins",
    modesAfterAdd.length === 9 && modesAfterAdd[8].id === "Swiggy Dineout" && modesAfterAdd[8].custom === true);
  // Exactly what a shipped app's Settings card posts: the built-ins it renders.
  await SetRestaurantSettings(RES_ID, {
    payment_methods: modesAfterAdd.filter((x) => !x.custom)
      .map(({ id, label, enabled, requires_screenshot, online }) => ({ id, label, enabled, requires_screenshot, online: online === true })),
  });
  check("an older app's built-ins-only save does NOT erase it",
    ((await GetRestaurantSettings(RES_ID)).payment_methods as any[]).some((x) => x.id === "Swiggy Dineout"));
  let compRefused = false;
  try { await SetRestaurantSettings(RES_ID, { payment_methods: [{ id: "Complimentary", custom: true }] }); }
  catch (e: any) { compRefused = e instanceof PaymentConfigError && /non-chargeable/i.test(String(e?.message)); }
  check("\"Complimentary\" is refused as a payment mode, pointing at non-chargeable", compRefused);

  await OccupyTable(RES_ID, "T13", 2, null, null);
  const pmOrder = await AddOrder(RES_ID, {
    table: "T13", customer: "Aggregator", status: "Preparing",
    items: [ITEM("pm1", "Thali", 500)], subtotal: 500, total: 500,
  });
  // The till's spelling differs; the STORED id is what lands on the bill.
  await ConfirmBillPaymentByWaiter(RES_ID, pmOrder.id, "admin", "swiggy dineout");
  await ApproveBillPaymentByAdmin(RES_ID, pmOrder.id, "admin");
  const pmBill = (await raw.query(
    `select payment_method, closed_at from "Bills" where res_id=$1 and table_id=$2 order by created_at desc limit 1`,
    [RES_ID, await tableId("T13")],
  )).rows[0];
  check("a bill settles with the custom mode, stored under its id",
    pmBill.closed_at != null && String(pmBill.payment_method) === "Swiggy Dineout");
  const pmRow = ((await GetSalesReport(RES_ID)).by_method as any[]).find((x) => x.method === "Swiggy Dineout");
  check("the sales report groups it under the id and carries its label",
    !!pmRow && pmRow.label === "Swiggy Dineout" && pmRow.bills === 1);

  // Part-paid in the mode, THEN the owner switches it off.
  await OccupyTable(RES_ID, "T14", 2, null, null);
  const offOrder = await AddOrder(RES_ID, {
    table: "T14", customer: "Switched off", status: "Preparing",
    items: [ITEM("pm2", "Biryani", 600)], subtotal: 600, total: 600,
  });
  await RecordBillTenders(RES_ID, {
    table_name: "T14", settled_by_username: "cashier1",
    tenders: [{ method: "Swiggy Dineout", amount: 200 }],
  });
  await SetRestaurantSettings(RES_ID, { payment_methods: [{ id: "Swiggy Dineout", custom: true, enabled: false }] });
  check("switching it off keeps the entry (removal is never a delete)",
    ((await GetRestaurantSettings(RES_ID)).payment_methods as any[]).some((x) => x.id === "Swiggy Dineout" && x.enabled === false));

  await OccupyTable(RES_ID, "T15", 2, null, null);
  const newOrder = await AddOrder(RES_ID, {
    table: "T15", customer: "New money", status: "Preparing",
    items: [ITEM("pm3", "Dosa", 300)], subtotal: 300, total: 300,
  });
  let newSettleRefused = false;
  try { await ConfirmBillPaymentByWaiter(RES_ID, newOrder.id, "admin", "Swiggy Dineout"); }
  catch (e: any) { newSettleRefused = /switched off/i.test(String(e?.message)); }
  check("a NEW settle in a switched-off mode is refused", newSettleRefused);
  let newTenderRefused = false;
  try {
    await RecordBillTenders(RES_ID, {
      table_name: "T14", settled_by_username: "cashier1",
      tenders: [{ method: "Swiggy Dineout", amount: 100 }],
    });
  } catch (e: any) { newTenderRefused = /switched off/i.test(String(e?.message)); }
  check("a NEW tender in a switched-off mode is refused", newTenderRefused);

  // The rest in cash, then the settle the route makes from the ledger's mirror.
  const offOwed = (await GetBillTenderState(RES_ID, { table_name: "T14" })).outstanding;
  await RecordBillTenders(RES_ID, {
    table_name: "T14", settled_by_username: "cashier1", require_full: true,
    tenders: [{ method: "Cash", amount: offOwed }],
  });
  const offLedger = await GetBillPaymentLedger(RES_ID, { order_id: offOrder.id });
  let unflaggedRefused = false;
  try { await ConfirmBillPaymentByWaiter(RES_ID, offOrder.id, "admin", "Split", null, offLedger.payment_splits); }
  catch (e: any) { unflaggedRefused = /switched off/i.test(String(e?.message)); }
  check("without the mirror flag the same parts are refused (the flag is what allows it)", unflaggedRefused);
  await ConfirmBillPaymentByWaiter(RES_ID, offOrder.id, "admin", "Split", null, offLedger.payment_splits, { mirrorsLedger: true });
  await ApproveBillPaymentByAdmin(RES_ID, offOrder.id, "admin");
  check("a bill already part-paid in the mode still CLOSES from its ledger", await billClosed("T14"));

  console.log(`\n✓ ALL ${passed} integration assertions passed`);
}

main()
  .then(async () => { await raw.end(); await closePools().catch(() => {}); process.exit(0); })
  .catch(async (e) => { console.error("\n✗ INTEGRATION FAILED:", e?.message ?? e); await raw.end().catch(() => {}); await closePools().catch(() => {}); process.exit(1); });
