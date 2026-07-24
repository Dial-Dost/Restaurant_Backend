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
    tables: ["T1", "T2", "T3", "T4", "T5"].map((n) => ({ name: n, capacity: 4 })),
  });
  RES_ID = (await raw.query(`select id from "Restaurant" order by created_at desc limit 1`)).rows[0].id;
  console.log("seeded res_id:", RES_ID);

  // ---- 1) Waitlist: atomic seat + guards ----
  console.log("\n[waitlist] atomic seat + double-seat + occupied-table guards");
  const a = await JoinWaitlist(RES_ID, { name: "Walk-in A", phone: "+10000000001", party_size: 2 });
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
  const b = await JoinWaitlist(RES_ID, { name: "Walk-in B", phone: "+10000000002", party_size: 2 });
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

  // ---- 6) DeleteOrder returns true + actually deletes (was always 404) ----
  console.log("\n[orders] DeleteOrder succeeds and removes the row");
  await OccupyTable(RES_ID, "T2", 2, null, null);
  const od = await AddOrder(RES_ID, { table: "T2", customer: "D", items: [ITEM("d1", "Soda", 40)], subtotal: 40, total: 40, status: "Preparing" });
  const del = await DeleteOrder(RES_ID, od.id);
  check("DeleteOrder returns true on success", del === true);
  const stillThere = Number((await raw.query(`select count(*)::int n from "Orders" where id=$1`, [od.id])).rows[0].n);
  check("the deleted order row is gone", stillThere === 0);

  console.log(`\n✓ ALL ${passed} integration assertions passed`);
}

main()
  .then(async () => { await raw.end(); await closePools().catch(() => {}); process.exit(0); })
  .catch(async (e) => { console.error("\n✗ INTEGRATION FAILED:", e?.message ?? e); await raw.end().catch(() => {}); await closePools().catch(() => {}); process.exit(1); });
