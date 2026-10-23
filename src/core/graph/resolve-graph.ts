import { CONFIG_PATH, EPICS_YAML_PATH } from "../config/load-repo-config.ts";
import { loadManifests } from "../manifests/parse-manifest.ts";
import { err, ok, type Result } from "../result.ts";
import { CONFIG_DEFAULTS, type Config } from "../schemas/config.ts";
import type { RetroGates } from "../schemas/retro-gates.ts";
import { compareStoryIds } from "../story-id.ts";
import { parseEpicsMd, type EpicsMdStory } from "./epics-md.ts";
import { EMPTY_EPICS_YAML, parseEpicsYaml } from "./epics-yaml.ts";
import { packageEdges, type Edge } from "./package-edges.ts";
import { emptyRetroGates, parseRetroGates } from "./retro-gates.ts";

/** The config fields the graph reads. */
export type GraphConfig = Pick<Config, "epics_path" | "retro_gates_path" | "bootstrapped_epics" | "manifests" | "epic_packages">;

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  epics_path: CONFIG_DEFAULTS.epics_path,
  retro_gates_path: CONFIG_DEFAULTS.retro_gates_path,
  bootstrapped_epics: [...CONFIG_DEFAULTS.bootstrapped_epics],
};

/** One `main` SHA's tree listing, the contents of the graph inputs read from it, and the graph config. */
export type GraphSnapshot = {
  readonly tree: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly config: GraphConfig;
};

export type GraphErrorKind =
  | "missing"
  | "unreadable"
  | "invalid"
  | "unsupported-version"
  | "unknown-epic"
  | "cycle"
  | "manifest-heading"
  | "story-dependency";

export type ResolvedEpic = {
  readonly number: number;
  readonly title: string;
  readonly depends_on: readonly number[];
  readonly checkpoint: boolean;
  readonly stories: readonly string[];
};

export type ResolvedGraph = {
  readonly epics: readonly ResolvedEpic[];
  readonly edges: readonly Edge[];
  readonly checkpoints: readonly number[];
  readonly unmanifested: readonly { readonly id: string; readonly epic: number; readonly line: number }[];
  readonly retroGates: RetroGates;
  readonly hash: string;
};

export { type Edge } from "./package-edges.ts";

/** A Story id's join key: numeric Epic and Story parts, then the suffix (`02.06a` → `2.6a`). */
function storyKey(id: string): string {
  const m = /^(\d+)\.(\d+)([a-z]?)$/.exec(id);
  return m === null ? id : `${Number(m[1])}.${Number(m[2])}${m[3] ?? ""}`;
}

/** Tree entries that are manifests: `.md` files directly inside `manifests.dir`. */
function manifestPaths(tree: readonly string[], config: GraphConfig): string[] {
  if (config.manifests === undefined) return [];
  const prefix = `${config.manifests.dir}/`;
  return tree.filter((p) => p.startsWith(prefix) && p.endsWith(".md") && !p.slice(prefix.length).includes("/"));
}

/**
 * The tree entries `resolveGraph` reads: `epics.md`, `.xarabot/epics.yaml`,
 * `retro-gates.yaml`, the manifests, and, when `epic_packages` is set, every
 * `package.json`. Sorted, each once.
 */
export function graphInputPaths(tree: readonly string[], config: GraphConfig): string[] {
  const wanted = new Set<string>([config.epics_path, EPICS_YAML_PATH, config.retro_gates_path, ...manifestPaths(tree, config)]);
  if (config.epic_packages !== undefined) {
    for (const p of tree) if (p === "package.json" || p.endsWith("/package.json")) wanted.add(p);
  }
  return [...new Set(tree.filter((p) => wanted.has(p)))].sort();
}

function readFile(snap: GraphSnapshot, path: string): Result<string, "missing" | "unreadable"> {
  if (!snap.tree.includes(path)) return err("missing", `${path}: missing`);
  const text = Object.hasOwn(snap.files, path) ? snap.files[path] : undefined;
  if (typeof text !== "string") return err("unreadable", `${path}: listed in the tree but its content was not read`);
  return ok(text);
}

/** The first cycle found among `deps` (node → its dependencies), as a closed path, or `undefined`. */
function findCycle<T>(nodes: readonly T[], deps: (n: T) => readonly T[]): T[] | undefined {
  const state = new Map<T, "open" | "done">();
  const stack: T[] = [];
  const visit = (n: T): T[] | undefined => {
    state.set(n, "open");
    stack.push(n);
    for (const d of deps(n)) {
      const s = state.get(d);
      if (s === "open") return [...stack.slice(stack.indexOf(d)), d];
      if (s === undefined) {
        const found = visit(d);
        if (found !== undefined) return found;
      }
    }
    stack.pop();
    state.set(n, "done");
    return undefined;
  };
  for (const n of nodes) {
    if (state.get(n) === undefined) {
      const found = visit(n);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return `sha256:${hasher.digest("hex")}`;
}

/**
 * Builds the effective Epic graph from one snapshot (AD-11, AR12): the
 * `epics.md` headings, `.xarabot/epics.yaml`, the manifests, package edges
 * when `epic_packages` is set, and `retro-gates.yaml`; validates it; and
 * returns it with a stable hash. Pure.
 */
export function resolveGraph(snap: GraphSnapshot): Result<ResolvedGraph, GraphErrorKind> {
  const { config } = snap;
  const epicsPath = config.epics_path;

  const mdText = readFile(snap, epicsPath);
  if (!mdText.ok) return mdText;
  const md = parseEpicsMd(epicsPath, mdText.value);
  if (!md.ok) return md;
  const headings = [...md.value.epics].sort((a, b) => a.number - b.number);
  const epicNumbers = new Set(headings.map((e) => e.number));
  const unknown = (n: number) => !epicNumbers.has(n);
  const noHeading = (n: number) => `Epic ${n} has no heading in ${epicsPath}`;

  let epicsYaml = EMPTY_EPICS_YAML;
  if (snap.tree.includes(EPICS_YAML_PATH)) {
    const text = readFile(snap, EPICS_YAML_PATH);
    if (!text.ok) return text;
    const parsed = parseEpicsYaml(EPICS_YAML_PATH, text.value);
    if (!parsed.ok) return parsed;
    epicsYaml = parsed.value;
  }

  let retroGates = emptyRetroGates();
  if (snap.tree.includes(config.retro_gates_path)) {
    const text = readFile(snap, config.retro_gates_path);
    if (!text.ok) return text;
    const parsed = parseRetroGates(config.retro_gates_path, text.value);
    if (!parsed.ok) return parsed;
    retroGates = parsed.value;
  }

  for (const [n, entry] of epicsYaml.epics) {
    if (unknown(n)) return err("unknown-epic", `${EPICS_YAML_PATH}: epics.${n}: ${noHeading(n)}`);
    const dep = (entry.depends_on ?? []).find(unknown);
    if (dep !== undefined) return err("unknown-epic", `${EPICS_YAML_PATH}: epics.${n}.depends_on: ${noHeading(dep)}`);
  }
  const boot = config.bootstrapped_epics.find(unknown);
  if (boot !== undefined) return err("unknown-epic", `${CONFIG_PATH}: bootstrapped_epics: ${noHeading(boot)}`);

  let pkgEdges: Edge[] = [];
  if (config.epic_packages !== undefined) {
    const key = Object.keys(config.epic_packages).find((k) => unknown(Number(k)));
    if (key !== undefined) return err("unknown-epic", `${CONFIG_PATH}: epic_packages: ${noHeading(Number(key))}`);
    const edges = packageEdges(snap, config.epic_packages);
    if (!edges.ok) return edges;
    pkgEdges = edges.value;
  }

  // Effective dependencies: the entry's depends_on, else the next lower Epic; plus package edges.
  const deps = new Map<number, number[]>();
  headings.forEach((e, i) => {
    const entry = epicsYaml.epics.get(e.number);
    const prev = i > 0 ? headings[i - 1]?.number : undefined;
    const base = entry?.depends_on ?? (prev === undefined ? [] : [prev]);
    const all = [...base, ...pkgEdges.filter((p) => p.from === e.number).map((p) => p.to)];
    deps.set(e.number, [...new Set(all)].sort((a, b) => a - b));
  });
  const depsOf = (n: number) => deps.get(n) ?? [];

  const epicCycle = findCycle([...epicNumbers].sort((a, b) => a - b), depsOf);
  if (epicCycle !== undefined) return err("cycle", `graph: cycle among Epics ${epicCycle.join(" → ")}`);

  const reach = new Map<number, Set<number>>();
  const reachOf = (n: number): Set<number> => {
    const known = reach.get(n);
    if (known !== undefined) return known;
    const set = new Set<number>();
    for (const d of depsOf(n)) {
      set.add(d);
      for (const t of reachOf(d)) set.add(t);
    }
    reach.set(n, set);
    return set;
  };

  // Manifests, joined to headings by numeric id.
  const loaded = loadManifests(snap, config.manifests);
  if (!loaded.ok) {
    const kind = loaded.error.kind === "unreadable" ? "unreadable" : "invalid";
    return err(kind, loaded.error.message);
  }
  const manifests = loaded.value;
  const storyHeadings = new Map<string, EpicsMdStory>();
  for (const e of md.value.epics) for (const s of e.stories) storyHeadings.set(storyKey(s.id), s);

  const byKey = new Map<string, (typeof manifests)[number]>();
  for (const m of manifests) {
    const heading = storyHeadings.get(storyKey(m.story_id));
    if (heading === undefined) {
      return err("manifest-heading", `${m.path}: story_id "${m.story_id}" has no Story heading in ${epicsPath}`);
    }
    if (heading.epic !== m.epic) {
      return err(
        "manifest-heading",
        `${m.path}: epic ${m.epic} differs from Story ${heading.id}'s Epic ${heading.epic} (${epicsPath}:${heading.line})`,
      );
    }
    const other = byKey.get(storyKey(m.story_id));
    if (other !== undefined) {
      return err("invalid", `${m.path}: story_id "${m.story_id}" duplicates ${other.path} ("${other.story_id}")`);
    }
    byKey.set(storyKey(m.story_id), m);
  }

  for (const m of manifests) {
    for (const d of m.depends_on) {
      const heading = storyHeadings.get(storyKey(d));
      if (heading === undefined) {
        return err("story-dependency", `${m.path}: depends_on "${d}" names no Story heading in ${epicsPath}`);
      }
      if (heading.epic !== m.epic && !reachOf(m.epic).has(heading.epic)) {
        return err(
          "story-dependency",
          `${m.path}: depends_on "${d}" is in Epic ${heading.epic}, which Epic ${m.epic} does not depend on`,
        );
      }
    }
  }

  const storyCycle = findCycle(
    manifests.map((m) => storyKey(m.story_id)),
    (k) => (byKey.get(k)?.depends_on ?? []).map(storyKey).filter((d) => byKey.has(d)),
  );
  if (storyCycle !== undefined) {
    const prefix = new Set(storyCycle).size > 1 ? "graph" : (byKey.get(storyCycle[0] as string)?.path ?? "graph");
    return err("story-dependency", `${prefix}: Story dependency cycle ${storyCycle.join(" → ")}`);
  }

  const storiesOf = new Map<number, string[]>();
  for (const m of manifests) storiesOf.set(m.epic, [...(storiesOf.get(m.epic) ?? []), m.story_id]);

  const epics: ResolvedEpic[] = headings.map((e) => ({
    number: e.number,
    title: e.title,
    depends_on: depsOf(e.number),
    checkpoint: epicsYaml.epics.get(e.number)?.checkpoint === true,
    stories: [...(storiesOf.get(e.number) ?? [])].sort(compareStoryIds),
  }));
  const edges = epics.flatMap((e) => e.depends_on.map((to) => ({ from: e.number, to })));
  const checkpoints = epics.filter((e) => e.checkpoint).map((e) => e.number);
  const bootstrapped = new Set(config.bootstrapped_epics);
  const unmanifested = md.value.epics
    .filter((e) => !bootstrapped.has(e.number))
    .flatMap((e) => e.stories)
    .filter((s) => !byKey.has(storyKey(s.id)))
    .map((s) => ({ id: s.id, epic: s.epic, line: s.line }));
  const hash = sha256(
    JSON.stringify(
      epics.map((e) => ({ number: e.number, depends_on: e.depends_on, checkpoint: e.checkpoint, stories: e.stories })),
    ),
  );

  return ok({ epics, edges, checkpoints, unmanifested, retroGates, hash });
}
