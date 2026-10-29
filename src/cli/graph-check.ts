import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH } from "../core/config/load-repo-config.ts";
import { DEFAULT_GRAPH_CONFIG, graphInputPaths, resolveGraph, type GraphConfig } from "../core/graph/resolve-graph.ts";
import { graphSettings } from "../core/graph/graph-gate.ts";
import { describeMissing, missingGlobs } from "../core/manifests/coverage.ts";
import { loadManifests, resolveManifestGlobs } from "../core/manifests/parse-manifest.ts";

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

/** The graph config from the working tree's `.xarabot/config.yaml`, or the defaults when it is absent. */
function graphConfig(root: string): { ok: true; config: GraphConfig } | { ok: false; message: string } {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return { ok: true, config: DEFAULT_GRAPH_CONFIG };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, message: `${CONFIG_PATH}: unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = graphSettings(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  return { ok: true, config: parsed.value.graph };
}

/**
 * `xarabot graph check`: resolves the graph of the working tree at the git
 * top level of `cwd`, prints it to stdout, and prints as warnings to stderr
 * each Story heading with no manifest and each manifest whose globs miss a
 * test or wiring glob (Epic 3 retro item 14). Returns 0, or 1 on any failure;
 * a warning never fails it.
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

  const config = graphConfig(root);
  if (!config.ok) return fail(config.message);

  const files: Record<string, string> = {};
  for (const path of graphInputPaths(tree, config.config)) {
    try {
      files[path] = readFileSync(join(root, path), "utf8");
    } catch {
      // Left out of `files`: resolveGraph reports it as unreadable.
    }
  }

  const graph = resolveGraph({ tree, files, config: config.config });
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
    console.error(`warning: Story ${s.id} (${config.config.epics_path}:${s.line}) has no manifest`);
  }
  // resolveGraph loaded these same manifests, so this load succeeds; an unclaimable one has no globs to check.
  const manifests = loadManifests({ tree, files }, config.config.manifests);
  for (const m of manifests.ok ? manifests.value : []) {
    const globs = resolveManifestGlobs(m, config.config.manifests);
    if (!globs.ok) continue;
    const missing = missingGlobs(globs.value, tree);
    if (missing.length > 0) console.error(`warning: ${m.path} (Story ${m.story_id}) misses globs its paths need: ${describeMissing(missing)}`);
  }
  return 0;
}
