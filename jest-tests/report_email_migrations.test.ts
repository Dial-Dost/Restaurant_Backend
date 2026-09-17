// MIGRATIONS 056-058 AND THE RUNTIME MUST ISSUE THE SAME STATEMENTS.
//
// The house pattern (048, 050, 053): the backend makes the schema at boot
// (InitReportEmailSchema, from report_email_schema.ts) and the files record it
// when root applies them by hand. The whole idiom rests on the two being the
// same statements — if they drifted, what a restaurant's database looked like
// would depend on which ran first. So each file is held to its list here,
// statement for statement, in order.
//
// The files land in their own last commits (the deploy gate reads them on
// their own); this suite is written before them, as 053's was.
//
// test/integration/report_email_migrations_pg.ts runs the same files against a
// real Postgres (by hand — see its header): the CHECKs refuse, re-running takes
// no lock it does not need, both ON CONFLICT targets work.

import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPORT_EMAIL_DDL_056,
  REPORT_EMAIL_DDL_057,
  REPORT_EMAIL_DDL_058,
  REPORT_EMAIL_SCHEMA_PROBE,
  SCHEDULABLE_REPORT_KEYS_SQL,
} from "../report_email_schema";
import { REPORT_KEYS } from "../report_catalogue";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();
/** The file without its comments — a warning QUOTING a bad form must not count as using it. */
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const FILES: [string, readonly string[]][] = [
  ["migrations/056_report_email_recipients.sql", REPORT_EMAIL_DDL_056],
  ["migrations/057_report_schedule_bundles.sql", REPORT_EMAIL_DDL_057],
  ["migrations/058_report_delivery_bundles.sql", REPORT_EMAIL_DDL_058],
];

describe.each(FILES)("%s", (file, statements) => {
  const text = read(file);
  const body = squash(code(text));

  test("starts with SET LOCAL lock_timeout = '5s', before any statement", () => {
    expect(body.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  test("issues exactly the runtime's statements, in the runtime's order", () => {
    const expected = `SET LOCAL lock_timeout = '5s'; ${statements.map((s) => `${squash(s)};`).join(" ")}`;
    expect(body).toBe(expected);
  });

  test("never array_length() — cardinality(), which is 0 for an empty array", () => {
    expect(body).not.toMatch(/array_length\(/i);
  });

  test("every ALTER TABLE on an existing table sits behind a catalogue check", () => {
    // ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE before it looks; a DO block
    // that asks information_schema / pg_constraint first takes nothing.
    for (const stmt of statements) {
      if (/ALTER TABLE "Report(Schedules|Deliveries)"/.test(stmt)) {
        expect(stmt.trimStart().startsWith("DO $$")).toBe(true);
        expect(stmt).toMatch(/IF (NOT )?EXISTS \(\s*SELECT 1 FROM (information_schema\.columns|pg_constraint)/);
      }
      if (/CREATE (UNIQUE )?INDEX/.test(stmt)) {
        expect(stmt).toMatch(/IF to_regclass\('[a-z_]+'\) IS NULL THEN/);
      }
    }
  });
});

describe("what the three files say", () => {
  const f056 = squash(code(read("migrations/056_report_email_recipients.sql")));
  const f057 = squash(code(read("migrations/057_report_schedule_bundles.sql")));
  const f058 = squash(code(read("migrations/058_report_delivery_bundles.sql")));

  test("056: the book is tenant data — RLS forced with the house policy — and unique among LIVE addresses", () => {
    expect(f056).toContain("ALTER TABLE \"ReportEmailRecipients\" ENABLE ROW LEVEL SECURITY;");
    expect(f056).toContain("ALTER TABLE \"ReportEmailRecipients\" FORCE ROW LEVEL SECURITY;");
    expect(f056).toContain("USING (res_id::text = current_setting('app.res_id', true)) WITH CHECK (res_id::text = current_setting('app.res_id', true));");
    expect(f056).toContain("ON \"ReportEmailRecipients\" (res_id, email_norm) WHERE removed_at IS NULL;");
    expect(f056).toContain("email_norm text GENERATED ALWAYS AS (lower(btrim(email))) STORED");
    expect(f056).toContain("('ffded2ef-a164-4acc-8c13-77f9c66e5c31', 'Report Email Recipients Changed',");
    expect(f056).toContain("('f23fc314-7d12-41d7-af36-1cd57d8d3419', 'Report Emailed',");
  });

  test("057: the key list is the catalogue's eighteen; pdf is not storable; GST/P&L never on a trading day", () => {
    const keys = [...SCHEDULABLE_REPORT_KEYS_SQL.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...REPORT_KEYS]);
    expect(f057).toContain(`CHECK (report_key IN (${SCHEDULABLE_REPORT_KEYS_SQL},'bundle'))`);
    expect(f057).toContain("CHECK (format IN ('csv','xlsx'))");
    expect(f057).toContain("CHECK (cardinality(formats) BETWEEN 1 AND 2 AND formats <@ ARRAY['csv','xlsx']::text[])");
    expect(f057).not.toMatch(/'pdf'/);
    expect(f057).toContain("CHECK (window_mode <> 'trading_day' OR frequency = 'daily')");
    expect(f057).toContain("CHECK (window_mode <> 'trading_day' OR (NOT (report_keys && ARRAY['gst','pnl']::text[]) AND report_key NOT IN ('gst','pnl')))");
    expect(f057).toContain("CHECK (cardinality(recipients) <= 10)");
    expect(f057).toContain("CHECK (report_key <> 'bundle' OR cardinality(report_keys) >= 2)");
  });

  test("057: the old CHECKs are dropped BY DEFINITION, and 026's payroll tripwire is spared", () => {
    expect(f057).toContain("pg_get_constraintdef(con.oid) ~ '\\mreport_key\\M'");
    expect(f057).toContain("pg_get_constraintdef(con.oid) !~ 'payroll'");
    expect(f057).toContain("pg_get_constraintdef(con.oid) ~ '\\mformat\\M'");
  });

  test("058: status gains 'sending'; ad hoc rows have no schedule, an 'adhoc:' key and 1-10 addresses (NULL-safe)", () => {
    expect(f058).toContain("CHECK (status IN ('claimed','rendered','sending','delivered','failed','abandoned'))");
    expect(f058).toContain("CHECK ((kind = 'adhoc') = (schedule_id IS NULL))");
    expect(f058).toContain("CHECK (kind <> 'adhoc' OR (occurrence_key LIKE 'adhoc:%' AND coalesce(cardinality(recipients), 0) BETWEEN 1 AND 10))");
    expect(f058).toContain("ALTER TABLE \"ReportDeliveries\" ALTER COLUMN schedule_id DROP NOT NULL;");
    expect(f058).toContain("ON \"ReportDeliveries\" (res_id, occurrence_key) WHERE schedule_id IS NULL;");
    expect(f058).toContain("UPDATE \"ReportDeliveries\" SET kind = 'manual' WHERE kind = 'scheduled' AND occurrence_key LIKE 'manual:%';");
  });

  test("058: files cascade with their delivery and are RLS-forced; the lease is one row the runtime cannot add to or delete", () => {
    expect(f058).toContain("delivery_id uuid NOT NULL REFERENCES \"ReportDeliveries\"(id) ON DELETE CASCADE");
    expect(f058).toContain("ALTER TABLE \"ReportDeliveryFiles\" FORCE ROW LEVEL SECURITY;");
    expect(f058).toContain("id smallint PRIMARY KEY CHECK (id = 1)");
    expect(f058).toContain("INSERT INTO \"ReportSweepLease\" (id) VALUES (1) ON CONFLICT (id) DO NOTHING;");
    expect(f058).toContain("GRANT SELECT, UPDATE ON \"ReportSweepLease\" TO app_runtime;");
    expect(f058).toContain("REVOKE INSERT, DELETE, TRUNCATE ON \"ReportSweepLease\" FROM app_runtime;");
  });

  test("058: the lease is out of reach of every other role — Supabase's anon/authenticated included — and RLS-forced", () => {
    // Supabase's default privileges grant anon and authenticated everything on
    // a new public table (production's pg_default_acl, read 2026-09-17); a
    // PostgREST caller could otherwise delete the row or set `until`, which
    // stops every restaurant's sweep.
    expect(f058).toContain("REVOKE ALL ON \"ReportSweepLease\" FROM PUBLIC;");
    expect(f058).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON \"ReportSweepLease\" FROM anon; END IF;");
    expect(f058).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON \"ReportSweepLease\" FROM authenticated; END IF;");
    expect(f058).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN REVOKE ALL ON \"ReportSweepLease\" FROM service_role; END IF;");
    expect(f058).toContain("ALTER TABLE \"ReportSweepLease\" ENABLE ROW LEVEL SECURITY; ALTER TABLE \"ReportSweepLease\" FORCE ROW LEVEL SECURITY;");
    // Only the owner (read from the catalogue, not named) and the runtime pass.
    expect(f058).toContain("CREATE POLICY sweep_lease_owner ON \"ReportSweepLease\" USING (pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = '\"ReportSweepLease\"'::regclass), 'USAGE'))");
    expect(f058).toContain("CREATE POLICY sweep_lease_runtime ON \"ReportSweepLease\" TO app_runtime USING (true) WITH CHECK (true);");
    // …made AFTER the one row is inserted, so the insert is not the policy's to judge.
    expect(f058.indexOf("INSERT INTO \"ReportSweepLease\" (id) VALUES (1)")).toBeLessThan(f058.indexOf("FORCE ROW LEVEL SECURITY; END IF; IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ReportSweepLease'"));
    // No public table without RLS: every CREATE TABLE in 056-058 is followed by a FORCE for it.
    for (const f of [f056, f057, f058]) {
      for (const m of f.matchAll(/CREATE TABLE IF NOT EXISTS "([A-Za-z]+)"/g)) {
        expect(f).toContain(`ALTER TABLE "${m[1]}" FORCE ROW LEVEL SECURITY;`);
      }
    }
  });

  test("058: a retry's email body is rebuilt from what was stored with the files", () => {
    expect(f058).toContain("ALTER TABLE \"ReportDeliveries\" ADD COLUMN IF NOT EXISTS message_meta jsonb;");
  });

  test("the runtime's probe looks for the LAST thing each file makes", () => {
    const probe = squash(REPORT_EMAIL_SCHEMA_PROBE);
    expect(probe).toContain("to_regclass('\"ReportEmailRecipients\"') is not null as m056");
    expect(probe).toContain("conname = 'ReportSchedules_recipients_cap'");
    expect(f057.lastIndexOf("ReportSchedules_recipients_cap")).toBeGreaterThan(f057.lastIndexOf("ReportSchedules_outlet_scope_check"));
    expect(probe).toContain("conname = 'ReportDeliveries_outlet_scope_check'");
    // 058's last column, and the last thing it makes: the lease's owner policy.
    expect(probe).toContain("column_name = 'message_meta'");
    expect(f058.lastIndexOf("message_meta")).toBeGreaterThan(f058.lastIndexOf("maybe_duplicate"));
    expect(probe).toContain("to_regclass('\"ReportSweepLease\"') is not null");
    expect(probe).toContain("tablename = 'ReportSweepLease' and policyname = 'sweep_lease_owner'");
    expect(f058.lastIndexOf("CREATE POLICY sweep_lease_owner")).toBeGreaterThan(f058.lastIndexOf("CREATE TABLE IF NOT EXISTS"));
  });
});
