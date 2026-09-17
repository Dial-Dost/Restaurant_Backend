// MIGRATIONS 056-058 AGAINST A REAL POSTGRES — the proof a source test cannot give.
//
// The CHECKs in these files are only worth anything if Postgres actually
// refuses the rows they describe, and the cardinality-vs-array_length trap
// (044) is the proof that reading a CHECK is not the same as running it. So
// this script builds two throwaway databases on a LOCAL server and asserts,
// against the database:
//
//   1. every file 000..058 applies in order, as scripts/migrate.ts applies it;
//   2. the runtime's own statements (report_email_schema.ts, what
//      InitReportEmailSchema issues at boot) followed by the files is the same
//      schema as the files alone — the production rollout order;
//   3. re-applying 056/057/058 is a no-op that takes no ACCESS EXCLUSIVE lock:
//      it succeeds under a 1s lock_timeout while another session holds a ROW
//      EXCLUSIVE lock on both tables (a settle-shaped lock), and the catalogue
//      is byte-identical before and after;
//   4. each CHECK refuses what it says, and the 026/044 writes still pass;
//   5. both ON CONFLICT targets work with their predicates, and fail with
//      42P10 without them;
//   6. RLS isolates the two new tenant tables for app_runtime;
//   7. the sweep lease is out of every other role's reach — Supabase's `anon`,
//      `authenticated` and `service_role` included, even with its default privileges
//      handing them everything — while a NON-superuser owner (production's
//      runtime connection; RLS is forced on it too) and app_runtime can still
//      take and renew it.
//
// RUN IT (never against anything but a throwaway local server):
//   REPORT_EMAIL_PG_URL=postgres://postgres@127.0.0.1:55439/postgres?sslmode=disable \
//     npx tsx test/integration/report_email_migrations_pg.ts
//
// It refuses any host that is not localhost, and it only ever creates and
// drops databases whose names start with `re_proof_`.

import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_EMAIL_DDL_056, REPORT_EMAIL_DDL_057, REPORT_EMAIL_DDL_058, REPORT_EMAIL_SCHEMA_PROBE } from "../../report_email_schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, "..", "..", "migrations");
const NEW_FILES = ["056_report_email_recipients.sql", "057_report_schedule_bundles.sql", "058_report_delivery_bundles.sql"];

const base = process.env.REPORT_EMAIL_PG_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)(:\d+)?\//.test(base)) {
  console.error("REPORT_EMAIL_PG_URL must point at a LOCAL throwaway server (127.0.0.1 / localhost).");
  process.exit(2);
}
const urlFor = (db: string) => base.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function refuses(c: pg.PoolClient | pg.Client, name: string, sql: string, params: unknown[], code: string): Promise<void> {
  await c.query("savepoint probe");
  try {
    await c.query(sql, params);
    check(name, false, "the row was accepted");
  } catch (err) {
    const got = (err as { code?: string }).code;
    check(name, got === code, `expected ${code}, got ${String(got)}: ${(err as Error).message}`);
  } finally {
    await c.query("rollback to savepoint probe");
  }
}

async function accepts(c: pg.PoolClient | pg.Client, name: string, sql: string, params: unknown[]): Promise<pg.QueryResult> {
  await c.query("savepoint probe");
  try {
    const r = await c.query(sql, params);
    check(name, true);
    await c.query("release savepoint probe");
    return r;
  } catch (err) {
    check(name, false, (err as Error).message);
    await c.query("rollback to savepoint probe");
    return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
  }
}

async function freshDb(admin: pg.Client, name: string): Promise<pg.Client> {
  if (!name.startsWith("re_proof_")) { throw new Error("refusing to touch a database not named re_proof_*"); }
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  const c = new pg.Client({ connectionString: urlFor(name) });
  await c.connect();
  // What a Supabase project has before any migration: the two PostgREST roles,
  // and default privileges that hand them every new public table.
  await c.query(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role`);
  return c;
}

async function ensureClusterRoles(admin: pg.Client): Promise<void> {
  for (const role of ["anon", "authenticated", "service_role"]) {
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`);
  }
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 're_proof_owner') then create role re_proof_owner nologin nosuperuser nobypassrls; end if; end $$`);
}

async function applyFile(c: pg.Client, file: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS, file), "utf8");
  await c.query("begin");
  try {
    await c.query(sql);
    await c.query("commit");
  } catch (err) {
    await c.query("rollback");
    throw new Error(`${file}: ${(err as Error).message}`);
  }
}

async function applyRuntime(c: pg.Client): Promise<void> {
  // What InitReportEmailSchema does: one transaction per migration, a LOCAL
  // lock timeout first, the statements in order.
  for (const list of [REPORT_EMAIL_DDL_056, REPORT_EMAIL_DDL_057, REPORT_EMAIL_DDL_058]) {
    await c.query("begin");
    await c.query("set local lock_timeout = '2s'");
    for (const stmt of list) { await c.query(stmt); }
    await c.query("commit");
  }
}

async function catalogue(c: pg.Client): Promise<string> {
  const cols = await c.query(`select table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression
      from information_schema.columns
     where table_schema = 'public' and table_name in ('ReportSchedules','ReportDeliveries','ReportEmailRecipients','ReportDeliveryFiles','ReportSweepLease')
     order by 1, 2`);
  const cons = await c.query(`select rel.relname, con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con join pg_class rel on rel.oid = con.conrelid
     where rel.relname in ('ReportSchedules','ReportDeliveries','ReportEmailRecipients','ReportDeliveryFiles','ReportSweepLease')
     order by 1, 2`);
  const idx = await c.query(`select tablename, indexname, indexdef from pg_indexes
     where tablename in ('ReportSchedules','ReportDeliveries','ReportEmailRecipients','ReportDeliveryFiles','ReportSweepLease') order by 1, 2`);
  const rls = await c.query(`select relname, relrowsecurity, relforcerowsecurity from pg_class
     where relname in ('ReportSchedules','ReportDeliveries','ReportEmailRecipients','ReportDeliveryFiles','ReportSweepLease') order by 1`);
  const pol = await c.query(`select tablename, policyname, qual, with_check from pg_policies
     where tablename in ('ReportEmailRecipients','ReportDeliveryFiles','ReportSweepLease') order by 1, 2`);
  const grants = await c.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants
     where table_name in ('ReportSchedules','ReportDeliveries','ReportEmailRecipients','ReportDeliveryFiles','ReportSweepLease') order by 1, 2, 3`);
  return JSON.stringify({ cols: cols.rows, cons: cons.rows, idx: idx.rows, rls: rls.rows, pol: pol.rows, grants: grants.rows });
}

async function main(): Promise<void> {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await ensureClusterRoles(admin);
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const upTo053 = files.filter((f) => f < "054");

  console.log("1. every file applies in order, on a fresh database");
  const fresh = await freshDb(admin, "re_proof_fresh");
  for (const f of upTo053) { await applyFile(fresh, f); }
  // A 'manual:' delivery written by 2.0.1, for the backfill.
  await fresh.query(`insert into "Restaurant" (id, res_username, res_name) values
    ('11111111-1111-4111-8111-111111111111', 'gaia', 'Gaia'),
    ('22222222-2222-4222-8222-222222222222', 'ggv', 'GGV')`);
  await fresh.query(`insert into "Outlets" (id, oultet_username, outlet_name, outlet_add, res_id) values
    ('33333333-3333-4333-8333-333333333333', 'gaia-main', 'Gaia', 'x', '11111111-1111-4111-8111-111111111111'),
    ('44444444-4444-4444-8444-444444444444', 'ggv-main', 'GGV', 'x', '22222222-2222-4222-8222-222222222222')`);
  const legacy = await fresh.query(`insert into "ReportSchedules" (res_id, outlet_id, name, report_key, frequency, hour_local, minute_local, channel, recipients, format)
    values ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'Daily sales', 'sales', 'daily', 8, 0, 'email', '{owner@gaia.test}', 'csv') returning id`);
  const legacySchedule = legacy.rows[0].id as string;
  await fresh.query(`insert into "ReportDeliveries" (res_id, outlet_id, schedule_id, occurrence_key, fire_at, period_from, period_to, timezone, status, next_attempt_at)
    values ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', $1, 'manual:2026-09-16T08:01', now(), '2026-09-15', '2026-09-15', 'Asia/Kolkata', 'delivered', now())`, [legacySchedule]);
  let allApplied = true;
  for (const f of NEW_FILES) {
    try { await applyFile(fresh, f); } catch (err) { allApplied = false; console.log(`    ${(err as Error).message}`); }
  }
  check("056, 057 and 058 apply on top of 000-053", allApplied);
  const meta = await fresh.query(`select data_type from information_schema.columns where table_name = 'ReportDeliveries' and column_name = 'message_meta'`);
  check("058 adds message_meta as jsonb (a retry's body is built from it)", meta.rows[0]?.data_type === "jsonb", JSON.stringify(meta.rows));
  const probe = await fresh.query(REPORT_EMAIL_SCHEMA_PROBE);
  check("the runtime's probe reads all three as present", probe.rows[0].m056 === true && probe.rows[0].m057 === true && probe.rows[0].m058 === true, JSON.stringify(probe.rows[0]));
  const backfilled = await fresh.query(`select kind from "ReportDeliveries" where occurrence_key like 'manual:%'`);
  check("a 2.0.1 'manual:' delivery is backfilled to kind 'manual'", backfilled.rows[0]?.kind === "manual");
  const tripwire = await fresh.query(`select 1 from pg_constraint where conname = 'report_schedules_period_shape'`);
  check("026's payroll/balance-sheet tripwire survives the widening", tripwire.rowCount === 1);
  const oldChecks = await fresh.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = '"ReportSchedules"'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''sales''%' and pg_get_constraintdef(oid) not like '%item_wise%'`);
  check("no narrow report_key CHECK is left behind to refuse the new keys", oldChecks.rowCount === 0, JSON.stringify(oldChecks.rows));

  console.log("2. runtime statements then the files == the files alone");
  const viaRuntime = await freshDb(admin, "re_proof_runtime");
  for (const f of upTo053) { await applyFile(viaRuntime, f); }
  await applyRuntime(viaRuntime);
  const afterRuntime = await catalogue(viaRuntime);
  let filesOk = true;
  for (const f of NEW_FILES) {
    try { await applyFile(viaRuntime, f); } catch (err) { filesOk = false; console.log(`    ${(err as Error).message}`); }
  }
  check("the files apply after the runtime has made the schema", filesOk);
  check("…and change nothing the runtime made", afterRuntime === (await catalogue(viaRuntime)));
  check("the runtime path and the file path give the same schema", (await catalogue(fresh)) === afterRuntime);

  console.log("3. re-applying takes no ACCESS EXCLUSIVE lock");
  const holder = new pg.Client({ connectionString: urlFor("re_proof_fresh") });
  await holder.connect();
  await holder.query("begin");
  await holder.query(`lock table "ReportSchedules", "ReportDeliveries", "ReportEmailRecipients", "ReportDeliveryFiles" in row exclusive mode`);
  const before = await catalogue(fresh);
  let rerunOk = true;
  for (const f of NEW_FILES) {
    const sql = (await readFile(join(MIGRATIONS, f), "utf8")).replace("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '1s';");
    await fresh.query("begin");
    try { await fresh.query(sql); await fresh.query("commit"); }
    catch (err) { rerunOk = false; await fresh.query("rollback"); console.log(`    ${f}: ${(err as Error).message}`); }
  }
  check("056-058 re-run under a 1s lock_timeout while a row-exclusive lock is held", rerunOk);
  check("…and the catalogue is identical afterwards", before === (await catalogue(fresh)));
  await holder.query("rollback");

  // The same lock against a database that still NEEDS 057: the file must give
  // up in bounded time rather than queue behind the holder.
  const pending = await freshDb(admin, "re_proof_pending");
  for (const f of upTo053) { await applyFile(pending, f); }
  const holder2 = new pg.Client({ connectionString: urlFor("re_proof_pending") });
  await holder2.connect();
  await holder2.query("begin");
  await holder2.query(`lock table "ReportSchedules" in row exclusive mode`);
  const started = Date.now();
  let code: string | undefined;
  try {
    const sql = (await readFile(join(MIGRATIONS, NEW_FILES[1]), "utf8")).replace("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '1s';");
    await pending.query("begin");
    await pending.query(sql);
    await pending.query("commit");
  } catch (err) { code = (err as { code?: string }).code; await pending.query("rollback"); }
  check("a 057 that has work to do gives up with lock_not_available instead of queueing", code === "55P03" && Date.now() - started < 4000, `code=${String(code)} after ${String(Date.now() - started)}ms`);
  await holder2.query("rollback");
  await holder2.end();
  await holder.end();
  await pending.end();

  console.log("4. the CHECKs refuse what they say; 026/044 writes still pass");
  const c = fresh;
  await c.query("begin");
  const RES = "11111111-1111-4111-8111-111111111111";
  const OUT = "33333333-3333-4333-8333-333333333333";
  const ins = `insert into "ReportSchedules" (res_id, outlet_id, name, report_key, frequency, hour_local, minute_local, weekday, channel, recipients, format, report_keys, formats, window_mode, outlet_scope)
               values ($1, $2, 'x', $3, $4, 2, 0, $5, $6, $7, $8, $9, $10, $11, $12) returning id`;
  const row = (o: Partial<Record<string, unknown>>) => [RES, OUT, o.report_key ?? "bundle", o.frequency ?? "daily", o.weekday ?? null, o.channel ?? "email",
    o.recipients ?? ["a@b.test"], o.format ?? "xlsx", o.report_keys ?? ["sales_summary", "settlement_summary"], o.formats ?? ["xlsx"], o.window_mode ?? "trading_day", o.outlet_scope ?? "outlet"];
  await accepts(c, "a trading-day bundle of two MIS reports as a workbook", ins, row({}));
  await accepts(c, "the 2.0.1 insert (no new columns) still passes", `insert into "ReportSchedules" (res_id, outlet_id, name, report_key, frequency, hour_local, minute_local, day_of_month, channel, recipients, format)
    values ($1, $2, 'legacy', 'gst', 'monthly', 8, 0, 1, 'inbox', '{}', 'csv')`, [RES, OUT]).then(async () => {
      const r = await c.query(`select report_keys, formats, window_mode, outlet_scope from "ReportSchedules" where name = 'legacy'`);
      check("…and reads back as a calendar CSV schedule with no report_keys", JSON.stringify(r.rows[0]) === JSON.stringify({ report_keys: [], formats: ["csv"], window_mode: "calendar", outlet_scope: "outlet" }), JSON.stringify(r.rows[0]));
    });
  await accepts(c, "one report on its own key, calendar, csv+xlsx", ins, row({ report_key: "item_wise", report_keys: ["item_wise"], formats: ["csv", "xlsx"], window_mode: "calendar" }));
  await refuses(c, "an unknown report_key", ins, row({ report_key: "payroll", report_keys: ["item_wise"] }), "23514");
  await refuses(c, "an unknown key inside report_keys", ins, row({ report_keys: ["item_wise", "payroll"] }), "23514");
  await refuses(c, "a 'bundle' with one report", ins, row({ report_keys: ["item_wise"] }), "23514");
  await refuses(c, "a 'bundle' with no reports (cardinality, not array_length)", ins, row({ report_keys: [] }), "23514");
  await refuses(c, "no formats (cardinality 0)", ins, row({ formats: [] }), "23514");
  await refuses(c, "a PDF format — nothing renders it yet", ins, row({ formats: ["pdf"] }), "23514");
  await refuses(c, "the legacy format column as 'pdf'", ins, row({ format: "pdf" }), "23514");
  await refuses(c, "a trading day on a weekly schedule", ins, row({ frequency: "weekly", weekday: 1 }), "23514");
  await refuses(c, "a trading day carrying GST", ins, row({ report_keys: ["sales_summary", "gst"] }), "23514");
  await refuses(c, "a trading day with P&L as the legacy key", ins, row({ report_key: "pnl", report_keys: ["pnl"] }), "23514");
  await accepts(c, "GST and P&L on calendar days", ins, row({ report_keys: ["gst", "pnl"], window_mode: "calendar" }));
  await accepts(c, "the accounting Sales report on a trading day", ins, row({ report_key: "sales", report_keys: ["sales"] }));
  await refuses(c, "an unknown window mode", ins, row({ window_mode: "fiscal" }), "23514");
  await refuses(c, "an unknown outlet scope", ins, row({ outlet_scope: "branch" }), "23514");
  await refuses(c, "eleven recipients", ins, row({ recipients: Array.from({ length: 11 }, (_v, i) => `p${String(i)}@x.test`) }), "23514");
  await refuses(c, "an email schedule with no recipients (044, still)", ins, row({ recipients: [] }), "23514");
  await refuses(c, "payroll on a daily schedule (026's tripwire, reached through the wider CHECK)", `insert into "ReportSchedules" (res_id, outlet_id, name, report_key, frequency) values ($1, $2, 'p', 'payroll', 'daily')`, [RES, OUT], "23514");

  const del = `insert into "ReportDeliveries" (res_id, outlet_id, schedule_id, occurrence_key, fire_at, period_from, period_to, timezone, status, next_attempt_at, kind, recipients, formats, report_keys)
               values ($1, $2, $3, $4, now(), '2026-09-16', '2026-09-16', 'Asia/Kolkata', $5, now(), $6, $7, $8, $9) returning id`;
  const drow = (o: Partial<Record<string, unknown>>) => [RES, OUT, o.schedule_id === undefined ? null : o.schedule_id, o.key ?? "adhoc:6f1c", o.status ?? "claimed", o.kind ?? "adhoc",
    o.recipients === undefined ? ["a@b.test"] : o.recipients, o.formats ?? ["xlsx"], o.report_keys ?? ["sales_summary"]];
  const adhoc = await accepts(c, "an ad hoc delivery: no schedule, 'adhoc:' key, one recipient", del, drow({}));
  await refuses(c, "a second ad hoc row with the same key (report_deliveries_adhoc_uniq)", del, drow({}), "23505");
  const onConflict = await c.query(`insert into "ReportDeliveries" (res_id, outlet_id, occurrence_key, fire_at, period_from, period_to, timezone, next_attempt_at, kind, recipients)
    values ($1, $2, 'adhoc:6f1c', now(), '2026-09-16', '2026-09-16', 'Asia/Kolkata', now(), 'adhoc', '{a@b.test}')
    on conflict (res_id, occurrence_key) where schedule_id is null do nothing returning id`, [RES, OUT]);
  check("ON CONFLICT … WHERE schedule_id IS NULL DO NOTHING returns no row on a replay", onConflict.rowCount === 0);
  await refuses(c, "…and the same ON CONFLICT without the predicate is 42P10", `insert into "ReportDeliveries" (res_id, outlet_id, occurrence_key, fire_at, period_from, period_to, timezone, next_attempt_at, kind, recipients)
    values ($1, $2, 'adhoc:6f1c', now(), '2026-09-16', '2026-09-16', 'Asia/Kolkata', now(), 'adhoc', '{a@b.test}')
    on conflict (res_id, occurrence_key) do nothing`, [RES, OUT], "42P10");
  await refuses(c, "an ad hoc row with NULL recipients (the cardinality(NULL) trap)", del, drow({ key: "adhoc:n1", recipients: null }), "23514");
  await refuses(c, "an ad hoc row with eleven recipients", del, drow({ key: "adhoc:n2", recipients: Array.from({ length: 11 }, (_v, i) => `p${String(i)}@x.test`) }), "23514");
  await refuses(c, "an ad hoc row whose key is not 'adhoc:'", del, drow({ key: "manual:2026-09-16T01:00" }), "23514");
  await refuses(c, "an ad hoc row that names a schedule", del, drow({ key: "adhoc:n3", schedule_id: legacySchedule }), "23514");
  await refuses(c, "a scheduled row with no schedule", del, drow({ key: "2026-09-16", kind: "scheduled" }), "23514");
  await refuses(c, "an unknown kind", del, drow({ key: "adhoc:n4", kind: "bulk" }), "23514");
  await accepts(c, "status 'sending'", del, drow({ key: "adhoc:n5", status: "sending" }));
  await refuses(c, "an unknown status", del, drow({ key: "adhoc:n6", status: "queued" }), "23514");
  await accepts(c, "the 026 claim, with its partial-index ON CONFLICT, still passes", `insert into "ReportDeliveries"
       (res_id, outlet_id, schedule_id, occurrence_key, fire_at, period_from, period_to, timezone, claimed_by, status, channel, next_attempt_at)
     values ($1,$2,$3,'2026-09-17',now(),'2026-09-16'::date,'2026-09-16'::date,'Asia/Kolkata','w','claimed','email',now())
     on conflict (schedule_id, occurrence_key) where occurrence_key is not null do nothing returning id`, [RES, OUT, legacySchedule]);
  const claimAgain = await c.query(`insert into "ReportDeliveries"
       (res_id, outlet_id, schedule_id, occurrence_key, fire_at, period_from, period_to, timezone, claimed_by, status, channel, next_attempt_at)
     values ($1,$2,$3,'2026-09-17',now(),'2026-09-16'::date,'2026-09-16'::date,'Asia/Kolkata','w','claimed','email',now())
     on conflict (schedule_id, occurrence_key) where occurrence_key is not null do nothing returning id`, [RES, OUT, legacySchedule]);
  check("…and a second claim of the same occurrence returns nothing (at most once)", claimAgain.rowCount === 0);

  const adhocId = adhoc.rows[0]?.id as string;
  const body = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0xFF, 0x0A]);
  await accepts(c, "a file row with a bytea body", `insert into "ReportDeliveryFiles" (res_id, delivery_id, report_key, format, filename, mime, bytes, rows, body)
    values ($1, $2, 'bundle', 'xlsx', 'reports.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 7, 3, $3)`, [RES, adhocId, body]);
  const back = await c.query(`select body from "ReportDeliveryFiles" where delivery_id = $1`, [adhocId]);
  check("…whose bytes come back byte for byte", Buffer.isBuffer(back.rows[0]?.body) && (back.rows[0].body as Buffer).equals(body));
  await refuses(c, "a file in a format nothing renders", `insert into "ReportDeliveryFiles" (res_id, delivery_id, report_key, format, filename, mime) values ($1, $2, 'x', 'pdf', 'x.pdf', 'application/pdf')`, [RES, adhocId], "23514");
  await c.query(`delete from "ReportDeliveries" where id = $1`, [adhocId]);
  const cascaded = await c.query(`select count(*)::int as n from "ReportDeliveryFiles" where delivery_id = $1`, [adhocId]);
  check("files go with their delivery (ON DELETE CASCADE)", cascaded.rows[0].n === 0);

  const book = `insert into "ReportEmailRecipients" (res_id, email, label, status) values ($1, $2, $3, $4) returning id, email_norm`;
  const first = await accepts(c, "an address", book, [RES, "Owner@Gaia.test", "Owner", "active"]);
  await refuses(c, "an address with surrounding whitespace (the server trims before it writes)", book, [RES, " x@gaia.test ", null, "active"], "23514");
  check("…normalised by the generated column", first.rows[0]?.email_norm === "owner@gaia.test", String(first.rows[0]?.email_norm));
  await refuses(c, "the same address in another case, while it is live", book, [RES, "OWNER@gaia.TEST", null, "active"], "23505");
  await accepts(c, "the same address for ANOTHER restaurant", book, ["22222222-2222-4222-8222-222222222222", "owner@gaia.test", null, "active"]);
  await c.query(`update "ReportEmailRecipients" set removed_at = now() where id = $1`, [first.rows[0]?.id]);
  await accepts(c, "the same address again once the first was removed", book, [RES, "owner@gaia.test", null, "active"]);
  await refuses(c, "an address with a space", book, [RES, "a b@c.test", null, "active"], "23514");
  await refuses(c, "an address with no @", book, [RES, "owner.gaia.test", null, "active"], "23514");
  await refuses(c, "a label over 60 characters", book, [RES, "l@x.test", "x".repeat(61), "active"], "23514");
  await refuses(c, "an unknown status", book, [RES, "s@x.test", null, "bounced"], "23514");
  const labels = await c.query(`select count(*)::int as n from "Actions" where id in ('ffded2ef-a164-4acc-8c13-77f9c66e5c31', 'f23fc314-7d12-41d7-af36-1cd57d8d3419')`);
  check("both audit labels are in \"Actions\"", labels.rows[0].n === 2);
  await c.query("commit");

  const lease = await c.query(`select count(*)::int as n from "ReportSweepLease"`);
  check("the lease table has exactly one row", lease.rows[0].n === 1);
  await c.query("begin");
  await refuses(c, "a second lease row", `insert into "ReportSweepLease" (id) values (2)`, [], "23514");
  const take = `update "ReportSweepLease" set holder = $1, until = now() + interval '4 minutes', heartbeat_at = now() where id = 1 and (until < now() or holder = $1) returning holder`;
  const a = await c.query(take, ["worker-a"]);
  const b = await c.query(take, ["worker-b"]);
  const a2 = await c.query(take, ["worker-a"]);
  check("the lease: A takes it, B is refused while it is held, A renews it", a.rowCount === 1 && b.rowCount === 0 && a2.rowCount === 1);
  await c.query("rollback");

  console.log("6. RLS on the new tenant tables, as app_runtime");
  await c.query("begin");
  await c.query(`insert into "ReportEmailRecipients" (res_id, email) values ('22222222-2222-4222-8222-222222222222', 'ggv-only@x.test')`);
  await c.query("set local role app_runtime");
  await c.query(`select set_config('app.res_id', $1, true)`, [RES]);
  const mine = await c.query(`select email from "ReportEmailRecipients" order by email`);
  check("a tenant reads only its own addresses", mine.rows.every((r) => r.email !== "ggv-only@x.test") && (mine.rowCount ?? 0) > 0, JSON.stringify(mine.rows));
  await refuses(c, "and cannot write one for another tenant", `insert into "ReportEmailRecipients" (res_id, email) values ('22222222-2222-4222-8222-222222222222', 'sneak@x.test')`, [], "42501");
  const leaseRead = await c.query(`select holder from "ReportSweepLease"`);
  check("the lease is readable by the runtime (not tenant data)", leaseRead.rowCount === 1);
  await refuses(c, "…but the runtime cannot insert lease rows", `insert into "ReportSweepLease" (id) values (1)`, [], "42501");
  await refuses(c, "…or delete the one there is", `delete from "ReportSweepLease"`, [], "42501");
  const runtimeTake = await c.query(`update "ReportSweepLease" set holder = 'runtime', until = now() + interval '4 minutes', heartbeat_at = now() where id = 1 returning holder`);
  check("…and can still take the lease with RLS forced (its own policy)", runtimeTake.rowCount === 1);
  await c.query("rollback");

  console.log("7. the sweep lease is out of every other role's reach");
  const grants = await c.query(`select grantee, string_agg(privilege_type, ',' order by privilege_type) as p
      from information_schema.role_table_grants where table_name = 'ReportSweepLease' group by grantee order by grantee`);
  const byRole = Object.fromEntries(grants.rows.map((r) => [r.grantee as string, r.p as string]));
  check("Supabase's default privileges were live on this database (the other tables have them)",
    ((await c.query(`select 1 from information_schema.role_table_grants where table_name = 'ReportEmailRecipients' and grantee = 'anon'`)).rowCount ?? 0) > 0);
  check("anon, authenticated and service_role hold NOTHING on the lease; PUBLIC nothing; the runtime SELECT and UPDATE only",
    byRole.anon === undefined && byRole.authenticated === undefined && byRole.service_role === undefined
      && byRole.PUBLIC === undefined && byRole.app_runtime === "SELECT,UPDATE",
    JSON.stringify(byRole));
  const forced = await c.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = '"ReportSweepLease"'::regclass`);
  check("RLS is enabled AND forced on the lease", forced.rows[0]?.relrowsecurity === true && forced.rows[0]?.relforcerowsecurity === true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    await refuses(c, `${role} cannot read the lease`, `select * from "ReportSweepLease"`, [], "42501");
    await refuses(c, `${role} cannot delete it`, `delete from "ReportSweepLease"`, [], "42501");
    await refuses(c, `${role} cannot move its deadline`, `update "ReportSweepLease" set until = '2099-01-01'`, [], "42501");
    await refuses(c, `${role} cannot trip the platform cap`, `update "ReportSweepLease" set sent_count = 2000`, [], "42501");
    await refuses(c, `${role} cannot truncate it`, `truncate "ReportSweepLease"`, [], "42501");
    await c.query("rollback");
  }
  // A NON-superuser owner — production's runtime connection. FORCE applies to
  // it, so only the owner policy lets it work; the policy reads the owner from
  // the catalogue, so handing the table to a new owner keeps working.
  await c.query("begin");
  await c.query(`alter table "ReportSweepLease" owner to re_proof_owner`);
  await c.query("set local role re_proof_owner");
  const ownerTake = await c.query(`update "ReportSweepLease" set holder = 'owner', until = now() + interval '4 minutes', heartbeat_at = now() where id = 1 and (until < now() or holder = 'owner') returning holder`);
  check("a non-superuser OWNER takes the lease with RLS forced", ownerTake.rowCount === 1);
  const ownerRead = await c.query(`select holder from "ReportSweepLease"`);
  check("…and reads it back", ownerRead.rows[0]?.holder === "owner");
  await c.query("rollback");
  // Re-applying 058 (the runtime's statements too) changes nothing now.
  const beforeLease = await catalogue(c);
  await applyFile(c, NEW_FILES[2]);
  for (const stmt of REPORT_EMAIL_DDL_058) { await c.query(stmt); }
  check("058 and its runtime statements re-run without changing the lease's grants or policies", beforeLease === (await catalogue(c)));

  await fresh.end();
  await viaRuntime.end();
  for (const db of ["re_proof_fresh", "re_proof_runtime", "re_proof_pending"]) {
    await admin.query(`drop database if exists ${db} with (force)`);
  }
  await admin.end();
  console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
