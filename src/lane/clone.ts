import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runGit, type GitIdentity, type GitRun, type RunGitOpts } from "../adapters/forge/github/runner-git.ts";
import { err, ok, type Result } from "../core/result.ts";
import { isAgentConfigPath } from "../core/review/agent-config.ts";
import { isUnitId, unitFileName, type UnitRecord } from "../core/schemas/ledger.ts";
import { removeTree } from "../sandbox/vendor-home.ts";

/**
 * The agent's clone, built from `runner.git` (AR10, AR16). The clone's `.git`
 * is written by hand from files the runner makes plus a pack made in
 * `runner.git`; no git process ever gets the clone's `.git` as its git dir,
 * and nothing here reads it. Every git call goes through the hardened
 * `runGit` with `--git-dir=<runner.git>`, the clone only ever a
 * `--work-tree` or a file destination.
 *
 * The marker ref `refs/xarabot/clone` records what the clone was built from
 * (unit, generation, branch, start SHA as its parent). It is written only
 * after a rebuild completes and deleted once the clone's work is saved as a
 * wip, so a half-built clone is never saved over a good wip.
 */

export type CloneErrorKind = "invalid" | "missing-object" | "no-session" | "git" | "transient";
export type CloneResult<T> = Result<T, CloneErrorKind>;

export const MARKER_REF = "refs/xarabot/clone";
export const WIP_REF_PREFIX = "refs/wip/";
export const HEAD_REF_PREFIX = "refs/xarabot/head/";

/** The identity of the runner's private commits (marker, wip, temp); never pushed. */
export const RUNNER_IDENTITY: GitIdentity = { name: "xarabot runner", email: "runner@xarabot.invalid" };

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A unit's id as used in file and ref names: `:` replaced by `__`. */
export function unitFileId(unit: string): string {
  return unitFileName(unit).slice(0, -".json".length);
}

export function wipRef(unit: string): string {
  return `${WIP_REF_PREFIX}${unitFileId(unit)}`;
}

export function headRef(unit: string): string {
  return `${HEAD_REF_PREFIX}${unitFileId(unit)}`;
}

// ------------------------------------------------------------------ git

type GitOpts = Omit<RunGitOpts, "credential">;

/** A git run that exited 0, its stdout; anything else is an error. */
export async function git(gitDir: string, args: readonly string[], opts: GitOpts): Promise<CloneResult<string>> {
  const r = await gitRun(gitDir, args, opts);
  if (!r.ok) return r;
  if (r.value.code !== 0) return failed(args, r.value);
  return ok(r.value.stdout);
}

/** A git run whatever its exit code; only a failure to run is an error. */
export async function gitRun(gitDir: string, args: readonly string[], opts: GitOpts): Promise<CloneResult<GitRun>> {
  const r = await runGit(gitDir, args, opts);
  if (!r.ok) return err("transient", r.error.message);
  return ok(r.value);
}

export function failed(args: readonly string[], run: GitRun): { readonly ok: false; readonly error: { readonly kind: "git"; readonly message: string } } {
  return err("git", `git ${args[0] ?? ""} exited ${run.code}: ${run.stderr.trim()}`);
}

/** True when `sha` names a commit in `gitDir`. */
async function hasCommit(gitDir: string, sha: string, signal: AbortSignal): Promise<CloneResult<boolean>> {
  const r = await gitRun(gitDir, ["cat-file", "-e", `${sha}^{commit}`], { signal });
  if (!r.ok) return r;
  return ok(r.value.code === 0);
}

/** Checks `sha` is a full hex SHA and a commit in `gitDir`. */
export async function needCommit(gitDir: string, sha: string, what: string, signal: AbortSignal): Promise<CloneResult<void>> {
  if (!SHA.test(sha)) return err("invalid", `${what}: ${JSON.stringify(sha)} is not a full hex SHA`);
  const has = await hasCommit(gitDir, sha, signal);
  if (!has.ok) return has;
  if (!has.value) return err("missing-object", `${what}: no commit ${sha} in runner.git`);
  return ok(undefined);
}

/** The id of a ref when it exists, else `null`. */
async function readRef(gitDir: string, ref: string, signal: AbortSignal): Promise<CloneResult<string | null>> {
  const r = await gitRun(gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { signal });
  if (!r.ok) return r;
  if (r.value.code !== 0) return ok(null);
  return ok(r.value.stdout.trim());
}

type CommitInfo = { readonly tree: string; readonly parents: readonly string[]; readonly message: string };

async function readCommit(gitDir: string, sha: string, signal: AbortSignal): Promise<CloneResult<CommitInfo>> {
  const r = await git(gitDir, ["cat-file", "commit", sha], { signal });
  if (!r.ok) return r;
  const text = r.value;
  const cut = text.indexOf("\n\n");
  const headers = (cut === -1 ? text : text.slice(0, cut)).split("\n");
  const message = cut === -1 ? "" : text.slice(cut + 2);
  let tree = "";
  const parents: string[] = [];
  for (const h of headers) {
    if (h.startsWith("tree ")) tree = h.slice(5);
    if (h.startsWith("parent ")) parents.push(h.slice(7));
  }
  return ok({ tree, parents, message });
}

/** `key: value` lines of a message body. */
function fields(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of message.split("\n")) {
    const m = /^([a-z]+): (.*)$/.exec(line);
    if (m !== null && m[1] !== undefined && m[2] !== undefined && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

// --------------------------------------------------------------- marker

export type Marker = {
  readonly unit: string;
  readonly generation: number;
  readonly branch: string;
  /** The SHA the clone was built at: the marker commit's parent. */
  readonly start: string;
};

/** The clone marker, or `null` when there is none (or it does not parse). */
export async function readMarker(gitDir: string, signal: AbortSignal): Promise<CloneResult<Marker | null>> {
  const id = await readRef(gitDir, MARKER_REF, signal);
  if (!id.ok || id.value === null) return id as CloneResult<null>;
  const c = await readCommit(gitDir, id.value, signal);
  if (!c.ok) return c;
  const f = fields(c.value.message);
  const unit = f.get("unit") ?? "";
  const generation = Number(f.get("generation"));
  const branch = f.get("branch") ?? "";
  const start = c.value.parents[0] ?? "";
  if (!isUnitId(unit) || !Number.isSafeInteger(generation) || generation < 1 || branch === "" || !SHA.test(start)) return ok(null);
  return ok({ unit, generation, branch, start });
}

async function writeMarker(gitDir: string, marker: Marker, tree: string, signal: AbortSignal): Promise<CloneResult<void>> {
  const message = `clone ${marker.unit}\n\nunit: ${marker.unit}\ngeneration: ${marker.generation}\nbranch: ${marker.branch}\n`;
  const made = await git(gitDir, ["commit-tree", tree, "-p", marker.start], { signal, identity: RUNNER_IDENTITY, stdin: message });
  if (!made.ok) return made;
  const set = await git(gitDir, ["update-ref", MARKER_REF, made.value.trim()], { signal });
  return set.ok ? ok(undefined) : set;
}

// -------------------------------------------------------------- snapshot

/**
 * The clone's working tree as a tree in `runner.git`: a temp index inside
 * `gitDir`, seeded from `start`, then `add -A` with work tree = clone, then
 * `write-tree`. Git skips the clone's own top-level `.git`.
 */
/** Gives the session's files u+r and folders u+rwx (not following symlinks, skipping the top-level `.git`), so `add -A` can read them. */
function unlockForSnapshot(path: string, top: boolean): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (!st.isDirectory()) {
    if ((st.mode & 0o400) === 0) chmodSync(path, (st.mode & 0o7777) | 0o400);
    return;
  }
  if ((st.mode & 0o700) !== 0o700) chmodSync(path, (st.mode & 0o7777) | 0o700);
  for (const entry of readdirSync(path)) {
    if (top && entry === ".git") continue;
    unlockForSnapshot(join(path, entry), false);
  }
}

export async function snapshotTree(gitDirIn: string, cloneIn: string, start: string, signal: AbortSignal): Promise<CloneResult<string>> {
  const gitDir = resolve(gitDirIn);
  const clone = resolve(cloneIn);
  try {
    unlockForSnapshot(clone, true);
  } catch (e) {
    return err("git", `snapshot: cannot unlock ${clone}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let tmp: string;
  try {
    tmp = mkdtempSync(join(gitDir, "xarabot-snapshot-"));
  } catch (e) {
    return err("git", `snapshot: cannot create a temp index in ${gitDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const indexFile = join(tmp, "index");
  try {
    const seeded = await git(gitDir, ["read-tree", start], { signal, indexFile });
    if (!seeded.ok) return seeded;
    const added = await git(gitDir, ["add", "-A"], { signal, indexFile, workTree: clone });
    if (!added.ok) return added;
    const tree = await git(gitDir, ["write-tree"], { signal, indexFile });
    if (!tree.ok) return tree;
    return ok(tree.value.trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- wip

export type Wip = {
  readonly sha: string;
  readonly tree: string;
  /** The SHA the wip was made on. */
  readonly parent: string;
  readonly generation: number;
};

/** The saved wip for `unit`, or `null`. */
export async function readWip(params: { readonly gitDir: string; readonly unit: string; readonly signal: AbortSignal }): Promise<CloneResult<Wip | null>> {
  const { gitDir, unit, signal } = params;
  if (!isUnitId(unit)) return err("invalid", `readWip: ${JSON.stringify(unit)} is not a unit id`);
  const id = await readRef(gitDir, wipRef(unit), signal);
  if (!id.ok || id.value === null) return id as CloneResult<null>;
  const c = await readCommit(gitDir, id.value, signal);
  if (!c.ok) return c;
  const generation = Number(fields(c.value.message).get("generation"));
  const parent = c.value.parents[0];
  if (parent === undefined || !SHA.test(parent) || !Number.isSafeInteger(generation) || generation < 1) return ok(null);
  return ok({ sha: id.value, tree: c.value.tree, parent, generation });
}

/**
 * Saves the clone's working tree as `refs/wip/<unit file id>` (parent = the
 * marker's start SHA), then deletes the marker. With no marker there is no
 * session's work to save. Wip refs live outside `refs/heads/`.
 */
export async function saveWip(params: { readonly gitDir: string; readonly clone: string; readonly signal: AbortSignal }): Promise<CloneResult<{ readonly saved: boolean }>> {
  const gitDir = resolve(params.gitDir);
  const clone = resolve(params.clone);
  const { signal } = params;
  const marker = await readMarker(gitDir, signal);
  if (!marker.ok) return marker;
  if (marker.value === null) return ok({ saved: false });
  const m = marker.value;
  let saved = false;
  let treeOf = "";
  if (existsSync(clone)) {
    const tree = await snapshotTree(gitDir, clone, m.start, signal);
    if (!tree.ok) return tree;
    const startTree = await git(gitDir, ["rev-parse", `${m.start}^{tree}`], { signal });
    if (!startTree.ok) return startTree;
    // A clean clone is no work: keep any earlier wip.
    treeOf = tree.value;
    saved = treeOf !== startTree.value.trim();
  }
  if (saved) {
    const message = `wip ${m.unit}\n\ngeneration: ${m.generation}\n`;
    const made = await git(gitDir, ["commit-tree", treeOf, "-p", m.start], { signal, identity: RUNNER_IDENTITY, stdin: message });
    if (!made.ok) return made;
    const set = await git(gitDir, ["update-ref", wipRef(m.unit), made.value.trim()], { signal });
    if (!set.ok) return set;
  }
  const dropped = await git(gitDir, ["update-ref", "-d", MARKER_REF], { signal });
  if (!dropped.ok) return dropped;
  return ok({ saved });
}

// --------------------------------------------------------------- rebuild

export type RebuildParams = {
  readonly gitDir: string;
  readonly clone: string;
  readonly unit: string;
  readonly branch: string;
  readonly sha: string;
  readonly generation: number;
  readonly resumeWip: boolean;
  readonly signal: AbortSignal;
};

export type Rebuilt = { readonly sha: string; readonly branch: string; readonly resumed: boolean };

/** True when `inner` is `outer` or below it. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fsError(what: string, e: unknown): { readonly ok: false; readonly error: { readonly kind: "git"; readonly message: string } } {
  return err("git", `${what}: ${e instanceof Error ? e.message : String(e)}`);
}

/** What `git init` probed for runner.git's file system, and its object format: what a hand-written `.git` repeats. */
export type GitDirSettings = { readonly sha256: boolean; readonly probed: readonly (readonly [string, string])[] };

/** `gitDir`'s object format and the `core.ignorecase` and `core.precomposeunicode` it recorded. */
export async function gitDirSettings(gitDir: string, signal: AbortSignal): Promise<CloneResult<GitDirSettings>> {
  const objectFormat = await git(gitDir, ["rev-parse", "--show-object-format"], { signal });
  if (!objectFormat.ok) return objectFormat;
  const sha256 = objectFormat.value.trim() === "sha256";
  // What `git init` probed for this file system, as runner.git recorded it.
  const probed: [string, string][] = [];
  for (const key of ["ignorecase", "precomposeunicode"]) {
    const got = await gitRun(gitDir, ["config", "--type=bool", "--get", `core.${key}`], { signal });
    if (!got.ok) return got;
    const v = got.value.stdout.trim();
    if (got.value.code === 0 && (v === "true" || v === "false")) probed.push([key, v]);
  }
  return ok({ sha256, probed });
}

/** Removes `dir` (unlocking it first) and makes it again, empty, mode 755. Throws on a filesystem error. */
export function freshDir(dir: string): void {
  removeTree(dir);
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { mode: 0o755 });
}

export type DotGit = {
  /** `HEAD`'s text, without its newline: `ref: refs/heads/<branch>`, or a SHA for a detached `HEAD`. */
  readonly head: string;
  /** Full ref name → SHA, each written as a loose ref file. */
  readonly refs: Readonly<Record<string, string>>;
  readonly settings: GitDirSettings;
  /** Lines added to `[core]` after the probed keys, such as `hooksPath = /dev/null`. */
  readonly core?: readonly string[];
};

/** Writes a fresh `.git` by hand at `dotGit`: its folders, refs, `HEAD` and config, no objects. Throws on a filesystem error. */
export function writeDotGit(dotGit: string, d: DotGit): void {
  for (const dir of ["refs/tags", "objects/info", "objects/pack"]) mkdirSync(join(dotGit, dir), { recursive: true });
  for (const [ref, sha] of Object.entries(d.refs)) {
    const file = join(dotGit, ...ref.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${sha}\n`);
  }
  writeFileSync(join(dotGit, "HEAD"), `${d.head}\n`);
  const { sha256, probed } = d.settings;
  let config = `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n`;
  for (const [key, v] of probed) config += `\t${key} = ${v}\n`;
  for (const line of d.core ?? []) config += `\t${line}\n`;
  if (sha256) config += "[extensions]\n\tobjectformat = sha256\n";
  writeFileSync(join(dotGit, "config"), config);
}

/** One pack of everything reachable from `tips`, made in a temp folder inside `gitDir`, then copied into `dotGit`. */
export async function copyPack(gitDir: string, dotGit: string, tips: readonly string[], what: string, signal: AbortSignal): Promise<CloneResult<void>> {
  let packDir: string;
  try {
    packDir = mkdtempSync(join(gitDir, "xarabot-pack-"));
  } catch (e) {
    return fsError(`${what}: cannot create a temp pack folder`, e);
  }
  try {
    const packed = await git(gitDir, ["pack-objects", "--quiet", "--revs", join(packDir, "pack")], { signal, stdin: tips.map((t) => `${t}\n`).join("") });
    if (!packed.ok) return packed;
    for (const f of readdirSync(packDir)) copyFileSync(join(packDir, f), join(dotGit, "objects", "pack", f));
  } catch (e) {
    return fsError(`${what}: cannot copy the pack`, e);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
  return ok(undefined);
}

/**
 * Rebuilds the clone, `.git` included, from `runner.git` at `sha` on
 * `branch`: saves any session's work as a wip, removes the clone, writes a
 * fresh `.git` by hand with a pack of everything reachable from `sha`, then
 * the working tree and index. With `resumeWip`, a wip of the same generation
 * made on `sha` becomes the working tree, showing as uncommitted changes.
 */
export async function rebuildClone(params: RebuildParams): Promise<CloneResult<Rebuilt>> {
  const { unit, branch, sha, generation, resumeWip, signal } = params;
  if (!isUnitId(unit)) return err("invalid", `rebuildClone: ${JSON.stringify(unit)} is not a unit id`);
  if (!Number.isSafeInteger(generation) || generation < 1) return err("invalid", `rebuildClone: generation ${generation} is not a positive integer`);
  if (!isAbsolute(params.clone)) return err("invalid", `rebuildClone: clone ${JSON.stringify(params.clone)} is not absolute`);
  const gitDir = resolve(params.gitDir);
  const clone = resolve(params.clone);
  if (within(gitDir, clone) || within(clone, gitDir)) {
    return err("invalid", `rebuildClone: clone ${clone} and runner.git ${gitDir} overlap`);
  }
  if (branch === "" || branch.includes("\n")) return err("invalid", `rebuildClone: ${JSON.stringify(branch)} is not a valid branch name`);
  const format = await gitRun(gitDir, ["check-ref-format", `refs/heads/${branch}`], { signal });
  if (!format.ok) return format;
  if (format.value.code !== 0) return err("invalid", `rebuildClone: ${JSON.stringify(branch)} is not a valid branch name`);
  const exists = await needCommit(gitDir, sha, "rebuildClone", signal);
  if (!exists.ok) return exists;
  const settings = await gitDirSettings(gitDir, signal);
  if (!settings.ok) return settings;
  const tree = await git(gitDir, ["rev-parse", `${sha}^{tree}`], { signal });
  if (!tree.ok) return tree;

  // 2. Save the session's work, then remove the clone.
  const saved = await saveWip({ gitDir, clone, signal });
  if (!saved.ok) return saved;
  const dotGit = join(clone, ".git");
  try {
    freshDir(clone);
    writeDotGit(dotGit, { head: `ref: refs/heads/${branch}`, refs: { [`refs/heads/${branch}`]: sha }, settings: settings.value });
  } catch (e) {
    return fsError("rebuildClone: cannot write the clone", e);
  }

  // 3. The pack: made in a temp folder inside runner.git, then copied in.
  const packed = await copyPack(gitDir, dotGit, [sha], "rebuildClone", signal);
  if (!packed.ok) return packed;

  // 4. Working tree and index.
  const indexFile = join(dotGit, "index");
  let resumed = false;
  if (resumeWip) {
    const wip = await readWip({ gitDir, unit, signal });
    if (!wip.ok) return wip;
    if (wip.value !== null && wip.value.generation === generation && wip.value.parent === sha) {
      const written = await git(gitDir, ["read-tree", "--reset", "-u", wip.value.tree], { signal, workTree: clone, indexFile });
      if (!written.ok) return written;
      // No `-u`: the work tree keeps the wip; read-tree still needs one named.
      const reset = await git(gitDir, ["read-tree", "--reset", sha], { signal, workTree: clone, indexFile });
      if (!reset.ok) return reset;
      resumed = true;
    }
  }
  if (!resumed) {
    const written = await git(gitDir, ["read-tree", "--reset", "-u", sha], { signal, workTree: clone, indexFile });
    if (!written.ok) return written;
  }

  // 5. Record the session.
  const marked = await writeMarker(gitDir, { unit, generation, branch, start: sha }, tree.value.trim(), signal);
  if (!marked.ok) return marked;
  return ok({ sha, branch, resumed });
}

// ------------------------------------------------------- review checkout

/** The branch name the review checkout's `main` ref has: the reviewer diffs `main...HEAD`. */
export const REVIEW_MAIN_REF = "refs/heads/main";

export type ReviewCheckoutParams = {
  readonly gitDir: string;
  /** The checkout folder, `<lane>/review`; never the agent's clone. */
  readonly dir: string;
  /** The reviewed SHA: the checkout's detached `HEAD`. */
  readonly head: string;
  /** `main`'s SHA: the checkout's `main`, and the source of its agent config. */
  readonly main: string;
  readonly signal: AbortSignal;
};

/** One `ls-tree -r -z` entry. */
type TreeLine = { readonly mode: string; readonly sha: string; readonly path: string };

/** Every blob, symlink and gitlink entry of `rev`'s tree, recursively. */
async function treeLines(gitDir: string, rev: string, signal: AbortSignal): Promise<CloneResult<TreeLine[]>> {
  const r = await git(gitDir, ["ls-tree", "-r", "-z", "--full-tree", rev], { signal });
  if (!r.ok) return r;
  const out: TreeLine[] = [];
  for (const line of r.value.split("\0")) {
    if (line === "") continue;
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    if (m === null) return err("git", `ls-tree: cannot read ${JSON.stringify(line)}`);
    out.push({ mode: m[1] as string, sha: m[2] as string, path: m[3] as string });
  }
  return ok(out);
}

/**
 * The tree the review checkout's working tree is written from: `head`'s,
 * with every agent config path (`isAgentConfigPath`) replaced by `main`'s version, or
 * removed when `main` has none. Made through a temp index inside `gitDir`.
 */
async function reviewTree(gitDir: string, head: string, main: string, signal: AbortSignal): Promise<CloneResult<string>> {
  const headLines = await treeLines(gitDir, head, signal);
  if (!headLines.ok) return headLines;
  const mainLines = await treeLines(gitDir, main, signal);
  if (!mainLines.ok) return mainLines;
  const drop = headLines.value.filter((l) => isAgentConfigPath(l.path));
  const take = mainLines.value.filter((l) => isAgentConfigPath(l.path));
  if (drop.length === 0 && take.length === 0) {
    const tree = await git(gitDir, ["rev-parse", `${head}^{tree}`], { signal });
    return tree.ok ? ok(tree.value.trim()) : tree;
  }
  let tmp: string;
  try {
    tmp = mkdtempSync(join(gitDir, "xarabot-review-"));
  } catch (e) {
    return fsError(`review checkout: cannot create a temp index in ${gitDir}`, e);
  }
  const indexFile = join(tmp, "index");
  try {
    const seeded = await git(gitDir, ["read-tree", head], { signal, indexFile });
    if (!seeded.ok) return seeded;
    // `--index-info` needs no work tree; a mode-0 line removes the path, and `-z` takes any path.
    // `--replace`: a restored path whose folder is a file at `head` (or the reverse) replaces that entry.
    const info = [...drop.map((l) => `0 ${"0".repeat(l.sha.length)}\t${l.path}\0`), ...take.map((l) => `${l.mode} ${l.sha}\t${l.path}\0`)].join("");
    const updated = await git(gitDir, ["update-index", "--add", "--replace", "-z", "--index-info"], { signal, indexFile, stdin: info });
    if (!updated.ok) return updated;
    const written = await git(gitDir, ["write-tree"], { signal, indexFile });
    if (!written.ok) return written;
    return ok(written.value.trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Writes the review checkout (Story 3.4, AR16, AR22) at `dir` from
 * `runner.git`: removes `dir`, then writes its `.git` by hand, as
 * `rebuildClone` does, with a detached `HEAD` at `head`, `main`'s ref at
 * `main`, `core.hooksPath = /dev/null` and one pack of everything reachable
 * from both. The working tree is `head`'s with every agent config path
 * (`isAgentConfigPath`) replaced by `main`'s version, or removed when `main` has
 * none; the index stays at `head`, so the restored paths show as
 * uncommitted changes. It reads and writes no marker ref, no wip ref and
 * nothing of the agent's clone.
 */
export async function writeReviewCheckout(params: ReviewCheckoutParams): Promise<CloneResult<{ readonly sha: string }>> {
  const { head, main, signal } = params;
  if (!isAbsolute(params.dir)) return err("invalid", `review checkout: ${JSON.stringify(params.dir)} is not absolute`);
  const gitDir = resolve(params.gitDir);
  const dir = resolve(params.dir);
  if (within(gitDir, dir) || within(dir, gitDir)) return err("invalid", `review checkout: ${dir} and runner.git ${gitDir} overlap`);
  const hasHead = await needCommit(gitDir, head, "review checkout head", signal);
  if (!hasHead.ok) return hasHead;
  const hasMain = await needCommit(gitDir, main, "review checkout main", signal);
  if (!hasMain.ok) return hasMain;
  const settings = await gitDirSettings(gitDir, signal);
  if (!settings.ok) return settings;
  const tree = await reviewTree(gitDir, head, main, signal);
  if (!tree.ok) return tree;

  const dotGit = join(dir, ".git");
  try {
    freshDir(dir);
    writeDotGit(dotGit, { head, refs: { [REVIEW_MAIN_REF]: main }, settings: settings.value, core: ["hooksPath = /dev/null"] });
  } catch (e) {
    return fsError("review checkout: cannot write it", e);
  }
  const packed = await copyPack(gitDir, dotGit, [head, main], "review checkout", signal);
  if (!packed.ok) return packed;

  // The working tree from the review tree; then the index back at `head`, with no `-u`.
  const indexFile = join(dotGit, "index");
  const written = await git(gitDir, ["read-tree", "--reset", "-u", tree.value], { signal, workTree: dir, indexFile });
  if (!written.ok) return written;
  const reset = await git(gitDir, ["read-tree", "--reset", head], { signal, workTree: dir, indexFile });
  if (!reset.ok) return reset;
  return ok({ sha: head });
}

// ------------------------------------------------------------ start SHA

export type SessionKind = "build" | "loopback" | "ci-fix";

/** The SHA a session's clone starts at: `base_sha` for a build, `head_sha` for a loopback or CI fix. */
export function sessionStartSha(kind: SessionKind, record: Pick<UnitRecord, "base_sha" | "head_sha">): Result<string, "invalid"> {
  const sha = kind === "build" ? record.base_sha : record.head_sha;
  if (sha === null) return err("invalid", `sessionStartSha: ${kind === "build" ? "base_sha" : "head_sha"} is null for a ${kind} session`);
  return ok(sha);
}
