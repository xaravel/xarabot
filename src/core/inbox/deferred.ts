import { splitFrontmatter } from "../config/load-repo-config.ts";
import { parseYaml } from "../schemas/common.ts";
import { compareStoryIds } from "../story-id.ts";

/**
 * The deferred entries of the Story specs on `main` that wait on the
 * Maintainer (Story 4.2, Maintainer decision 2026-10-26). A spec is a `main`
 * path matching `story_spec_path` with `<epic>` and `<story>` widened; its
 * Story id comes from its name (`spec-4-1-…` gives `4.1`). Entry `n`
 * (1-based) of a spec's frontmatter `deferred` list has the id of its `id`
 * key, or `<story id>-d<n>`. An entry is resolved once another spec lists its
 * id in its frontmatter `resolves`: an id exists only once its spec is on
 * `main`, so a spec naming it merged later. A spec whose frontmatter does not
 * parse is skipped and reported. Pure.
 */

/** One unresolved deferred entry: its id, its spec's path, its summary and its spec's `created` (`null` when unset). */
export type DeferredEntry = {
  readonly id: string;
  readonly spec: string;
  readonly summary: string;
  readonly created: string | null;
};

/** A spec left out: its path and why. */
export type SkippedSpec = { readonly path: string; readonly message: string };

export type DeferredScan = {
  /** The unresolved entries, by Story id, then position. */
  readonly open: readonly DeferredEntry[];
  /** The specs left out, by path. */
  readonly skipped: readonly SkippedSpec[];
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The glob `story_spec_path` widens to: `<epic>` and `<story>` each become `*`. */
export function widenedSpecGlob(pattern: string): string {
  return pattern.replaceAll("<epic>", "*").replaceAll("<story>", "*");
}

/**
 * A regex over a path that matches `pattern` (glob `*` within a segment,
 * `**` across them, `**` and a `/` also across no directory, `?` one
 * character) with `<epic>` and `<story>` captured as the Story id's parts.
 */
function specRegExp(pattern: string): RegExp {
  let out = "";
  const seen = new Set<string>();
  for (let i = 0; i < pattern.length; ) {
    const rest = pattern.slice(i);
    const placeholder = /^<(epic|story)>/.exec(rest);
    if (placeholder !== null) {
      const name = placeholder[1] as string;
      out += seen.has(name) ? `\\k<${name}>` : name === "epic" ? "(?<epic>[0-9]+)" : "(?<story>[0-9]+[a-z]?)";
      seen.add(name);
      i += placeholder[0].length;
    } else if (rest.startsWith("**/")) {
      // As `Bun.Glob`: `**/` also matches no directory at all.
      out += "(?:.*/)?";
      i += 3;
    } else if (rest.startsWith("**")) {
      out += ".*";
      i += 2;
    } else if (rest.startsWith("*")) {
      out += "[^/]*";
      i += 1;
    } else if (rest.startsWith("?")) {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeRegExp(rest[0] as string);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** A Story spec on `main`: its path and the Story id its name gives. */
export type StorySpecFile = { readonly path: string; readonly storyId: string };

/**
 * The paths of `paths` that match `pattern` widened, each with the Story id
 * its name gives, by path; a match that gives no id is skipped and reported.
 */
export function storySpecFiles(pattern: string, paths: readonly string[]): { readonly specs: StorySpecFile[]; readonly skipped: SkippedSpec[] } {
  const glob = new Bun.Glob(widenedSpecGlob(pattern));
  const re = specRegExp(pattern);
  const specs: StorySpecFile[] = [];
  const skipped: SkippedSpec[] = [];
  for (const path of [...paths].sort()) {
    if (!glob.match(path)) continue;
    const m = re.exec(path);
    const epic = m?.groups?.["epic"];
    const story = m?.groups?.["story"];
    if (epic === undefined || story === undefined) {
      skipped.push({ path, message: `${path}: its name gives no Story id` });
      continue;
    }
    specs.push({ path, storyId: `${Number(epic)}.${story.replace(/^0+(?=[0-9])/, "")}` });
  }
  return { specs, skipped };
}

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A frontmatter `created` as text: a string as given, a YAML date as its UTC day; `null` otherwise. */
function createdOf(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Date.parse(v.trim()))) return v.trim();
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

type ParsedSpec = {
  readonly entries: readonly { readonly id: string; readonly summary: string }[];
  readonly resolves: readonly string[];
  readonly created: string | null;
};

/** One spec's frontmatter: its entries with their ids, its `resolves` and `created`; an error message when it does not parse. */
function parseSpec(spec: StorySpecFile, text: string): ParsedSpec | string {
  const split = splitFrontmatter(spec.path, text);
  if (!split.ok) return split.error.message;
  const yaml = parseYaml(spec.path, split.value.yaml);
  if (!yaml.ok) return yaml.error.message;
  const fm = yaml.value;
  if (!isObj(fm)) return `${spec.path}: the frontmatter is not a mapping`;
  const deferred = fm["deferred"] ?? [];
  if (!Array.isArray(deferred)) return `${spec.path}: deferred is not a list`;
  const resolves = fm["resolves"] ?? [];
  if (!Array.isArray(resolves) || !resolves.every((r) => typeof r === "string")) return `${spec.path}: resolves is not a list of ids`;
  const entries: { id: string; summary: string }[] = [];
  for (const [i, raw] of deferred.entries()) {
    const fallback = `${spec.storyId}-d${i + 1}`;
    if (typeof raw === "string") {
      entries.push({ id: fallback, summary: raw.trim() });
      continue;
    }
    if (!isObj(raw)) return `${spec.path}: deferred entry ${i + 1} is neither a mapping nor text`;
    const id = raw["id"];
    if (id !== undefined && (typeof id !== "string" || id.trim() === "")) return `${spec.path}: deferred entry ${i + 1} has an id that is not text`;
    const summary = raw["summary"];
    if (summary !== undefined && typeof summary !== "string") return `${spec.path}: deferred entry ${i + 1} has a summary that is not text`;
    entries.push({ id: id === undefined ? fallback : id.trim(), summary: (summary ?? "").trim() });
  }
  return { entries, resolves: resolves.map((r) => r.trim()), created: createdOf(fm["created"]) };
}

/**
 * The unresolved deferred entries of the Story specs on `main`: `paths` is
 * `main`'s tree and `files` the texts read. A spec whose text was not read is
 * skipped as one that does not parse.
 */
export function openDeferred(pattern: string, paths: readonly string[], files: Readonly<Record<string, string>>): DeferredScan {
  const listed = storySpecFiles(pattern, paths);
  const skipped: SkippedSpec[] = [...listed.skipped];
  const parsed: { readonly spec: StorySpecFile; readonly value: ParsedSpec }[] = [];
  for (const spec of listed.specs) {
    const text = Object.hasOwn(files, spec.path) ? files[spec.path] : undefined;
    if (text === undefined) {
      skipped.push({ path: spec.path, message: `${spec.path}: its text was not read` });
      continue;
    }
    const value = parseSpec(spec, text);
    if (typeof value === "string") skipped.push({ path: spec.path, message: value });
    else parsed.push({ spec, value });
  }
  const open: (DeferredEntry & { readonly storyId: string; readonly n: number })[] = [];
  for (const { spec, value } of parsed) {
    value.entries.forEach((e, i) => {
      const resolved = parsed.some((other) => other.spec.path !== spec.path && other.value.resolves.includes(e.id));
      if (!resolved) open.push({ id: e.id, spec: spec.path, summary: e.summary, created: value.created, storyId: spec.storyId, n: i });
    });
  }
  open.sort((a, b) => compareStoryIds(a.storyId, b.storyId) || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0) || a.n - b.n);
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { open: open.map(({ id, spec, summary, created }) => ({ id, spec, summary, created })), skipped };
}
