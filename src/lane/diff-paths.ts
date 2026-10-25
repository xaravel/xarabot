import { resolve } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { failed, git, gitRun, needCommit } from "./clone.ts";
import { message } from "./session.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The paths a PR changes (FR13, AR7), behind a narrow port so the merge step
 * runs against the fake forge. The git reader works in `runner.git` only: it
 * fetches a missing SHA, then diffs the merge base of head and `main` against
 * the head, as the PR's own diff does.
 */

export type DiffPathsRequest = {
  /** The PR's head. */
  readonly headSha: string;
  /** The fresh `main`. */
  readonly mainSha: string;
  readonly signal: AbortSignal;
};

/** The PR's changed paths, sorted and each once. Never throws. */
export type DiffPaths = (request: DiffPathsRequest) => Promise<Result<readonly string[], WorkspaceErrorKind>>;

export type GitDiffPathsParams = {
  readonly gitDir: string;
  readonly fetch: FetchShas;
};

export function createGitDiffPaths(params: GitDiffPathsParams): DiffPaths {
  const gitDir = resolve(params.gitDir);
  const { fetch } = params;

  const diff = async (r: DiffPathsRequest): Promise<Result<readonly string[], WorkspaceErrorKind>> => {
    const { headSha, mainSha, signal } = r;

    // 1. Both SHAs in runner.git, fetching only what is missing.
    const missing: string[] = [];
    for (const [what, sha] of [
      ["headSha", headSha],
      ["mainSha", mainSha],
    ] as const) {
      const has = await needCommit(gitDir, sha, `diff paths: ${what}`, signal);
      if (has.ok) continue;
      if (has.error.kind !== "missing-object") return has;
      if (!missing.includes(sha)) missing.push(sha);
    }
    if (missing.length > 0) {
      let fetched: Result<void>;
      try {
        fetched = await fetch(missing, signal);
      } catch (e) {
        fetched = err("fetch", message(e));
      }
      if (!fetched.ok) return err("fetch", `diff paths: fetching ${missing.join(", ")}: ${fetched.error.message}`);
      for (const sha of missing) {
        const has = await needCommit(gitDir, sha, "diff paths: after fetch", signal);
        if (!has.ok) return has;
      }
    }

    // 2. The merge base, or the empty tree when the histories never met.
    const baseArgs = ["merge-base", headSha, mainSha];
    const baseRun = await gitRun(gitDir, baseArgs, { signal });
    if (!baseRun.ok) return baseRun;
    let base: string;
    if (baseRun.value.code === 0) {
      base = baseRun.value.stdout.trim();
    } else if (baseRun.value.code === 1) {
      const empty = await git(gitDir, ["mktree"], { signal, stdin: "" });
      if (!empty.ok) return empty;
      base = empty.value.trim();
    } else {
      return failed(baseArgs, baseRun.value);
    }

    // 3. The PR's diff, by name, renames as a delete plus an add.
    const listed = await git(gitDir, ["diff", "--name-only", "-z", "--no-renames", base, headSha], { signal });
    if (!listed.ok) return listed;
    const paths = [...new Set(listed.value.split("\0").filter((p) => p !== ""))].sort();
    return ok(paths);
  };

  return async (r) => {
    try {
      return await diff(r);
    } catch (e) {
      return err("transient", `diff paths threw: ${message(e)}`);
    }
  };
}
