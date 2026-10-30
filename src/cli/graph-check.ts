import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH } from "../core/config/load-repo-config.ts";
import { DEFAULT_GRAPH_CONFIG, graphInputPaths, resolveGraph, type GraphConfig } from "../core/graph/resolve-graph.ts";
import { graphSettings } from "../core/graph/graph-gate.ts";
import { describeMissing, missingGlobs } from "../core/manifests/coverage.ts";
import { loadManifests, resolveManifestGlobs } from "../core/manifests/parse-manifest.ts";
import { parseVersionedYaml } from "../core/schemas/common.ts";
import { ConfigSchema, type GlobCoverage } from "../core/schemas/config.ts";

const PREFIX = "xarabot graph check:";

/** Each git call's default deadline. */
export const GRAPH_GIT_TIMEOUT_MS = 60_000;

export type GraphCheckOpts = {
  /** Each git call's deadline; default 60 000 ms. */
  readonly gitTimeoutMs?: number;
  /** The git calls' environment; default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

type GitOpts = { readonly timeoutMs: number; readonly env: Readonly<Record<string, string | undefined>> };

/** One git call: never prompts, and is killed past its deadline (decision 33). */
function git(cwd: string, args: readonly string[], o: GitOpts): { ok: true; stdout: string } | { ok: false; message: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...o.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: o.timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) return { ok: false, message: `git ${args[0] ?? ""}: ran past ${o.timeoutMs} ms` };
  if (proc.exitCode !== 0) {
    const reason = proc.stderr.toString().trim() || `exit ${proc.exitCode ?? "?"}`;
    return { ok: false, message: `git ${args[0] ?? ""}: ${reason}` };
  }
  return { ok: true, stdout: proc.stdout.toString() };
}

type CheckConfig = { readonly graph: GraphConfig; readonly coverage: GlobCoverage | undefined };

/**
 * The graph config and `glob_coverage` from the working tree's
 * `.xarabot/config.yaml`, or the defaults and no coverage when it is absent.
 */
function checkConfig(root: string): { ok: true; config: CheckConfig } | { ok: false; message: string } {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return { ok: true, config: { graph: DEFAULT_GRAPH_CONFIG, coverage: undefined } };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, message: `${CONFIG_PATH}: unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = graphSettings(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  const full = parseVersionedYaml(CONFIG_PATH, text, ConfigSchema);
  if (!full.ok) return { ok: false, message: full.error.message };
  return { ok: true, config: { graph: parsed.value.graph, coverage: full.value.glob_coverage } };
}

/**
 * One warning per manifest whose globs miss a glob `coverage` needs on
 * `tree` (Epic 3 retro item 14), naming each missing glob. A manifest whose
 * globs do not resolve gets none: claiming it reports that.
 */
function coverageWarnings(
  snap: { readonly tree: readonly string[]; readonly files: Readonly<Record<string, string>> },
  graph: GraphConfig,
  coverage: GlobCoverage,
): string[] {
  const loaded = loadManifests(snap, graph.manifests);
  if (!loaded.ok) return [];
  const out: string[] = [];
  for (const m of loaded.value) {
    const globs = resolveManifestGlobs(m, graph.manifests);
    if (!globs.ok) continue;
    const missing = missingGlobs(globs.value, coverage, snap.tree);
    if (missing.length > 0) out.push(`warning: Story ${m.story_id} (${m.path}) globs miss ${describeMissing(missing)}`);
  }
  return out;
}

/**
 * `xarabot graph check`: resolves the graph of the working tree at the git
 * top level of `cwd`, prints it to stdout and Story headings with no manifest
 * as warnings to stderr, then, when the config sets `glob_coverage`, each
 * manifest whose globs miss a glob the table needs (a warning only, never a
 * failure). Returns 0, or 1 on any failure.
 */
export function graphCheck(cwd: string, opts: GraphCheckOpts = {}): number {
  const gitOpts: GitOpts = { timeoutMs: opts.gitTimeoutMs ?? GRAPH_GIT_TIMEOUT_MS, env: opts.env ?? process.env };
  const fail = (message: string): number => {
    console.error(`${PREFIX} ${message}`);
    return 1;
  };

  const top = git(cwd, ["rev-parse", "--show-toplevel"], gitOpts);
  if (!top.ok) return fail(top.message);
  const root = top.stdout.trim();

  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], gitOpts);
  if (!listed.ok) return fail(listed.message);
  const tree = [...new Set(listed.stdout.split("\0").filter((p) => p !== ""))].filter((p) => existsSync(join(root, p))).sort();

  const checked = checkConfig(root);
  if (!checked.ok) return fail(checked.message);
  const { graph: graphConfig, coverage } = checked.config;

  const files: Record<string, string> = {};
  for (const path of graphInputPaths(tree, graphConfig)) {
    try {
      files[path] = readFileSync(join(root, path), "utf8");
    } catch {
      // Left out of `files`: resolveGraph reports it as unreadable.
    }
  }

  const graph = resolveGraph({ tree, files, config: graphConfig });
  if (!graph.ok) return fail(graph.error.message);

  const out = [`graph ${graph.value.hash}`];
  for (const e of graph.value.epics) {
    let line = `${e.number} → [${e.depends_on.join(", ")}]`;
    if (e.checkpoint) line += " checkpoint";
    if (e.stories.length > 0) line += ` stories: ${e.stories.join(", ")}`;
    out.push(line);
  }
  console.log(out.join("\n"));
  for (const s of graph.value.unmanifested) {
    console.error(`warning: Story ${s.id} (${graphConfig.epics_path}:${s.line}) has no manifest`);
  }
  if (coverage !== undefined) {
    for (const w of coverageWarnings({ tree, files }, graphConfig, coverage)) console.error(w);
  }
  return 0;
}
