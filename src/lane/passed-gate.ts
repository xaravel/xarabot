import { resolve } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { failed, git, gitRun } from "./clone.ts";
import { haveCommits, message, type PassedGate, type PassedGateOutcome, type PassedGateRequest } from "./session.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The passed gate (Story 3.5, FR8, AD-16): whether a PR's head is one a
 * review round passed, behind a narrow port so the steps run against the
 * fake forge. A head passes when it is the record's `passed_sha`, or it
 * walks back to `passed_sha` through a chain of clean merges with commits
 * on `main` that the runner recomputes itself in `runner.git`, one merge
 * per queue ejection (Epic 3 retro item 4). Each merge in the chain has
 * exactly two parents: one is `passed_sha` or descends from it, the next
 * link; the other is `main` or an ancestor of it; `git merge-tree
 * --write-tree` of the two is clean; and its tree is the merge's own. The
 * walk stops at `MAX_MERGES` merges.
 * Anything else is `unreviewed`, with the reason. Neither the record nor
 * the commit's author is trusted, and a status-YAML or lockfile rule is
 * never recomputed here: such a merge counts as a change, reviewed again.
 * The gate's types are `session.ts`'s, which the steps call it through
 * (`callPassedGate`).
 */

export type { PassedGate, PassedGateOutcome, PassedGateRequest } from "./session.ts";

export type GitPassedGateParams = {
  readonly gitDir: string;
  readonly fetch: FetchShas;
};

/** The most clean merges with `main` the walk goes back through; one per queue ejection. */
export const MAX_MERGES = 32;

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
    const have = await haveCommits(gitDir, fetch, "passed gate", [["headSha", headSha], ["passedSha", passedSha], ["mainSha", mainSha]], signal);
    if (!have.ok) return have;
    const unreviewed = (why: string) => ok({ kind: "unreviewed" as const, why: `the head ${headSha} is not the passed head ${passedSha}: ${why}` });

    const isAncestor = async (ancestor: string, of: string): Promise<Result<boolean, WorkspaceErrorKind>> => {
      const args = ["merge-base", "--is-ancestor", ancestor, of];
      const r = await gitRun(gitDir, args, { signal });
      if (!r.ok) return r;
      if (r.value.code === 0) return ok(true);
      if (r.value.code === 1) return ok(false);
      return failed(args, r.value);
    };

    // Walk back from the head, one clean merge with main at a time, to the passed head.
    let at = headSha;
    for (let n = 0; at !== passedSha; n += 1) {
      if (n === MAX_MERGES) return unreviewed(`it is more than ${MAX_MERGES} merges with main past the passed head`);
      // A reason says "it" for the head, and names a merge further back.
      const where = n === 0 ? "" : ` (at ${at}, ${n} merge(s) back)`;
      const off = (why: string) => unreviewed(`${why}${where}`);

      // 2. A merge commit of the passed head (or a descendant of it) and one other parent.
      const listed = await git(gitDir, ["rev-list", "--parents", "-n", "1", at], { signal });
      if (!listed.ok) return listed;
      const parents = listed.value.trim().split(/\s+/).slice(1);
      if (parents.length !== 2) return off(`it has ${parents.length} parent(s), not a merge of the passed head`);
      const [a, b] = parents as [string, string];
      let link: string;
      let other: string;
      if (a === passedSha || b === passedSha) {
        [link, other] = a === passedSha ? [a, b] : [b, a];
      } else {
        const fromA = await isAncestor(passedSha, a);
        if (!fromA.ok) return fromA;
        const fromB = await isAncestor(passedSha, b);
        if (!fromB.ok) return fromB;
        if (!fromA.value && !fromB.value) return off("neither of its parents is or descends from the passed head");
        if (fromA.value && fromB.value) {
          // Both descend from the passed head: the link is the one not on main.
          const bOnMain = await isAncestor(b, mainSha);
          if (!bOnMain.ok) return bOnMain;
          [link, other] = bOnMain.value ? [a, b] : [b, a];
        } else {
          [link, other] = fromA.value ? [a, b] : [b, a];
        }
      }

      // 3. The other parent is main or an ancestor of it.
      if (other !== mainSha) {
        const onMain = await isAncestor(other, mainSha);
        if (!onMain.ok) return onMain;
        if (!onMain.value) return off(`its other parent ${other} is not on main ${mainSha}`);
      }

      // 4. The merge, recomputed in runner.git only: clean, and the merge's own tree.
      const mergeArgs = ["merge-tree", "--write-tree", "--no-messages", link, other];
      const merged = await gitRun(gitDir, mergeArgs, { signal });
      if (!merged.ok) return merged;
      if (merged.value.code === 1) return off(`the merge of ${link} and ${other} conflicts`);
      if (merged.value.code !== 0) return failed(mergeArgs, merged.value);
      const tree = (merged.value.stdout.split("\n")[0] ?? "").trim();
      const atTree = await git(gitDir, ["rev-parse", "--verify", `${at}^{tree}`], { signal });
      if (!atTree.ok) return atTree;
      if (atTree.value.trim() !== tree) return off(`its tree differs from the clean merge of ${link} and ${other}`);
      at = link;
    }
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
