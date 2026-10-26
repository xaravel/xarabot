import { resolve } from "node:path";
import { CONFIG_PATH } from "../core/config/load-repo-config.ts";
import { graphReadPaths, type GraphTree } from "../core/graph/graph-gate.ts";
import { err, ok, type Result } from "../core/result.ts";
import { failed, git, gitRun, type CloneResult } from "./clone.ts";
import { haveCommits, message } from "./session.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The two trees the graph-change gate compares (Story 2.8, AR12), behind a
 * narrow port so the steps run against the fake forge. The git reader works
 * in `runner.git` only: it fetches a missing SHA, recomputes the PR's merge
 * with `main` (`git merge-tree --write-tree <head> <main>`), and reads from
 * `main`'s tree and the merge tree each one's listing plus the files
 * `graphReadPaths` names (its config, graph inputs and `sprint_status_path`).
 */

export type GraphTreesRequest = {
  /** The PR's head. */
  readonly headSha: string;
  /** The fresh `main`. */
  readonly mainSha: string;
  readonly signal: AbortSignal;
};

export type GraphTreesOutcome =
  | { readonly kind: "clean"; readonly main: GraphTree; readonly merged: GraphTree }
  /** The merge conflicts in `paths`. */
  | { readonly kind: "conflict"; readonly paths: readonly string[] };

/** `main`'s tree and the merge tree, or the merge's conflicts. Never throws. */
export type GraphTrees = (request: GraphTreesRequest) => Promise<Result<GraphTreesOutcome, WorkspaceErrorKind>>;

export type GitGraphTreesParams = {
  readonly gitDir: string;
  readonly fetch: FetchShas;
};

/** A blob's text at `rev:path`, or `null` when `rev` has no such blob. */
async function blobText(gitDir: string, rev: string, path: string, signal: AbortSignal): Promise<CloneResult<string | null>> {
  const r = await gitRun(gitDir, ["cat-file", "blob", `${rev}:${path}`], { signal });
  if (!r.ok) return r;
  if (r.value.code !== 0) return ok(null);
  return ok(r.value.stdout);
}

/** `rev`'s tree listing and the gate's files from it; a listed file that cannot be read is a `git` error. */
async function readTree(gitDir: string, rev: string, signal: AbortSignal): Promise<CloneResult<GraphTree>> {
  const listed = await git(gitDir, ["ls-tree", "-r", "-z", "--name-only", rev], { signal });
  if (!listed.ok) return listed;
  const tree = [...new Set(listed.value.split("\0").filter((p) => p !== ""))].sort();
  let configText: string | null = null;
  if (tree.includes(CONFIG_PATH)) {
    const c = await blobText(gitDir, rev, CONFIG_PATH, signal);
    if (!c.ok) return c;
    if (c.value === null) return err("git", `graph trees: cannot read ${CONFIG_PATH} in ${rev}`);
    configText = c.value;
  }
  const files: Record<string, string> = {};
  for (const path of graphReadPaths(tree, configText)) {
    const t = path === CONFIG_PATH ? ok(configText) : await blobText(gitDir, rev, path, signal);
    if (!t.ok) return t;
    // Every path comes from this tree's own listing: a failed read is a git failure, never an unreadable input.
    if (t.value === null) return err("git", `graph trees: cannot read ${path} in ${rev}`);
    files[path] = t.value;
  }
  return ok({ tree, files });
}

export function createGitGraphTrees(params: GitGraphTreesParams): GraphTrees {
  const gitDir = resolve(params.gitDir);
  const { fetch } = params;

  const read = async (r: GraphTreesRequest): Promise<Result<GraphTreesOutcome, WorkspaceErrorKind>> => {
    const { headSha, mainSha, signal } = r;

    // 1. Both SHAs in runner.git, fetching only what is missing.
    const have = await haveCommits(gitDir, fetch, "graph trees", [["headSha", headSha], ["mainSha", mainSha]], signal);
    if (!have.ok) return have;

    // 2. The merge result, in runner.git only.
    const mergeArgs = ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", headSha, mainSha];
    const merged = await gitRun(gitDir, mergeArgs, { signal });
    if (!merged.ok) return merged;
    if (merged.value.code !== 0 && merged.value.code !== 1) return failed(mergeArgs, merged.value);
    const [treeOut = "", ...rest] = merged.value.stdout.split("\0");
    if (merged.value.code === 1) return ok({ kind: "conflict", paths: [...new Set(rest.filter((p) => p !== ""))].sort() });
    const tree = treeOut.trim();

    // 3. Both trees' listings and the files the gate reads.
    const mainTree = await readTree(gitDir, mainSha, signal);
    if (!mainTree.ok) return mainTree;
    const mergedTree = await readTree(gitDir, tree, signal);
    if (!mergedTree.ok) return mergedTree;
    return ok({ kind: "clean", main: mainTree.value, merged: mergedTree.value });
  };

  return async (r) => {
    try {
      return await read(r);
    } catch (e) {
      return err("transient", `graph trees threw: ${message(e)}`);
    }
  };
}
