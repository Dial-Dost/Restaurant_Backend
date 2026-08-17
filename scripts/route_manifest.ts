/**
 * route_manifest.ts — STATIC route-order manifest for the Express app.
 *
 * WHY THIS EXISTS
 * ---------------
 * Express matches routes in REGISTRATION ORDER. Splitting index.ts's route
 * registrations into a routes/ folder is therefore an order-sensitive refactor:
 * if `/reports/sales.csv` ends up registered after a `/reports/:something`
 * pattern, the literal route becomes permanently unreachable and nothing fails
 * loudly. This script freezes the *observable registration order* into a stable,
 * diffable text file so that class of mistake shows up as a one-line diff.
 *
 * HOW IT WORKS
 * ------------
 * Pure static analysis over the TypeScript AST (the `typescript` compiler API,
 * already a devDependency). It NEVER imports, boots or executes the app, never
 * opens a socket and never touches a database. It:
 *
 *   1. Parses the entry file (index.ts by default) and walks its TOP-LEVEL
 *      statements in source order — deliberately NOT descending into function
 *      bodies, because a function body only contributes routes when it is
 *      actually called.
 *   2. Tracks which identifiers are bound to an Express app (`express()`) or a
 *      Router (`express.Router()`).
 *   3. On `app.<method>(path, ...guards, handler)` it emits one manifest line.
 *   4. On a call that PASSES an app-bound identifier — `registerPlatformRoutes(app)`,
 *      and after the refactor `registerOrderRoutes(app)` etc. — it resolves the
 *      callee (same file or a relative import), binds the parameter name to the
 *      same app, and walks that function body AT THAT POINT in the sequence. So
 *      routes emitted from other modules land in the exact position index.ts
 *      invokes them.
 *   5. Router objects buffer their routes; `app.use("/prefix", router)` splices
 *      the buffer in at the mount point with the prefix applied.
 *   6. `for (const x of ["a","b"])` / `["a","b"].forEach(x => ...)` loops around a
 *      registration are UNROLLED, so index.ts's two-in-one
 *      `/discount-requests/:id/${decision}` registration reports as two routes.
 *   7. A raw whole-repo AST rescan cross-checks that every registration SITE the
 *      ordered walk could have missed is accounted for. Anything missed is a loud
 *      stderr error and a non-zero exit — the walk is never allowed to silently
 *      under-report.
 *
 * OUTPUT CONTRACT (the reason it is safe to diff)
 * -----------------------------------------------
 * The manifest contains NO file names and NO line numbers. A pure move refactor
 * must therefore reproduce the baseline BYTE FOR BYTE. Column widths are fixed
 * (never derived from the longest value) so adding one long path cannot reflow
 * unrelated lines.
 *
 * Each route line is:   <seq> <METHOD> <path> | <guard chain as written> | <fp>
 * Each middleware line: mwNN USE     <mount> | <middleware as written>   | <fp>
 *
 * `fp` is an 8-hex fingerprint of the handler, taken from the TypeScript
 * printer's re-print (comments stripped, whitespace normalised) so it is immune
 * to reindentation and comment edits but catches an accidentally mangled body
 * during the move. Use --no-fingerprint for a looser comparison.
 *
 * Diagnostics — counts, unresolved paths, conditional registrations, unfollowed
 * calls, and the ORDER-SENSITIVE ROUTE PAIRS (paths that can shadow each other)
 * — all go to stderr, so stdout stays a clean golden file.
 *
 * USAGE
 * -----
 *   npx tsx scripts/route_manifest.ts --out scripts/route_manifest.baseline.txt
 *   npx tsx scripts/route_manifest.ts | diff scripts/route_manifest.baseline.txt -
 *   npx tsx scripts/route_manifest.ts --check scripts/route_manifest.baseline.txt
 *   npx tsx scripts/route_manifest.ts --json         # machine-readable
 *   npx tsx scripts/route_manifest.ts --verbose      # adds file:line (NOT diffable)
 *
 * Exit codes: 0 ok · 1 missed registration site / internal error · 2 --check drift.
 */

/*
 * Lint posture for this file: it is a DEV-TIME CLI, not runtime server code. It
 * walks an untyped AST (hence the non-null assertions after explicit length /
 * kind checks), reads and writes developer-supplied paths (hence the non-literal
 * fs arguments), and exits with a status code because CI consumes that code.
 * Every rule below is disabled for those reasons and for no other.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion,
                  @typescript-eslint/no-unnecessary-type-assertion,
                  @typescript-eslint/no-unnecessary-condition,
                  @typescript-eslint/no-use-before-define,
                  @typescript-eslint/restrict-template-expressions,
                  @typescript-eslint/prefer-nullish-coalescing,
                  @typescript-eslint/prefer-optional-chain,
                  @typescript-eslint/explicit-function-return-type,
                  security/detect-non-literal-fs-filename,
                  n/no-process-exit */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
function flag(name: string): boolean {
	return argv.includes(`--${name}`);
}
function opt(name: string, fallback?: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const ENTRY = path.resolve(opt("entry", path.join(BACKEND_ROOT, "index.ts"))!);
const OUT = opt("out");
const CHECK = opt("check");
const AS_JSON = flag("json");
const VERBOSE = flag("verbose");
const WITH_FP = !flag("no-fingerprint");
const SCAN_ROOT = path.resolve(opt("scan-root", BACKEND_ROOT)!);

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
/** Directories never scanned for the missed-site cross-check. */
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".git", ".venv", ".next", "coverage", "__snapshots__"]);

// ---------------------------------------------------------------------------
// Source file loading / resolution (no ts.Program — parse only, so this stays
// fast and cannot be derailed by type errors elsewhere in the repo)
// ---------------------------------------------------------------------------

const sourceCache = new Map<string, ts.SourceFile | null>();

function loadFile(abs: string): ts.SourceFile | null {
	const key = path.normalize(abs);
	if (sourceCache.has(key)) {return sourceCache.get(key)!;}
	let sf: ts.SourceFile | null = null;
	try {
		if (fs.existsSync(key) && fs.statSync(key).isFile()) {
			sf = ts.createSourceFile(key, fs.readFileSync(key, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		}
	} catch {
		sf = null;
	}
	sourceCache.set(key, sf);
	return sf;
}

/** Resolve a RELATIVE import specifier to a .ts file. Handles the ESM ".js" suffix. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
	if (!spec.startsWith(".")) {return null;}
	const base = path.resolve(path.dirname(fromFile), spec);
	const candidates: string[] = [];
	if (/\.[cm]?js$/.test(base)) {
		const stem = base.replace(/\.[cm]?js$/, "");
		candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
	}
	candidates.push(`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base);
	for (const c of candidates) {
		try {
			if (fs.existsSync(c) && fs.statSync(c).isFile() && /\.[cm]?tsx?$/.test(c)) {return path.normalize(c);}
		} catch { /* ignore */ }
	}
	return null;
}

interface ImportBinding { spec: string; imported: string }

const importCache = new Map<string, Map<string, ImportBinding>>();

/** local name -> { module specifier, exported name ("default" / "*" for namespace) } */
function importsOf(sf: ts.SourceFile): Map<string, ImportBinding> {
	const key = sf.fileName;
	const cached = importCache.get(key);
	if (cached) {return cached;}
	const map = new Map<string, ImportBinding>();
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st) || !st.importClause) {continue;}
		if (!ts.isStringLiteral(st.moduleSpecifier)) {continue;}
		const spec = st.moduleSpecifier.text;
		const clause = st.importClause;
		if (clause.name) {map.set(clause.name.text, { spec, imported: "default" });}
		const nb = clause.namedBindings;
		if (nb && ts.isNamespaceImport(nb)) {map.set(nb.name.text, { spec, imported: "*" });}
		if (nb && ts.isNamedImports(nb)) {
			for (const el of nb.elements) {
				map.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
			}
		}
	}
	importCache.set(key, map);
	return map;
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFunctionLike(n: ts.Node | undefined): n is FunctionLike {
	return !!n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n));
}

/** Find a top-level function declaration / `const f = (…) => …` by name. */
function findFunctionInFile(sf: ts.SourceFile, name: string): FunctionLike | null {
	for (const st of sf.statements) {
		if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) {return st;}
		if (ts.isVariableStatement(st)) {
			for (const d of st.declarationList.declarations) {
				if (ts.isIdentifier(d.name) && d.name.text === name && isFunctionLike(d.initializer)) {return d.initializer;}
			}
		}
		if (ts.isExportAssignment(st) && name === "default") {
			if (isFunctionLike(st.expression)) {return st.expression;}
			if (ts.isIdentifier(st.expression)) {return findFunctionInFile(sf, st.expression.text);}
		}
	}
	return null;
}

/** What identifier does `export default X` / `export { X as default }` point at? */
function defaultExportName(sf: ts.SourceFile): string | null {
	for (const st of sf.statements) {
		if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {return st.expression.text;}
		if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
			for (const el of st.exportClause.elements) {
				if (el.name.text === "default") {return (el.propertyName ?? el.name).text;}
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Manifest entries
// ---------------------------------------------------------------------------

interface Entry {
	kind: "route" | "middleware";
	method: string;
	rawPath: string;
	mountPrefix: string;
	guards: string[];
	fingerprint: string;
	/** file:line — diagnostics / --verbose only. Deliberately NOT in the golden output. */
	origin: string;
	/** Enclosing runtime conditions (if / ternary guards) — empty for unconditional. */
	conditions: string[];
	/** Registration SITE key (file#pos) used by the missed-site cross-check. */
	site: string;
	unresolved: boolean;
}

const stream: Entry[] = [];
const warnings: string[] = [];
const errors: string[] = [];
const capturedSites = new Set<string>();

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function canonicalText(node: ts.Node, sf: ts.SourceFile): string {
	try {
		return printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, " ").trim();
	} catch {
		try { return node.getText(sf).replace(/\s+/g, " ").trim(); } catch { return "<unprintable>"; }
	}
}

/**
 * Short, stable content hash. The separator is U+0001, which cannot occur in
 * real TypeScript source, so field boundaries are unambiguous: ["GET","/a/b"]
 * can never collide with ["GET/a","/b"].
 */
function fingerprint(parts: string[]): string {
	return createHash("sha1").update(parts.join("\u0001")).digest("hex").slice(0, 8);
}

function relOf(file: string): string {
	const rel = path.relative(BACKEND_ROOT, file).replace(/\\/g, "/");
	return rel.startsWith("..") ? file.replace(/\\/g, "/") : rel;
}

function locOf(node: ts.Node, sf: ts.SourceFile): string {
	const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
	return `${relOf(sf.fileName)}:${line + 1}`;
}

function siteOf(node: ts.Node, sf: ts.SourceFile): string {
	return `${path.normalize(sf.fileName)}#${node.getStart(sf)}`;
}

// ---------------------------------------------------------------------------
// Walk context
// ---------------------------------------------------------------------------

interface Binding {
	kind: "app" | "router";
	sink: Entry[];
	/** routers only: set once app.use() mounts them */
	mounted?: boolean;
	label: string;
}

interface Ctx {
	sf: ts.SourceFile;
	/** identifier -> app/router binding */
	binds: Map<string, Binding>;
	/** const string bindings visible here (module consts + unrolled loop vars) */
	strings: Map<string, string>;
	conditions: string[];
	/** recursion guard: "<file>#<fn>" frames already on the stack */
	stack: Set<string>;
	depth: number;
}

function childCtx(ctx: Ctx, over: Partial<Ctx>): Ctx {
	return { ...ctx, ...over };
}

// ---------------------------------------------------------------------------
// Literal helpers
// ---------------------------------------------------------------------------

function unwrap(node: ts.Expression): ts.Expression {
	let n: ts.Expression = node;
	// `as const`, `satisfies`, `<T>x`, and (x)
	for (;;) {
		if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) { n = n.expression; continue; }
		if (ts.isParenthesizedExpression(n)) { n = n.expression; continue; }
		if (ts.isNonNullExpression(n)) { n = n.expression; continue; }
		return n;
	}
}

/** A string value we can resolve statically, or null. */
function staticString(node: ts.Expression, ctx: Ctx): string | null {
	const n = unwrap(node);
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {return n.text;}
	if (ts.isIdentifier(n)) {return ctx.strings.get(n.text) ?? null;}
	if (ts.isTemplateExpression(n)) {
		let out = n.head.text;
		for (const span of n.templateSpans) {
			const v = staticString(span.expression, ctx);
			if (v === null) {return null;}
			out += v + span.literal.text;
		}
		return out;
	}
	if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const l = staticString(n.left, ctx);
		const r = staticString(n.right, ctx);
		return l !== null && r !== null ? l + r : null;
	}
	return null;
}

/** Best-effort path text: resolves what it can, keeps `${expr}` verbatim otherwise. */
function pathText(node: ts.Expression, ctx: Ctx): { text: string; unresolved: boolean } {
	const exact = staticString(node, ctx);
	if (exact !== null) {return { text: exact, unresolved: false };}
	const n = unwrap(node);
	if (ts.isTemplateExpression(n)) {
		let out = n.head.text;
		for (const span of n.templateSpans) {
			const v = staticString(span.expression, ctx);
			out += v !== null ? v : `\${${canonicalText(span.expression, ctx.sf)}}`;
			out += span.literal.text;
		}
		return { text: out, unresolved: true };
	}
	if (ts.isRegularExpressionLiteral(n)) {return { text: `regexp:${n.text}`, unresolved: false };}
	return { text: `<dynamic:${canonicalText(n, ctx.sf)}>`, unresolved: true };
}

/** `["a","b"] as const` -> ["a","b"] */
function stringArrayLiteral(node: ts.Expression, ctx: Ctx): string[] | null {
	const n = unwrap(node);
	if (!ts.isArrayLiteralExpression(n)) {return null;}
	const out: string[] = [];
	for (const el of n.elements) {
		if (ts.isSpreadElement(el)) {return null;}
		const v = staticString(el as ts.Expression, ctx);
		if (v === null) {return null;}
		out.push(v);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Guard rendering — "as written", so a moved-but-unchanged guard chain is
// byte-identical after the refactor.
// ---------------------------------------------------------------------------

function renderArg(node: ts.Expression, sf: ts.SourceFile): string {
	const n = unwrap(node);
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {return JSON.stringify(n.text);}
	if (ts.isNumericLiteral(n)) {return n.text.replace(/_/g, "");}
	if (n.kind === ts.SyntaxKind.TrueKeyword) {return "true";}
	if (n.kind === ts.SyntaxKind.FalseKeyword) {return "false";}
	if (n.kind === ts.SyntaxKind.NullKeyword) {return "null";}
	if (ts.isIdentifier(n)) {return n.text;}
	if (ts.isPropertyAccessExpression(n)) {return canonicalText(n, sf);}
	if (ts.isObjectLiteralExpression(n)) {return "{...}";}
	if (ts.isArrayLiteralExpression(n)) {return "[...]";}
	if (isFunctionLike(n)) {return "<fn>";}
	if (ts.isCallExpression(n)) {return renderMiddleware(n, sf);}
	const t = canonicalText(n, sf);
	return t.length > 40 ? `${t.slice(0, 37)}...` : t;
}

function renderMiddleware(node: ts.Expression, sf: ts.SourceFile): string {
	const n = unwrap(node);
	if (isFunctionLike(n)) {
		const params = n.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "_")).join(",");
		return `<inline(${params})>`;
	}
	if (ts.isIdentifier(n)) {return n.text;}
	if (ts.isPropertyAccessExpression(n)) {return canonicalText(n, sf);}
	if (ts.isCallExpression(n)) {
		const callee = ts.isIdentifier(n.expression) || ts.isPropertyAccessExpression(n.expression)
			? canonicalText(n.expression, sf)
			: "<expr>";
		return `${callee}(${n.arguments.map((a) => renderArg(a, sf)).join(", ")})`;
	}
	if (ts.isArrayLiteralExpression(n)) {
		return `[${n.elements.map((e) => renderMiddleware(e as ts.Expression, sf)).join(", ")}]`;
	}
	const t = canonicalText(n, sf);
	return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/** Guards = every argument between the path and the terminal handler, flattened. */
function renderGuards(args: readonly ts.Expression[], sf: ts.SourceFile): string[] {
	const out: string[] = [];
	for (const a of args) {
		const n = unwrap(a);
		if (ts.isArrayLiteralExpression(n)) {
			for (const e of n.elements) {out.push(renderMiddleware(e as ts.Expression, sf));}
		} else {
			out.push(renderMiddleware(a, sf));
		}
	}
	return out;
}

function joinPath(prefix: string, p: string): string {
	if (!prefix) {return p;}
	const a = prefix.replace(/\/+$/, "");
	const b = p === "/" ? "" : p;
	const joined = `${a}${b.startsWith("/") || b === "" ? "" : "/"}${b}`;
	return joined === "" ? "/" : joined;
}

// ---------------------------------------------------------------------------
// The ordered walk
// ---------------------------------------------------------------------------

const MAX_DEPTH = 24;

function emitRoute(
	bind: Binding,
	call: ts.CallExpression,
	method: string,
	ctx: Ctx,
): void {
	const args = call.arguments;
	const first = args[0]!;
	const rest = args.slice(1);
	// Terminal handler is the last argument; everything before it is a guard.
	const guardArgs = rest.length > 0 ? rest.slice(0, -1) : [];
	const handler = rest.length > 0 ? rest[rest.length - 1]! : undefined;

	// Express accepts an array of paths on one registration -> one line each.
	const arrayPaths = stringArrayLiteral(first, ctx);
	const paths = arrayPaths ? arrayPaths.map((p) => ({ text: p, unresolved: false })) : [pathText(first, ctx)];

	for (const p of paths) {
		const full = joinPath("", p.text);
		stream.push({
			kind: "route",
			method: method.toUpperCase(),
			rawPath: full,
			mountPrefix: "",
			guards: renderGuards(guardArgs, ctx.sf),
			fingerprint: fingerprint([full, method, handler ? canonicalText(handler, ctx.sf) : "<none>"]),
			origin: locOf(call, ctx.sf),
			conditions: [...ctx.conditions],
			site: siteOf(call, ctx.sf),
			unresolved: p.unresolved,
		});
		if (bind.kind === "router") {
			// routers buffer; move the entry we just pushed into the router sink
			bind.sink.push(stream.pop()!);
		}
	}
	capturedSites.add(siteOf(call, ctx.sf));
}

function emitMiddleware(bind: Binding, call: ts.CallExpression, ctx: Ctx, mountPath: string | null): void {
	const args = call.arguments;
	const fns = mountPath === null ? args : args.slice(1);
	const entry: Entry = {
		kind: "middleware",
		method: "USE",
		rawPath: mountPath ?? "*",
		mountPrefix: "",
		guards: fns.map((a) => renderMiddleware(a, ctx.sf)),
		fingerprint: fingerprint([mountPath ?? "*", canonicalText(call, ctx.sf)]),
		origin: locOf(call, ctx.sf),
		conditions: [...ctx.conditions],
		site: siteOf(call, ctx.sf),
		unresolved: false,
	};
	bind.sink.push(entry);
}

/** Splice a router's buffered routes into the mount point, applying the prefix. */
function spliceRouter(target: Binding, router: Binding, prefix: string): void {
	for (const e of router.sink) {
		target.sink.push({ ...e, rawPath: joinPath(prefix, e.rawPath), mountPrefix: joinPath(prefix, e.mountPrefix) });
	}
	router.mounted = true;
	router.sink.length = 0;
}

/**
 * Resolve an identifier that should be a Router value, possibly imported.
 * Returns a binding whose sink holds that module's collected routes.
 */
function resolveRouterIdentifier(name: string, ctx: Ctx): Binding | null {
	const local = ctx.binds.get(name);
	if (local && local.kind === "router") {return local;}

	const imp = importsOf(ctx.sf).get(name);
	if (!imp || imp.imported === "*") {return null;}
	const target = resolveSpecifier(ctx.sf.fileName, imp.spec);
	if (!target) {return null;}
	const tsf = loadFile(target);
	if (!tsf) {return null;}

	const wantedName = imp.imported === "default" ? defaultExportName(tsf) : imp.imported;
	if (!wantedName) {return null;}

	const frame = `${target}#module`;
	if (ctx.stack.has(frame)) {return null;}

	// Walk the whole module top-level so `const r = express.Router(); r.get(...)`
	// is collected, then hand back the binding for the exported name.
	const modCtx: Ctx = {
		sf: tsf,
		binds: new Map(),
		strings: collectModuleStringConsts(tsf),
		conditions: [],
		stack: new Set([...ctx.stack, frame]),
		depth: ctx.depth + 1,
	};
	walkBlock(tsf, modCtx);
	const b = modCtx.binds.get(wantedName);
	return b && b.kind === "router" ? b : null;
}

/** Module-level `const X = "…"` bindings, so `app.get(BASE + "/x")` resolves. */
function collectModuleStringConsts(sf: ts.SourceFile): Map<string, string> {
	const out = new Map<string, string>();
	const tmpCtx: Ctx = { sf, binds: new Map(), strings: out, conditions: [], stack: new Set(), depth: 0 };
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) {continue;}
		for (const d of st.declarationList.declarations) {
			if (!ts.isIdentifier(d.name) || !d.initializer) {continue;}
			const v = staticString(d.initializer, tmpCtx);
			if (v !== null) {out.set(d.name.text, v);}
		}
	}
	return out;
}

/** Is this call `express()` / `express.Router()` / `Router()`? */
function expressFactoryKind(init: ts.Expression | undefined): "app" | "router" | null {
	if (!init) {return null;}
	const n = unwrap(init);
	if (!ts.isCallExpression(n)) {return null;}
	const callee = n.expression;
	if (ts.isIdentifier(callee)) {
		if (callee.text === "express") {return "app";}
		if (callee.text === "Router") {return "router";}
	}
	if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router") {return "router";}
	return null;
}

function handleVariableStatement(st: ts.VariableStatement, ctx: Ctx): void {
	for (const d of st.declarationList.declarations) {
		if (!ts.isIdentifier(d.name)) {continue;}
		const kind = expressFactoryKind(d.initializer);
		if (kind) {
			const bind: Binding = kind === "app"
				? { kind: "app", sink: stream, label: d.name.text }
				: { kind: "router", sink: [], mounted: false, label: d.name.text };
			ctx.binds.set(d.name.text, bind);
			continue;
		}
		// alias: `const r2 = r;`
		if (d.initializer && ts.isIdentifier(unwrap(d.initializer))) {
			const src = ctx.binds.get((unwrap(d.initializer) as ts.Identifier).text);
			if (src) {ctx.binds.set(d.name.text, src);}
		}
		if (d.initializer) {
			const v = staticString(d.initializer, ctx);
			if (v !== null) {ctx.strings.set(d.name.text, v);}
		}
	}
}

/**
 * A call that receives an app/router-bound identifier is a route-registration
 * module boundary (`registerPlatformRoutes(app)`). Follow it and emit its routes
 * inline, at this exact position in the sequence.
 */
function followRegistrationCall(call: ts.CallExpression, ctx: Ctx): boolean {
	const appArgIdx = call.arguments.findIndex(
		(a) => ts.isIdentifier(unwrap(a)) && ctx.binds.has((unwrap(a) as ts.Identifier).text),
	);
	if (appArgIdx < 0) {return false;}

	const argIdent = unwrap(call.arguments[appArgIdx]!) as ts.Identifier;
	const bind = ctx.binds.get(argIdent.text)!;

	const callee = call.expression;
	if (!ts.isIdentifier(callee)) {
		warnings.push(`UNFOLLOWED registration-shaped call (non-identifier callee) at ${locOf(call, ctx.sf)}: ${canonicalText(callee, ctx.sf)}`);
		return true;
	}

	// same-file function first, then a relative import
	let targetSf: ts.SourceFile = ctx.sf;
	let fn = findFunctionInFile(ctx.sf, callee.text);
	if (!fn) {
		const imp = importsOf(ctx.sf).get(callee.text);
		if (imp && imp.imported !== "*") {
			const resolved = resolveSpecifier(ctx.sf.fileName, imp.spec);
			const isf = resolved ? loadFile(resolved) : null;
			if (isf) {
				const name = imp.imported === "default" ? (defaultExportName(isf) ?? "default") : imp.imported;
				const found = findFunctionInFile(isf, name);
				if (found) { targetSf = isf; fn = found; }
			}
		}
	}
	if (!fn || !fn.body) {
		errors.push(
			`UNFOLLOWED: \`${callee.text}(…)\` at ${locOf(call, ctx.sf)} is passed the app/router \`${argIdent.text}\` ` +
			`but its definition could not be resolved statically. Routes registered inside it are MISSING from this manifest.`,
		);
		return true;
	}

	const frame = `${targetSf.fileName}#${callee.text}`;
	if (ctx.stack.has(frame) || ctx.depth >= MAX_DEPTH) {
		warnings.push(`recursion/depth guard stopped following ${callee.text} at ${locOf(call, ctx.sf)}`);
		return true;
	}

	const inner: Ctx = {
		sf: targetSf,
		binds: new Map(),
		strings: collectModuleStringConsts(targetSf),
		conditions: [...ctx.conditions],
		stack: new Set([...ctx.stack, frame]),
		depth: ctx.depth + 1,
	};
	// bind the parameter that receives the app to the SAME sink
	const param = fn.parameters[appArgIdx];
	if (param && ts.isIdentifier(param.name)) {
		inner.binds.set(param.name.text, bind);
	} else {
		// fall back to the first parameter
		const p0 = fn.parameters[0];
		if (p0 && ts.isIdentifier(p0.name)) {inner.binds.set(p0.name.text, bind);}
	}
	// string arguments become resolvable constants inside (e.g. a mount prefix)
	fn.parameters.forEach((p, i) => {
		if (!ts.isIdentifier(p.name)) {return;}
		const a = call.arguments[i];
		if (!a) {return;}
		const v = staticString(a, ctx);
		if (v !== null) {inner.strings.set(p.name.text, v);}
	});

	walkBlock(fn.body, inner);
	return true;
}

function handleAppCall(call: ts.CallExpression, ctx: Ctx): boolean {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee)) {return false;}
	const objName = ts.isIdentifier(callee.expression) ? callee.expression.text : null;
	if (!objName) {return false;}
	const bind = ctx.binds.get(objName);
	if (!bind) {return false;}
	const member = callee.name.text;

	if (HTTP_METHODS.has(member)) {
		if (call.arguments.length === 0) {return false;}
		emitRoute(bind, call, member, ctx);
		return true;
	}

	if (member === "use") {
		const args = call.arguments;
		if (args.length === 0) {return true;}
		const firstStr = staticString(args[0]!, ctx);
		const hasPath = firstStr !== null && (firstStr.startsWith("/") || firstStr === "*");

		// app.use(path?, router)
		const routerArg = args.slice(hasPath ? 1 : 0).find((a) => ts.isIdentifier(unwrap(a)));
		if (routerArg) {
			const rname = (unwrap(routerArg) as ts.Identifier).text;
			const router = resolveRouterIdentifier(rname, ctx);
			if (router) {
				spliceRouter(bind, router, hasPath ? firstStr! : "");
				capturedSites.add(siteOf(call, ctx.sf));
				return true;
			}
		}
		emitMiddleware(bind, call, ctx, hasPath ? firstStr! : null);
		capturedSites.add(siteOf(call, ctx.sf));
		return true;
	}

	// app.route("/x").get(...).post(...)
	if (member === "route") {
		const p = pathText(call.arguments[0]!, ctx);
		warnings.push(`app.route("${p.text}") chain at ${locOf(call, ctx.sf)} — chained .get/.post are NOT expanded by this manifest.`);
		return true;
	}

	// app.set / app.disable / app.listen / app.engine — not routing
	return true;
}

/** Unroll `for (const x of ["a","b"]) { … }`. */
function tryUnrollForOf(node: ts.ForOfStatement, ctx: Ctx): boolean {
	const values = stringArrayLiteral(node.expression, ctx);
	if (!values) {return false;}
	const init = node.initializer;
	if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) {return false;}
	const decl = init.declarations[0]!;
	if (!ts.isIdentifier(decl.name)) {return false;}
	for (const v of values) {
		const strings = new Map(ctx.strings);
		strings.set(decl.name.text, v);
		walkBlock(node.statement, childCtx(ctx, { strings }));
	}
	return true;
}

/** Unroll `["a","b"].forEach(x => { … })`. */
function tryUnrollForEach(call: ts.CallExpression, ctx: Ctx): boolean {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "forEach") {return false;}
	const values = stringArrayLiteral(callee.expression as ts.Expression, ctx);
	if (!values) {return false;}
	const cb = call.arguments[0] ? unwrap(call.arguments[0]!) : undefined;
	if (!isFunctionLike(cb) || !cb.body) {return false;}
	const p0 = cb.parameters[0];
	for (const v of values) {
		const strings = new Map(ctx.strings);
		if (p0 && ts.isIdentifier(p0.name)) {strings.set(p0.name.text, v);}
		walkBlock(cb.body, childCtx(ctx, { strings }));
	}
	return true;
}

/**
 * Ordered walk. Descends only through control flow that actually executes at
 * module/function-body level; it never descends into a nested function body
 * unless that function is followed via a registration call.
 */
function walkBlock(node: ts.Node, ctx: Ctx): void {
	if (ctx.depth > MAX_DEPTH) {return;}

	const visit = (n: ts.Node): void => {
		// never walk into a nested function/class definition on its own
		if (isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) ||
			ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
			ts.isGetAccessor(n) || ts.isSetAccessor(n)) {
			return;
		}

		if (ts.isVariableStatement(n)) {
			handleVariableStatement(n, ctx);
			return;
		}

		if (ts.isForOfStatement(n)) {
			if (tryUnrollForOf(n, ctx)) {return;}
			walkBlock(n.statement, childCtx(ctx, { conditions: [...ctx.conditions, `for-of ${canonicalText(n.expression, ctx.sf)}`] }));
			return;
		}

		if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) {
			walkBlock(n.statement, childCtx(ctx, { conditions: [...ctx.conditions, `loop@${locOf(n, ctx.sf)}`] }));
			return;
		}

		if (ts.isIfStatement(n)) {
			const cond = canonicalText(n.expression, ctx.sf);
			walkBlock(n.thenStatement, childCtx(ctx, { conditions: [...ctx.conditions, cond] }));
			if (n.elseStatement) {
				walkBlock(n.elseStatement, childCtx(ctx, { conditions: [...ctx.conditions, `!(${cond})`] }));
			}
			return;
		}

		if (ts.isCallExpression(n)) {
			if (handleAppCall(n, ctx)) {return;}
			if (tryUnrollForEach(n, ctx)) {return;}
			if (followRegistrationCall(n, ctx)) {return;}
			// keep descending: the call may be `void (async () => …)` style wrapping
			ts.forEachChild(n, visit);
			return;
		}

		ts.forEachChild(n, visit);
	};

	if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
		for (const st of node.statements) {visit(st);}
	} else {
		// A single statement (unbraced loop/if body) or a concise arrow body that
		// IS the registration expression — visit the node itself, not its children.
		visit(node);
	}
}

// ---------------------------------------------------------------------------
// Cross-check: find registration SITES the ordered walk never reached
// ---------------------------------------------------------------------------

const REGISTRATION_HINT = /\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*[`"']\//;

function* walkTsFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		if (e.name.startsWith(".") && e.name !== ".") {continue;}
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) {continue;}
			yield* walkTsFiles(full);
		} else if (/\.[cm]?tsx?$/.test(e.name)) {
			yield full;
		}
	}
}

function crossCheck(): void {
	for (const file of walkTsFiles(SCAN_ROOT)) {
		let text: string;
		try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
		if (!REGISTRATION_HINT.test(text)) {continue;}
		const sf = loadFile(file);
		if (!sf) {continue;}
		const seen: ts.CallExpression[] = [];
		const scan = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
				const member = n.expression.name.text;
				const a0 = n.arguments[0];
				if (HTTP_METHODS.has(member) && a0) {
					const lit = unwrap(a0);
					const isPathLit =
						((ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) && lit.text.startsWith("/")) ||
						(ts.isTemplateExpression(lit) && lit.head.text.startsWith("/"));
					// only count when a handler-ish 2nd arg exists (excludes map.get("/x"))
					if (isPathLit && n.arguments.length >= 2) {seen.push(n);}
				}
			}
			ts.forEachChild(n, scan);
		};
		ts.forEachChild(sf, scan);
		for (const call of seen) {
			const site = siteOf(call, sf);
			if (!capturedSites.has(site)) {
				errors.push(
					`MISSED registration site at ${locOf(call, sf)} — ` +
					`\`${canonicalText(call.expression, sf)}(${renderArg(call.arguments[0]!, sf)}, …)\` ` +
					`was NOT reached by the ordered walk. The manifest is incomplete.`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Order-sensitive (shadowing) analysis
// ---------------------------------------------------------------------------

interface Seg { kind: "literal" | "param" | "wild"; value: string }

function segments(p: string): Seg[] {
	return p.split("/").filter((s) => s.length > 0).map((s): Seg => {
		if (s === "*" || s.startsWith("*") || s.startsWith("{*")) {return { kind: "wild", value: s };}
		if (s.startsWith(":")) {return { kind: "param", value: s };}
		// mixed segments like ":id.csv" or "sales.csv" stay literal-ish
		if (s.includes(":")) {return { kind: "param", value: s };}
		return { kind: "literal", value: s };
	});
}

/** Could a single concrete URL be matched by BOTH patterns? */
function patternsOverlap(a: string, b: string): boolean {
	const A = segments(a);
	const B = segments(b);
	const aWild = A.some((s) => s.kind === "wild");
	const bWild = B.some((s) => s.kind === "wild");
	if (!aWild && !bWild && A.length !== B.length) {return false;}
	const n = Math.min(A.length, B.length);
	for (let i = 0; i < n; i++) {
		const x = A[i]!;
		const y = B[i]!;
		if (x.kind === "wild" || y.kind === "wild") {return true;}
		if (x.kind === "literal" && y.kind === "literal" && x.value !== y.value) {return false;}
	}
	return true;
}

function methodsCollide(a: string, b: string): boolean {
	return a === b || a === "ALL" || b === "ALL";
}

interface ShadowPair { i: number; j: number; a: Entry; b: Entry; kind: "shadows" | "order-sensitive" | "latent" }

/**
 * "shadows"         the earlier pattern already swallows the later path — a LIVE bug.
 * "order-sensitive" both can match the same URL with the same method — relative
 *                   order is load-bearing and must be preserved by the refactor.
 * "latent"          paths overlap but the HTTP methods differ, so they are safe
 *                   TODAY and only today. These are the families where adding a
 *                   method (or reordering after adding one) silently kills a route.
 */
function shadowReport(routes: Entry[]): ShadowPair[] {
	const pairs: ShadowPair[] = [];
	for (let i = 0; i < routes.length; i++) {
		for (let j = i + 1; j < routes.length; j++) {
			const a = routes[i]!;
			const b = routes[j]!;
			const sameMethod = methodsCollide(a.method, b.method);
			if (a.rawPath === b.rawPath) {
				if (sameMethod) {pairs.push({ i, j, a, b, kind: "shadows" });}
				continue;
			}
			if (!patternsOverlap(a.rawPath, b.rawPath)) {continue;}
			if (!sameMethod) {
				pairs.push({ i, j, a, b, kind: "latent" });
				continue;
			}
			const aHasParam = segments(a.rawPath).some((s) => s.kind !== "literal");
			const bHasParam = segments(b.rawPath).some((s) => s.kind !== "literal");
			// A pattern registered FIRST swallows a later literal -> live shadow.
			if (aHasParam && !bHasParam) {pairs.push({ i, j, a, b, kind: "shadows" });}
			else {pairs.push({ i, j, a, b, kind: "order-sensitive" });}
		}
	}
	return pairs;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const W_METHOD = 7;
const W_PATH = 54;
const W_GUARDS = 46;

function pad(s: string, w: number): string {
	return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function renderManifest(): string {
	const routes = stream.filter((e) => e.kind === "route");
	const mws = stream.filter((e) => e.kind === "middleware");
	const lines: string[] = [];

	lines.push("# route-manifest v1");
	lines.push(`# entry: ${relOf(ENTRY)}`);
	lines.push(`# routes: ${routes.length}`);
	lines.push(`# middleware: ${mws.length}`);
	lines.push("#");
	lines.push("# Ordered EXACTLY as Express registers them. Express matches in registration");
	lines.push("# order, so any reordering of these lines is a behaviour change.");
	lines.push("#");
	lines.push("# route line:  NNNN METHOD  path                     | guard chain as written | handler-fp");
	lines.push("# mw line:     mwNN USE     mount                    | middleware as written  | call-fp");
	lines.push("# guards: '-' means no middleware between the path and the handler.");
	lines.push("# handler-fp: sha1(path+method+normalised handler source), first 8 hex.");
	lines.push("#             Stable across reindentation and comment edits.");
	lines.push("#");

	let rSeq = 0;
	let mSeq = 0;
	for (const e of stream) {
		const seq = e.kind === "route"
			? String(++rSeq).padStart(4, "0")
			: `mw${String(++mSeq).padStart(2, "0")}`;
		const guards = e.guards.length > 0 ? e.guards.join(" -> ") : "-";
		const cols = [
			seq,
			pad(e.method, W_METHOD),
			pad(e.rawPath, W_PATH),
			`| ${pad(guards, W_GUARDS)}`,
		];
		if (WITH_FP) {cols.push(`| ${e.fingerprint}`);}
		if (e.conditions.length > 0) {cols.push(`| COND: ${e.conditions.join(" && ")}`);}
		if (e.unresolved) {cols.push("| UNRESOLVED-PATH");}
		if (VERBOSE) {cols.push(`| ${e.origin}`);}
		lines.push(cols.join(" ").replace(/\s+$/, ""));
	}
	lines.push("");
	return lines.join("\n");
}

function renderJson(): string {
	let rSeq = 0;
	let mSeq = 0;
	return `${JSON.stringify(
		{
			version: 1,
			entry: relOf(ENTRY),
			routeCount: stream.filter((e) => e.kind === "route").length,
			middlewareCount: stream.filter((e) => e.kind === "middleware").length,
			entries: stream.map((e) => ({
				seq: e.kind === "route" ? ++rSeq : `mw${++mSeq}`,
				kind: e.kind,
				method: e.method,
				path: e.rawPath,
				guards: e.guards,
				fingerprint: e.fingerprint,
				conditions: e.conditions,
				unresolved: e.unresolved,
				origin: e.origin,
			})),
		},
		null,
		2,
	)}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
	const entrySf = loadFile(ENTRY);
	if (!entrySf) {
		process.stderr.write(`route_manifest: cannot read entry file ${ENTRY}\n`);
		return 1;
	}

	const rootCtx: Ctx = {
		sf: entrySf,
		binds: new Map(),
		strings: collectModuleStringConsts(entrySf),
		conditions: [],
		stack: new Set([`${entrySf.fileName}#module`]),
		depth: 0,
	};
	walkBlock(entrySf, rootCtx);

	// any router collected but never mounted is a silently-dead route module
	for (const [name, b] of rootCtx.binds) {
		if (b.kind === "router" && !b.mounted && b.sink.length > 0) {
			errors.push(`Router \`${name}\` registers ${b.sink.length} route(s) but is never mounted with app.use(). Those routes are DEAD.`);
		}
	}

	crossCheck();

	const out = AS_JSON ? renderJson() : renderManifest();

	// ---- diagnostics (stderr only, so stdout stays a clean golden file) ----
	const routes = stream.filter((e) => e.kind === "route");
	const mws = stream.filter((e) => e.kind === "middleware");
	const err = (s: string) => process.stderr.write(`${s}\n`);

	err("--------------------------------------------------------------------");
	err(`route_manifest: ${routes.length} routes, ${mws.length} middleware registrations`);
	err(`entry: ${ENTRY}`);

	const unresolved = routes.filter((r) => r.unresolved);
	if (unresolved.length > 0) {
		err(`\nUNRESOLVED PATHS (${unresolved.length}) — path contains a value this static pass could not evaluate:`);
		for (const r of unresolved) {err(`  ${r.method} ${r.rawPath}   (${r.origin})`);}
	}

	const conditional = stream.filter((e) => e.conditions.length > 0);
	if (conditional.length > 0) {
		err(`\nCONDITIONALLY REGISTERED (${conditional.length}) — registration depends on runtime state:`);
		for (const r of conditional) {err(`  ${r.method} ${r.rawPath}   IF ${r.conditions.join(" && ")}   (${r.origin})`);}
	} else {
		err("\nCONDITIONALLY REGISTERED: none (every registration is unconditional).");
	}

	const pairs = shadowReport(routes);
	const seq = (n: number) => `#${String(n + 1).padStart(4, "0")}`;
	const live = pairs.filter((p) => p.kind === "shadows");
	const ordered = pairs.filter((p) => p.kind === "order-sensitive");
	const latent = pairs.filter((p) => p.kind === "latent");

	err(`\nLIVE SHADOWING (same method, earlier pattern swallows later path): ${live.length}`);
	for (const p of live) {
		err(`  !! ${seq(p.i)} ${p.a.method} ${p.a.rawPath}   SHADOWS   ${seq(p.j)} ${p.b.method} ${p.b.rawPath}`);
	}

	err(`\nORDER-SENSITIVE PAIRS (same method, both can match one URL — relative order is load-bearing): ${ordered.length}`);
	for (const p of ordered) {
		err(`   ~ ${seq(p.i)} ${p.a.method} ${p.a.rawPath}   <->   ${seq(p.j)} ${p.b.method} ${p.b.rawPath}`);
	}

	err(`\nLATENT PAIRS (paths overlap; safe ONLY because the methods differ): ${latent.length}`);
	for (const p of latent) {
		err(`   ? ${seq(p.i)} ${p.a.method} ${p.a.rawPath}   <->   ${seq(p.j)} ${p.b.method} ${p.b.rawPath}`);
	}

	for (const w of warnings) {err(`\nWARN: ${w}`);}
	for (const e of errors) {err(`\nERROR: ${e}`);}
	err("--------------------------------------------------------------------");

	if (CHECK) {
		const baseline = fs.existsSync(CHECK) ? fs.readFileSync(CHECK, "utf8").replace(/\r\n/g, "\n") : null;
		if (baseline === null) {
			err(`--check: baseline ${CHECK} does not exist`);
			return 2;
		}
		if (baseline !== out) {
			err(`--check: MANIFEST DRIFT vs ${CHECK}. Route order/guards/handlers changed.`);
			const a = baseline.split("\n");
			const b = out.split("\n");
			for (let i = 0; i < Math.max(a.length, b.length); i++) {
				if (a[i] !== b[i]) {
					err(`  line ${i + 1}:`);
					err(`    baseline: ${a[i] ?? "<eof>"}`);
					err(`    current : ${b[i] ?? "<eof>"}`);
				}
			}
			return 2;
		}
		err(`--check: OK — manifest matches ${CHECK}`);
		return errors.length > 0 ? 1 : 0;
	}

	if (OUT) {
		const dest = path.resolve(OUT);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, out, { encoding: "utf8" });
		err(`written: ${dest}`);
	} else {
		process.stdout.write(out);
	}

	return errors.length > 0 ? 1 : 0;
}

process.exit(main());
