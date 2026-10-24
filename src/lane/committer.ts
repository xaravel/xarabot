import type { BotIdentity } from "../core/bot-identity.ts";
import type { WriteRules } from "../core/lane/write-check.ts";
import { err, type Result } from "../core/result.ts";
import { failed, gitRun, needCommit, readMarker } from "./clone.ts";
import { commitSession, type CommitOutcome } from "./commit.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The session commit behind a narrow port (AR16, FR13), so the PR step runs
 * against the fake forge, whose SHAs are not real git objects. The git
 * committer fetches `ontoSha` only when `runner.git` lacks it, measures the
 * session's change from `merge-base(start, ontoSha)` and makes the one
 * bot-authored commit through `commitSession`, whose write check sees only
 * that change, so `main`'s own changes never trip it.
 */

export type CommitRequest = {
  readonly unit: string;
  /** The fresh `main` the commit goes onto. */
  readonly ontoSha: string;
  /** The agent's message; `commitSession` sanitizes it. */
  readonly message: string;
  /** The write check's rules, built from the same fresh `main`. */
  readonly rules: WriteRules;
  readonly signal: AbortSignal;
};

export type Committer = {
  /** Never throws. */
  commit(request: CommitRequest): Promise<Result<CommitOutcome, WorkspaceErrorKind>>;
};

export type GitCommitterParams = {
  readonly gitDir: string;
  readonly clone: string;
  readonly bot: BotIdentity;
  readonly fetch: FetchShas;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createGitCommitter(params: GitCommitterParams): Committer {
  const { gitDir, clone, bot, fetch } = params;

  const commit = async (r: CommitRequest): Promise<Result<CommitOutcome, WorkspaceErrorKind>> => {
    const { unit, ontoSha, signal } = r;
    const has = await needCommit(gitDir, ontoSha, "commit: ontoSha", signal);
    if (!has.ok) {
      if (has.error.kind !== "missing-object") return has;
      let fetched: Result<void>;
      try {
        fetched = await fetch([ontoSha], signal);
      } catch (e) {
        fetched = err("fetch", message(e));
      }
      if (!fetched.ok) return err("fetch", `commit: fetching ${ontoSha}: ${fetched.error.message}`);
    }

    const marker = await readMarker(gitDir, signal);
    if (!marker.ok) return marker;
    if (marker.value === null) return err("no-session", "commit: no clone session is recorded in runner.git");
    if (marker.value.unit !== unit) return err("no-session", `commit: the clone session is for ${marker.value.unit}, not ${unit}`);
    const start = marker.value.start;

    const args = ["merge-base", start, ontoSha];
    const base = await gitRun(gitDir, args, { signal });
    if (!base.ok) return base;
    if (base.value.code === 1) return err("invalid", `commit: ${start} and ${ontoSha} have no merge base`);
    if (base.value.code !== 0) return failed(args, base.value);
    const baseSha = base.value.stdout.trim();

    return commitSession({ gitDir, clone, baseSha, ontoSha, bot, message: r.message, rules: r.rules, signal });
  };

  return {
    async commit(r) {
      try {
        return await commit(r);
      } catch (e) {
        return err("transient", `commit threw: ${message(e)}`);
      }
    },
  };
}
