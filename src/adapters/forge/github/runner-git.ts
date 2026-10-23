import { closeSync, existsSync, mkdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { deadlinePassed, forgeErr, forgeOk, type ForgeResult } from "../../../ports/forge.ts";

/**
 * The runner's private git (AR16, AR19). `openRunnerGit` creates the lane's
 * bare `runner.git`; `runGit` is the only place the GitHub adapter spawns a
 * process. Git runs with an allowlisted environment, no system or global
 * config, hooks and other repo-configured programs switched off, and the
 * installation token handed to a `get`-only credential helper over a pipe on
 * fd 3: never through the environment, argv or a file.
 */

/** The `-c` settings every git run gets, in order. */
export const RUNNER_GIT_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.attributesFile=/dev/null",
  "diff.external=",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "push.gpgSign=false",
  "gpg.program=false",
  "protocol.file.allow=never",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "push.recurseSubmodules=no",
  "core.askPass=",
  "credential.helper=",
];

/**
 * The credential helper: answers only `get`. It drains git's request from its
 * stdin, then takes the token from the pipe on fd 3 (which every descendant of
 * the git run inherits) and prints it. The token never appears in its argv.
 */
export const CREDENTIAL_HELPER =
  "!f() { " +
  "while IFS= read -r l && test -n \"$l\"; do :; done; " +
  "test \"$1\" = get || exit 0; " +
  "exec 0<&3 3<&-; " +
  "IFS= read -r t; " +
  "test -n \"$t\" || exit 0; " +
  "printf 'username=x-access-token\\npassword=%s\\n' \"$t\"; " +
  "}; f";

export type GitIdentity = {
  readonly name: string;
  readonly email: string;
  /** A git date, for both author and committer; default now. */
  readonly date?: string;
};

export type GitCredential = {
  /** The remote URL the credential is scoped to. */
  readonly url: string;
  readonly token: string;
};

export type RunGitOpts = {
  readonly signal: AbortSignal;
  readonly credential?: GitCredential;
  readonly identity?: GitIdentity;
  /** Written to git's stdin; with none, stdin is closed. */
  readonly stdin?: string;
  /** A work tree: emits `--work-tree=<path>` right after `--git-dir`. */
  readonly workTree?: string;
  /** An index file, passed as `GIT_INDEX_FILE`. */
  readonly indexFile?: string;
};

export type GitRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** The whole environment a git run gets. */
export function runnerGitEnv(gitDir: string, identity?: GitIdentity, indexFile?: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: gitDir,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (identity !== undefined) {
    env["GIT_AUTHOR_NAME"] = identity.name;
    env["GIT_AUTHOR_EMAIL"] = identity.email;
    env["GIT_COMMITTER_NAME"] = identity.name;
    env["GIT_COMMITTER_EMAIL"] = identity.email;
    if (identity.date !== undefined) {
      env["GIT_AUTHOR_DATE"] = identity.date;
      env["GIT_COMMITTER_DATE"] = identity.date;
    }
  }
  if (indexFile !== undefined) env["GIT_INDEX_FILE"] = indexFile;
  return env;
}

/** The full argv of a git run, without the program name. */
export function runnerGitArgs(gitDir: string, args: readonly string[], credential?: GitCredential, workTree?: string): string[] {
  const out = [`--git-dir=${gitDir}`];
  if (workTree !== undefined) out.push(`--work-tree=${workTree}`);
  for (const c of RUNNER_GIT_CONFIG) out.push("-c", c);
  if (credential !== undefined) out.push("-c", `credential.${credential.url}.helper=${CREDENTIAL_HELPER}`);
  out.push(...args);
  return out;
}

/**
 * Runs `git --git-dir=<gitDir> <args>` hardened. Any exit code comes back as
 * `ok`; an abort kills the child by its PID and is `transient`.
 */
export async function runGit(gitDir: string, args: readonly string[], opts: RunGitOpts): Promise<ForgeResult<GitRun>> {
  const what = `git ${args[0] ?? ""}`.trimEnd();
  if (opts.signal.aborted) return deadlinePassed(what);
  const withPipe = opts.credential !== undefined;
  const stdin = opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin);
  let child: Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(["git", ...runnerGitArgs(gitDir, args, opts.credential, opts.workTree)], {
      env: runnerGitEnv(gitDir, opts.identity, opts.indexFile),
      stdio: withPipe ? [stdin, "pipe", "pipe", "pipe"] : [stdin, "pipe", "pipe"],
    }) as Subprocess<"ignore", "pipe", "pipe">;
  } catch (e) {
    return forgeErr("transient", `${what}: cannot start git: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (withPipe) {
    const fd = child.stdio[3];
    if (typeof fd === "number") {
      try {
        writeSync(fd, `${opts.credential?.token ?? ""}\n`);
      } catch {
        // The child already exited; its result says why.
      } finally {
        closeSync(fd);
      }
    }
  }
  const pid = child.pid;
  let onAbort = () => {};
  // Resolves on abort; a grandchild may still hold the output pipes, so the run is not awaited then.
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      resolve("aborted");
    };
  });
  opts.signal.addEventListener("abort", onAbort, { once: true });
  if (opts.signal.aborted) onAbort();
  try {
    const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    done.catch(() => {});
    const r = await Promise.race([done, aborted]);
    if (r === "aborted") return deadlinePassed(what);
    const [stdout, stderr, code] = r;
    return forgeOk({ code, stdout, stderr });
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
}

export const RUNNER_GIT_DIR = "runner.git";

/**
 * Creates `laneDir` (mode 700) and a bare `<laneDir>/runner.git` on `main`
 * when missing; returns the repo's path. Running it again changes nothing.
 */
export async function openRunnerGit(laneDir: string, opts: { readonly signal: AbortSignal }): Promise<ForgeResult<string>> {
  if (opts.signal.aborted) return deadlinePassed("openRunnerGit");
  const gitDir = join(laneDir, RUNNER_GIT_DIR);
  try {
    mkdirSync(laneDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return forgeErr("transient", `openRunnerGit: cannot create ${laneDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (existsSync(join(gitDir, "HEAD"))) return forgeOk(gitDir);
  const r = await runGit(gitDir, ["init", "--quiet", "--bare", "--initial-branch=main"], opts);
  if (!r.ok) return r;
  if (r.value.code !== 0) return forgeErr("transient", `openRunnerGit: git init failed: ${r.value.stderr.trim()}`);
  return forgeOk(gitDir);
}
