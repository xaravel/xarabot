import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit, type GitCredential } from "../adapters/forge/github/runner-git.ts";
import { checkRunnerVersion } from "../core/lane/runner.ts";
import { err, ok, type Result } from "../core/result.ts";
import { message } from "./session.ts";

/**
 * Installs a pinned runner version (FR1, NFR15, AR26): the commit the tag
 * `<version>` names, fetched shallow through the hardened `runGit` into a
 * staging folder, checked out, marked with `.xarabot-runner`
 * (`<version>\n<sha>\n`), stripped of `.git`, given its production
 * dependencies and renamed to `<runnerRoot>/<version>`. A version already
 * there is left alone. Any failure removes the staging folder. Never throws.
 */

export const RUNNER_MARKER = ".xarabot-runner";

export type InstallStep = "version" | "staging" | "init" | "fetch" | "checkout" | "marker" | "deps" | "rename";

/** Installs the dependencies of the checked-out runner in `dir`. */
export type InstallDeps = (dir: string, signal: AbortSignal) => Promise<Result<void>>;

export type InstallRunnerParams = {
  /** `~/.xarabot/runner`. */
  readonly runnerRoot: string;
  readonly version: string;
  /** The runner repo's git URL. */
  readonly url: string;
  /** The installation token for `url`, through the credential helper only. */
  readonly credential?: GitCredential;
  readonly signal: AbortSignal;
  /** Default `<bun> install --frozen-lockfile --production` in the folder. */
  readonly installDeps?: InstallDeps;
};

export type InstallRunnerResult = Result<{ readonly installed: boolean; readonly dir: string }, InstallStep>;

export type InstallRunner = (params: InstallRunnerParams) => Promise<InstallRunnerResult>;

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The variables `bun install` gets: enough to find its cache, nothing else. */
function depsEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const name of ["HOME", "TMPDIR", "LANG", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "XDG_CACHE_HOME"]) {
    const v = process.env[name];
    if (v !== undefined && v !== "") env[name] = v;
  }
  return env;
}

/** `bun install --frozen-lockfile --production` in `dir`, killed by its PID when `signal` aborts. */
export const bunInstallDeps: InstallDeps = async (dir, signal) => {
  if (signal.aborted) return err("deps", "bun install: deadline passed");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--production"], {
      cwd: dir,
      env: depsEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return err("deps", `bun install: cannot start: ${message(e)}`);
  }
  const pid = proc.pid;
  const onAbort = () => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (signal.aborted) return err("deps", "bun install: deadline passed");
    if (code !== 0) return err("deps", `bun install exited ${code}: ${stderr.trim().slice(0, 2000)}`);
    return ok(undefined);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

class StepError extends Error {
  constructor(
    readonly step: InstallStep,
    text: string,
  ) {
    super(text);
  }
}

export async function installRunner(params: InstallRunnerParams): Promise<InstallRunnerResult> {
  const checked = checkRunnerVersion(params.version);
  if (!checked.ok) return err("version", `install runner: ${checked.error.message}`);
  const version = checked.value;
  const dir = join(params.runnerRoot, version);
  if (existsSync(dir)) return ok({ installed: false, dir });

  const random = Math.random().toString(36).slice(2, 10);
  const staging = join(params.runnerRoot, `.staging-${version}-${process.pid}-${random}`);
  const gitDir = join(staging, ".git");
  const { signal } = params;

  const git = async (step: InstallStep, args: readonly string[], withCredential = false, workTree?: string): Promise<string> => {
    const r = await runGit(gitDir, args, {
      signal,
      ...(withCredential && params.credential !== undefined ? { credential: params.credential } : {}),
      ...(workTree !== undefined ? { workTree } : {}),
    });
    if (!r.ok) throw new StepError(step, r.error.message);
    if (r.value.code !== 0) throw new StepError(step, `git ${args[0] ?? ""} exited ${r.value.code}: ${r.value.stderr.trim()}`);
    return r.value.stdout;
  };

  try {
    try {
      mkdirSync(params.runnerRoot, { recursive: true, mode: 0o755 });
      mkdirSync(staging, { mode: 0o755 });
    } catch (e) {
      return err("staging", `install runner ${version}: cannot create ${staging}: ${message(e)}`);
    }
    await git("init", ["init", "--quiet"]);
    await git("fetch", ["fetch", "--quiet", "--depth=1", "--no-tags", params.url, `refs/tags/${version}`], true);
    const sha = (await git("checkout", ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"])).trim();
    if (!SHA_PATTERN.test(sha)) throw new StepError("checkout", `tag ${version} does not name a commit`);
    await git("checkout", ["-c", "core.bare=false", "checkout", "--quiet", "--force", "--detach", sha], false, staging);
    try {
      writeFileSync(join(staging, RUNNER_MARKER), `${version}\n${sha}\n`);
      rmSync(gitDir, { recursive: true, force: true });
    } catch (e) {
      throw new StepError("marker", message(e));
    }
    let deps: Result<void>;
    try {
      deps = await (params.installDeps ?? bunInstallDeps)(staging, signal);
    } catch (e) {
      deps = err("deps", message(e));
    }
    if (!deps.ok) throw new StepError("deps", deps.error.message);
    try {
      renameSync(staging, dir);
    } catch (e) {
      // Another installer won the race: its folder is the same tag.
      if (existsSync(dir)) {
        rmSync(staging, { recursive: true, force: true });
        return ok({ installed: false, dir });
      }
      throw new StepError("rename", message(e));
    }
    return ok({ installed: true, dir });
  } catch (e) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best effort; the error below names the step.
    }
    if (e instanceof StepError) return err(e.step, `install runner ${version}: ${e.step}: ${e.message}`);
    return err("staging", `install runner ${version}: ${message(e)}`);
  }
}
