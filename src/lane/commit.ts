import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isBotIdentity, type BotIdentity } from "../core/bot-identity.ts";
import { checkWrite, epicContextMatch, type CoordinatorWriteRules, type WriteChange, type WriteRefusal, type WriteRules } from "../core/lane/write-check.ts";
import { err, ok } from "../core/result.ts";
import { holdsCredential, sanitizeAgentText } from "../core/sanitize.ts";
import { failed, git, gitRun, headRef, needCommit, readMarker, RUNNER_IDENTITY, snapshotTree, type CloneResult } from "./clone.ts";

/**
 * Turns a finished session's working tree into one bot-authored commit,
 * three-way merged onto `origin/main` (AR16, FR13). The change is the
 * snapshot against `baseSha`. Under builder rules, changes to Epic context
 * files and to superseded spec files are reverted to `baseSha`'s version
 * (an added one removed); then the write check (FR18, AR31), a
 * builder's or the coordinator's, runs on what is left, before any temp
 * commit; a refusal writes nothing. It refuses, under either role, every
 * added or changed blob that holds one of `secrets` or a token-shaped
 * string (`credential`, Epic 2 retro item 20). Under coordinator rules the
 * check judges the clone session's own unit, from its marker. `merge-tree`
 * applies the change onto `ontoSha`. A conflict is returned, never resolved,
 * with the session's start, onto which the same change always applies.
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
  /** Credentials the message's sanitizing redacts and the write check refuses in a committed blob; default none. */
  readonly secrets?: readonly string[];
  /** The write check's rules, from the same fresh `main`: a builder's or the coordinator's. */
  readonly rules: WriteRules | CoordinatorWriteRules;
  readonly signal: AbortSignal;
};

export type CommitOutcome =
  | { readonly kind: "committed"; readonly base_sha: string; readonly head_sha: string; readonly reverted?: readonly string[] }
  /** `start` is the clone session's start: a commit onto it never conflicts (the PR step's fallback, Story 2.11). */
  | { readonly kind: "conflict"; readonly paths: readonly string[]; readonly start: string }
  | { readonly kind: "empty"; readonly reverted?: readonly string[] }
  /** The write check refused the change: nothing is committed. */
  | { readonly kind: "refused"; readonly refusals: readonly WriteRefusal[]; readonly reverted: readonly string[] };

const GITLINK = "160000";
const REGULAR = "100644";
const SYMLINK = "120000";
const ABSENT = "000000";

/** One `diff-tree --raw` entry. */
type RawChange = {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldSha: string;
  readonly newSha: string;
  readonly status: string;
  readonly path: string;
};

/** Every path `tree` changes against `base`; a rename is a delete plus an add. */
async function rawDiff(gitDir: string, base: string, tree: string, signal: AbortSignal): Promise<CloneResult<RawChange[]>> {
  const r = await git(gitDir, ["diff-tree", "-r", "-z", "--no-renames", "--raw", base, tree], { signal });
  if (!r.ok) return r;
  const parts = r.value.split("\0");
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = (parts[i] as string).split(" ");
    out.push({ oldMode: oldMode.replace(/^:/, ""), newMode, oldSha, newSha, status, path: parts[i + 1] as string });
  }
  return ok(out);
}

/** The paths a raw diff adds or changes as a gitlink (embedded repository). */
function gitlinks(changes: readonly RawChange[]): string[] {
  return changes.filter((c) => c.newMode === GITLINK && !c.status.startsWith("D")).map((c) => c.path);
}

/** `tree` with each of `changes` set back to its old side: restored, or removed when it was added. */
async function revertPaths(gitDir: string, tree: string, changes: readonly RawChange[], signal: AbortSignal): Promise<CloneResult<string>> {
  let tmp: string;
  try {
    tmp = mkdtempSync(join(gitDir, "xarabot-revert-"));
  } catch (e) {
    return err("git", `revert: cannot create a temp index in ${gitDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const indexFile = join(tmp, "index");
  try {
    const seeded = await git(gitDir, ["read-tree", tree], { signal, indexFile });
    if (!seeded.ok) return seeded;
    const info = changes
      .map((c) => (c.oldMode === ABSENT ? `0 ${"0".repeat(c.oldSha.length)}\t${c.path}\0` : `${c.oldMode} ${c.oldSha}\t${c.path}\0`))
      .join("");
    const updated = await git(gitDir, ["update-index", "-z", "--index-info"], { signal, indexFile, stdin: info });
    if (!updated.ok) return updated;
    const written = await git(gitDir, ["write-tree"], { signal, indexFile });
    if (!written.ok) return written;
    return ok(written.value.trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Full case folding, as the write check folds: NFD, then case. */
const fold = (s: string): string => s.normalize("NFD").toUpperCase().toLowerCase();

/** A side's blob text, or `null` when the path is absent on that side. */
async function sideText(gitDir: string, mode: string, sha: string, signal: AbortSignal): Promise<CloneResult<string | null>> {
  if (mode === ABSENT) return ok(null);
  return await git(gitDir, ["cat-file", "blob", sha], { signal });
}

/**
 * The write check's input: each changed path and its new mode, with whether
 * an added or changed blob holds a credential (`secrets` or a token-shaped
 * string; Epic 2 retro item 20), an added or changed symlink's target (Epic
 * 2 retro item 18), the own manifest's texts when it is a regular file on
 * both sides and, under coordinator rules, `retro_gates_path`'s and
 * `sprint_status_path`'s texts (`null` on a side where it is absent; Story
 * 2.9, AR31).
 */
async function writeChanges(
  gitDir: string,
  rules: WriteRules | CoordinatorWriteRules,
  changes: readonly RawChange[],
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<CloneResult<WriteChange[]>> {
  const out: WriteChange[] = [];
  for (const c of changes) {
    // Every new side is read once: a deleted path has none, and a gitlink was refused before.
    const after = await sideText(gitDir, c.newMode, c.newSha, signal);
    if (!after.ok) return after;
    const credential = after.value !== null && holdsCredential(after.value, secrets) ? { credential: true } : {};
    const before = () => sideText(gitDir, c.oldMode, c.oldSha, signal);
    if (rules.role === "coordinator" && fold(c.path) === fold(rules.retroGatesPath)) {
      const b = await before();
      if (!b.ok) return b;
      out.push({ path: c.path, mode: c.newMode, retroGates: { before: b.value, after: after.value }, ...credential });
    } else if (rules.role === "coordinator" && fold(c.path) === fold(rules.sprintStatusPath)) {
      const b = await before();
      if (!b.ok) return b;
      out.push({ path: c.path, mode: c.newMode, sprintStatus: { before: b.value, after: after.value }, ...credential });
    } else if (rules.role === "builder" && c.path === rules.storyFile && c.oldMode === REGULAR && c.newMode === REGULAR) {
      const b = await before();
      if (!b.ok) return b;
      out.push({ path: c.path, mode: c.newMode, storyFile: { before: b.value ?? "", after: after.value ?? "" }, ...credential });
    } else if (c.newMode === SYMLINK) {
      out.push({ path: c.path, mode: c.newMode, linkTarget: after.value ?? "", ...credential });
    } else {
      out.push({ path: c.path, mode: c.newMode, ...credential });
    }
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
  const message = sanitizeAgentText(params.message, { secrets: params.secrets ?? [] });
  if (message.trim() === "") return err("invalid", "commitSession: the commit message is empty after sanitizing");

  const tree = await snapshotTree(gitDir, clone, start, signal);
  if (!tree.ok) return tree;
  const diff = await rawDiff(gitDir, baseSha, tree.value, signal);
  if (!diff.ok) return diff;
  const links = gitlinks(diff.value);
  if (links.length > 0) {
    return err("invalid", `commitSession: the working tree adds or changes a gitlink (embedded repository): ${links.join(", ")}`);
  }

  // Epic context files are the coordinator's, and a superseded spec stays as `main` has it:
  // a builder session's change to one is set back to `baseSha`'s version.
  const rules = params.rules;
  const contextChanges =
    rules.role === "builder" ? diff.value.filter((c) => rules.superseded.includes(c.path) || epicContextMatch(rules.epicContextPath, c.path)) : [];
  const reverted = contextChanges.map((c) => c.path);
  let squash = tree.value;
  if (contextChanges.length > 0) {
    const r = await revertPaths(gitDir, tree.value, contextChanges, signal);
    if (!r.ok) return r;
    squash = r.value;
  }
  const extra = reverted.length > 0 ? { reverted } : {};

  // The write check, on the tree that is squashed: the session's own change with the reverts applied.
  let own = diff.value;
  if (squash !== tree.value) {
    const again = await rawDiff(gitDir, baseSha, squash, signal);
    if (!again.ok) return again;
    own = again.value;
  }
  const changes = await writeChanges(gitDir, rules, own, params.secrets ?? [], signal);
  if (!changes.ok) return changes;
  // A coordinator session may change only its own unit's keys of the sprint status.
  const refusals = checkWrite(rules.role === "coordinator" ? { ...rules, unit } : rules, changes.value);
  if (refusals.length > 0) return ok({ kind: "refused", refusals, reverted });

  const temp = await git(gitDir, ["commit-tree", squash, "-p", baseSha], { signal, identity: RUNNER_IDENTITY, stdin: "session snapshot\n" });
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
    return ok({ kind: "conflict", paths, start });
  }
  if (merged.value.code !== 0) return failed(mergeArgs, merged.value);

  const ontoTree = await git(gitDir, ["rev-parse", `${ontoSha}^{tree}`], { signal });
  if (!ontoTree.ok) return ontoTree;
  if (mergedTree.trim() === ontoTree.value.trim()) return ok({ kind: "empty", ...extra });

  const head = await git(gitDir, ["commit-tree", mergedTree.trim(), "-p", ontoSha], {
    signal,
    identity: { name: bot.name, email: bot.email },
    stdin: message.endsWith("\n") ? message : `${message}\n`,
  });
  if (!head.ok) return head;
  const headSha = head.value.trim();
  const set = await git(gitDir, ["update-ref", headRef(unit), headSha], { signal });
  if (!set.ok) return set;
  return ok({ kind: "committed", base_sha: ontoSha, head_sha: headSha, ...extra });
}
