import { posix } from "node:path";

/**
 * Layer boundary and purity checker (AR1, AR2). `checkSource` is pure so the
 * tests can feed it fixture strings; `checkTree` walks the real `src/`.
 */

export type Layer = "core" | "ports" | "adapters" | "sandbox" | "lane" | "cli";

export type Violation = {
  readonly path: string;
  readonly rule: "layer" | "purity" | "spawn";
  readonly detail: string;
};

const LAYERS: readonly Layer[] = ["core", "ports", "adapters", "sandbox", "lane", "cli"];

/** The AR1 table: an importer may use the layers listed. */
export const ALLOWED: Readonly<Record<Layer, readonly Layer[]>> = {
  core: ["core"],
  ports: ["ports", "core"],
  adapters: ["adapters", "ports", "core"],
  sandbox: ["sandbox", "ports", "core"],
  lane: ["lane", "sandbox", "adapters", "ports", "core"],
  cli: ["cli", "lane", "sandbox", "adapters", "ports", "core"],
};

/** Bare specifiers `src/core/` may import. */
const CORE_BARE_ALLOWED: readonly string[] = ["zod"];

type Location = {
  readonly layer: Layer;
  /** For adapters, `adapters/<kind>/<name>`; otherwise the layer name. */
  readonly unit: string;
};

/** Where a repo-relative path sits in the layer table, or `undefined` outside `src/<layer>/`. */
export function locate(path: string): Location | undefined {
  const parts = posix.normalize(path).split("/");
  if (parts[0] !== "src" || parts.length < 3) return undefined;
  const layer = LAYERS.find((l) => l === parts[1]);
  if (layer === undefined) return undefined;
  if (layer !== "adapters") return { layer, unit: layer };
  // src/adapters/<kind>/<name>/... ; shallower files count as their own directory.
  const dirParts = parts.slice(1, -1).slice(0, 3);
  return { layer, unit: dirParts.join("/") };
}

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)\s*$/;

/** True when a `/` following `before` (comments already blanked) starts a regex literal. */
function regexMayStart(before: string): boolean {
  const trimmed = before.trimEnd();
  if (trimmed === "") return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(trimmed[trimmed.length - 1] as string)) return true;
  return REGEX_AFTER_KEYWORD.test(trimmed);
}

/**
 * Splits source into two views: `code` with comments blanked (string contents
 * kept, for import specifiers) and `bare` with comments, string contents and
 * regex literal bodies blanked (for purity checks). Lengths and line breaks
 * are preserved. A `/` counts as a regex literal from the token before it.
 */
export function strip(source: string): { readonly code: string; readonly bare: string } {
  let code = "";
  let bare = "";
  const blank = (c: string): string => (c === "\n" ? "\n" : " ");
  // Stack of open template literals; each entry counts `{` depth inside its current `${`.
  const templates: number[] = [];
  let i = 0;
  const n = source.length;
  const inTemplateText = (): boolean => templates.length > 0 && templates[templates.length - 1] === -1;

  // -1 on the stack top means "inside template text"; >= 0 means brace depth inside `${ }`.
  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];

    if (inTemplateText()) {
      if (c === "\\") {
        code += c + (next ?? "");
        bare += " " + (next === undefined ? "" : blank(next));
        i += 2;
        continue;
      }
      if (c === "`") {
        templates.pop();
        code += c;
        bare += c;
        i += 1;
        continue;
      }
      if (c === "$" && next === "{") {
        templates[templates.length - 1] = 0;
        code += "${";
        bare += "${";
        i += 2;
        continue;
      }
      code += c;
      bare += blank(c);
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        code += " ";
        bare += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i += 1) {
        const b = blank(source[i] as string);
        code += b;
        bare += b;
      }
      continue;
    }
    if (c === "/" && regexMayStart(code)) {
      // A regex literal: keep it in `code`, blank its body in `bare`.
      code += c;
      bare += c;
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\" && i + 1 < n && source[i + 1] !== "\n") {
          code += source[i] + (source[i + 1] as string);
          bare += "  ";
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        if (source[i] === "]") inClass = false;
        code += source[i];
        bare += " ";
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      code += c;
      bare += c;
      i += 1;
      while (i < n && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\" && i + 1 < n) {
          code += source[i] + (source[i + 1] as string);
          bare += "  ";
          i += 2;
          continue;
        }
        code += source[i];
        bare += " ";
        i += 1;
      }
      if (i < n) {
        code += source[i];
        bare += source[i] === "\n" ? "\n" : source[i];
        i += 1;
      }
      continue;
    }
    if (c === "`") {
      templates.push(-1);
      code += c;
      bare += c;
      i += 1;
      continue;
    }
    if (templates.length > 0) {
      const depth = templates[templates.length - 1] as number;
      if (c === "{") templates[templates.length - 1] = depth + 1;
      if (c === "}") {
        if (depth === 0) {
          templates[templates.length - 1] = -1;
        } else {
          templates[templates.length - 1] = depth - 1;
        }
      }
    }
    code += c;
    bare += c;
    i += 1;
  }
  return { code, bare };
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1/g,
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1/g,
];

/** Every module specifier imported, re-exported, dynamically imported or required. */
export function importsOf(code: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      if (m[2] !== undefined) found.push(m[2]);
    }
  }
  return found;
}

const CORE_BANS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /(?<![\w$.])fetch\b/, what: "fetch" },
  { pattern: /\bglobalThis\s*\.\s*fetch\b/, what: "fetch" },
  { pattern: /\bBun\s*\.\s*spawn\b/, what: "Bun.spawn" },
  { pattern: /\bBun\s*\.\s*spawnSync\b/, what: "Bun.spawnSync" },
  { pattern: /\bBun\s*\.\s*file\b/, what: "Bun.file" },
  { pattern: /\bBun\s*\.\s*write\b/, what: "Bun.write" },
  { pattern: /\bBun\s*\.\s*\$/, what: "Bun.$" },
  { pattern: /\bDate\s*\.\s*now\b/, what: "Date.now()" },
  { pattern: /\bnew\s+Date\b\s*(?:\(\s*\)|(?![\s(]))/, what: "new Date()" },
  { pattern: /\bprocess\s*\.\s*env\b/, what: "process.env" },
  { pattern: /\bBun\s*\.\s*env\b/, what: "Bun.env" },
  { pattern: /\bimport\s*\.\s*meta\s*\.\s*env\b/, what: "import.meta.env" },
];

const AGENT_SPAWN_BANS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bBun\s*\.\s*spawn\b/, what: "Bun.spawn" },
  { pattern: /\bBun\s*\.\s*spawnSync\b/, what: "Bun.spawnSync" },
  { pattern: /\bBun\s*\.\s*\$/, what: "Bun.$" },
];

/** A named import of a spawning export from the `bun` module, matched on the `code` view. */
const BUN_SPAWN_IMPORT = /\bimport\s*\{[^}]*(?:\bspawn\b|\bspawnSync\b|\$)[^}]*\}\s*from\s*["']bun["']/;

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function bareName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] as string;
}

/** The macOS sandbox launcher, named in code (strings included, comments not). */
const SANDBOX_EXEC = /sandbox-exec/;

/** Applies the layer table, core purity, the agent spawn ban and the `sandbox-exec` rule to one file. */
export function checkSource(path: string, source: string): Violation[] {
  const filePath = posix.normalize(path);
  const here = locate(filePath);
  const violations: Violation[] = [];
  const { code, bare } = strip(source);

  if (filePath.startsWith("src/") && !filePath.startsWith("src/sandbox/") && SANDBOX_EXEC.test(code)) {
    violations.push({ path: filePath, rule: "spawn", detail: "only src/sandbox/ may name sandbox-exec" });
  }

  if (here === undefined) {
    if (filePath.startsWith("src/")) {
      violations.push({ path: filePath, rule: "layer", detail: "file is outside every layer" });
    }
    return violations;
  }

  for (const specifier of importsOf(code)) {
    if (!isRelative(specifier)) {
      if (here.layer === "core" && !CORE_BARE_ALLOWED.includes(bareName(specifier))) {
        violations.push({ path: filePath, rule: "purity", detail: `core may not import ${specifier}` });
      }
      continue;
    }
    const target = posix.normalize(posix.join(posix.dirname(filePath), specifier));
    const there = locate(target);
    if (there === undefined) {
      if (here.layer === "core") {
        violations.push({ path: filePath, rule: "layer", detail: `core may not import ${target}` });
      }
      continue;
    }
    if (!ALLOWED[here.layer].includes(there.layer)) {
      violations.push({ path: filePath, rule: "layer", detail: `${here.layer} may not import ${there.layer}` });
      continue;
    }
    if (here.layer === "adapters" && there.layer === "adapters" && there.unit !== here.unit) {
      violations.push({ path: filePath, rule: "layer", detail: `${here.unit} may not import ${there.unit}` });
    }
  }

  if (here.layer === "core") {
    const seen = new Set<string>();
    for (const ban of CORE_BANS) {
      if (!seen.has(ban.what) && ban.pattern.test(bare)) {
        seen.add(ban.what);
        violations.push({ path: filePath, rule: "purity", detail: `core may not use ${ban.what}` });
      }
    }
  }

  if (filePath.startsWith("src/adapters/agent/")) {
    for (const ban of AGENT_SPAWN_BANS) {
      if (ban.pattern.test(bare)) {
        violations.push({ path: filePath, rule: "spawn", detail: `agent adapters may not use ${ban.what}` });
      }
    }
    if (BUN_SPAWN_IMPORT.test(code)) {
      violations.push({ path: filePath, rule: "spawn", detail: 'agent adapters may not import spawn or $ from "bun"' });
    }
    if (/\bchild_process\b/.test(code)) {
      violations.push({ path: filePath, rule: "spawn", detail: "agent adapters may not use child_process" });
    }
  }

  return violations;
}

const SOURCE_GLOB = new Bun.Glob("src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");

/** Checks every source file under `<root>/src`; throws if there are none, so a wrong root cannot pass. */
export async function checkTree(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const paths: string[] = [];
  for await (const rel of SOURCE_GLOB.scan({ cwd: root, dot: true })) paths.push(rel.split("\\").join("/"));
  if (paths.length === 0) throw new Error(`no source files under ${posix.join(root, "src")}`);
  paths.sort();
  for (const rel of paths) {
    const source = await Bun.file(posix.join(root, rel)).text();
    violations.push(...checkSource(rel, source));
  }
  return violations;
}

// ------------------------------------------------------------ import cycles

/**
 * Every elementary cycle in `graph` (file -> the files it imports). Each
 * cycle starts at its smallest file and closes on it (`["a.ts", "b.ts",
 * "a.ts"]`; a self import is `["a.ts", "a.ts"]`), and the cycles are sorted.
 */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const nodes = [...graph.keys()].sort();
  const edges = new Map(nodes.map((n) => [n, [...new Set(graph.get(n) ?? [])].filter((m) => graph.has(m)).sort()]));
  const cycles: string[][] = [];
  for (const start of nodes) {
    // Only files after `start` may sit on its cycles, so each cycle is found once, from its smallest file.
    const inScope = (n: string): boolean => n >= start;
    // The in-scope files that can reach `start`: no path through any other file closes a cycle.
    const reaches = new Set<string>([start]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) {
        if (!inScope(n) || reaches.has(n)) continue;
        if ((edges.get(n) ?? []).some((m) => reaches.has(m))) {
          reaches.add(n);
          grew = true;
        }
      }
    }
    const path: string[] = [start];
    const onPath = new Set<string>([start]);
    const walk = (n: string): void => {
      for (const m of edges.get(n) ?? []) {
        if (m === start) cycles.push([...path, start]);
        else if (inScope(m) && reaches.has(m) && !onPath.has(m)) {
          path.push(m);
          onPath.add(m);
          walk(m);
          onPath.delete(m);
          path.pop();
        }
      }
    };
    walk(start);
  }
  const key = (c: readonly string[]): string => c.join("\u0000");
  return cycles.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const LANE_DIR = "src/lane";

/**
 * The import graph of the files under `dir`, a repo-relative directory such
 * as `src/core` (`files`: path relative to `dir` -> source). Type-only
 * imports count. Every relative specifier is resolved from the file's own
 * path (`<dir>/<name>`), so from `src/lane/a.ts`, `../lane/b.ts` counts as
 * `b.ts`, and from `src/core/next/a.ts`, `../ledger/b.ts` as
 * `ledger/b.ts`; a target under `dir` is kept, a `.js` ending read as `.ts`
 * and `.ts` appended when there is no extension. Anything else (another
 * directory, a package, a file not in `files`) is dropped.
 */
export function importGraph(dir: string, files: Readonly<Record<string, string>>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [name, source] of Object.entries(files)) {
    const file = posix.join(dir, name);
    const targets: string[] = [];
    for (const specifier of importsOf(strip(source).code)) {
      if (!isRelative(specifier)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!resolved.startsWith(`${dir}/`)) continue;
      let target = resolved.slice(dir.length + 1);
      const ext = posix.extname(target);
      if (ext === ".js") target = `${target.slice(0, -ext.length)}.ts`;
      else if (ext === "") target = `${target}.ts`;
      if (Object.hasOwn(files, target)) targets.push(target);
    }
    graph.set(name, targets);
  }
  return graph;
}

/** The import graph of `src/lane`'s files (file name -> source): `importGraph` on `src/lane`. */
export function laneGraph(files: Readonly<Record<string, string>>): Map<string, string[]> {
  return importGraph(LANE_DIR, files);
}

const TS_GLOB = new Bun.Glob("**/*.ts");

/** The sources of every `.ts` file under `<root>/<dir>`, by path relative to `dir`; throws if there are none. */
export async function sourcesUnder(root: string, dir: string): Promise<Record<string, string>> {
  const abs = posix.join(root, dir);
  const files: Record<string, string> = {};
  for await (const rel of TS_GLOB.scan({ cwd: abs })) {
    const name = rel.split("\\").join("/");
    files[name] = await Bun.file(posix.join(abs, name)).text();
  }
  if (Object.keys(files).length === 0) throw new Error(`no source files under ${abs}`);
  return files;
}

/** The sources of `<root>/src/lane/*.ts` by file name; throws if there are none. */
export async function laneSources(root: string): Promise<Record<string, string>> {
  return sourcesUnder(root, LANE_DIR);
}

// ------------------------------------------------------------ the agent config rule's one home

/** Where the agent config rule is declared: the write check and the review checkout share it (Epic 3 retro, D2). */
export const AGENT_CONFIG_RULE_HOME = "core/review/agent-config.ts";

const AGENT_CONFIG_RULE = /\b(?:const|let|var)\s+(AGENT_CONFIG_DIRS)\b|\bfunction\s+(isAgentConfigPath)\b/g;

/** The agent config rule names `source` declares (comments ignored): `AGENT_CONFIG_DIRS`, `isAgentConfigPath`. */
export function agentConfigRules(source: string): string[] {
  const { code } = strip(source);
  const found = new Set<string>();
  for (const m of code.matchAll(AGENT_CONFIG_RULE)) found.add((m[1] ?? m[2]) as string);
  return [...found].sort();
}

/** The import cycles under `<root>/<dir>`, as paths relative to `dir`. */
export async function cyclesUnder(root: string, dir: string): Promise<string[][]> {
  return findCycles(importGraph(dir, await sourcesUnder(root, dir)));
}

/** The import cycles in `<root>/src/lane`. */
export async function laneCycles(root: string): Promise<string[][]> {
  return cyclesUnder(root, LANE_DIR);
}

// ------------------------------------------------------------ the step helpers' one home

/**
 * The session runner's step helpers, declared only in `src/lane/session.ts`:
 * the kit's (Story 2.6a), then the step ops and error texts the CI step and
 * the coordinator steps share (Epic 2 retro, D2), then the review plumbing
 * the steps share (Epic 3 retro, D2), then the best-effort log and forge
 * calls of the inbox and rulings steps (Epic 4 retro, D2).
 */
export const SHARED_HELPERS: readonly string[] = [
  "call",
  "swap",
  "forgeNow",
  "laneStop",
  "held",
  "beat",
  "aborted",
  "parkBlocked",
  "freshMain",
  "poll",
  "closeOrphan",
  "closeOrphans",
  "recordPr",
  "describeError",
  "message",
  "pushSessionFix",
  "allowanceReason",
  "callPassedGate",
  "passedGate",
  "haveCommits",
  "bestEffortOps",
];

/**
 * The `src/lane` files that keep their own copy of a shared helper, with
 * why: each is one `session.ts` imports, so importing the helper from
 * `session.ts` would be an import cycle.
 */
export const OWN_COPIES: Readonly<Record<string, readonly string[]>> = {
  "heartbeat.ts": ["message"],
  "wait.ts": ["message"],
};

const HELPER = SHARED_HELPERS.join("|");
const HELPER_FUNCTION = new RegExp(`\\bfunction\\s*\\*?\\s*(${HELPER})\\b`, "g");
/** `const`/`let <name> =` an arrow or `async` arrow, generic or not, with or without parentheses. */
const HELPER_ARROW = new RegExp(`\\b(?:const|let)\\s+(${HELPER})\\s*(?::[^=]*)?=\\s*(?:async\\s+)?(?:<[^>]*>\\s*)?(?:\\(|[A-Za-z_$][\\w$]*\\s*=>)`, "g");
const END_CLASS = /\bclass\s+End\b/;

/** The shared helpers `source` declares a copy of (comments ignored), plus `End` for a `class End`. */
export function helperCopies(source: string): string[] {
  const { code } = strip(source);
  const found = new Set<string>();
  for (const m of code.matchAll(HELPER_FUNCTION)) found.add(m[1] as string);
  for (const m of code.matchAll(HELPER_ARROW)) found.add(m[1] as string);
  if (END_CLASS.test(code)) found.add("End");
  return [...found].sort();
}
