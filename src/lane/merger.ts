import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isLockfile, mergeStatusYaml } from "../core/ci/status-merge.ts";
import { isBotIdentity, type BotIdentity } from "../core/bot-identity.ts";
import { err, ok, type Result } from "../core/result.ts";
import { failed, git, gitRun, headRef, needCommit, RUNNER_IDENTITY, type CloneResult } from "./clone.ts";
import type { FetchShas, WorkspaceErrorKind } from "./workspace.ts";

/**
 * Merging `main` into a unit's PR (AR20, AD-19), behind a narrow port so the
 * CI step runs against the fake forge. The git merger works in `runner.git`
 * only: `merge-tree` finds the conflicts, status YAML is resolved with
 * `mergeStatusYaml`, a lockfile takes the given regenerated text, and what
 * no rule resolves goes to a session as a candidate commit with its
 * conflict markers kept.
 */

export type MergeRequest = {
  readonly unit: string;
  /** The PR's head. */
  readonly headSha: string;
  /** The fresh `main` merged into it. */
  readonly mainSha: string;
  /** The merge commit's message. */
  readonly message: string;
  /** The status YAML paths the status rule resolves. */
  readonly statusPaths: readonly string[];
  /** Regenerated lockfile texts, by path. */
  readonly lockfiles?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

export type MergeOutcome =
  /** `main` is an ancestor of the head. */
  | { readonly kind: "up-to-date" }
  /** `merge-tree` finds no conflict: nothing to push. */
  | { readonly kind: "clean" }
  /** Every conflict resolved: a bot commit (head, main) written to `headRef(unit)`. */
  | { readonly kind: "merged"; readonly head_sha: string; readonly resolved: readonly string[] }
  /** Only status and lockfile conflicts remain, and no lockfile texts were given. */
  | { readonly kind: "lockfile"; readonly candidate_sha: string; readonly paths: readonly string[] }
  /**
   * A conflict no rule resolves; the candidate keeps its markers in `paths`.
   * `lockfiles`: conflicted lockfiles that took `main`'s blob (no markers, the PR's changes dropped).
   */
  | { readonly kind: "needs-session"; readonly candidate_sha: string; readonly paths: readonly string[]; readonly lockfiles: readonly string[] };

export type Merger = {
  /** Never throws. */
  merge(request: MergeRequest): Promise<Result<MergeOutcome, WorkspaceErrorKind>>;
};

export type GitMergerParams = {
  readonly gitDir: string;
  readonly bot: BotIdentity;
  readonly fetch: FetchShas;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A blob's text at `rev:path`, or `null` when `rev` has no such blob. */
async function blobText(gitDir: string, rev: string, path: string, signal: AbortSignal): Promise<CloneResult<string | null>> {
  const r = await gitRun(gitDir, ["cat-file", "blob", `${rev}:${path}`], { signal });
  if (!r.ok) return r;
  if (r.value.code !== 0) return ok(null);
  return ok(r.value.stdout);
}

/** The mode and blob id of `path` in `tree`, or `null`. */
async function treeEntry(gitDir: string, tree: string, path: string, signal: AbortSignal): Promise<CloneResult<{ mode: string; sha: string } | null>> {
  const r = await git(gitDir, ["ls-tree", "-z", tree, "--", path], { signal });
  if (!r.ok) return r;
  const line = r.value.split("\0").find((l) => l !== "");
  if (line === undefined) return ok(null);
  const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(line);
  if (m === null) return err("git", `ls-tree: cannot read ${JSON.stringify(line)}`);
  return ok({ mode: m[1] as string, sha: m[2] as string });
}

type Replacement = { readonly path: string } & ({ readonly text: string } | { readonly fromTree: string });

/** `tree` with each replacement applied, through a temp index inside `gitDir`. */
async function rewriteTree(gitDir: string, tree: string, replacements: readonly Replacement[], signal: AbortSignal): Promise<CloneResult<string>> {
  if (replacements.length === 0) return ok(tree);
  let tmp: string;
  try {
    tmp = mkdtempSync(join(gitDir, "xarabot-merge-"));
  } catch (e) {
    return err("git", `merge: cannot create a temp index in ${gitDir}: ${message(e)}`);
  }
  const indexFile = join(tmp, "index");
  try {
    const seeded = await git(gitDir, ["read-tree", tree], { signal, indexFile });
    if (!seeded.ok) return seeded;
    for (const rep of replacements) {
      if (/[\n\t"\\]/.test(rep.path)) return err("invalid", `merge: cannot rewrite the path ${JSON.stringify(rep.path)}`);
      const current = await treeEntry(gitDir, tree, rep.path, signal);
      if (!current.ok) return current;
      let mode = current.value?.mode ?? "100644";
      let blob: string | null;
      if ("text" in rep) {
        const hashed = await git(gitDir, ["hash-object", "-w", "--stdin"], { signal, stdin: rep.text });
        if (!hashed.ok) return hashed;
        blob = hashed.value.trim();
      } else {
        const from = await treeEntry(gitDir, rep.fromTree, rep.path, signal);
        if (!from.ok) return from;
        blob = from.value?.sha ?? null;
        if (from.value !== null) mode = from.value.mode;
      }
      // `--index-info` needs no work tree; a mode-0 line removes the path.
      const zero = "0".repeat(blob?.length ?? current.value?.sha.length ?? 40);
      const info = blob === null ? `0 ${zero}\t${rep.path}\n` : `${mode} ${blob}\t${rep.path}\n`;
      const updated = await git(gitDir, ["update-index", "--add", "--index-info"], { signal, indexFile, stdin: info });
      if (!updated.ok) return updated;
    }
    const written = await git(gitDir, ["write-tree"], { signal, indexFile });
    if (!written.ok) return written;
    return ok(written.value.trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function createGitMerger(params: GitMergerParams): Merger {
  const gitDir = resolve(params.gitDir);
  const { bot, fetch } = params;

  const merge = async (r: MergeRequest): Promise<Result<MergeOutcome, WorkspaceErrorKind>> => {
    const { unit, headSha, mainSha, signal } = r;
    if (!isBotIdentity(bot)) return err("invalid", `merge: ${JSON.stringify(bot)} is not a bot identity`);

    // 1. Both SHAs in runner.git, fetching only what is missing.
    const missing: string[] = [];
    for (const [what, sha] of [
      ["headSha", headSha],
      ["mainSha", mainSha],
    ] as const) {
      const has = await needCommit(gitDir, sha, `merge: ${what}`, signal);
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
      if (!fetched.ok) return err("fetch", `merge: fetching ${missing.join(", ")}: ${fetched.error.message}`);
      for (const sha of missing) {
        const has = await needCommit(gitDir, sha, "merge: after fetch", signal);
        if (!has.ok) return has;
      }
    }

    // 2. Already merged?
    const ancestorArgs = ["merge-base", "--is-ancestor", mainSha, headSha];
    const ancestor = await gitRun(gitDir, ancestorArgs, { signal });
    if (!ancestor.ok) return ancestor;
    if (ancestor.value.code === 0) return ok({ kind: "up-to-date" });
    if (ancestor.value.code !== 1) return failed(ancestorArgs, ancestor.value);

    // 3. The merge, in runner.git only.
    const mergeArgs = ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", headSha, mainSha];
    const merged = await gitRun(gitDir, mergeArgs, { signal });
    if (!merged.ok) return merged;
    if (merged.value.code === 0) return ok({ kind: "clean" });
    if (merged.value.code !== 1) return failed(mergeArgs, merged.value);
    const [treeOut = "", ...rest] = merged.value.stdout.split("\0");
    const tree = treeOut.trim();
    const conflicted = [...new Set(rest.filter((p) => p !== ""))].sort();

    const baseArgs = ["merge-base", headSha, mainSha];
    const baseRun = await gitRun(gitDir, baseArgs, { signal });
    if (!baseRun.ok) return baseRun;
    const baseSha = baseRun.value.code === 0 ? baseRun.value.stdout.trim() : null;
    if (baseRun.value.code !== 0 && baseRun.value.code !== 1) return failed(baseArgs, baseRun.value);

    // 4. Resolve what the rules can.
    const replacements: Replacement[] = [];
    const resolved: string[] = [];
    const lockfiles: string[] = [];
    const unresolved: string[] = [];
    /** Lockfiles that took main's blob. */
    const fromMain: string[] = [];
    for (const path of conflicted) {
      if (r.statusPaths.includes(path)) {
        const texts: (string | null)[] = [];
        for (const rev of [baseSha, headSha, mainSha]) {
          if (rev === null) {
            texts.push(null);
            continue;
          }
          const t = await blobText(gitDir, rev, path, signal);
          if (!t.ok) return t;
          texts.push(t.value);
        }
        const [base, pr, main] = texts;
        const m = pr === null || pr === undefined || main === null || main === undefined ? null : mergeStatusYaml({ base: base ?? "", pr, main }, path);
        if (m !== null && m.ok) {
          replacements.push({ path, text: m.value });
          resolved.push(path);
        } else {
          unresolved.push(path);
        }
        continue;
      }
      if (isLockfile(path)) {
        const given = r.lockfiles?.[path];
        if (r.lockfiles !== undefined && given === undefined) {
          unresolved.push(path);
          continue;
        }
        lockfiles.push(path);
        if (given !== undefined) {
          replacements.push({ path, text: given });
          resolved.push(path);
        } else {
          replacements.push({ path, fromTree: mainSha });
          fromMain.push(path);
        }
        continue;
      }
      unresolved.push(path);
    }

    const finalTree = await rewriteTree(gitDir, tree, replacements, signal);
    if (!finalTree.ok) return finalTree;

    const write = async (identity: { name: string; email: string }, text: string): Promise<CloneResult<string>> => {
      const made = await git(gitDir, ["commit-tree", finalTree.value, "-p", headSha, "-p", mainSha], {
        signal,
        identity,
        stdin: text.endsWith("\n") ? text : `${text}\n`,
      });
      return made.ok ? ok(made.value.trim()) : made;
    };

    if (unresolved.length > 0) {
      const c = await write(RUNNER_IDENTITY, `merge candidate ${unit}\n`);
      if (!c.ok) return c;
      return ok({ kind: "needs-session", candidate_sha: c.value, paths: unresolved, lockfiles: fromMain });
    }
    if (r.lockfiles === undefined && lockfiles.length > 0) {
      const c = await write(RUNNER_IDENTITY, `merge candidate ${unit}\n`);
      if (!c.ok) return c;
      return ok({ kind: "lockfile", candidate_sha: c.value, paths: lockfiles });
    }
    if (r.message.trim() === "") return err("invalid", "merge: the merge commit message is empty");
    const head = await write({ name: bot.name, email: bot.email }, r.message);
    if (!head.ok) return head;
    const set = await git(gitDir, ["update-ref", headRef(unit), head.value], { signal });
    if (!set.ok) return set;
    return ok({ kind: "merged", head_sha: head.value, resolved });
  };

  return {
    async merge(r) {
      try {
        return await merge(r);
      } catch (e) {
        return err("transient", `merge threw: ${message(e)}`);
      }
    },
  };
}
