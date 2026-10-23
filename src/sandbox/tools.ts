import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import type { LaunchingEnv } from "./environment.ts";

/**
 * Finds the real files a session runs: the agent CLI plus `bun`, `uv` and
 * `git`, and the directories git and uv need. Only the agent CLI is required;
 * a missing `bun`, `uv`, `git` or uv Python directory is left out.
 */

/** The helper tools a session gets besides the agent CLI. */
export const HELPER_TOOLS: readonly string[] = ["bun", "uv", "git"];

/** The xcrun shim that stands in for git on stock macOS. */
const XCRUN_GIT_SHIM = "/usr/bin/git";
const XCRUN = "/usr/bin/xcrun";
const PROBE_TIMEOUT_MS = 10_000;

export type Tool = {
  /** The name the session calls it by (its symlink in `<tempDir>/bin`). */
  readonly name: string;
  /** Its real file. */
  readonly path: string;
};

export type ResolvedTools = {
  readonly agent: Tool;
  /** The helpers found, in `HELPER_TOOLS` order, without the agent's own name. */
  readonly helpers: readonly Tool[];
  /** Real directories to read: git's exec-path and `share/git-core`, the uv Python directory. */
  readonly dirs: readonly string[];
};

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The real file `name` resolves to on `PATH` (absolute entries only), or `null`. */
export function which(name: string, path: string | undefined): string | null {
  if (name === "" || name.includes("/")) return null;
  for (const dir of (path ?? "").split(":")) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (!isExecutableFile(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** Runs a probe command and returns its trimmed stdout, or `null` on any failure. */
async function probe(argv: readonly string[], launching: LaunchingEnv): Promise<string | null> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of ["HOME", "DEVELOPER_DIR", "TMPDIR"]) {
    const v = launching[name];
    if (v !== undefined && v !== "") env[name] = v;
  }
  try {
    const child = Bun.spawn([...argv], { env, stdio: ["ignore", "pipe", "ignore"], timeout: PROBE_TIMEOUT_MS });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return null;
    const line = out.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The real git behind the xcrun shim, or the git found itself. */
async function realGit(found: string, launching: LaunchingEnv): Promise<string | null> {
  if (found !== XCRUN_GIT_SHIM) return found;
  const located = await probe([XCRUN, "--find", "git"], launching);
  if (located === null || !isAbsolute(located)) return null;
  const path = real(located);
  return path !== null && isExecutableFile(path) ? path : null;
}

/** `UV_PYTHON_INSTALL_DIR`, else `XDG_DATA_HOME/uv/python`, else `~/.local/share/uv/python`. */
export function uvPythonDir(launching: LaunchingEnv): string | null {
  const explicit = launching["UV_PYTHON_INSTALL_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const data = launching["XDG_DATA_HOME"];
  if (data !== undefined && data !== "") return join(data, "uv", "python");
  const home = launching["HOME"];
  if (home !== undefined && home !== "") return join(home, ".local", "share", "uv", "python");
  return null;
}

export async function resolveTools(launching: LaunchingEnv, agentCommand: string): Promise<Result<ResolvedTools, "refused">> {
  const pathVar = launching["PATH"];
  const agentPath = which(agentCommand, pathVar);
  if (agentPath === null) return err("refused", `sandbox: agent CLI ${JSON.stringify(agentCommand)} not found on PATH`);
  const agent: Tool = { name: agentCommand, path: agentPath };

  const helpers: Tool[] = [];
  const dirs: string[] = [];
  for (const name of HELPER_TOOLS) {
    if (name === agentCommand) continue;
    const found = which(name, pathVar);
    if (found === null) continue;
    if (name !== "git") {
      helpers.push({ name, path: found });
      continue;
    }
    const git = await realGit(found, launching);
    if (git === null) continue;
    helpers.push({ name, path: git });
  }

  const git = agentCommand === "git" ? agent.path : helpers.find((t) => t.name === "git")?.path;
  if (git !== undefined) {
    const execPath = await probe([git, "--exec-path"], launching);
    const execDir = execPath !== null && isAbsolute(execPath) ? real(execPath) : null;
    if (execDir !== null && isDirectory(execDir)) dirs.push(execDir);
    const share = real(resolve(dirname(git), "..", "share", "git-core"));
    if (share !== null && isDirectory(share)) dirs.push(share);
  }
  const uvDir = uvPythonDir(launching);
  const uvReal = uvDir !== null && isAbsolute(uvDir) ? real(uvDir) : null;
  if (uvReal !== null && isDirectory(uvReal)) dirs.push(uvReal);

  return ok({ agent, helpers, dirs: [...new Set(dirs)] });
}
