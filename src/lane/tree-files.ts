import { resolve } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { git, needCommit } from "./clone.ts";
import { message } from "./session.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * One commit's tree listing and the texts of the files a filter picks
 * (Story 2.9), behind a narrow port so the retro step runs against the fake
 * forge. The git reader works in `runner.git` only, fetching the SHA when it
 * is missing, as the graph reader (`graph-trees.ts`) does.
 */

export type TreeFilesRequest = {
  readonly sha: string;
  /** Which listed paths to read the texts of. */
  readonly read: (path: string) => boolean;
  readonly signal: AbortSignal;
};

export type TreeFilesValue = {
  /** Every path of the commit's tree, sorted. */
  readonly tree: readonly string[];
  /** The texts of the paths `read` picked. */
  readonly files: Readonly<Record<string, string>>;
};

/** The commit's tree and the picked files' texts. Never throws. */
export type TreeFiles = (request: TreeFilesRequest) => Promise<Result<TreeFilesValue, WorkspaceErrorKind>>;

export type GitTreeFilesParams = {
  readonly gitDir: string;
  readonly fetch: FetchShas;
};

export function createGitTreeFiles(params: GitTreeFilesParams): TreeFiles {
  const gitDir = resolve(params.gitDir);
  const { fetch } = params;

  const read = async (r: TreeFilesRequest): Promise<Result<TreeFilesValue, WorkspaceErrorKind>> => {
    const { sha, signal } = r;

    // 1. The SHA in runner.git, fetched when missing.
    const has = await needCommit(gitDir, sha, "tree files", signal);
    if (!has.ok) {
      if (has.error.kind !== "missing-object") return has;
      let fetched: Result<void>;
      try {
        fetched = await fetch([sha], signal);
      } catch (e) {
        fetched = err("fetch", message(e));
      }
      if (!fetched.ok) return err("fetch", `tree files: fetching ${sha}: ${fetched.error.message}`);
      const again = await needCommit(gitDir, sha, "tree files: after fetch", signal);
      if (!again.ok) return again;
    }

    // 2. The listing, then each picked blob; every path comes from the listing, so a failed read is a git failure.
    const listed = await git(gitDir, ["ls-tree", "-r", "-z", "--name-only", sha], { signal });
    if (!listed.ok) return listed;
    const tree = [...new Set(listed.value.split("\0").filter((p) => p !== ""))].sort();
    const files: Record<string, string> = {};
    for (const path of tree) {
      if (!r.read(path)) continue;
      const text = await git(gitDir, ["cat-file", "blob", `${sha}:${path}`], { signal });
      if (!text.ok) return err("git", `tree files: cannot read ${path} in ${sha}: ${text.error.message}`);
      files[path] = text.value;
    }
    return ok({ tree, files });
  };

  return async (r) => {
    try {
      return await read(r);
    } catch (e) {
      return err("transient", `tree files threw: ${message(e)}`);
    }
  };
}
