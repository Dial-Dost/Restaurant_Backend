// EVERY ACTION ID THE CODE NAMES MUST BE A ROW SOME MIGRATION INSERTS.
//
// ============================================================================
// WHAT WENT WRONG
// ============================================================================
// "Audit_logs".action_id has a foreign key to "Actions"(id). The original
// catalogue was created by hand in the first Supabase project and no migration
// ever seeded it, so on a database built from migrations — the local docker
// stack, CI's ephemeral Postgres, any fresh box — seating a table logged under
// 090ea8d4 "Table Occupied" and failed with 23503. The audit line was simply
// lost. Nothing in the unit suite could see it: every test fakes the database.
//
// The lazy seeds in database_supabase.ts had the same hole one level down. Each
// catch says "seeded by migrations under least-privilege runtimes", and none of
// them was — so under app_runtime the insert failed, the catch swallowed it and
// the row never existed.
//
// ============================================================================
// WHAT THIS SUITE PINS
// ============================================================================
//   1. Every uuid literal in the shipped TypeScript (comments stripped) is
//      inserted by a migration. A new validateAction("…") or log_audit(req, "…")
//      without a migration fails HERE, not on somebody's first audited write.
//   2. The lazy seeds and the migration agree on name and group, so whichever
//      runs first cannot give the same id two labels.
//   3. Migration 045 only ever inserts — it cannot rename a production row.

import { describe, test, expect } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const UUID = /["'`]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["'`]/g;

/**
 * Not action ids, each for a stated reason. Keep this list SHORT: anything added
 * here is an id the FK check will never see.
 */
const NOT_ACTIONS = new Set<string>([
  // The coalesce() sentinel in the Coupons unique index (database_supabase.ts).
  "00000000-0000-0000-0000-000000000000",
]);

/** Directories that are not shipped server code. */
const SKIP_DIRS = new Set([
  "node_modules", "build", "jest-tests", "test", "scripts", "migrations", "docs",
  "C_Sharp_temp_printer_server", "Python_servers", "deploy",
]);

function shippedTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) { continue; }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { out.push(...shippedTsFiles(full)); continue; }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) { out.push(full); }
  }
  return out;
}

/** uuid -> first file that names it, ignoring whole-line // comments (dead routes stay dead). */
function actionIdsInCode(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const file of shippedTsFiles(ROOT)) {
    const live = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const m of live.matchAll(UUID)) {
      const id = m[1];
      if (NOT_ACTIONS.has(id) || ids.has(id)) { continue; }
      ids.set(id, relative(ROOT, file));
    }
  }
  return ids;
}

interface SeedRow { id: string; name: string; group: string | null }

/** Every row an `INSERT INTO "Actions" … ON CONFLICT` block in `sql` inserts. */
function actionInserts(sql: string): SeedRow[] {
  const rows: SeedRow[] = [];
  const block = /INSERT INTO "Actions"[\s\S]*?ON CONFLICT/gi;
  const tuple = /\(\s*'([0-9a-f-]{36})',\s*'((?:[^']|'')*)',\s*(?:'(?:[^']|'')*'|null)\s*(?:,\s*'([^']+)'::"Action_groups")?\s*\)/gi;
  for (const b of sql.matchAll(block)) {
    for (const t of b[0].matchAll(tuple)) {
      rows.push({ id: t[1], name: t[2].replace(/''/g, "'"), group: t[3] ?? null });
    }
  }
  return rows;
}

const MIGRATIONS_DIR = join(ROOT, "migrations");
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const seeded = new Map<string, SeedRow & { file: string }>();
for (const file of migrationFiles) {
  for (const row of actionInserts(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
    if (!seeded.has(row.id)) { seeded.set(row.id, { ...row, file }); }
  }
}

describe("the Actions catalogue a migrated database starts with", () => {
  test("090ea8d4 — the id the live seat/release audit write failed on — is seeded", () => {
    expect(seeded.get("090ea8d4-e348-4e1b-9723-11131a73a085")?.name).toBe("Table Occupied");
  });

  test("EVERY action id the shipped code names is inserted by some migration", () => {
    const code = actionIdsInCode();
    // Guard against the scan silently finding nothing and passing vacuously.
    expect(code.size).toBeGreaterThan(50);
    const unseeded = [...code].filter(([id]) => !seeded.has(id)).map(([id, file]) => `${id} (${file})`);
    expect(unseeded).toEqual([]);
  });

  test("the lazy seeds in database_supabase.ts and the migrations give each id ONE name and group", () => {
    const src = readFileSync(join(ROOT, "database_supabase.ts"), "utf8");
    const lazy: SeedRow[] = [];
    // Literal tuples: ('id', 'name', 'desc', 'Group'::"Action_groups")
    for (const t of src.matchAll(/\('([0-9a-f-]{36})', '((?:[^']|'')*)', '(?:[^']|'')*', '([^']+)'::"Action_groups"\)/g)) {
      lazy.push({ id: t[1], name: t[2].replace(/''/g, "'"), group: t[3] });
    }
    // Parameterised seeds: values ($1, 'name', 'desc', 'Group'::"Action_groups") … [CONST]
    for (const m of src.matchAll(/values \(\$1, '((?:[^']|'')*)', '(?:[^']|'')*', '([^']+)'::"Action_groups"\)[\s\S]{0,200}?\[([A-Z_]+)\]/g)) {
      const id = new RegExp(`${m[3]} = "([0-9a-f-]{36})"`).exec(src)?.[1];
      if (id) { lazy.push({ id, name: m[1].replace(/''/g, "'"), group: m[2] }); }
    }
    expect(lazy.length).toBeGreaterThan(20);
    for (const row of lazy) {
      const mig = seeded.get(row.id);
      expect([row.id, mig?.name, mig?.group ?? row.group]).toEqual([row.id, row.name, row.group]);
    }
  });

  test("045 only INSERTs, and only ON CONFLICT DO NOTHING — a production row is never renamed", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "045_seed_actions_catalog.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    // Statement keywords at the start of a line, not the words inside action names.
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|ALTER|DROP)\b/m);
    expect(sql).not.toMatch(/DO UPDATE/);
    const inserts = sql.match(/INSERT INTO "Actions"/gi) ?? [];
    const guards = sql.match(/ON CONFLICT \(id\) DO NOTHING/gi) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(guards.length).toBe(inserts.length);
  });
});
