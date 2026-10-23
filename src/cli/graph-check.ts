import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH } from "../core/config/load-repo-config.ts";
import { DEFAULT_GRAPH_CONFIG, graphInputPaths, resolveGraph, type GraphConfig } from "../core/graph/resolve-graph.ts";
import { parseVersionedYaml } from "../core/schemas/common.ts";
import { ConfigSchema } from "../core/schemas/config.ts";

const PREFIX = "xarabot graph check:";

function git(cwd: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false; message: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
  const parsed = parseVersionedYaml(CONFIG_PATH, text, ConfigSchema);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  const c = parsed.value;
  return {
    ok: true,
    config: {
      epics_path: c.epics_path,
      retro_gates_path: c.retro_gates_path,
      bootstrapped_epics: c.bootstrapped_epics,
      ...(c.manifests === undefined ? {} : { manifests: c.manifests }),
      ...(c.epic_packages === undefined ? {} : { epic_packages: c.epic_packages }),
    },
  };
}

/**
 * `xarabot graph check`: resolves the graph of the working tree at the git
 * top level of `cwd`, prints it to stdout and Story headings with no manifest
 * as warnings to stderr. Returns 0, or 1 on any failure.
 */
export function graphCheck(cwd: string): number {
  const fail = (message: string): number => {
    console.error(`${PREFIX} ${message}`);
    return 1;
  };

  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return fail(top.message);
  const root = top.stdout.trim();

  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
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
  return 0;
}
