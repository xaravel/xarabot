import { resolve } from "node:path";
import { isBotIdentity, type BotIdentity } from "../core/bot-identity.ts";
import { err, ok } from "../core/result.ts";
import { sanitizeAgentText } from "../core/sanitize.ts";
import { failed, git, gitRun, headRef, needCommit, readMarker, RUNNER_IDENTITY, snapshotTree, type CloneResult } from "./clone.ts";

/**
 * Turns a finished session's working tree into one bot-authored commit,
 * three-way merged onto `origin/main` (AR16, FR13). The change is the
 * snapshot against `baseSha`; `merge-tree` applies it onto `ontoSha`. A
 * conflict is returned, never resolved.
 */

export type CommitParams = {
  readonly gitDir: string;
  readonly clone: string;
  /** The SHA the session's change is measured against. */
  readonly baseSha: string;
  /** The SHA the commit goes onto (`origin/main`). */
  readonly ontoSha: string;
  readonly bot: BotIdentity;
  /** The agent's commit message; sanitized before use. */
  readonly message: string;
  readonly signal: AbortSignal;
};

export type CommitOutcome =
  | { readonly kind: "committed"; readonly base_sha: string; readonly head_sha: string }
  | { readonly kind: "conflict"; readonly paths: readonly string[] }
  | { readonly kind: "empty" };

const GITLINK = "160000";

/** The paths `tree` adds or changes as a gitlink against `base`. */
async function gitlinks(gitDir: string, base: string, tree: string, signal: AbortSignal): Promise<CloneResult<string[]>> {
  const r = await git(gitDir, ["diff-tree", "-r", "-z", "--no-renames", "--raw", base, tree], { signal });
  if (!r.ok) return r;
  const parts = r.value.split("\0");
  const out: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = (parts[i] as string).split(" ");
    const path = parts[i + 1] as string;
    if (meta[1] === GITLINK && !(meta[4] ?? "").startsWith("D")) out.push(path);
  }
  return ok(out);
}

export async function commitSession(params: CommitParams): Promise<CloneResult<CommitOutcome>> {
  const { baseSha, ontoSha, bot, signal } = params;
  const gitDir = resolve(params.gitDir);
  const clone = resolve(params.clone);
  if (!isBotIdentity(bot)) return err("invalid", `commitSession: ${JSON.stringify(bot)} is not a bot identity`);
  const marker = await readMarker(gitDir, signal);
  if (!marker.ok) return marker;
  if (marker.value === null) return err("no-session", "commitSession: no clone session is recorded in runner.git");
  const { unit, start } = marker.value;
  for (const [what, sha] of [
    ["baseSha", baseSha],
    ["ontoSha", ontoSha],
  ] as const) {
    const has = await needCommit(gitDir, sha, `commitSession: ${what}`, signal);
    if (!has.ok) return has;
  }
  const ancestorArgs = ["merge-base", "--is-ancestor", baseSha, start];
  const ancestor = await gitRun(gitDir, ancestorArgs, { signal });
  if (!ancestor.ok) return ancestor;
  if (ancestor.value.code === 1) return err("invalid", `commitSession: baseSha ${baseSha} is not the session's start ${start} or an ancestor of it`);
  if (ancestor.value.code !== 0) return failed(ancestorArgs, ancestor.value);
  const message = sanitizeAgentText(params.message);
  if (message.trim() === "") return err("invalid", "commitSession: the commit message is empty after sanitizing");

  const tree = await snapshotTree(gitDir, clone, start, signal);
  if (!tree.ok) return tree;
  const links = await gitlinks(gitDir, baseSha, tree.value, signal);
  if (!links.ok) return links;
  if (links.value.length > 0) {
    return err("invalid", `commitSession: the working tree adds or changes a gitlink (embedded repository): ${links.value.join(", ")}`);
  }

  const temp = await git(gitDir, ["commit-tree", tree.value, "-p", baseSha], { signal, identity: RUNNER_IDENTITY, stdin: "session snapshot\n" });
  if (!temp.ok) return temp;
  const mergeArgs = [
    "merge-tree",
    "--write-tree",
    "-z",
    "--name-only",
    "--no-messages",
    `--merge-base=${baseSha}`,
    ontoSha,
    temp.value.trim(),
  ];
  const merged = await gitRun(gitDir, mergeArgs, { signal });
  if (!merged.ok) return merged;
  const [mergedTree = "", ...rest] = merged.value.stdout.split("\0");
  if (merged.value.code === 1) {
    const paths = [...new Set(rest.filter((p) => p !== ""))].sort();
    return ok({ kind: "conflict", paths });
  }
  if (merged.value.code !== 0) return failed(mergeArgs, merged.value);

  const ontoTree = await git(gitDir, ["rev-parse", `${ontoSha}^{tree}`], { signal });
  if (!ontoTree.ok) return ontoTree;
  if (mergedTree.trim() === ontoTree.value.trim()) return ok({ kind: "empty" });

  const head = await git(gitDir, ["commit-tree", mergedTree.trim(), "-p", ontoSha], {
    signal,
    identity: { name: bot.name, email: bot.email },
    stdin: message.endsWith("\n") ? message : `${message}\n`,
  });
  if (!head.ok) return head;
  const headSha = head.value.trim();
  const set = await git(gitDir, ["update-ref", headRef(unit), headSha], { signal });
  if (!set.ok) return set;
  return ok({ kind: "committed", base_sha: ontoSha, head_sha: headSha });
}
