// A MOVED ORDER AGAINST A REAL POSTGRES — integration review of 2.0.2
// (money-floor). The jest suite (jest-tests/moved_order_attribution.test.ts)
// drives the same paths over an in-memory model of the SQL; this script is the
// proof that the SQL itself says what the model says:
//
//   1. the settled-bill window reads when an order ARRIVED on its table
//      (food.table_since, stamped by the database's now(); else the move
//      history; else created_at) — GetClosedBill, ListClosedBills and ReopenBill
//      after a party move, a move-order and a merge;
//   2. the print bound is anchored on the open seating (TableSessions) — the
//      destination of a move-order does not count the previous party's paper,
//      and the source keeps its own when its first ticket leaves;
//   3. a moved ticket takes the destination's guest;
//   4. orderArrivalSql and orderArrivedAt agree, row for row.
//
// RUN IT (never against anything but a throwaway local server):
//   MOVES_PG_URL=postgres://postgres@127.0.0.1:55451/postgres?sslmode=disable \
//     npx tsx test/integration/moved_order_attribution_pg.ts
//
// It refuses any host that is not localhost, creates and drops ONE database
// named `mv_proof`, and applies the repo's migrations 000-053 to it (054/055 are
// made by the boot steps, as on production).

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, "..", "..", "migrations");
const base = process.env.MOVES_PG_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)(:\d+)?\//.test(base)) {
  console.error("MOVES_PG_URL must point at a LOCAL throwaway server (127.0.0.1 / localhost).");
  process.exit(2);
}
const urlFor = (name: string) => base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
const DB_NAME = "mv_proof";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prepare(): Promise<void> {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  for (const role of ["anon", "authenticated", "service_role"]) {
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`);
  }
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const c = new pg.Client({ connectionString: urlFor(DB_NAME) });
  await c.connect();
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql") && f < "054")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const f of files) {
    await c.query("begin");
    try { await c.query(await readFile(join(MIGRATIONS, f), "utf8")); await c.query("commit"); }
    catch (err) { await c.query("rollback"); throw new Error(`${f}: ${(err as Error).message}`); }
  }
  await c.end();
}

async function main(): Promise<void> {
  await prepare();
  process.env.SUPABASE_DIRECT_URL = urlFor(DB_NAME);
  process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || "test";
  process.env.ALLOW_DEV_QR_SECRET = "true";
  delete process.env.REDIS_URL;
  const db: any = await import("../../database_supabase.js");
  const moves: typeof import("../../order_moves.js") = await import("../../order_moves.js");
  const raw = new pg.Pool({ connectionString: urlFor(DB_NAME), max: 2 });

  // The production boot order, as far as these features go.
  await db.initPrintRoutingSchema();
  await db.InitTableNextPartySchema();
  await db.InitPrintJobPaperSchema();
  await db.InitBillCustomerAddressSchema();

  await db.EnsureRestaurantSeed({
    name: `Moves ${randomUUID().slice(0, 8)}`,
    admin: { employeeId: "admin", name: "Admin", password: "test1234" },
    tables: Array.from({ length: 24 }, (_v, i) => ({ name: `T${String(i + 1)}`, capacity: 6 })),
  });
  const RES = (await raw.query(`select id from "Restaurant" order by created_at desc limit 1`)).rows[0].id as string;
  const OUTLET = (await raw.query(`select id from "Outlets" where res_id = $1 limit 1`, [RES])).rows[0].id as string;
  const tableId = async (name: string): Promise<string> =>
    (await raw.query(`select id from "Tables" where res_id = $1 and table_name = $2`, [RES, name])).rows[0].id as string;
  const item = (name: string, price: number) => ({ id: randomUUID(), name, price, quantity: 1 });
  const order = async (table: string, name: string, price: number): Promise<string> => {
    const o = await db.AddOrder(RES, { table, customer: "Guest", items: [item(name, price)], subtotal: price, total: price, status: "Preparing" });
    await sleep(25);
    return o.id as string;
  };
  const seatAndOrder = async (table: string, name: string, price: number): Promise<string> => {
    await db.OccupyTable(RES, table, 2, null, null);
    return order(table, name, price);
  };
  const settle = async (table: string): Promise<string> => {
    const tid = await tableId(table);
    const any = (await raw.query(`select id from "Orders" where table_id = $1 and coalesce(status::text,'1') not in ('4','5','7') order by created_at limit 1`, [tid])).rows[0].id;
    await db.ConfirmBillPaymentByWaiter(RES, any, "admin", "Cash");
    await db.ApproveBillPaymentByAdmin(RES, any, "admin");
    await sleep(25);
    return (await raw.query(`select id from "Bills" where table_id = $1 and closed_at is not null order by closed_at desc limit 1`, [tid])).rows[0].id as string;
  };
  const printJob = async (billId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const r = await raw.query(
      `insert into "PrintJobs" (res_id, outlet_id, bill_id, kind, esc_base64, status, lines_digest, bill_digest, table_name)
       values ($1, $2, $3, 'bill', 'AA==', 'delivered', $4, $5, $6) returning id`,
      [RES, OUTLET, billId, extra.lines_digest ?? null, extra.bill_digest ?? null, extra.table_name ?? null],
    );
    await sleep(25);
    return r.rows[0].id as string;
  };
  const counts = async (table: string) => ({
    bill: (await db.GetBillForTable(RES, table))?.print_count ?? null,
    guard: (await db.GetOrderingPrintGuard(RES, table))?.print_count ?? null,
    tile: ((await db.GetTables(RES)) as { table_name: string; print_count: number }[]).find((r) => r.table_name === table)?.print_count ?? null,
  });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  console.log("1. the settled-bill window, after a PARTY MOVE (GGV 15 -> 14)");
  await seatAndOrder("T14", "Dal", 1836);
  await db.SetBillCustomerName(RES, "T14", "Zed Traders", "27AAACZ1234C1Z9", null);
  const moved15 = await seatAndOrder("T15", "Paneer", 2055);
  await db.SetBillCustomerName(RES, "T15", "Acme Pvt Ltd", "29ABCDE1234F1Z5", "Tower B\nMG Road");
  const previous = await settle("T14");
  await db.MoveTableParty(RES, "T15", "T14");
  await sleep(25);
  const stamp = (await raw.query(`select food::jsonb->>'table_since' as since, updated_at, created_at from "Orders" where id = $1`, [moved15])).rows[0];
  const prevClosed = (await raw.query(`select closed_at from "Bills" where id = $1`, [previous])).rows[0].closed_at as Date;
  check("the party move stamped table_since (database clock), after the previous party's close", !!stamp.since && new Date(stamp.since).getTime() > prevClosed.getTime(), JSON.stringify(stamp));
  check("…and the move's own update stamped updated_at no earlier (the window's pre-filter holds)", new Date(stamp.updated_at).getTime() >= new Date(stamp.since).getTime() - 1);
  await order("T14", "Kulfi", 907);
  const movedBill = await settle("T14");
  const p = await db.GetClosedBill(RES, previous);
  const m = await db.GetClosedBill(RES, movedBill);
  check("GetClosedBill(previous): its own 1836, one order (was 3891, three)", p.items_subtotal === 1836 && p.order_ids.length === 1, `${String(p.items_subtotal)} / ${String(p.order_ids.length)}`);
  check("GetClosedBill(moved): all 2962 of its food, two orders (was 907)", m.items_subtotal === 2962 && m.order_ids.length === 2, `${String(m.items_subtotal)} / ${String(m.order_ids.length)}`);
  check("…each bill names its own guest: Acme (with its address) on the moved bill, Zed on the previous one", m.customer === "Acme Pvt Ltd" && m.customer_gstin === "29ABCDE1234F1Z5" && m.customer_address === "Tower B\nMG Road" && p.customer === "Zed Traders" && p.customer_gstin === "27AAACZ1234C1Z9" && p.customer_address === null, JSON.stringify({ p: [p.customer, p.customer_gstin, p.customer_address], m: [m.customer, m.customer_gstin, m.customer_address] }));
  const list = (await db.ListClosedBills(RES, { limit: 50 })).bills as { id: string; customer: string | null; customer_gstin: string | null }[];
  const lp = list.find((b) => b.id === previous);
  const lm = list.find((b) => b.id === movedBill);
  check("ListClosedBills: each row names its own guest (the list's own window)", lm?.customer === "Acme Pvt Ltd" && lm?.customer_gstin === "29ABCDE1234F1Z5" && lp?.customer === "Zed Traders" && lp?.customer_gstin === "27AAACZ1234C1Z9", JSON.stringify({ lp, lm }));
  // What the created_at window (before this fix) would have said, on the same rows.
  const oldWindow = (await raw.query(
    `select count(*)::int n, sum((food::jsonb->>'subtotal')::numeric)::int s from "Orders"
      where table_id = $1 and created_at > 'epoch' and created_at <= $2 and coalesce(status::text,'1') in ('4','7')`,
    [await tableId("T14"), prevClosed],
  )).rows[0];
  check("(control) the old created_at window over the same rows still says 2 orders / 3891", oldWindow.n === 2 && oldWindow.s === 3891, JSON.stringify(oldWindow));
  const back = await db.ReopenBill(RES, previous, null, "admin");
  const running = await db.GetBillForTable(RES, "T14");
  check("ReopenBill(previous) restores its own order only, and the moved order stays paid", back.restored_orders === 1 && running?.subtotal === 1836
    && ["4", "7"].includes(String((await raw.query(`select status from "Orders" where id = $1`, [moved15])).rows[0].status)), `${String(back.restored_orders)} / ${String(running?.subtotal)}`);

  console.log("2. ReopenBill of the MOVED party's bill (a second pair of tables)");
  await seatAndOrder("T16", "Dal", 1836);
  await seatAndOrder("T17", "Paneer", 2055);
  await settle("T16");
  await db.MoveTableParty(RES, "T17", "T16");
  await sleep(25);
  await order("T16", "Kulfi", 907);
  const moved2 = await settle("T16");
  const back2 = await db.ReopenBill(RES, moved2, null, "admin");
  check("ReopenBill(moved) restores both of its orders — 2962 (was 907)", back2.restored_orders === 2 && (await db.GetBillForTable(RES, "T16"))?.subtotal === 2962, String(back2.restored_orders));

  console.log("3. MOVE-ORDER and MERGE onto a table whose previous party has paid");
  await seatAndOrder("T13", "Soup", 600);
  const ticket = await seatAndOrder("T12", "Naan", 450);
  await db.SetBillCustomerName(RES, "T12", "Acme Pvt Ltd", "29ABCDE1234F1Z5", "Tower B\nMG Road");
  await order("T12", "Lassi", 300);
  const prev13 = await settle("T13");
  await db.OccupyTable(RES, "T13", 2, null, null);
  await order("T13", "Tea", 90);
  const beforeIdentity = await db.GetBillForTable(RES, "T13");
  await db.MoveOrderToTable(RES, ticket, "T13", { by: "admin" });
  await sleep(25);
  const afterIdentity = await db.GetBillForTable(RES, "T13");
  check("the moved ticket takes T13's guest: T13's paper names nobody, before and after",
    same([beforeIdentity?.customer, beforeIdentity?.customer_gstin, beforeIdentity?.customer_address], [null, null, null])
    && same([afterIdentity?.customer, afterIdentity?.customer_gstin, afterIdentity?.customer_address], [null, null, null]),
    JSON.stringify([afterIdentity?.customer, afterIdentity?.customer_gstin, afterIdentity?.customer_address]));
  const t12 = await db.GetBillForTable(RES, "T12");
  check("…and T12 keeps its own guest, although only the moved ticket carried it", t12?.customer === "Acme Pvt Ltd" && t12?.customer_gstin === "29ABCDE1234F1Z5" && t12?.customer_address === "Tower B\nMG Road",
    JSON.stringify([t12?.customer, t12?.customer_gstin, t12?.customer_address]));
  const closed13 = await settle("T13");
  const pc13 = await db.GetClosedBill(RES, prev13);
  const mc13 = await db.GetClosedBill(RES, closed13);
  check("GetClosedBill: the previous party's bill is its own 600; the new one is 90 + the moved 450", pc13.items_subtotal === 600 && mc13.items_subtotal === 540, `${String(pc13.items_subtotal)} / ${String(mc13.items_subtotal)}`);

  await seatAndOrder("T11", "Soup", 600);
  await seatAndOrder("T10", "Naan", 450);
  const prev11 = await settle("T11");
  await db.OccupyTable(RES, "T11", 2, null, null);
  await order("T11", "Tea", 90);
  await db.MergeTableBills(RES, "T10", "T11");
  await sleep(25);
  const merged11 = await settle("T11");
  const pm = await db.GetClosedBill(RES, prev11);
  const mm = await db.GetClosedBill(RES, merged11);
  check("merge: the previous bill is its own 600; the merged bill is 90 + 450", pm.items_subtotal === 600 && mm.items_subtotal === 540, `${String(pm.items_subtotal)} / ${String(mm.items_subtotal)}`);

  console.log("4. the print bound, anchored on the open seating");
  await seatAndOrder("T20", "Soup", 800);
  const t21Ticket = await seatAndOrder("T21", "Naan", 450);
  const phantomId = `T20-${String(Date.now())}`;
  const phantom = await printJob(phantomId);
  await settle("T20");
  const mv = await db.MoveOrderToTable(RES, t21Ticket, "T20", { by: "admin" });
  await sleep(25);
  check("DESTINATION: T20 was seated by the move", mv.seated_destination === true);
  check("DESTINATION: the previous party's paper is not the new seating's (bill, guard, tile)", same(await counts("T20"), { bill: 0, guard: 0, tile: 0 }), JSON.stringify(await counts("T20")));
  check("…and the move filed that paper as nobody's", (await raw.query(`select bill_id from "PrintJobs" where id = $1`, [phantom])).rows[0].bill_id === `previous-party:${phantomId}`);
  // The seating alone (without the retirement) already bounds it.
  await raw.query(`update "PrintJobs" set bill_id = $2 where id = $1`, [phantom, phantomId]);
  check("…and even un-retired, the open seating keeps it out", same(await counts("T20"), { bill: 0, guard: 0, tile: 0 }), JSON.stringify(await counts("T20")));

  await db.OccupyTable(RES, "T19", 2, null, null);
  await order("T19", "Tea", 90);
  const first18 = await seatAndOrder("T18", "Chaat", 300);
  const { billLinesDigest } = await import("../../bill_paper_digest.js");
  await printJob(`T18-${String(Date.now())}`, { lines_digest: billLinesDigest([{ name: "Chaat", price: 300, quantity: 1 }]), bill_digest: "b".repeat(64), table_name: "T18" });
  await order("T18", "Kulfi", 200);
  await db.MoveOrderToTable(RES, first18, "T19", { by: "admin" });
  await sleep(25);
  check("SOURCE: T18 keeps its print when its first ticket leaves (bill, guard, tile)", same(await counts("T18"), { bill: 1, guard: 1, tile: 1 }), JSON.stringify(await counts("T18")));
  const tile18 = ((await db.GetTables(RES)) as { table_name: string; paper_stale: boolean | null }[]).find((r) => r.table_name === "T18");
  check("…and its paper reads stale (the guest's paper still charges for the Chaat)", tile18?.paper_stale === true, String(tile18?.paper_stale));
  check("T19 (seated before the move, never printed) reads unprinted", same(await counts("T19"), { bill: 0, guard: 0, tile: 0 }), JSON.stringify(await counts("T19")));

  await seatAndOrder("T22", "Chaat", 300);
  await printJob(`T22-${String(Date.now())}`);
  await settle("T22");
  const reopen22 = (await raw.query(`select id, created_at from "Bills" where table_id = $1 and closed_at is not null`, [await tableId("T22")])).rows[0];
  await db.ReopenBill(RES, reopen22.id, null, "admin");
  check("RE-OPENED: a bill whose row was born at the settle, after its print, still reads printed", same(await counts("T22"), { bill: 1, guard: 1, tile: 1 }), JSON.stringify(await counts("T22")));

  console.log("5. orderArrivalSql and orderArrivedAt agree");
  const samples: [Record<string, unknown>, string][] = [
    [{}, "T1"],
    [{ table_since: "2026-09-14T10:34:00.123456+05:30" }, "T1"],
    [{ moves: [{ to_table: "T1", at: "2026-09-14T10:20:00.000Z" }, { to_table: " t1 ", at: "2026-09-14T10:30:00.000Z" }, { to_table: "T2", at: "2026-09-14T10:40:00.000Z" }] }, "T1"],
    [{ moves: [{ to_table: "T1", at: "yesterday" }] }, "T1"],
    [{ moves: "x", table_since: "not a time" }, "T1"],
    [{ moves: [{ to_table: "T1", at: "2026-09-14T10:20:00Z" }], table_since: "2026-09-14T11:00:00Z" }, "T1"],
  ];
  const created = "2026-09-14T10:00:00.000Z";
  for (const [food, name] of samples) {
    const sqlAt = (await raw.query(`select ${moves.orderArrivalSql({ food: "$1::json", createdAt: "$2::timestamptz", tableName: "$3::text" })} as at`, [JSON.stringify(food), created, name])).rows[0].at as Date;
    const jsAt = moves.orderArrivedAt(food, name, created);
    check(`SQL == TS for ${JSON.stringify(food).slice(0, 60)}`, sqlAt.getTime() === jsAt, `${sqlAt.toISOString()} vs ${new Date(jsAt ?? 0).toISOString()}`);
  }

  await raw.end();
  await db.closePools().catch(() => undefined);
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
  console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
