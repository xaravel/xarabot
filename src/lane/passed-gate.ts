import { resolve } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { failed, git, gitRun, needCommit } from "./clone.ts";
import { message } from "./session.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The passed gate (Story 3.5, FR8, AD-16): whether a PR's head is one a
 * review round passed, behind a narrow port so the steps run against the
 * fake forge. A head passes when it is the record's `passed_sha`, or a
 * clean merge of `passed_sha` with a commit on `main` that the runner
 * recomputes itself in `runner.git`: the head has exactly two parents, one
 * of them `passed_sha`; the other is `main` or an ancestor of it; `git
 * merge-tree --write-tree` of the two is clean; and its tree is the head's.
 * Anything else is `unreviewed`, with the reason. Neither the record nor
 * the commit's author is trusted, and a status-YAML or lockfile rule is
 * never recomputed here: such a merge counts as a change, reviewed again.
 */

export type PassedGateRequest = {
  /** The PR's head. */
  readonly headSha: string;
  /** The record's `passed_sha`; `null` when no review round passed a head. */
  readonly passedSha: string | null;
  /** The fresh `main`. */
  readonly mainSha: string;
  readonly signal: AbortSignal;
};

export type PassedGateOutcome =
  | { readonly kind: "passed"; readonly how: "head" | "clean-merge" }
  | { readonly kind: "unreviewed"; readonly why: string };

/** Whether the head passed a review; an error when git cannot tell. Never throws. */
export type PassedGate = (request: PassedGateRequest) => Promise<Result<PassedGateOutcome, WorkspaceErrorKind>>;

export type GitPassedGateParams = {
  readonly gitDir: string;
  readonly fetch: FetchShas;
};

const NO_PASS: PassedGateOutcome = { kind: "unreviewed", why: "no review round passed a head of this PR (passed_sha is unset)" };

/** The gate without git: only a head equal to `passed_sha` passes (tests and fakes). */
export const headPassedGate: PassedGate = async (r) => {
  if (r.passedSha === null) return ok(NO_PASS);
  if (r.headSha === r.passedSha) return ok({ kind: "passed", how: "head" });
  return ok({ kind: "unreviewed", why: `the head ${r.headSha} is not the passed head ${r.passedSha}` });
};

export function createGitPassedGate(params: GitPassedGateParams): PassedGate {
  const gitDir = resolve(params.gitDir);
  const { fetch } = params;

  const check = async (r: PassedGateRequest): Promise<Result<PassedGateOutcome, WorkspaceErrorKind>> => {
    const { headSha, passedSha, mainSha, signal } = r;
    if (passedSha === null) return ok(NO_PASS);
    if (headSha === passedSha) return ok({ kind: "passed", how: "head" });

    // 1. The three SHAs in runner.git, fetching only what is missing.
    const missing: string[] = [];
    for (const [what, sha] of [
      ["headSha", headSha],
      ["passedSha", passedSha],
      ["mainSha", mainSha],
    ] as const) {
      const has = await needCommit(gitDir, sha, `passed gate: ${what}`, signal);
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
      if (!fetched.ok) return err("fetch", `passed gate: fetching ${missing.join(", ")}: ${fetched.error.message}`);
      for (const sha of missing) {
        const has = await needCommit(gitDir, sha, "passed gate: after fetch", signal);
        if (!has.ok) return has;
      }
    }
    const unreviewed = (why: string) => ok({ kind: "unreviewed" as const, why: `the head ${headSha} is not the passed head ${passedSha}: ${why}` });

    // 2. A merge commit of the passed head and one other parent.
    const listed = await git(gitDir, ["rev-list", "--parents", "-n", "1", headSha], { signal });
    if (!listed.ok) return listed;
    const parents = listed.value.trim().split(/\s+/).slice(1);
    if (parents.length !== 2) return unreviewed(`it has ${parents.length} parent(s), not a merge of the passed head`);
    if (!parents.includes(passedSha)) return unreviewed("neither of its parents is the passed head");
    const other = parents[0] === passedSha ? (parents[1] as string) : (parents[0] as string);

    // 3. The other parent is main or an ancestor of it.
    if (other !== mainSha) {
      const ancestorArgs = ["merge-base", "--is-ancestor", other, mainSha];
      const ancestor = await gitRun(gitDir, ancestorArgs, { signal });
      if (!ancestor.ok) return ancestor;
      if (ancestor.value.code === 1) return unreviewed(`its other parent ${other} is not on main ${mainSha}`);
      if (ancestor.value.code !== 0) return failed(ancestorArgs, ancestor.value);
    }

    // 4. The merge, recomputed in runner.git only: clean, and the head's own tree.
    const mergeArgs = ["merge-tree", "--write-tree", "--no-messages", passedSha, other];
    const merged = await gitRun(gitDir, mergeArgs, { signal });
    if (!merged.ok) return merged;
    if (merged.value.code === 1) return unreviewed(`the merge of ${passedSha} and ${other} conflicts`);
    if (merged.value.code !== 0) return failed(mergeArgs, merged.value);
    const tree = (merged.value.stdout.split("\n")[0] ?? "").trim();
    const headTree = await git(gitDir, ["rev-parse", "--verify", `${headSha}^{tree}`], { signal });
    if (!headTree.ok) return headTree;
    if (headTree.value.trim() !== tree) return unreviewed(`its tree differs from the clean merge of ${passedSha} and ${other}`);
    return ok({ kind: "passed", how: "clean-merge" });
  };

  return async (r) => {
    try {
      return await check(r);
    } catch (e) {
      return err("transient", `passed gate threw: ${message(e)}`);
    }
  };
}
