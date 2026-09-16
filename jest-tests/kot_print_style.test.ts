// THE OWNER'S ESCAPE HATCH FROM THE RASTER DOCKET ("Restaurant".kot_print_style).
//
// The reference kitchen docket is drawn as an IMAGE, because the client's ticket
// is a proportional Arial-metric face and the printer's built-in fonts are
// monospaced. A thermal printer that does not implement `GS v 0` does not
// complain about an image — it feeds BLANK PAPER. On a kitchen printer that is
// silent order loss: the food is never cooked, every screen says the order is
// fine, and the guest finds out first. No printer model is on record for this
// estate, so the risk cannot be checked in advance; it can only be made
// recoverable by an owner, in Settings, without a deploy.
//
// That makes this switch a SAFETY control rather than a preference, and it is
// why the cases below pin the things that would fail quietly:
//
//   * the vocabulary: reads forgive anything (a NULL, a column that does not
//     exist yet, a hand-typed value) and answer the default; writes refuse
//     anything that is not one of the two styles, so a save can never report
//     success while leaving a kitchen on the docket it cannot print;
//   * EVERY docket carries the restaurant's style — including each per-station
//     ticket a KOT splits into, and the cancellation slip;
//   * nothing builds a KOT without it. That is this project's most repeated
//     defect ("built but never called"): correct code with no caller. Here the
//     caller that forgot would not throw, it would print blank paper.
//
// The renderer's own half — what "reference" and "classic" actually put on the
// roll — belongs to escpos.ts and is tested with the renderer. What is pinned
// here is that the word REACHES it, and that the two files still agree on which
// words exist.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  KOT_PRINT_STYLES,
  KOT_PRINT_STYLE_DEFAULT,
  normalizeKotPrintStyle,
  parseKotPrintStyle,
} from "../kot_print_style";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";
const TABLE = "33333333-3333-4333-8333-333333333333";

/** What GetKotPrintStyle answers for this test. */
const mockStyle: { value: string } = { value: "reference" };
/**
 * Every ReceiptOptions handed to the renderer.
 *
 * ONE OBJECT PER DISPATCH, not per station: buildKotBase64 takes the whole
 * ticket and spreads `...opts` into each station docket it splits out (pinned by
 * a source guard at the foot of this file), so this object is what every one of
 * those dockets is made from. The REAL splitter still runs underneath — the mock
 * delegates — so the station count each case asserts is the shipped behaviour
 * rather than a fixture's opinion.
 */
const mockReceipts: Record<string, unknown>[] = [];

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<{ rows: unknown[] }> { return Promise.resolve({ rows: [] }); }
    connect(): Promise<never> { return Promise.reject(new Error("kot_print_style fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    // The one read under test. Returning the raw fixture string (not a parsed
    // style) would test the wrong thing — dispatchKot is entitled to trust that
    // this function has already normalized, and it is loadKotPrintStyle's job to
    // do so. kot_print_style_column.test.ts drives the real one over SQL.
    GetKotPrintStyle: () => Promise.resolve(mockStyle.value),
    // Two dishes on two stations, so a single dispatch produces TWO dockets and
    // the per-station split is actually exercised.
    GetMenuItems: () => Promise.resolve([
      { id: "m-1", name: "Subz Tehri", station: "Kitchen" },
      { id: "m-2", name: "Gaia Rose Cookies", station: "Bakery" },
    ]),
    GetRestaurantSettings: () => Promise.resolve({
      currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata",
      kitchen_sections: ["Kitchen", "Bakery"], kot_auto_print: true,
    }),
    GetRestaurantProfile: () => Promise.resolve({ outlet_name: "Fixture Diner" }),
    GetTableFeedbackContext: () => Promise.resolve(null),
    LookupKotNumber: () => Promise.resolve(null),
  };
});

jest.mock("../kot_numbers", () => ({
  ...(jest.requireActual("../kot_numbers") as Record<string, unknown>),
  // Numbering has its own suite over its own SQL fixture. An unnumbered docket
  // is a real, shipped outcome (migration 029 unapplied), so it is a fair
  // stand-in here and keeps this file about ONE thing.
  allocateKotNumber: () => Promise.resolve(null),
}));

jest.mock("../escpos", () => {
  const actual = jest.requireActual("../escpos") as typeof import("../escpos");
  return {
    __esModule: true,
    ...(actual as unknown as Record<string, unknown>),
    buildKotBase64: (opts: Parameters<typeof actual.buildKotBase64>[0], width?: number) => {
      mockReceipts.push(opts as unknown as Record<string, unknown>);
      return actual.buildKotBase64(opts, width);
    },
  };
});

jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: () => Promise.resolve({ jobId: "job-1", decision: { mode: "broadcast" }, assignedDeviceId: null }),
}));

type KotPrint = typeof import("../kot_print");
let kp: KotPrint;

beforeEach(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  if (!kp) { kp = await import("../kot_print"); }
  mockStyle.value = "reference";
  mockReceipts.length = 0;
});

/** Dispatch one two-station KOT: what the renderer was handed, and what came back. */
async function dispatch(extra: Record<string, unknown> = {}): Promise<{
  options: Record<string, unknown>;
  result: Awaited<ReturnType<KotPrint["dispatchKot"]>>;
}> {
  mockReceipts.length = 0;
  const result = await kp.dispatchKot({
    restaurantId: RES,
    outletId: OUTLET,
    tableName: "33",
    tableId: TABLE,
    section: "DOME SECTION",
    covers: 4,
    isVirtual: false,
    orderType: "dine_in",
    items: [
      { name: "Subz Tehri", quantity: 1 },
      { name: "Gaia Rose Cookies", quantity: 1 },
    ],
    assignedTo: "yado",
    captain: "TIYASHA",
    billId: "order-1",
    restaurantName: "Fixture Diner",
    currency: "₹",
    cols: 48,
    tz: "Asia/Kolkata",
    ...extra,
  } as never);
  const options = mockReceipts[0];
  if (!options) { throw new Error("the dispatch built no docket at all"); }
  return { options, result };
}

// ---------------------------------------------------------------------------

describe("the vocabulary", () => {
  test("a read forgives everything it cannot use and answers the default", () => {
    // NULL column, column that does not exist yet, a value from a future
    // version, something typed in by hand. All of them mean the same thing on
    // the print path: this restaurant has not chosen.
    for (const raw of [null, undefined, "", "   ", "REFERENCE-ish", "raster", 7, true, {}, []]) {
      expect(normalizeKotPrintStyle(raw)).toBe(KOT_PRINT_STYLE_DEFAULT);
    }
    expect(KOT_PRINT_STYLE_DEFAULT).toBe("reference");
  });

  test("a read accepts either style, however it was cased or spaced", () => {
    // A value put in the column by hand must still select the docket it names.
    // Coercing " Classic " to the default would put a kitchen that cannot draw a
    // raster back on blank paper, which is the whole failure this column exists
    // to prevent.
    expect(normalizeKotPrintStyle("classic")).toBe("classic");
    expect(normalizeKotPrintStyle(" Classic ")).toBe("classic");
    expect(normalizeKotPrintStyle("CLASSIC")).toBe("classic");
    expect(normalizeKotPrintStyle("reference")).toBe("reference");
    expect(normalizeKotPrintStyle(" Reference\n")).toBe("reference");
  });

  test("a write refuses anything that is not a style, and treats an absent key as no change", () => {
    // The strict half. An unrecognised value on a SAVE is a client sending
    // something wrong, and coercing it to the default would tell an owner who
    // just chose "Classic" that their save worked.
    for (const raw of ["", "  ", "raster", "text", "Classic docket", 1, true, {}, null, undefined]) {
      expect(parseKotPrintStyle(raw)).toBeNull();
    }
    expect(parseKotPrintStyle("classic")).toBe("classic");
    expect(parseKotPrintStyle("REFERENCE")).toBe("reference");
  });

  test("there are exactly two styles, and the default is one of them", () => {
    // A third value would have to be taught to the renderer, the column, the
    // settings screen and the undo table in the same commit; this is where that
    // conversation starts.
    expect([...KOT_PRINT_STYLES]).toEqual(["reference", "classic"]);
    expect(KOT_PRINT_STYLES).toContain(KOT_PRINT_STYLE_DEFAULT);
  });
});

describe("every docket carries the restaurant's style", () => {
  test("the default reaches the renderer as a real value, not as an absent field", async () => {
    // An absent field would render the same docket TODAY and a different one the
    // day the renderer learns to read it. "This restaurant chose nothing" has to
    // arrive as a word.
    const { options } = await dispatch();
    expect(options.kotPrintStyle).toBe("reference");
  });

  test("a restaurant on the classic docket gets it, and it covers every station ticket", async () => {
    // Two dishes on two stations, so the real splitter produces two dockets —
    // both built from this one options object (see the spread guard below).
    mockStyle.value = "classic";
    const { options, result } = await dispatch();
    expect(options.kotPrintStyle).toBe("classic");
    expect(result.tickets).toBe(2);
    expect(result.stations).toEqual(["Kitchen", "Bakery"]);
  });

  test("the cancellation slip obeys it too", async () => {
    // The slip that tells a kitchen to STOP cooking is the last docket that can
    // afford to come out blank.
    mockStyle.value = "classic";
    const { options, result } = await dispatch({ cancelled: true, neverAllocate: true, contextLine: "*** REASON: SPILLED ***" });
    expect(options.cancelled).toBe(true);
    expect(options.kotPrintStyle).toBe("classic");
    expect(result.tickets).toBe(2);
  });

  test("the style is the ONLY thing that changes between the two", async () => {
    // A switch that also moved a line, dropped the hold marker or renamed a
    // station would be a layout change wearing a safety control's clothes.
    mockStyle.value = "reference";
    const reference = (await dispatch()).options;
    mockStyle.value = "classic";
    const classic = (await dispatch()).options;
    const { kotPrintStyle: _a, ...referenceRest } = reference;
    const { kotPrintStyle: _b, ...classicRest } = classic;
    expect(classicRest).toEqual(referenceRest);
  });
});

// ---------------------------------------------------------------------------
// SOURCE GUARDS
//
// database_supabase.ts cannot run its SQL under jest and escpos.ts's own half of
// this feature belongs to another lane, so the wiring that must not rot is
// asserted against the source. Each of these fails LOUDLY the day somebody adds
// a KOT producer, renames the field, or teaches one file a word the other does
// not know.

describe("nothing builds a KOT without a style", () => {
  const root = join(__dirname, "..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");

  /** Every shipped .ts file — not tests, not build output, not dependencies. */
  function shippedSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "build", "jest-tests", "test", ".git", "Python_servers", "C_Sharp_temp_printer_server"].includes(entry)) { continue; }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { shippedSources(full, out); }
      else if (entry.endsWith(".ts")) { out.push(full); }
    }
    return out;
  }

  /** The text between the delimiters whose opener sits just before `from`. */
  function balanced(src: string, from: number, open: string, close: string): string {
    let depth = 1;
    let i = from;
    while (i < src.length && depth > 0) {
      if (src[i] === open) { depth += 1; } else if (src[i] === close) { depth -= 1; }
      i += 1;
    }
    return src.slice(from, i - 1);
  }

  /** Every argument list a file passes to buildKotBase64, verbatim. */
  function callArguments(src: string): string[] {
    const out: string[] = [];
    const call = /buildKotBase64\s*\(/g;
    let hit: RegExpExecArray | null;
    while ((hit = call.exec(src)) !== null) { out.push(balanced(src, call.lastIndex, "(", ")")); }
    return out;
  }

  /**
   * Does this call actually hand the renderer a style?
   *
   * Either the options are written inline at the call (routes/printing.ts), or
   * they are a named object built just above it (kot_print.ts's renderOptions),
   * in which case the object's own body is what has to carry the field.
   */
  function handsAStyle(src: string, args: string): boolean {
    if (args.includes("kotPrintStyle")) { return true; }
    const named = /^\s*([A-Za-z_$][\w$]*)\s*[,)]?/.exec(`${args},`);
    const name = named?.[1];
    if (!name) { return false; }
    const declaration = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\{`).exec(src);
    if (!declaration) { return false; }
    return balanced(src, declaration.index + declaration[0].length, "{", "}").includes("kotPrintStyle");
  }

  test("every caller of buildKotBase64 hands it a style", () => {
    const files = shippedSources(root)
      .filter((f) => /\bbuildKotBase64\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1).replace(/\\/g, "/"))
      .sort();
    // THE LIST IS PINNED, not merely filtered. A new KOT producer must show up
    // here and be given the style deliberately — this is the assertion that
    // makes "built but never called" a failing test rather than a blank ticket.
    expect(files).toEqual(["escpos.ts", "kot_print.ts", "routes/printing.ts"]);
    // escpos.ts is where buildKotBase64 is DEFINED; the other two call it. The
    // check reads the ARGUMENTS, not just the file: a style resolved at the top
    // of a handler and then not passed is exactly the shape of this project's
    // "built but never called" defect, and mentioning the word somewhere in the
    // file is not evidence that the renderer was handed it.
    for (const caller of ["kot_print.ts", "routes/printing.ts"]) {
      const src = read(caller);
      const calls = callArguments(src);
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) { expect({ caller, args, handsAStyle: handsAStyle(src, args) }).toMatchObject({ handsAStyle: true }); }
    }
  });

  test("dispatchKot resolves the style itself rather than taking it from a caller", () => {
    // Every KOT path in the product funnels through dispatchKot. Resolving here
    // is what makes the switch impossible for a caller to forget — so a future
    // `printStyle?:` on KotDispatchInput is a regression, not a feature.
    const src = read("kot_print.ts");
    expect(src).toContain("const kotPrintStyle = await GetKotPrintStyle(input.restaurantId);");
    expect(src).toContain("kotPrintStyle,");
    expect(src).not.toMatch(/printStyle\?:/);
  });

  test("the per-station split carries the whole options object, so it carries the style", () => {
    // This is what lets the cases above assert on ONE options object and speak
    // for every station docket. If buildKotBase64 ever stopped spreading and
    // started naming the fields it forwards, a five-station order would have
    // four dockets whose style is whatever the renderer defaults to.
    expect(read("escpos.ts")).toContain("buildReceiptBase64({ ...opts, kind: \"kot\", station, items }, width)");
  });

  test("escpos.ts knows exactly the styles kot_print_style.ts does", () => {
    // escpos.ts keeps zero imports on purpose, so it spells the union out. The
    // day the two disagree, a kitchen that chose the word escpos.ts forgot goes
    // back to a docket it may print as blank paper.
    const declaration = /kotPrintStyle\?:\s*([^;]+);/.exec(read("escpos.ts"));
    expect(declaration).not.toBeNull();
    const declared = (declaration?.[1] ?? "").split("|").map((s) => s.trim().replace(/^"|"$/g, ""));
    expect(declared.sort()).toEqual([...KOT_PRINT_STYLES].sort());
  });
});

describe("the column is created at runtime, and the setting can be undone", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

  test("the runtime DDL creates the column with no default", () => {
    // The 040/047/049 idiom: the column is created at runtime so the feature
    // works before anybody applies the migration file by hand on the VPS. NO
    // COLUMN DEFAULT, because a default would be a second place for "what does a
    // restaurant that never chose get?" to live — and it could not cover the
    // other two cases the read has to answer the same way (a column that does
    // not exist yet, and a value nobody recognises). The day the two disagreed,
    // the one on the paper would be whichever the printer got.
    //
    // kot_print_style_migration.test.ts holds this statement against the
    // migration file, which lands in a commit of its own.
    expect(read("database_supabase.ts")).toContain('alter table "Restaurant" add column if not exists kot_print_style text`');
  });

  test("an undo can restore the setting", () => {
    // Settings undo refuses any key it has no column for ("cannot_restore_key"),
    // so a switch missing from that table is a switch the Audit Log cannot put
    // back — on the one setting somebody flips in a hurry, at a printer.
    expect(read("database_supabase.ts")).toContain('kot_print_style: { column: "kot_print_style"');
  });
});
