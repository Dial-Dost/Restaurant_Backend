/**
 * One-off repair of known-wrong historical "Bills" rows for the CSR Organics tenant.
 *
 *   npx tsx scripts/repair_historical_bills.ts            # DRY RUN (default) — writes nothing
 *   npx tsx scripts/repair_historical_bills.ts --apply    # commits the repair
 *   npx tsx scripts/repair_historical_bills.ts --revert   # DRY RUN of the inverse
 *   npx tsx scripts/repair_historical_bills.ts --revert --apply   # commits the inverse
 *
 * WHY EACH ROW IS IN THE PLAN
 * ---------------------------
 * A. Bill #18 (db444e0d) — ReleaseTable closed it without payment. Its only real
 *    order was cancelled and its two "paid" orders are E2E test fixtures
 *    (customer "E2E", item "E2E Item"). total_amt still held the running pre-tax
 *    subtotal, so every revenue reader books a 1,000 sale that nobody paid.
 *    ReleaseTable ALREADY zeroes this at the write site (database_supabase.ts,
 *    "ZERO an UNPAID bill's money as part of closing it"); this row predates that
 *    fix. The repair is exactly what that code would do today.
 *
 * B. Bills #1 (ab2ac42c) and #2 (a26376ef) — their tax_breakdown omits the
 *    "Service Charge" line. This is NOT an under-collection: the Orders behind
 *    them carry subtotal 360 / 429 and total 414 / 493.35, i.e. exactly
 *    subtotal x 1.15 (SGST 2.5 + CGST 2.5 + Service Charge 10). The money
 *    collected is right and the stored SGST/CGST amounts are right (2.5% of the
 *    TRUE base). Only the omitted service-charge line is wrong, which makes
 *    closedBillCharges() report taxable_base 36.00 / 42.90 too high and
 *    service_charge that much too low. total_amt is deliberately NOT touched.
 *
 * C. Bill #4 (3193cb18) — its total decomposes exactly as
 *    1928.00 (its own order) + 414.00 (bill #1) + 493.35 (bill #2) = 2835.35.
 *    The table's running subtotal was never reset after #1 and #2 settled, so
 *    907.35 of already-booked revenue was billed a second time. It is the only
 *    bill in the tenant whose total matches "own items + earlier bills on the
 *    same table"; the other 44 charged bills all match "items x 1.15" exactly.
 *
 * NOT IN THE PLAN (found, quantified, deliberately left alone — see the report):
 *   - Bills #3/#5/#6/#7/#9 (1,380 total) look bot-generated but a human decision
 *     is needed; bill #9 mixes a synthetic 240 with a genuine 360 order.
 *   - Bill #8 (total 0 over a real 1,208 order) is plausibly a legitimate comp
 *     or merge-absorbed row; zeroing is what MergeBills does on purpose.
 *
 * IDEMPOTENCY — two independent guards, both must pass before a row is written:
 *   1. LEDGER: every applied correction inserts an "Audit_logs" row whose
 *      additional_details->>'repair_key' is `${REPAIR_KEY_PREFIX}:${bill_id}`.
 *      A second run finds that key and skips the row. The audit log is
 *      append-only, so this ledger is never rewritten — a revert adds its own
 *      row rather than deleting the original.
 *   2. PRECONDITION: the row's CURRENT total_amt and tax_breakdown must still
 *      equal the recorded `before` state. If anything else has since changed the
 *      bill, the script refuses that row instead of stamping a stale value over
 *      newer data.
 *
 * INVERSE — `--revert` restores every repaired row to the `before` state read
 * back out of its own repair audit row (not from the constants below), then
 * writes a new audit row keyed `${REVERT_KEY_PREFIX}:${bill_id}`. It is itself
 * idempotent and refuses to revert a row whose current values no longer match
 * the `after` state that the repair wrote. Manual equivalent, per bill:
 *   update "Bills" set total_amt = <before.total_amt>,
 *                      tax_breakdown = '<before.tax_breakdown>'::json
 *    where id = <bill_id> and res_id = <RES_ID> and outlet_id = <outlet_id>;
 * (Bills' primary key is (id, res_id, outlet_id) — always key on all three.)
 */

import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const RES_ID = 'e47e69a8-fd5b-462e-bb33-92024b5ab347';
const ACTOR_USERNAME = 'admin';
const ACTION_NAME = 'Repair Historical Bill';
const REPAIR_KEY_PREFIX = 'historical_bill_repair:v1';
const REVERT_KEY_PREFIX = 'historical_bill_repair_revert:v1';

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');

const round2 = (n: unknown) => Number((Number(n) || 0).toFixed(2));
const money = (n: number) => n.toFixed(2).padStart(12);

interface TaxLine { name: string; percentage: number; amount: number }
interface Repair {
  bill_id: string;
  bill_no: string;
  klass: 'A' | 'B' | 'C';
  reason: string;
  before: { total_amt: number; tax_breakdown: TaxLine[] };
  after: { total_amt: number; tax_breakdown: TaxLine[] };
}

const SGST = (a: number): TaxLine => ({ name: 'SGST', percentage: 2.5, amount: a });
const CGST = (a: number): TaxLine => ({ name: 'CGST', percentage: 2.5, amount: a });
const SVC = (a: number): TaxLine => ({ name: 'Service Charge', percentage: 10, amount: a });

const PLAN: Repair[] = [
  {
    bill_id: 'db444e0d-dea7-41d4-a0a1-c9df10937d3e',
    bill_no: '18',
    klass: 'A',
    reason: 'Closed by ReleaseTable without payment; only real order was cancelled. Zeroed to match what ReleaseTable does at the write site today.',
    before: { total_amt: 1000, tax_breakdown: [] },
    after: { total_amt: 0, tax_breakdown: [] },
  },
  {
    bill_id: 'ab2ac42c-8715-4aea-b3af-1dc4ef15f678',
    bill_no: '1',
    klass: 'B',
    reason: 'tax_breakdown omitted the Service Charge line (10% of the 360 base = 36.00). total_amt 414.00 is correct and is left untouched.',
    before: { total_amt: 414, tax_breakdown: [SGST(9), CGST(9)] },
    after: { total_amt: 414, tax_breakdown: [SGST(9), CGST(9), SVC(36)] },
  },
  {
    bill_id: 'a26376ef-95e0-4b1c-8445-65fd58b5aea1',
    bill_no: '2',
    klass: 'B',
    // 429 x 1.15 = 493.35 exactly, but the stored SGST/CGST were rounded up from
    // 10.725 to 10.73, so the recovered base reads 428.99 rather than 429.00. The
    // 1-paisa gap is in the ORIGINAL rounding, and closing it would mean editing
    // an amount the guest actually paid — left as-is on purpose.
    reason: 'tax_breakdown omitted the Service Charge line (10% of the 429 base = 42.90). total_amt 493.35 is correct and is left untouched.',
    before: { total_amt: 493.35, tax_breakdown: [SGST(10.73), CGST(10.73)] },
    after: { total_amt: 493.35, tax_breakdown: [SGST(10.73), CGST(10.73), SVC(42.9)] },
  },
  {
    bill_id: '3193cb18-5d5a-4c9b-a905-80c46f51fb77',
    bill_no: '4',
    klass: 'C',
    reason: 'total_amt double-counted bills #1 (414.00) and #2 (493.35) on top of its own 1928.00 order. Removing 907.35 already booked elsewhere.',
    before: { total_amt: 2835.35, tax_breakdown: [] },
    after: { total_amt: 1928, tax_breakdown: [] },
  },
];

function parseLines(raw: unknown): TaxLine[] {
  const v = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw ?? []);
  return Array.isArray(v) ? v : [];
}

/** Order-insensitive, 1-paisa-tolerant comparison of two stored breakdowns. */
function linesEqual(a: TaxLine[], b: TaxLine[]): boolean {
  if (a.length !== b.length) {return false;}
  const key = (l: TaxLine) => String(l?.name ?? '').trim().toLowerCase();
  const sa = [...a].sort((x, y) => key(x).localeCompare(key(y)));
  const sb = [...b].sort((x, y) => key(x).localeCompare(key(y)));
  return sa.every((l, i) => {
    const r = sb[i]!;
    return key(l) === key(r)
      && Math.abs(Number(l.percentage) - Number(r.percentage)) < 0.001
      && Math.abs(round2(l.amount) - round2(r.amount)) <= 0.011;
  });
}

const fmtLines = (l: TaxLine[]) => l.length === 0 ? '[]' : l.map((x) => `${x.name}@${x.percentage}%=${round2(x.amount)}`).join(', ');

// closedBillCharges() with scPct = 0 (Restaurant.service_charge is 0 for this
// tenant), so the diff below reads in the same units the reports do.
function charges(total: number, lines: TaxLine[]) {
  const i = lines.findIndex((l) => /service\s*charge/i.test(String(l?.name ?? '')));
  const service_charge = i >= 0 ? round2(lines[i]!.amount) : 0;
  const tax_total = round2(lines.filter((_, k) => k !== i).reduce((s, l) => s + (Number(l.amount) || 0), 0));
  return { tax_total, service_charge, taxable_base: round2(total - tax_total - service_charge) };
}

async function main() {
  const connectionString = process.env.SUPABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!connectionString) {throw new Error('No SUPABASE_DIRECT_URL / DATABASE_URL / DIRECT_URL in the environment');}
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  const mode = REVERT ? 'REVERT' : 'REPAIR';
  console.log(`\n  ${mode} — historical bill repair, tenant ${RES_ID}`);
  console.log(`  ${APPLY ? '*** --apply GIVEN: changes WILL be committed ***' : 'DRY RUN (default) — every write is rolled back. Pass --apply to commit.'}\n`);

  let committed = false;
  try {
    // Everything (including the dry run) executes inside one transaction, so the
    // dry run exercises the real UPDATEs and surfaces any constraint failure
    // instead of only predicting one. Without --apply it always ROLLBACKs.
    await client.query('BEGIN');

    const actor = await client.query<{ id: string; outlet_id: string }>(
      `select e.id, e.outlet_id from "Employees" e join "Login" l on l.emp_id = e.id
        where e.res_id = $1 and l.emp_username = $2
        order by (e.emp_roles->>'primary' = 'admin') desc limit 1`,
      [RES_ID, ACTOR_USERNAME],
    );
    if (!actor.rows[0]) {throw new Error(`No employee '${ACTOR_USERNAME}' in restaurant ${RES_ID} to attribute the audit row to`);}
    const actorId = actor.rows[0].id;

    // Audit_logs.action_id is a FK to "Actions"; find-or-create like the runtime does.
    let actionId: string;
    const existingAction = await client.query<{ id: string }>(
      `select id from "Actions" where lower(action_name) = lower($1) limit 1`, [ACTION_NAME]);
    if (existingAction.rows[0]) {
      actionId = existingAction.rows[0].id;
    } else {
      actionId = randomUUID();
      await client.query(
        `insert into "Actions" (id, created_at, action_name, action_desc, "group")
         values ($1, now(), $2, $3, 'Bills')`,
        [actionId, ACTION_NAME, 'One-off correction of a known-wrong historical bill row'],
      );
      console.log(`  (created "Actions" row '${ACTION_NAME}')\n`);
    }

    let planned = 0, skipped = 0, blocked = 0;
    const totals = { gross: 0, tax: 0, svc: 0, base: 0 };

    for (const r of PLAN) {
      const repairKey = `${REPAIR_KEY_PREFIX}:${r.bill_id}`;
      const revertKey = `${REVERT_KEY_PREFIX}:${r.bill_id}`;

      const row = await client.query<{ total_amt: string; tax_breakdown: unknown; outlet_id: string; bill_no: string }>(
        `select total_amt, tax_breakdown, outlet_id, bill_no::text as bill_no
           from "Bills" where id = $1 and res_id = $2 for update`,
        [r.bill_id, RES_ID],
      );
      if (!row.rows[0]) {
        console.log(`  [BLOCKED] bill #${r.bill_no} ${r.bill_id} — row not found in this tenant`);
        blocked++; continue;
      }
      const cur = { total_amt: round2(row.rows[0].total_amt), tax_breakdown: parseLines(row.rows[0].tax_breakdown) };
      const outletId = row.rows[0].outlet_id;

      const ledger = await client.query<{ repair_key: string; additional_details: any }>(
        `select additional_details->>'repair_key' as repair_key, additional_details
           from "Audit_logs"
          where res_id = $1 and additional_details->>'repair_key' = any($2::text[])
          order by created_at`,
        [RES_ID, [repairKey, revertKey]],
      );
      const hasRepair = ledger.rows.some((x) => x.repair_key === repairKey);
      const hasRevert = ledger.rows.some((x) => x.repair_key === revertKey);
      // A repair is "live" when it was applied and not since reverted.
      const live = hasRepair && !hasRevert;

      const want = REVERT ? 'revert' : 'repair';
      if (want === 'repair' && live) {
        console.log(`  [SKIP]    bill #${r.bill_no} — already repaired (audit repair_key ${repairKey}); nothing to do`);
        skipped++; continue;
      }
      if (want === 'revert' && !live) {
        console.log(`  [SKIP]    bill #${r.bill_no} — no live repair to revert`);
        skipped++; continue;
      }

      // On revert, the restore target comes from the audit row the repair wrote,
      // never from the constants in this file — the ledger is the record of what
      // actually happened.
      let from: { total_amt: number; tax_breakdown: TaxLine[] };
      let to: { total_amt: number; tax_breakdown: TaxLine[] };
      if (want === 'repair') {
        from = r.before; to = r.after;
      } else {
        const applied = ledger.rows.find((x) => x.repair_key === repairKey)!.additional_details;
        from = { total_amt: round2(applied.after.total_amt), tax_breakdown: parseLines(applied.after.tax_breakdown) };
        to = { total_amt: round2(applied.before.total_amt), tax_breakdown: parseLines(applied.before.tax_breakdown) };
      }

      if (Math.abs(cur.total_amt - from.total_amt) > 0.011 || !linesEqual(cur.tax_breakdown, from.tax_breakdown)) {
        console.log(`  [BLOCKED] bill #${r.bill_no} — precondition failed, row changed since this plan was written`);
        console.log(`              expected total ${from.total_amt.toFixed(2)}  lines ${fmtLines(from.tax_breakdown)}`);
        console.log(`              actual   total ${cur.total_amt.toFixed(2)}  lines ${fmtLines(cur.tax_breakdown)}`);
        blocked++; continue;
      }

      const cb = charges(from.total_amt, from.tax_breakdown);
      const ca = charges(to.total_amt, to.tax_breakdown);
      console.log(`  [${want === 'repair' ? 'REPAIR' : 'REVERT'}]  bill #${r.bill_no}  (class ${r.klass})  ${r.bill_id}`);
      console.log(`              ${r.reason}`);
      console.log(`                             ${'before'.padStart(12)} ${'after'.padStart(12)} ${'delta'.padStart(12)}`);
      console.log(`              grand_total   ${money(from.total_amt)} ${money(to.total_amt)} ${money(round2(to.total_amt - from.total_amt))}`);
      console.log(`              taxable_base  ${money(cb.taxable_base)} ${money(ca.taxable_base)} ${money(round2(ca.taxable_base - cb.taxable_base))}`);
      console.log(`              service_chg   ${money(cb.service_charge)} ${money(ca.service_charge)} ${money(round2(ca.service_charge - cb.service_charge))}`);
      console.log(`              tax_total     ${money(cb.tax_total)} ${money(ca.tax_total)} ${money(round2(ca.tax_total - cb.tax_total))}`);
      console.log(`              tax_breakdown  ${fmtLines(from.tax_breakdown)}  ->  ${fmtLines(to.tax_breakdown)}\n`);

      totals.gross = round2(totals.gross + (to.total_amt - from.total_amt));
      totals.tax = round2(totals.tax + (ca.tax_total - cb.tax_total));
      totals.svc = round2(totals.svc + (ca.service_charge - cb.service_charge));
      totals.base = round2(totals.base + (ca.taxable_base - cb.taxable_base));

      await client.query(
        `update "Bills" set total_amt = $1, tax_breakdown = $2::json
          where id = $3 and res_id = $4 and outlet_id = $5`,
        [to.total_amt, JSON.stringify(to.tax_breakdown), r.bill_id, RES_ID, outletId],
      );

      await client.query(
        `insert into "Audit_logs" (id, created_at, res_id, outlet_id, employee_id, action_id, reason, category, additional_details)
         values ($1, now(), $2, $3, $4, $5, $6, 'Bill', $7)`,
        [
          randomUUID(), RES_ID, outletId, actorId, actionId,
          `${want === 'repair' ? 'Repaired' : 'Reverted repair of'} historical bill #${r.bill_no} (class ${r.klass}): `
            + `total ${from.total_amt.toFixed(2)} -> ${to.total_amt.toFixed(2)}. ${r.reason}`,
          JSON.stringify({
            repair_key: want === 'repair' ? repairKey : revertKey,
            script: 'scripts/repair_historical_bills.ts',
            klass: r.klass,
            bill_id: r.bill_id,
            bill_no: r.bill_no,
            before: from,
            after: to,
            ...(want === 'revert' ? { reverts: repairKey } : {}),
          }),
        ],
      );
      planned++;
    }

    console.log(`  ------------------------------------------------------------------`);
    console.log(`  rows to write: ${planned}    skipped (already done): ${skipped}    blocked: ${blocked}`);
    console.log(`  net effect on the reports:`);
    console.log(`      gross_sales / net_revenue  ${money(totals.gross)}`);
    console.log(`      taxable_base               ${money(totals.base)}`);
    console.log(`      service_charge             ${money(totals.svc)}`);
    console.log(`      tax_collected              ${money(totals.tax)}`);

    if (blocked > 0 && APPLY) {
      throw new Error(`${blocked} row(s) failed their precondition — rolling back the whole run rather than applying a partial repair`);
    }

    if (APPLY) {
      await client.query('COMMIT');
      committed = true;
      console.log(`\n  COMMITTED.\n`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n  ROLLED BACK (dry run). Re-run with --apply to commit.\n`);
    }
  } catch (err) {
    if (!committed) {await client.query('ROLLBACK').catch(() => undefined);}
    console.error(`\n  FAILED — nothing was written.`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
