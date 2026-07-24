// Idempotent SQL migration runner.
//
// Applies every Restaurant_Backend/migrations/*.sql file that hasn't been run
// yet, in filename order, each inside its own transaction, recording applied
// files in a `schema_migrations` table. Safe to run repeatedly — already-applied
// migrations are skipped.
//
// Usage:
//   npm run migrate            # apply all pending migrations
//   npm run migrate -- --dry-run   # list pending migrations without applying
//
// Connection: uses MIGRATION_DATABASE_URL (preferred — should be an OWNER/superuser
// role, since migrations create roles, schemas, and RLS policies) and falls back to
// SUPABASE_DIRECT_URL / DATABASE_URL / DIRECT_URL. NEVER point this at the runtime
// `app_runtime` role — it intentionally lacks DDL privileges.
import { Pool } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const connectionString =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.SUPABASE_DIRECT_URL ??
  process.env.DATABASE_URL ??
  process.env.DIRECT_URL;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (!connectionString) {
    throw new Error(
      "MIGRATION_DATABASE_URL (or SUPABASE_DIRECT_URL / DATABASE_URL / DIRECT_URL) is required to run migrations.",
    );
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (files.length === 0) {
    console.log("No .sql migrations found in", MIGRATIONS_DIR);
    return;
  }

  // Managed Postgres (Supabase/Railway) needs SSL; a local/CI Postgres (localhost)
  // doesn't speak it. Force SSL only for remote hosts so `npm run migrate` works in
  // CI's plain Postgres service too. Override with sslmode=disable / sslmode=require.
  const useSsl = /[?&]sslmode=require/i.test(connectionString)
    || (!/[?&]sslmode=disable/i.test(connectionString) && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(connectionString));
  const pool = new Pool({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : false });
  try {
    await pool.query(
      `create table if not exists schema_migrations (
         filename text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const appliedRows = await pool.query<{ filename: string }>(`select filename from schema_migrations`);
    const applied = new Set(appliedRows.rows.map((r) => r.filename));

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log(`All ${files.length} migrations already applied. Nothing to do.`);
      return;
    }

    console.log(`${pending.length} pending migration(s):`);
    for (const f of pending) {console.log(`  - ${f}`);}
    if (dryRun) {
      console.log("\n--dry-run: no changes made.");
      return;
    }

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(`insert into schema_migrations (filename) values ($1)`, [file]);
        await client.query("commit");
        console.log(`✓ applied ${file}`);
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.error(`✗ failed ${file} — rolled back.`);
        throw err;
      } finally {
        client.release();
      }
    }
    console.log(`\nDone. Applied ${pending.length} migration(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
