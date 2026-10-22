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

/**
 * Splits source into two views: `code` with comments blanked (string contents
 * kept, for import specifiers) and `bare` with comments and string contents
 * blanked (for purity checks). Lengths and line breaks are preserved.
 * Regex literals are not recognised; a regex containing a quote or `//` may
 * confuse the scan.
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
  { pattern: /\bDate\s*\.\s*now\b/, what: "Date.now()" },
  { pattern: /\bnew\s+Date\b\s*(?:\(\s*\)|(?![\s(]))/, what: "new Date()" },
  { pattern: /\bprocess\s*\.\s*env\b/, what: "process.env" },
  { pattern: /\bBun\s*\.\s*env\b/, what: "Bun.env" },
];

const AGENT_SPAWN_BANS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bBun\s*\.\s*spawn\b/, what: "Bun.spawn" },
  { pattern: /\bBun\s*\.\s*spawnSync\b/, what: "Bun.spawnSync" },
];

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function bareName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] as string;
}

/** Applies the layer table, core purity and the agent spawn ban to one file. */
export function checkSource(path: string, source: string): Violation[] {
  const filePath = posix.normalize(path);
  const here = locate(filePath);
  const violations: Violation[] = [];
  const { code, bare } = strip(source);

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
    if (/\bchild_process\b/.test(code)) {
      violations.push({ path: filePath, rule: "spawn", detail: "agent adapters may not use child_process" });
    }
  }

  return violations;
}

const SOURCE_GLOB = new Bun.Glob("src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");

/** Checks every source file under `<root>/src`. */
export async function checkTree(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const paths: string[] = [];
  for await (const rel of SOURCE_GLOB.scan({ cwd: root, dot: true })) paths.push(rel.split("\\").join("/"));
  paths.sort();
  for (const rel of paths) {
    const source = await Bun.file(posix.join(root, rel)).text();
    violations.push(...checkSource(rel, source));
  }
  return violations;
}
