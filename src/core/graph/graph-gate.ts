import { CONFIG_PATH } from "../config/load-repo-config.ts";
import { loadManifests } from "../manifests/parse-manifest.ts";
import { emptySprintStatus, parseSprintStatus } from "../next/sprint-status.ts";
import { err, ok, type Result } from "../result.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../sanitize.ts";
import { parseVersionedYaml } from "../schemas/common.ts";
import { ConfigSchema } from "../schemas/config.ts";
import { compareStoryIds, storyKey } from "../story-id.ts";
import { parseEpicsMd, type EpicsMd } from "./epics-md.ts";
import { graphInputPaths, resolveGraph, type Edge, type GraphConfig, type ResolvedGraph } from "./resolve-graph.ts";

/**
 * The graph-change gate's pure half (Story 2.8, FR2, NFR18, AR6, AR12,
 * AR17): what a PR's merge with `main` does to the effective Epic graph.
 * Each side reads its own `.xarabot/config.yaml`, its graph inputs and its
 * `sprint_status_path`; "changed" means the two `ResolvedGraph.hash` values
 * differ. Refusals, changed or not: a merge result that fails `resolveGraph`
 * (a missing or invalid config included), a used Epic number or Story id
 * dropped, a new Story in an Epic whose retro is recorded or that is
 * bootstrapped, and `checkpoint: true` retired from an Epic still present
 * with no recorded checkpoint go. Pure.
 */

/** One tree as the gate reads it: its listing and the contents `graphReadPaths` names. */
export type GraphTree = {
  readonly tree: readonly string[];
  readonly files: Readonly<Record<string, string>>;
};

/** The config fields the gate reads from one side's `.xarabot/config.yaml`. */
export type GraphSettings = {
  readonly graph: GraphConfig;
  readonly sprintStatusPath: string;
  /** `branches.story`, the prefix of a Story's branch. */
  readonly storyBranch: string;
};

export type GraphSettingsErrorKind = "invalid-yaml" | "invalid" | "unsupported-version";

/** The graph settings from `.xarabot/config.yaml` text (strict `ConfigSchema`). */
export function graphSettings(text: string): Result<GraphSettings, GraphSettingsErrorKind> {
  const parsed = parseVersionedYaml(CONFIG_PATH, text, ConfigSchema);
  if (!parsed.ok) return parsed;
  const c = parsed.value;
  return ok({
    graph: {
      epics_path: c.epics_path,
      retro_gates_path: c.retro_gates_path,
      bootstrapped_epics: c.bootstrapped_epics,
      ...(c.manifests === undefined ? {} : { manifests: c.manifests }),
      ...(c.epic_packages === undefined ? {} : { epic_packages: c.epic_packages }),
    },
    sprintStatusPath: c.sprint_status_path,
    storyBranch: c.branches.story,
  });
}

/**
 * The tree entries the gate reads from one side: the config, its graph
 * inputs (`graphInputPaths`) and its `sprint_status_path`. With no config
 * text, or one that does not parse, only the config. Sorted, each once.
 */
export function graphReadPaths(tree: readonly string[], configText: string | null): string[] {
  const out = new Set<string>();
  if (tree.includes(CONFIG_PATH)) out.add(CONFIG_PATH);
  if (configText !== null) {
    const s = graphSettings(configText);
    if (s.ok) {
      for (const p of graphInputPaths(tree, s.value.graph)) out.add(p);
      if (tree.includes(s.value.sprintStatusPath)) out.add(s.value.sprintStatusPath);
    }
  }
  return [...out].sort();
}

/** One Epic's Story ids that a side added or dropped. */
export type EpicStories = { readonly epic: number; readonly ids: readonly string[] };

/** What the merge result changes against `main`. */
export type GraphDelta = {
  readonly edgesAdded: readonly Edge[];
  readonly edgesRemoved: readonly Edge[];
  readonly checkpointsAdded: readonly number[];
  readonly checkpointsRemoved: readonly number[];
  readonly epicsAdded: readonly number[];
  readonly epicsRemoved: readonly number[];
  readonly storiesAdded: readonly EpicStories[];
  readonly storiesRemoved: readonly EpicStories[];
  /** Each checkpoint of the merge result with no recorded go, and the Epics depending on it directly or through others. */
  readonly holds: readonly { readonly checkpoint: number; readonly epics: readonly number[] }[];
  /** The merge result's hash. */
  readonly hash: string;
};

/** A removed Story id no other use refused: a PR in any state on `branch` refuses it. */
export type BranchCheck = { readonly id: string; readonly branch: string };

export type GraphChange =
  /** `main`'s own graph does not resolve. */
  | { readonly kind: "main-invalid"; readonly message: string }
  /** The merge result does not resolve. */
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "checked";
      readonly changed: boolean;
      readonly mainHash: string;
      readonly mergedHash: string;
      readonly delta: GraphDelta;
      readonly refusals: readonly string[];
      readonly branchChecks: readonly BranchCheck[];
    };

export type GraphChangeInput = {
  readonly main: GraphTree;
  readonly merged: GraphTree;
  /** The ids of every ledger record. */
  readonly ledgerUnits: readonly string[];
};

type Side = {
  readonly settings: GraphSettings;
  readonly graph: ResolvedGraph;
  readonly md: EpicsMd;
};

function readText(t: GraphTree, path: string): Result<string, "missing" | "unreadable"> {
  if (!t.tree.includes(path)) return err("missing", `${path}: missing`);
  const text = Object.hasOwn(t.files, path) ? t.files[path] : undefined;
  if (typeof text !== "string") return err("unreadable", `${path}: listed in the tree but its content was not read`);
  return ok(text);
}

function resolveSide(t: GraphTree): Result<Side, string> {
  const configText = readText(t, CONFIG_PATH);
  if (!configText.ok) return configText;
  const settings = graphSettings(configText.value);
  if (!settings.ok) return settings;
  const graph = resolveGraph({ tree: t.tree, files: t.files, config: settings.value.graph });
  if (!graph.ok) return graph;
  const mdText = readText(t, settings.value.graph.epics_path);
  if (!mdText.ok) return mdText;
  const md = parseEpicsMd(settings.value.graph.epics_path, mdText.value);
  if (!md.ok) return md;
  return ok({ settings: settings.value, graph: graph.value, md: md.value });
}

const edgeId = (e: Edge) => `${e.from}>${e.to}`;
const byNumber = (a: number, b: number) => a - b;

function minus<T>(a: readonly T[], b: readonly T[], id: (x: T) => string): T[] {
  const ids = new Set(b.map(id));
  return a.filter((x) => !ids.has(id(x)));
}

/** Story ids of `a` per Epic that `b` lacks (by `storyKey`). */
function storiesMinus(a: ResolvedGraph, b: ResolvedGraph): EpicStories[] {
  const out: EpicStories[] = [];
  for (const e of [...a.epics].sort((x, y) => x.number - y.number)) {
    const other = new Set((b.epics.find((x) => x.number === e.number)?.stories ?? []).map(storyKey));
    const ids = e.stories.filter((s) => !other.has(storyKey(s))).sort(compareStoryIds);
    if (ids.length > 0) out.push({ epic: e.number, ids });
  }
  return out;
}

/** Each unrecorded checkpoint of `g`, with every Epic that reaches it. */
function holds(g: ResolvedGraph): GraphDelta["holds"] {
  const deps = new Map(g.epics.map((e) => [e.number, e.depends_on]));
  const reaches = (from: number, target: number): boolean => {
    const seen = new Set<number>();
    const stack = [...(deps.get(from) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop() as number;
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(deps.get(n) ?? []));
    }
    return false;
  };
  return [...g.checkpoints]
    .sort(byNumber)
    .filter((c) => g.retroGates.epics[String(c)]?.checkpoint === undefined)
    .map((c) => ({
      checkpoint: c,
      epics: g.epics
        .map((e) => e.number)
        .filter((n) => n !== c && reaches(n, c))
        .sort(byNumber),
    }));
}

function delta(main: ResolvedGraph, merged: ResolvedGraph): GraphDelta {
  const mainEpics = main.epics.map((e) => e.number);
  const mergedEpics = merged.epics.map((e) => e.number);
  const sortEdges = (es: Edge[]) => es.sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    edgesAdded: sortEdges(minus(merged.edges, main.edges, edgeId)),
    edgesRemoved: sortEdges(minus(main.edges, merged.edges, edgeId)),
    checkpointsAdded: minus(merged.checkpoints, main.checkpoints, String).sort(byNumber),
    checkpointsRemoved: minus(main.checkpoints, merged.checkpoints, String).sort(byNumber),
    epicsAdded: minus(mergedEpics, mainEpics, String).sort(byNumber),
    epicsRemoved: minus(mainEpics, mergedEpics, String).sort(byNumber),
    storiesAdded: storiesMinus(merged, main),
    storiesRemoved: storiesMinus(main, merged),
    holds: holds(merged),
    hash: merged.hash,
  };
}

/** A status that is set and not `backlog`. */
function beyondBacklog(status: Readonly<Record<string, string>>, key: string): string | undefined {
  if (!Object.hasOwn(status, key)) return undefined;
  const s = status[key] as string;
  return s === "backlog" ? undefined : s;
}

/** The `development_status` key prefix of a Story id: `2.6a` → `2-6a-`. */
function storyKeyPrefix(id: string): string {
  return `${storyKey(id).replace(".", "-")}-`;
}

/** What the merge result changes against `main`, and what of it is refused. */
export function checkGraphChange(input: GraphChangeInput): GraphChange {
  const main = resolveSide(input.main);
  if (!main.ok) return { kind: "main-invalid", message: `main: ${main.error.message}` };
  const mainSettings = main.value.settings;
  let status = emptySprintStatus().development_status;
  if (input.main.tree.includes(mainSettings.sprintStatusPath)) {
    const text = readText(input.main, mainSettings.sprintStatusPath);
    if (!text.ok) return { kind: "main-invalid", message: `main: ${text.error.message}` };
    const parsed = parseSprintStatus(mainSettings.sprintStatusPath, text.value);
    if (!parsed.ok) return { kind: "main-invalid", message: `main: ${parsed.error.message}` };
    status = parsed.value.development_status;
  }
  const manifests = loadManifests(input.main, mainSettings.graph.manifests);
  if (!manifests.ok) return { kind: "main-invalid", message: `main: ${manifests.error.message}` };

  const merged = resolveSide(input.merged);
  if (!merged.ok) return { kind: "invalid", message: `merge result: ${merged.error.message}` };

  const m = main.value;
  const g = merged.value;
  const refusals: string[] = [];
  const branchChecks: BranchCheck[] = [];
  const units = new Set(input.ledgerUnits);
  const gates = m.graph.retroGates.epics;

  // 1. Used Epic numbers dropped.
  const mergedEpicNumbers = new Set(g.md.epics.map((e) => e.number));
  for (const e of [...m.md.epics].sort((a, b) => a.number - b.number)) {
    if (mergedEpicNumbers.has(e.number)) continue;
    const uses: string[] = [];
    const s = beyondBacklog(status, `epic-${e.number}`);
    if (s !== undefined) uses.push(`epic-${e.number} is ${s}`);
    if (Object.hasOwn(gates, String(e.number))) uses.push(`retro-gates.yaml has an entry for it`);
    const records = [...units]
      .filter((u) => u === `retro:${e.number}` || u === `checkpoint:${e.number}` || u.startsWith(`retro-item:epic-${e.number}-`))
      .sort();
    if (records.length > 0) uses.push(`ledger record${records.length > 1 ? "s" : ""} ${records.join(", ")}`);
    if (uses.length > 0) refusals.push(`Epic ${e.number} is removed, but it is used: ${uses.join("; ")}`);
  }

  // 2. Used Story ids dropped.
  const mergedStoryKeys = new Set(g.md.epics.flatMap((e) => e.stories.map((s) => storyKey(s.id))));
  const mainStories = new Map<string, { id: string; epic: number }>();
  for (const e of m.md.epics) for (const s of e.stories) mainStories.set(storyKey(s.id), { id: s.id, epic: s.epic });
  for (const x of manifests.value) if (!mainStories.has(storyKey(x.story_id))) mainStories.set(storyKey(x.story_id), { id: x.story_id, epic: x.epic });
  const storyUnits = new Set([...units].filter((u) => u.startsWith("story:")).map((u) => storyKey(u.slice("story:".length))));
  for (const [key, s] of [...mainStories].sort(([, a], [, b]) => compareStoryIds(a.id, b.id))) {
    if (mergedStoryKeys.has(key)) continue;
    const manifest = manifests.value.find((x) => storyKey(x.story_id) === key);
    const uses: string[] = [];
    if (manifest !== undefined) {
      const st = beyondBacklog(status, manifest.sprint_key);
      if (st !== undefined) uses.push(`${manifest.sprint_key} is ${st}`);
    } else {
      const prefix = storyKeyPrefix(s.id);
      for (const k of Object.keys(status).filter((k) => k.startsWith(prefix)).sort()) {
        const st = beyondBacklog(status, k);
        if (st !== undefined) uses.push(`${k} is ${st}`);
      }
    }
    if (storyUnits.has(key)) uses.push(`it has a story:${s.id} ledger record`);
    if (uses.length > 0) refusals.push(`Story ${s.id} is removed, but it is used: ${uses.join("; ")}`);
    else branchChecks.push({ id: s.id, branch: `${mainSettings.storyBranch}${manifest?.story_id ?? s.id}` });
  }

  // 3. New Stories in an Epic whose retro is recorded, or that is bootstrapped.
  const bootstrapped = new Set([...m.settings.graph.bootstrapped_epics, ...g.settings.graph.bootstrapped_epics]);
  for (const e of [...g.md.epics].sort((a, b) => a.number - b.number)) {
    const retro = gates[String(e.number)]?.retro !== undefined;
    const boot = bootstrapped.has(e.number);
    if (!retro && !boot) continue;
    for (const s of e.stories) {
      if (mainStories.has(storyKey(s.id))) continue;
      refusals.push(`Story ${s.id} is new to Epic ${e.number}, ${retro ? "whose retro is recorded" : "which is bootstrapped"}`);
    }
  }

  // 4. A checkpoint retired with no recorded go.
  for (const e of m.graph.epics) {
    if (!e.checkpoint) continue;
    const now = g.graph.epics.find((x) => x.number === e.number);
    if (now === undefined || now.checkpoint) continue;
    if (gates[String(e.number)]?.checkpoint !== undefined) continue;
    refusals.push(`Epic ${e.number}'s checkpoint is removed, but its go is not recorded`);
  }

  return {
    kind: "checked",
    changed: m.graph.hash !== g.graph.hash,
    mainHash: m.graph.hash,
    mergedHash: g.graph.hash,
    delta: delta(m.graph, g.graph),
    refusals,
    branchChecks,
  };
}

// ------------------------------------------------------------ comments

/** Agent-bound text on one line. */
function clean(text: string): string {
  return sanitizeAgentText(text).replace(/\s+/g, " ").trim();
}

const edgeText = (e: Edge) => `${e.from} → ${e.to}`;
const numbers = (ns: readonly number[]) => ns.join(", ");
const stories = (ss: readonly EpicStories[], sign: string) => ss.map((s) => `Epic ${s.epic}: ${s.ids.map((id) => `${sign}${clean(id)}`).join(", ")}`).join("; ");

/** The delta's lines against `main`, each a list item; empty sections are left out (the hash is in the comment's lead). */
export function graphDeltaLines(d: GraphDelta): string[] {
  const lines: string[] = [];
  if (d.edgesAdded.length > 0) lines.push(`- Edges added: ${d.edgesAdded.map(edgeText).join(", ")}`);
  if (d.edgesRemoved.length > 0) lines.push(`- Edges removed: ${d.edgesRemoved.map(edgeText).join(", ")}`);
  if (d.checkpointsAdded.length > 0) lines.push(`- Checkpoints added: ${numbers(d.checkpointsAdded)}`);
  if (d.checkpointsRemoved.length > 0) lines.push(`- Checkpoints removed: ${numbers(d.checkpointsRemoved)}`);
  if (d.epicsAdded.length > 0) lines.push(`- Epics added: ${numbers(d.epicsAdded)}`);
  if (d.epicsRemoved.length > 0) lines.push(`- Epics removed: ${numbers(d.epicsRemoved)}`);
  if (d.storiesAdded.length > 0) lines.push(`- Stories added: ${stories(d.storiesAdded, "+")}`);
  if (d.storiesRemoved.length > 0) lines.push(`- Stories removed: ${stories(d.storiesRemoved, "-")}`);
  for (const h of d.holds) {
    lines.push(`- Checkpoint ${h.checkpoint} (no go recorded) holds ${h.epics.length === 0 ? "no Epics" : `Epics ${numbers(h.epics)}`}`);
  }
  return lines;
}

export type GraphDeltaCommentParams = {
  readonly delta: GraphDelta;
  /** `config.maintainer`, named in backticks with no `@`. */
  readonly maintainer: string;
  /** Paths the approval gate holds, listed after the delta; default none. */
  readonly gatedPaths?: readonly string[];
  /** `main` moved after the Maintainer's approval and the hash changed: the approval is void. */
  readonly voided?: boolean;
};

/** The 🤖 comment on a PR whose merge result changes the Epic graph: the delta, then any gated paths. */
export function graphDeltaComment(subject: string, p: GraphDeltaCommentParams): string {
  const who = `\`${clean(p.maintainer).replace(/[@`]/g, "")}\``;
  const lead = p.voided === true
    ? `🤖 ${clean(subject)}: \`main\` moved after the Maintainer approved this PR, and its merge result now changes the Epic graph differently, so that approval no longer counts. It is parked awaiting approval again and was not queued. A new approval of its current head from the Maintainer (${who}) queues it.`
    : `🤖 ${clean(subject)}: this PR's merge with \`main\` changes the Epic graph, so it is parked awaiting the Maintainer's approval and was not queued. Only an approval of its current head from the Maintainer (${who}) queues it; another owner's approval does not.`;
  // The hash the Maintainer approves sits in the lead, so the cap never drops it.
  const parts = [`${lead} The merge result's graph hash is \`${clean(p.delta.hash)}\`.`, "", "The Epic graph against `main`:", "", ...graphDeltaLines(p.delta)];
  const gated = (p.gatedPaths ?? []).map(clean);
  if (gated.length > 0) parts.push("", `It also changes paths that need approval: ${gated.join(", ")}.`);
  return capText(`${parts.join("\n")}\n`, FORGE_TEXT_LIMITS.comment);
}

/** The 🤖 comment on a PR parked `blocked` `graph-invalid`, naming each refusal. */
export function graphRefusalComment(subject: string, refusals: readonly string[]): string {
  const parts = [
    `🤖 ${clean(subject)}: the Epic graph of this PR's merge with \`main\` is refused, so it is parked blocked (graph-invalid) and was not queued.`,
    "",
    ...refusals.map((r) => `- ${clean(r)}`),
    "",
    "Epic numbers and Story ids are fixed once used, a Story joins no Epic whose retro is recorded or that is bootstrapped, and only a checkpoint with a recorded go may be retired.",
  ];
  return capText(`${parts.join("\n")}\n`, FORGE_TEXT_LIMITS.comment);
}
