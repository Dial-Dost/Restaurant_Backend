// THE DEMO SEED'S ADMIN PASSWORD COMES FROM THE ENVIRONMENT, OR THE SEED DOES
// NOT RUN.
//
// ============================================================================
// WHY THIS SUITE EXISTS
// ============================================================================
// bootstrap() seeds a demo tenant whose admin login is called `admin`, and for a
// long time the password for it was a plaintext literal sitting in index.ts. Two
// things made that a live problem rather than an untidy one:
//
//   * the gate is `SEED_DEMO === "true" || NODE_ENV !== "production"`, and
//     NODE_ENV is unset on a great many boxes, so the seed ran far more often
//     than the word "demo" suggests — including, historically, in CI against a
//     database nobody could audit from the repository (.github/workflows/ci.yml
//     says so in its header);
//   * all three repositories are public. A literal in index.ts was therefore a
//     PUBLISHED password, and a read-only check against production found it was
//     still the real password of real `admin` logins. Finding it took a search,
//     not an attack.
//
// So the rule is now: the password is read from SEED_DEMO_ADMIN_PASSWORD, there
// is NO fallback, and with the variable unset or blank the seed is SKIPPED and
// says which variable to set. A default would just be the same published secret
// under another name, and a silent skip reads exactly like an unreachable
// database — the wrong thing to spend an evening debugging.
//
// The second half of the suite pins the other side of it: EnsureRestaurantSeed
// must not overwrite an EXISTING login's password. Seeding a tenant that is
// already seeded was a silent password reset, and on a provisioning route a
// tenant-takeover primitive (provisionRestaurant's existence pre-check was the
// only thing in front of it). Only the first seed of a login writes a password.
//
// ============================================================================
// WHAT THIS SUITE READS
// ============================================================================
// Source, not a running app — the same posture as bill_print_doors_always_on and
// scripts/route_manifest.ts. bootstrap() cannot be invoked here: it opens pools,
// binds a port and talks to Postgres, and the thing being asserted is a property
// of the TEXT (what is and is not written down in a public repository), which no
// amount of runtime behaviour can demonstrate.
//
// NOTHING IN THIS FILE NAMES A PASSWORD VALUE, and nothing in it may. A guard
// test that spells out the secret it is guarding has published it again, in a
// file nobody thinks to grep.

import { describe, test, expect } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = [process.cwd(), join(__dirname, "..")].find((b) => existsSync(join(b, "index.ts")));
if (!ROOT) { throw new Error("backend root (with index.ts) not found"); }

const read = (relative: string): string =>
  readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

/** Line comments dropped, so prose that quotes code cannot satisfy a code assertion. */
const withoutComments = (source: string): string =>
  source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

const indexSource = read("index.ts");

/**
 * The object literal passed to `await EnsureRestaurantSeed(…)` in bootstrap(),
 * brace-matched rather than line-sliced: the argument spans twenty lines and
 * nests three objects, and a fixed slice would quietly stop covering the
 * `admin:` block the day a field is added above it.
 */
const seedArgument = (): string => {
  const call = indexSource.indexOf("await EnsureRestaurantSeed(");
  if (call < 0) { throw new Error("index.ts: no `await EnsureRestaurantSeed(` call"); }
  const from = indexSource.indexOf("{", call);
  let depth = 0;
  for (let i = from; i < indexSource.length; i += 1) {
    if (indexSource[i] === "{") { depth += 1; }
    else if (indexSource[i] === "}") {
      depth -= 1;
      if (depth === 0) { return indexSource.slice(from, i + 1); }
    }
  }
  throw new Error("index.ts: the EnsureRestaurantSeed({ … }) argument never closes");
};

/** Whatever `password:` is set to in that argument, verbatim and untrimmed of quotes. */
const seedPasswordExpression = (): string => {
  const match = /(?:^|\n)\s*password:\s*([^,\n]+?),?\s*$/m.exec(seedArgument());
  if (!match) { throw new Error("index.ts: the seed argument has no `password:` field"); }
  return match[1]!.trim();
};

/** The `const …` / `let …` initialiser for a name, with no trailing semicolon. */
const initialiserOf = (name: string): string => {
  const match = new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=]*=\\s*([^;]+);`).exec(indexSource);
  if (!match) { throw new Error(`index.ts: no binding found for \`${name}\``); }
  return match[1]!.trim();
};

describe("the demo seed's admin password is environment-supplied, never written down", () => {
  test("the seed call passes a variable, not a string literal", () => {
    const expression = seedPasswordExpression();
    // A quote of any kind here is a credential in a public repository.
    expect(expression).not.toMatch(/["'`]/);
    // ...and what it does pass has to be a plain identifier, so the next test can
    // follow it to its binding. A call or a conditional would slip past that.
    expect(expression).toMatch(/^[A-Za-z_$][\w$]*$/);
  });

  test("that variable is read from SEED_DEMO_ADMIN_PASSWORD, and trimmed so blank means blank", () => {
    const initialiser = initialiserOf(seedPasswordExpression());
    expect(initialiser).toContain("process.env.SEED_DEMO_ADMIN_PASSWORD");
    // Without the trim, a variable set to spaces is a one-character password.
    expect(initialiser).toContain(".trim()");
  });

  test("there is NO fallback default — the only permitted coalesce is to blank", () => {
    const initialiser = initialiserOf(seedPasswordExpression());
    // `?? ""` / `|| ""` normalises "unset" to "blank" and is the point of the
    // next test. Coalescing to anything else is a baked-in credential.
    const coalesced = [...initialiser.matchAll(/(?:\?\?|\|\|)\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]);
    expect(coalesced.filter((value) => value !== "")).toEqual([]);
    // Nowhere else in the file may read the variable with a default either.
    const everyRead = [...withoutComments(indexSource).matchAll(
      /process\.env\.SEED_DEMO_ADMIN_PASSWORD\s*(?:\?\?|\|\|)\s*(["'`])([\s\S]*?)\1/g,
    )].map((m) => m[2]);
    expect(everyRead.filter((value) => value !== "")).toEqual([]);
  });

  test("an unset or blank variable SKIPS the seed: the password is part of the guard", () => {
    const upToCall = indexSource.slice(
      indexSource.indexOf("const shouldSeedDemo"),
      indexSource.indexOf("await EnsureRestaurantSeed("),
    );
    const conditions = [...upToCall.matchAll(/\bif \((.+?)\) \{/g)].map((m) => m[1]!);
    expect(conditions.length).toBeGreaterThan(0);
    const guard = conditions[conditions.length - 1]!;
    // Both halves: the opt-in gate AND a password to seed with.
    expect(guard).toContain("shouldSeedDemo");
    expect(guard).toContain(seedPasswordExpression());
  });

  test("the skip SAYS SO, on one line, naming the variable to set", () => {
    const code = withoutComments(indexSource);
    // Reached when the gate is open but the variable is not set — a silent skip
    // here is indistinguishable from a database that cannot be reached.
    expect(code).toMatch(/\}\s*else if \(shouldSeedDemo\) \{\s*logger\.warn\(/);
    const warning = /logger\.warn\("([^"]*SEED_DEMO_ADMIN_PASSWORD[^"]*)"\)/.exec(code);
    expect(warning).not.toBeNull();
    expect(warning![1]).not.toContain("\n");
  });

  test("the SEED_DEMO / NODE_ENV gate itself is unchanged", () => {
    expect(withoutComments(indexSource)).toContain(
      'const shouldSeedDemo = process.env.SEED_DEMO === "true" || process.env.NODE_ENV !== "production";',
    );
    // And production still says why it skipped, as it always did.
    expect(indexSource).toContain('logger.info("Skipping demo seed (production; set SEED_DEMO=true to override)");');
  });

  test("no non-empty credential literal is left in the boot or provisioning path", () => {
    // Any property whose NAME says credential, assigned a quoted value: pass,
    // password, emp_pass, pwd, secret, adminPassword, in any case. Property
    // ACCESS (`input.password`) is excluded by the leading character class, and a
    // type annotation (`password: string;`) has nothing quoted to match.
    const credentialLiteral = /(?:^|[^\w$.])([A-Za-z_$][\w$]*(?:pass|pwd|secret)[\w$]*)\s*:\s*(["'`])([^"'`\n]+)\2/gi;
    for (const file of ["index.ts", "provisioning.ts", "database_supabase.ts"]) {
      const literals = [...withoutComments(read(file)).matchAll(credentialLiteral)]
        // `password: ""` is allowed and used (a response shape that must not
        // carry a hash); a literal with anything in it is a secret in a public
        // repository. The value is NEVER reported — only its name and length.
        .map((m) => `${file}: \`${m[1]!}\` holds a ${m[3]!.length}-character literal`);
      expect(literals).toEqual([]);
    }
  });
});

describe("EnsureRestaurantSeed cannot reset an existing login's password", () => {
  const seedBody = (): string => {
    const source = read("database_supabase.ts");
    const at = source.indexOf("export async function EnsureRestaurantSeed(");
    if (at < 0) { throw new Error("database_supabase.ts: EnsureRestaurantSeed not found"); }
    // Top-level functions close with `}` at column 0 — the same end-of-function
    // rule bill_customer_address_boot.test.ts uses.
    const end = source.indexOf("\n}\n", at);
    if (end < 0) { throw new Error("database_supabase.ts: EnsureRestaurantSeed never closes"); }
    return withoutComments(source.slice(at, end));
  };

  test("the seed issues no UPDATE against \"Login\" at all", () => {
    expect(seedBody()).not.toMatch(/update\s+"Login"/i);
    expect(seedBody()).not.toMatch(/set\s+emp_pass/i);
  });

  test("a password is hashed exactly once, for the INSERT that creates the login", () => {
    const body = seedBody();
    const hashes = [...body.matchAll(/hashPassword\(/g)].map((m) => m.index!);
    expect(hashes).toHaveLength(1);
    const insert = body.indexOf('insert into "Login"');
    expect(insert).toBeGreaterThan(-1);
    expect(hashes[0]!).toBeGreaterThan(insert);
  });

  test("the caller's existence pre-check is still there — this is defence in depth, not a swap", () => {
    // provisionRestaurant is the one path that brings a tenant into existence,
    // and the pre-check is what turns a duplicate slug into a clean 409 instead
    // of a silent rename of a live tenant.
    const provisioning = withoutComments(read("provisioning.ts"));
    const seedCall = provisioning.indexOf("await EnsureRestaurantSeed(");
    const check = provisioning.indexOf("await getRestaurantIdFromUsername(slug)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(seedCall);
    expect(provisioning).toMatch(/throw new RestaurantExistsError\(slug\);/);
  });
});
