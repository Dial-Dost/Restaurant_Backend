// MIGRATION 050 AND THE RUNTIME DDL MUST ISSUE THE SAME STATEMENT.
//
// "Restaurant".kot_print_style is created twice on purpose — once by
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

describe("migration 050", () => {
  test("issues the same statement the runtime DDL does", () => {
    expect(read("database_supabase.ts")).toContain(`${STATEMENT}\``);
    expect(read("migrations/050_kot_print_style.sql").toLowerCase()).toContain(STATEMENT.toLowerCase());
  });

  test("gives the column no default — the default lives in code", () => {
    // KOT_PRINT_STYLE_DEFAULT in kot_print_style.ts is the ONE answer to "what
    // does a restaurant that never chose get?", and it has to be the same answer
    // for a NULL column, for a column that does not exist yet (42703) and for a
    // value nobody recognises. A column default could only cover the first of
    // those three, so having one would guarantee an eventual disagreement.
    expect(read("migrations/050_kot_print_style.sql").toLowerCase()).not.toMatch(/kot_print_style\s+text\s+default/);
  });

  test("is idempotent, so applying it after the runtime already created the column is a no-op", () => {
    // On the VPS the runtime connects as the table owner, so by the time anybody
    // runs this file the column exists. `if not exists` is what makes that the
    // ordinary case rather than a failed migration.
    expect(read("migrations/050_kot_print_style.sql").toLowerCase()).toContain("add column if not exists");
  });

  test("says in the column comment what NULL means, for whoever reads the schema instead of the code", () => {
    const sql = read("migrations/050_kot_print_style.sql");
    expect(sql).toContain('comment on column "Restaurant".kot_print_style is');
    expect(sql).toMatch(/NULL = never chosen/i);
    expect(sql).toContain("classic");
  });
});
