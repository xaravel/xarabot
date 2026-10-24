import { resolve } from "node:path";
import { isBotIdentity, type BotIdentity } from "../core/bot-identity.ts";
import { err, ok, type Result } from "../core/result.ts";
import { git, headRef, needCommit } from "./clone.ts";
import { rewriteTree } from "./merger.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The `reconcile` commit (FR2, FR13, AR10) behind a narrow port, so the
 * `reconcile` step runs against the fake forge. The git committer works in
 * `runner.git` only, with no clone and no agent: one bot-authored commit onto
 * `ontoSha` whose tree is `ontoSha`'s with the given files replaced, through a
 * temp index (the merger's `rewriteTree`), written to `headRef(unit)`.
 */

export type ReconcileCommitRequest = {
  readonly unit: string;
  /** The `main` the commit goes onto. */
  readonly ontoSha: string;
  readonly message: string;
  /** Repo path → the file's new text. */
  readonly files: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

export type ReconcileCommit = { readonly head_sha: string; readonly base_sha: string };

export type ReconcileCommitter = {
  /** Never throws. A commit that would change nothing is `invalid`. */
  commit(request: ReconcileCommitRequest): Promise<Result<ReconcileCommit, WorkspaceErrorKind>>;
};

export type GitReconcileCommitterParams = {
  readonly gitDir: string;
  readonly bot: BotIdentity;
  readonly fetch: FetchShas;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createGitReconcileCommitter(params: GitReconcileCommitterParams): ReconcileCommitter {
  const gitDir = resolve(params.gitDir);
  const { bot, fetch } = params;

  const commit = async (r: ReconcileCommitRequest): Promise<Result<ReconcileCommit, WorkspaceErrorKind>> => {
    const { unit, ontoSha, signal } = r;
    if (!isBotIdentity(bot)) return err("invalid", `reconcile commit: ${JSON.stringify(bot)} is not a bot identity`);
    if (r.message.trim() === "") return err("invalid", "reconcile commit: the message is empty");
    const paths = Object.keys(r.files).sort();
    if (paths.length === 0) return err("invalid", "reconcile commit: no files to write");

    const has = await needCommit(gitDir, ontoSha, "reconcile commit: ontoSha", signal);
    if (!has.ok) {
      if (has.error.kind !== "missing-object") return has;
      let fetched: Result<void>;
      try {
        fetched = await fetch([ontoSha], signal);
      } catch (e) {
        fetched = err("fetch", message(e));
      }
      if (!fetched.ok) return err("fetch", `reconcile commit: fetching ${ontoSha}: ${fetched.error.message}`);
      const again = await needCommit(gitDir, ontoSha, "reconcile commit: after fetch", signal);
      if (!again.ok) return again;
    }

    const base = await git(gitDir, ["rev-parse", `${ontoSha}^{tree}`], { signal });
    if (!base.ok) return base;
    const baseTree = base.value.trim();
    const tree = await rewriteTree(
      gitDir,
      baseTree,
      paths.map((path) => ({ path, text: r.files[path] as string })),
      signal,
    );
    if (!tree.ok) return tree;
    if (tree.value === baseTree) return err("invalid", `reconcile commit: the files already hold this text on ${ontoSha}`);

    const text = r.message.endsWith("\n") ? r.message : `${r.message}\n`;
    const made = await git(gitDir, ["commit-tree", tree.value, "-p", ontoSha], { signal, identity: { name: bot.name, email: bot.email }, stdin: text });
    if (!made.ok) return made;
    const head = made.value.trim();
    const set = await git(gitDir, ["update-ref", headRef(unit), head], { signal });
    if (!set.ok) return set;
    return ok({ head_sha: head, base_sha: ontoSha });
  };

  return {
    async commit(r) {
      try {
        return await commit(r);
      } catch (e) {
        return err("transient", `reconcile commit threw: ${message(e)}`);
      }
    },
  };
}
