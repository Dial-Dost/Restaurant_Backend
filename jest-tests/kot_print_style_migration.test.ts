// MIGRATION 050 AND THE RUNTIME DDL MUST ISSUE THE SAME STATEMENTS.
//
// "Restaurant".kot_print_style (and, since the text-size setting,
// "Restaurant".kot_text_size) is created twice on purpose — once by
// ensureBrandingColumns() the first time this process touches settings, and once
// by migrations/050_kot_print_style.sql when somebody applies it by hand on the
// VPS. That is the 040/047/049 idiom: the feature works the moment the backend
// ships, and the file records the column in schema_migrations afterwards.
//
// The whole idiom rests on the two statements being the same statement. If they
// drifted, the column a restaurant ended up with would depend on WHICH of them
// ran first — and this column decides whether a kitchen's paper is a raster the
// printer may not be able to draw. So it is pinned, here, in the same commit as
// the migration file itself.
//
// This file is separate from kot_print_style.test.ts only because the migration
// lands in its own last commit; everything else about the switch is testable
// before the file exists, and is tested there.

import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const STATEMENT = 'alter table "Restaurant" add column if not exists kot_print_style text';
const SIZE_STATEMENT = 'alter table "Restaurant" add column if not exists kot_text_size text';

describe("migration 050", () => {
  test("issues the same statement the runtime DDL does", () => {
    expect(read("database_supabase.ts")).toContain(`${STATEMENT}\``);
    expect(read("migrations/050_kot_print_style.sql").toLowerCase()).toContain(STATEMENT.toLowerCase());
  });

  test("issues the same text-size statement the runtime DDL does, after the style's, in both places", () => {
    // The style first: it is the escape hatch, and if the second statement ever
    // fails on its own the first has already run. The runtime and the file agree
    // on that order so neither can leave a database the other did not expect.
    const runtime = read("database_supabase.ts");
    const file = read("migrations/050_kot_print_style.sql").toLowerCase();
    expect(runtime).toContain(`${SIZE_STATEMENT}\``);
    expect(file).toContain(SIZE_STATEMENT.toLowerCase());
    expect(runtime.indexOf(`${SIZE_STATEMENT}\``)).toBeGreaterThan(runtime.indexOf(`${STATEMENT}\``));
    expect(file.indexOf(SIZE_STATEMENT.toLowerCase())).toBeGreaterThan(file.indexOf(STATEMENT.toLowerCase()));
  });

  test("gives neither column a default — the defaults live in code", () => {
    // KOT_PRINT_STYLE_DEFAULT and KOT_TEXT_SIZE_DEFAULT in kot_print_style.ts are
    // the ONE answer to "what does a restaurant that never chose get?", and each
    // has to be the same answer for a NULL column, for a column that does not
    // exist yet (42703) and for a value nobody recognises. A column default could
    // only cover the first of those three, so having one would guarantee an
    // eventual disagreement.
    const file = read("migrations/050_kot_print_style.sql").toLowerCase();
    expect(file).not.toMatch(/kot_print_style\s+text\s+default/);
    expect(file).not.toMatch(/kot_text_size\s+text\s+default/);
    expect(file).not.toMatch(/alter column kot_(print_style|text_size) set default/);
  });

  test("is idempotent, so applying it after the runtime already created the columns is a no-op", () => {
    // On the VPS the runtime connects as the table owner, so by the time anybody
    // runs this file the columns exist. `if not exists` is what makes that the
    // ordinary case rather than a failed migration — on EVERY add column here.
    const file = read("migrations/050_kot_print_style.sql").toLowerCase();
    const adds = file.match(/add column[^;]*/g) ?? [];
    expect(adds).toHaveLength(2);
    for (const add of adds) { expect(add).toContain("add column if not exists"); }
  });

  test("says in the column comment what NULL means, for whoever reads the schema instead of the code", () => {
    const sql = read("migrations/050_kot_print_style.sql");
    expect(sql).toContain('comment on column "Restaurant".kot_print_style is');
    expect(sql).toMatch(/NULL = never chosen/i);
    expect(sql).toContain("classic");
  });

  test("…and so does the text-size column's, naming all three sizes", () => {
    const sql = read("migrations/050_kot_print_style.sql");
    const comment = /comment on column "Restaurant"\.kot_text_size is\s*'((?:[^']|'')*)'/.exec(sql);
    expect(comment).not.toBeNull();
    const text = comment?.[1] ?? "";
    expect(text).toMatch(/NULL = never chosen, read as ''standard''/);
    for (const size of ["small", "standard", "large"]) { expect(text).toContain(`''${size}''`); }
    expect(text).toMatch(/classic text docket ignores it/i);
  });

  test("waits at most 5s for its locks on \"Restaurant\" — the first thing it does", () => {
    // Applied by hand, possibly during service, and every request's context
    // read joins "Restaurant": the ALTER must refuse fast rather than queue them.
    const code = read("migrations/050_kot_print_style.sql")
      .split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  test("touches nothing but those two columns and their comments", () => {
    // Additive and nothing else: no backfill, no rewrite of any tenant's row.
    // Split on semicolons OUTSIDE string literals — both comments contain one.
    const code = read("migrations/050_kot_print_style.sql")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const statements: string[] = [];
    let current = "";
    let quoted = false;
    for (const ch of code) {
      if (ch === "'") { quoted = !quoted; }
      if (ch === ";" && !quoted) { statements.push(current.trim().toLowerCase()); current = ""; continue; }
      current += ch;
    }
    if (current.trim()) { statements.push(current.trim().toLowerCase()); }
    // The lock timeout, the two columns and their two comments.
    expect(statements).toHaveLength(5);
    expect(statements[0]).toBe("set local lock_timeout = '5s'");
    expect(statements.filter((s) => s.startsWith("alter table"))).toHaveLength(2);
    expect(statements.filter((s) => s.startsWith("comment on column"))).toHaveLength(2);
  });
});
