// EVERY ROUTE THAT PRINTS IS SERVED BY THE TASK THAT OWNS THE PRINTER SOCKETS.
//
// ============================================================================
// THE INVARIANT, AND HOW IT WAS QUIETLY BROKEN
// ============================================================================
// The serverless topology (deploy/template.yaml — parked, but the template is
// the plan the day Lambda hosting resumes) serves most routes from Lambda and a
// few from one always-on Fargate task that holds the Socket.IO connections.
// Printing is the reason for the split. A print route ends in a 'bill:print'
// emit, and an emit made on Lambda can still be sitting in node-redis's queue
// when the container freezes (lambda.ts says so beside its setImmediate). So
// CloudFront sends /print/* and /publish/* to the task, and deploy/README.md 2.1
// lists the routes that depend on it.
//
// That rule was written as a PREFIX, and the doors were not. Client item 6 added
// POST /bills/service-charge-waiver/print, which records a waiver and then prints
// through printOpenTableBill — /print/bill's own dispatch — from under /bills/,
// beside the other waiver routes. Neither pattern matched it. On that topology a
// committed waiver would have answered `printed: true` while no paper came out,
// and nothing would have said so: the template has no test, and the route has
// no reason to know where it is hosted.
//
// ============================================================================
// WHAT THIS SUITE READS
// ============================================================================
// Source, not a running app (the same posture as scripts/route_manifest.ts):
//
//   * every `app.<method>(path, …)` registration in routes/*.ts and index.ts,
//     with the handler body that follows it;
//   * a DOOR is a handler that calls one of the dispatchers that emit to a
//     printer — dispatchPrintJob, printOpenTableBill or dispatchKot;
//   * every CloudFront behaviour in deploy/template.yaml whose TargetOriginId is
//     realtimeAlb, with CloudFront's own wildcard rules (`*` any run of
//     characters including '/', `?` exactly one).
//
// Then: every door is matched by a realtimeAlb behaviour, and no ordinary route
// is dragged onto the task by a pattern wider than the doors need.
//
// NOT COUNTED, deliberately: routes that print a KOT as a SIDE EFFECT of placing
// or changing an order (autoPrintOrderKot, dispatchCancellationKot in
// kot_print.ts — POST /orders, PATCH /orders/:id/status and their siblings).
// The template has never routed those, and moving order placement off Lambda is
// a different decision from this one. Nothing here asserts they are safe there.

import { describe, test, expect } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("node:fs") as typeof import("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("node:path") as typeof import("node:path");

const ROOT = [process.cwd(), path.join(__dirname, "..")].find((b) => fs.existsSync(path.join(b, "deploy", "template.yaml")));
if (!ROOT) { throw new Error("backend root (with deploy/template.yaml) not found"); }

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

/** The calls that put a job on a printer's socket. */
const PRINT_DISPATCH = /\b(dispatchPrintJob|printOpenTableBill|dispatchKot)\(/;

interface Registration { file: string; method: string; path: string; body: string }

/**
 * Every route registration with the source of its handler.
 *
 * Registrations sit at column 0 inside their register*Routes function (a few are
 * indented inside a loop), and a handler closes with `});` at column 0. So a
 * handler's body runs from its `app.` line to the next registration or the next
 * line that starts with `}` — which also stops it before a top-level helper such
 * as printOpenTableBill itself, whose own dispatchPrintJob call must not be
 * credited to whichever route happens to precede it in the file.
 */
function registrations(): Registration[] {
  const files = fs.readdirSync(path.join(ROOT!, "routes"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `routes/${f}`)
    .concat(["index.ts"]);
  const out: Registration[] = [];
  const start = /^\s*app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/;
  for (const file of files) {
    const lines = read(file).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = start.exec(lines[i]);
      if (!m) { continue; }
      let j = i + 1;
      while (j < lines.length && !/^\s*app\.(get|post|put|patch|delete|use)\(/.test(lines[j]) && !/^\}/.test(lines[j])) { j++; }
      out.push({ file, method: m[1].toUpperCase(), path: m[3], body: lines.slice(i, j + 1).join("\n") });
    }
  }
  return out;
}

/** The PathPatterns CloudFront sends to the always-on task. */
function realtimePatterns(): string[] {
  const lines = read("deploy/template.yaml").split("\n");
  const patterns: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*PathPattern:\s*(\S+)\s*$/.exec(lines[i]);
    if (!m) { continue; }
    // TargetOriginId is the next key of the same behaviour.
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const t = /^\s*TargetOriginId:\s*(\S+)\s*$/.exec(lines[j]);
      if (t) { if (t[1] === "realtimeAlb") { patterns.push(m[1]); } break; }
    }
  }
  return patterns;
}

/** CloudFront's matcher: case-sensitive, `*` = any run (slashes included), `?` = one character. */
const cloudFrontMatches = (pattern: string, urlPath: string): boolean => {
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern.startsWith("/") ? "" : "/"}${rx}$`).test(urlPath);
};

/** An Express path as a concrete request path: `:id` and `${…}` become one segment. */
const concrete = (expressPath: string): string =>
  expressPath.replace(/\$\{[^}]*\}/g, "x").replace(/:[A-Za-z_][A-Za-z0-9_]*\??/g, "x");

const ROUTES = registrations();
const DOORS = ROUTES.filter((r) => PRINT_DISPATCH.test(r.body));
const PATTERNS = realtimePatterns();
const onTask = (p: string): boolean => PATTERNS.some((pattern) => cloudFrontMatches(pattern, concrete(p)));

describe("the reader itself — a suite that finds nothing proves nothing", () => {
  test("it sees the app's routes and the template's realtime behaviours", () => {
    expect(ROUTES.length).toBeGreaterThan(300);
    expect(PATTERNS).toEqual(expect.arrayContaining(["/socket.io/*", "/print/*", "/publish/*"]));
  });

  test("it finds the doors that are known to print, including the one under /bills/", () => {
    const found = DOORS.map((d) => `${d.method} ${d.path}`);
    expect(found).toEqual(expect.arrayContaining([
      "POST /print/bill",
      "POST /publish/bill",
      "POST /print/bill/settled",
      "POST /print/bill/split",
      "POST /print/kot/order/:id",
      "POST /print/test",
      "POST /bills/service-charge-waiver/print",
      "POST /bills/order/:orderId/settle-nc",
    ]));
  });

  test("outside /print/ and /publish/ there are exactly two doors: the waiver print and the NC settle", () => {
    // Closed on purpose. A second name here is either a new door under a new
    // prefix — which needs its own behaviour, a README row and a line in this
    // list — or the body scan crediting a top-level helper's dispatch (such as
    // printOpenTableBill's own dispatchPrintJob, defined between two register
    // functions in routes/bills.ts) to the route that precedes it in the file.
    const elsewhere = DOORS
      .filter((d) => !/^\/(print|publish)\//.test(d.path))
      .map((d) => `${d.method} ${d.path}`);
    expect(elsewhere.sort()).toEqual(["POST /bills/order/:orderId/settle-nc", "POST /bills/service-charge-waiver/print"]);
  });

  test("the wildcard reader follows CloudFront's rules", () => {
    expect(cloudFrontMatches("/print/*", "/print/bill/claim")).toBe(true);
    expect(cloudFrontMatches("/print/*", "/printers")).toBe(false);
    expect(cloudFrontMatches("/bills/service-charge-waiver/print", "/bills/service-charge-waiver/print")).toBe(true);
    expect(cloudFrontMatches("/bills/service-charge-waiver/print", "/bills/service-charge-waiver")).toBe(false);
    expect(cloudFrontMatches("/a?c", "/abc")).toBe(true);
  });
});

describe("every door that prints is served by the always-on task", () => {
  test("no route that dispatches to a printer falls through to Lambda", () => {
    const stranded = DOORS.filter((d) => !onTask(d.path)).map((d) => `${d.method} ${d.path} (${d.file})`);
    // A name here needs a realtimeAlb CacheBehavior in deploy/template.yaml and
    // a row in deploy/README.md 2.1 — or its print moved under /print/.
    expect(stranded).toEqual([]);
  });

  test('"Remove service charge & print" in particular — the door that is not under /print/', () => {
    expect(onTask("/bills/service-charge-waiver/print")).toBe(true);
  });

  test('"Settle as NC" too, and its wildcard reaches no sibling settle route', () => {
    expect(onTask("/bills/order/x/settle-nc")).toBe(true);
    for (const sibling of ["/bills/order/x", "/bills/order/x/close", "/bills/order/x/waiter-confirm-payment", "/bills/order/x/admin-approve-payment", "/bills/order/x/status"]) {
      expect(onTask(sibling)).toBe(false);
    }
  });

  test("and no ordinary route is dragged onto the task by a pattern wider than the doors", () => {
    // /print/*, /publish/* and /socket.io/* are the task's by design, whatever
    // they do. Anywhere else, only a door belongs there: a `/bills/*` behaviour
    // would move every bill read and write off Lambda to cover one print.
    const doorPaths = new Set(DOORS.map((d) => d.path));
    const dragged = ROUTES
      .filter((r) => !/^\/(print|publish|socket\.io)\//.test(r.path))
      .filter((r) => !doorPaths.has(r.path) && onTask(r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(dragged).toEqual([]);
    expect(onTask("/bills/service-charge-waiver")).toBe(false);
  });

  test("the documents that describe the topology name the third door", () => {
    expect(read("deploy/README.md")).toContain("`POST /bills/service-charge-waiver/print`");
    expect(read("lambda.ts")).toContain("POST /bills/service-charge-waiver/print");
    expect(read("deploy/README.md")).toContain("`POST /bills/order/:orderId/settle-nc`");
    expect(read("lambda.ts")).toContain("/bills/order/:orderId/settle-nc");
  });
});
