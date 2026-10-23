import { CONFIG_PATH } from "../config/load-repo-config.ts";
import { err, ok, type Result } from "../result.ts";

export type Edge = { readonly from: number; readonly to: number };
export type PackageEdgesErrorKind = "missing" | "unreadable" | "invalid";

type Files = { readonly tree: readonly string[]; readonly files: Readonly<Record<string, string>> };

const ROOT_PACKAGE_JSON = "package.json";
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function readText(snap: Files, path: string): Result<string, "missing" | "unreadable"> {
  if (!snap.tree.includes(path)) return err("missing", `${path}: missing`);
  const text = Object.hasOwn(snap.files, path) ? snap.files[path] : undefined;
  if (typeof text !== "string") return err("unreadable", `${path}: listed in the tree but its content was not read`);
  return ok(text);
}

function readJsonObject(snap: Files, path: string): Result<Record<string, unknown>, PackageEdgesErrorKind> {
  const text = readText(snap, path);
  if (!text.ok) return text;
  let value: unknown;
  try {
    value = JSON.parse(text.value);
  } catch (e) {
    return err("invalid", `${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return err("invalid", `${path}: top level must be a JSON object`);
  }
  return ok(value as Record<string, unknown>);
}

/** A workspace pattern with its leading `./` and trailing `/` stripped. */
function cleanPattern(p: string): string {
  let s = p;
  while (s.startsWith("./")) s = s.slice(2);
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** The root `package.json`'s `workspaces` patterns: an array, or `{packages: [...]}`; none when absent. */
function workspacePatterns(root: Record<string, unknown>): Result<string[], "invalid"> {
  const ws = root["workspaces"];
  if (ws === undefined) return ok([]);
  const list = Array.isArray(ws)
    ? ws
    : ws !== null && typeof ws === "object" && Array.isArray((ws as Record<string, unknown>)["packages"])
      ? ((ws as Record<string, unknown>)["packages"] as unknown[])
      : undefined;
  if (list === undefined || !list.every((p) => typeof p === "string" && p !== "")) {
    return err("invalid", `${ROOT_PACKAGE_JSON}: workspaces must be a list of patterns or {packages: [...]}`);
  }
  return ok(list as string[]);
}

/** Workspace `package.json` paths in the tree: matching a positive pattern and no `!` pattern. */
export function workspacePackagePaths(tree: readonly string[], patterns: readonly string[]): string[] {
  const include: Bun.Glob[] = [];
  const exclude: Bun.Glob[] = [];
  for (const p of patterns) {
    if (p.startsWith("!")) exclude.push(new Bun.Glob(`${cleanPattern(p.slice(1))}/package.json`));
    else include.push(new Bun.Glob(`${cleanPattern(p)}/package.json`));
  }
  return tree
    .filter((t) => t !== ROOT_PACKAGE_JSON && include.some((g) => g.match(t)) && !exclude.some((g) => g.match(t)))
    .sort();
}

/**
 * Epic edges from workspace package dependencies (AD-11): when package P,
 * mapped to Epic A, lists workspace package Q, mapped to Epic B ≠ A, in any
 * dependency field, Epic A depends on Epic B. Fails on a mapped name that is
 * no workspace package, a name mapped to two Epics, two workspace packages
 * sharing a name, and bad JSON. Pure.
 */
export function packageEdges(
  snap: Files,
  epicPackages: Readonly<Record<string, readonly string[]>>,
): Result<Edge[], PackageEdgesErrorKind> {
  const epicOf = new Map<string, number>();
  for (const key of Object.keys(epicPackages).sort((a, b) => Number(a) - Number(b))) {
    for (const name of epicPackages[key] ?? []) {
      const prior = epicOf.get(name);
      if (prior !== undefined && prior !== Number(key)) {
        return err("invalid", `${CONFIG_PATH}: epic_packages: package "${name}" is mapped to Epics ${prior} and ${key}`);
      }
      epicOf.set(name, Number(key));
    }
  }

  const root = readJsonObject(snap, ROOT_PACKAGE_JSON);
  if (!root.ok) return root;
  const patterns = workspacePatterns(root.value);
  if (!patterns.ok) return patterns;

  const packages = new Map<string, { path: string; json: Record<string, unknown> }>();
  for (const path of workspacePackagePaths(snap.tree, patterns.value)) {
    const json = readJsonObject(snap, path);
    if (!json.ok) return json;
    const name = json.value["name"];
    if (typeof name !== "string" || name === "") return err("invalid", `${path}: name must be a non-empty string`);
    const prior = packages.get(name);
    if (prior !== undefined) return err("invalid", `${path}: workspace package name "${name}" is also used by ${prior.path}`);
    packages.set(name, { path, json: json.value });
  }

  for (const [name, epic] of epicOf) {
    if (!packages.has(name)) {
      return err("invalid", `${CONFIG_PATH}: epic_packages.${epic}: "${name}" is not a workspace package`);
    }
  }

  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const [name, { path, json }] of packages) {
    const from = epicOf.get(name);
    if (from === undefined) continue;
    for (const field of DEP_FIELDS) {
      const deps = json[field];
      if (deps === undefined) continue;
      if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
        return err("invalid", `${path}: ${field} must be an object`);
      }
      for (const dep of Object.keys(deps)) {
        const to = packages.has(dep) ? epicOf.get(dep) : undefined;
        if (to === undefined || to === from) continue;
        const id = `${from}>${to}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ from, to });
      }
    }
  }
  return ok(edges.sort((a, b) => a.from - b.from || a.to - b.to));
}
