import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseLedger } from "../../../core/ledger/codec.ts";
import type { LedgerCommit } from "../../../core/ledger/edits.ts";
import type { PrState } from "../../../core/schemas/snapshot.ts";
import {
  deadlinePassed,
  forgeErr,
  forgeOk,
  type CallOpts,
  type Forge,
  type ForgeFailure,
  type ForgeOperation,
  type ForgePr,
  type ForgeResult,
  type ForgeSnapshot,
  type GitSha,
  type PrefetchRequest,
  type PushLease,
  rateLimited,
} from "../../../ports/forge.ts";
import type { AppCredentials } from "./credentials.ts";
import {
  formatDate,
  GITHUB_OPERATIONS,
  isSuccess,
  mapHttpError,
  request,
  type FetchLike,
  type HttpReply,
  type Operation,
  type Redirect,
} from "./http.ts";
import { runGit, type GitRun } from "./runner-git.ts";
import { createTokenSource } from "./tokens.ts";

/**
 * The GitHub `Forge` adapter (FR24, AR7, AR16, AR19, AR27, AR39). `snapshot`
 * and `ledgerSwap` work over the REST git data API; `pushBranch` runs
 * `git push --force-with-lease` from the lane's private `runner.git`; the PR
 * operations, `comment` and the CI-log prefetch use REST. `checks`, `enqueue`,
 * `dequeue` and `alert` are stubs until Story 1.10. Each call makes one
 * attempt, never throws, and returns `transient` for an already-aborted
 * signal before any request.
 */

export const DEFAULT_LEDGER_BRANCH = "xarabot/claims";
export const DEFAULT_MAIN_BRANCH = "main";
/** git's empty tree. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const LEDGER_ROOT_MESSAGE = "xarabot ledger root [skip ci]";
export const DEFAULT_GIT_URL = "https://github.com";
/** A list is read 100 entries a page, at most this many pages. */
export const MAX_PAGES = 50;
const PER_PAGE = 100;
/** Check conclusions that are not failures. */
const PASSING_CONCLUSIONS: readonly string[] = ["success", "neutral", "skipped"];
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type SnapshotPart = "ledger" | "main" | "prs";

export type GitHubForgeOptions = {
  readonly repo: { readonly owner: string; readonly name: string };
  readonly credentials: AppCredentials;
  readonly fetch?: FetchLike;
  /** Epoch milliseconds, for the JWT and token expiry; default `Date.now`. */
  readonly now?: () => number;
  readonly apiUrl?: string;
  readonly ledgerBranch?: string;
  readonly mainBranch?: string;
  /** Fires at the start of each snapshot part. */
  readonly onRead?: (part: SnapshotPart) => void;
  /** The lane's `runner.git` (from `openRunnerGit`); `pushBranch` needs it. */
  readonly runnerGit?: string;
  /** The git host; default `https://github.com`. */
  readonly gitUrl?: string;
};

type Obj = Readonly<Record<string, unknown>>;

function asObj(v: unknown): Obj | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function str(v: unknown, key: string): string | undefined {
  const value = asObj(v)?.[key];
  return typeof value === "string" ? value : undefined;
}

type TreeEntry = { readonly path: string; readonly mode: string; readonly type: string; readonly sha: string };
type Tree = { readonly entries: readonly TreeEntry[]; readonly truncated: boolean };

function parseTree(body: unknown): Tree | undefined {
  const raw = asObj(body)?.["tree"];
  if (!Array.isArray(raw)) return undefined;
  const entries: TreeEntry[] = [];
  for (const e of raw) {
    const path = str(e, "path");
    const mode = str(e, "mode");
    const type = str(e, "type");
    const sha = str(e, "sha");
    if (path === undefined || mode === undefined || type === undefined || sha === undefined) return undefined;
    entries.push({ path, mode, type, sha });
  }
  return { entries, truncated: asObj(body)?.["truncated"] === true };
}

/** Encodes each segment of a branch name for a URL path. */
function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * A file name for a check's log, as the fake forge names them: unsafe
 * characters become `-`, and `taken` (lowercased names) dedupes names that
 * differ only in case.
 */
function logFileName(check: string, taken: Set<string>): string {
  const base = check.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "check";
  let name = `${base}.log`;
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${base}-${i}.log`;
  taken.add(name.toLowerCase());
  return name;
}

/** One `git push --porcelain` ref line. */
const PORCELAIN_LINE = /^([ *+\-!=])\t([^\t]*)\t(.*)$/;

/**
 * Maps a `git push --porcelain --force-with-lease` run to a forge result.
 * Pure. The ref line for `refs/heads/<branch>` decides; with none, stderr
 * does. Messages are not redacted here.
 */
export function mapPushResult(lease: PushLease, run: GitRun): ForgeResult<{ readonly sha: GitSha }> {
  const target = `refs/heads/${lease.branch}`;
  const what = `pushBranch: ${lease.branch}`;
  for (const line of run.stdout.split("\n")) {
    const m = PORCELAIN_LINE.exec(line);
    if (m === null) continue;
    const [, flag, refs, summary] = m as unknown as [string, string, string, string];
    if (!refs.endsWith(`:${target}`)) continue;
    if (flag === "*" || flag === "+" || flag === " ") return forgeOk({ sha: lease.sha });
    if (flag === "=") {
      return lease.expected_sha === lease.sha
        ? forgeOk({ sha: lease.sha })
        : forgeErr("conflict", `${what} is already at ${lease.sha}, not ${lease.expected_sha ?? "nothing"}`);
    }
    if (flag === "!") {
      if (/stale info|fetch first|non-fast-forward/.test(summary)) return forgeErr("conflict", `${what}: ${summary}`);
      if (/remote rejected/.test(summary)) return forgeErr(/lock/i.test(summary) ? "transient" : "forbidden", `${what}: ${summary}`);
      return forgeErr("transient", `${what}: ${summary}`);
    }
    return forgeErr("transient", `${what}: unexpected ref status ${JSON.stringify(flag)}: ${summary}`);
  }
  const err = run.stderr.trim();
  const message = `${what}: git exited ${run.code}${err === "" ? "" : `: ${err}`}`;
  if (/Authentication failed|Invalid username or password|error: 401/.test(err)) return forgeErr("auth", message);
  if (/error: 403|Permission to/.test(err)) return forgeErr("forbidden", message);
  if (/not found|error: 404/i.test(err)) return forgeErr("not-found", message);
  if (/error: 429/.test(err)) return rateLimited(60, message);
  return forgeErr("transient", message);
}

export function createGitHubForge(options: GitHubForgeOptions): Forge {
  const { owner, name } = options.repo;
  const ledgerBranch = options.ledgerBranch ?? DEFAULT_LEDGER_BRANCH;
  const mainBranch = options.mainBranch ?? DEFAULT_MAIN_BRANCH;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const tokens = createTokenSource({
    credentials: options.credentials,
    repo: options.repo,
    fetch: options.fetch,
    apiUrl: options.apiUrl,
    now: options.now,
  });

  const redacted = (f: ForgeFailure): ForgeFailure => ({ ok: false, error: { ...f.error, message: tokens.redact(f.error.message) } });

  /** One call's context: tracks the latest `Date` header. */
  type Ctx = { readonly signal: AbortSignal; latest: number | null };

  /**
   * One API call with an installation token. A non-2xx reply is mapped to a
   * forge error; a 401 drops the cached token.
   */
  async function api(ctx: Ctx, op: Operation, path: string, body?: unknown): Promise<ForgeResult<HttpReply>> {
    const r = await apiReply(ctx, op, path, body);
    if (!r.ok) return r;
    if (!isSuccess(r.value.status)) return redacted(mapHttpError(op, r.value));
    return r;
  }

  /** As `api`, but any HTTP reply, 2xx or not, comes back `ok` for the caller to map. */
  async function apiReply(ctx: Ctx, op: Operation, path: string, body?: unknown, redirect?: Redirect): Promise<ForgeResult<HttpReply>> {
    const token = await tokens.get(ctx.signal);
    if (!token.ok) return redacted(token);
    const r = await request({
      op,
      path: `${repoPath}${path}`,
      token: token.value,
      signal: ctx.signal,
      fetch: options.fetch,
      apiUrl: options.apiUrl,
      body,
      redirect,
    });
    if (!r.ok) return redacted(r);
    if (r.value.date !== null) {
      const at = Date.parse(r.value.date);
      if (Number.isFinite(at) && (ctx.latest === null || at > ctx.latest)) ctx.latest = at;
    }
    if (r.value.status === 401) tokens.invalidate(token.value);
    return r;
  }

  function malformed(op: Operation, what: string): ForgeFailure {
    return forgeErr("transient", `${op.name}: malformed reply: ${what}`);
  }

  /** The SHA a branch ref points at; `not-found` when the branch is missing. */
  async function readRef(ctx: Ctx, branch: string): Promise<ForgeResult<GitSha>> {
    const op = GITHUB_OPERATIONS.getRef;
    const r = await api(ctx, op, `/git/ref/heads/${encodeBranch(branch)}`);
    if (!r.ok) return r;
    const sha = str(asObj(r.value.body)?.["object"], "sha");
    return sha === undefined ? malformed(op, "no object.sha") : forgeOk(sha);
  }

  async function commitTree(ctx: Ctx, commit: GitSha): Promise<ForgeResult<GitSha>> {
    const op = GITHUB_OPERATIONS.getCommit;
    const r = await api(ctx, op, `/git/commits/${commit}`);
    if (!r.ok) return r;
    const tree = str(asObj(r.value.body)?.["tree"], "sha");
    return tree === undefined ? malformed(op, "no tree.sha") : forgeOk(tree);
  }

  /** Every entry of a tree, recursively; a truncated tree is `transient`. */
  async function readTree(ctx: Ctx, tree: GitSha): Promise<ForgeResult<readonly TreeEntry[]>> {
    if (tree === EMPTY_TREE) return forgeOk([]);
    const op = GITHUB_OPERATIONS.getTree;
    const r = await api(ctx, op, `/git/trees/${tree}?recursive=1`);
    if (!r.ok) return r;
    const parsed = parseTree(r.value.body);
    if (parsed === undefined) return malformed(op, "no tree");
    if (parsed.truncated) return forgeErr("transient", `${op.name}: tree ${tree} is truncated`);
    return forgeOk(parsed.entries);
  }

  async function readBlob(ctx: Ctx, sha: GitSha): Promise<ForgeResult<string>> {
    const op = GITHUB_OPERATIONS.getBlob;
    const r = await api(ctx, op, `/git/blobs/${sha}`);
    if (!r.ok) return r;
    const content = str(r.value.body, "content");
    const encoding = str(r.value.body, "encoding");
    if (content === undefined) return malformed(op, "no content");
    if (encoding === "utf-8") return forgeOk(content);
    if (encoding !== "base64") return malformed(op, `encoding ${encoding ?? "missing"}`);
    return forgeOk(new TextDecoder().decode(Buffer.from(content, "base64")));
  }

  /** Reads the blobs of `entries` in parallel, keyed by path. */
  async function readBlobs(ctx: Ctx, entries: readonly TreeEntry[]): Promise<ForgeResult<Record<string, string>>> {
    const results = await Promise.all(entries.map((e) => readBlob(ctx, e.sha)));
    const files: Record<string, string> = {};
    for (const [i, r] of results.entries()) {
      if (!r.ok) return r;
      files[(entries[i] as TreeEntry).path] = r.value;
    }
    return forgeOk(files);
  }

  /** Creates the ledger branch at an empty root commit; a racing creator is `conflict`. */
  async function createLedger(ctx: Ctx): Promise<ForgeResult<GitSha>> {
    const commitOp = GITHUB_OPERATIONS.createCommit;
    const commit = await api(ctx, commitOp, "/git/commits", { message: LEDGER_ROOT_MESSAGE, tree: EMPTY_TREE, parents: [] });
    if (!commit.ok) return commit;
    const sha = str(commit.value.body, "sha");
    if (sha === undefined) return malformed(commitOp, "no sha");
    const ref = await api(ctx, GITHUB_OPERATIONS.createRef, "/git/refs", { ref: `refs/heads/${ledgerBranch}`, sha });
    if (!ref.ok) return ref;
    return forgeOk(sha);
  }

  async function readLedger(ctx: Ctx): Promise<ForgeResult<ForgeSnapshot["ledger"]>> {
    const tip = await readRef(ctx, ledgerBranch);
    if (!tip.ok && tip.error.kind === "not-found") {
      const created = await createLedger(ctx);
      if (!created.ok) return created;
      return forgeOk({ tip: created.value, files: {} });
    }
    if (!tip.ok) return tip;
    const tree = await commitTree(ctx, tip.value);
    if (!tree.ok) return tree;
    const entries = await readTree(ctx, tree.value);
    if (!entries.ok) return entries;
    const files = await readBlobs(
      ctx,
      entries.value.filter((e) => e.type === "blob"),
    );
    if (!files.ok) return files;
    return forgeOk({ tip: tip.value, files: files.value });
  }

  async function readMain(ctx: Ctx, read: (path: string) => boolean): Promise<ForgeResult<ForgeSnapshot["main"]>> {
    const sha = await readRef(ctx, mainBranch);
    if (!sha.ok) return sha;
    const tree = await commitTree(ctx, sha.value);
    if (!tree.ok) return tree;
    const entries = await readTree(ctx, tree.value);
    if (!entries.ok) return entries;
    const blobs = entries.value.filter((e) => e.type === "blob").sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const blobShas: Record<string, string> = {};
    for (const e of blobs) blobShas[e.path] = e.sha;
    const files = await readBlobs(
      ctx,
      blobs.filter((e) => read(e.path)),
    );
    if (!files.ok) return files;
    return forgeOk({ sha: sha.value, tree: blobs.map((e) => e.path), files: files.value, blob_shas: blobShas });
  }

  async function readPrs(ctx: Ctx, ledgerFiles: Readonly<Record<string, string>>): Promise<ForgeResult<ForgeSnapshot["prs"]>> {
    const parsed = parseLedger(ledgerFiles);
    if (!parsed.ok) return forgeOk({});
    const wanted = [...parsed.value.units].flatMap(([unit, record]) => (record.pr === null ? [] : [{ unit, pr: record.pr }]));
    const op = GITHUB_OPERATIONS.getPull;
    const results = await Promise.all(wanted.map((w) => api(ctx, op, `/pulls/${w.pr}`)));
    const states: Record<string, PrState> = {};
    for (const [i, r] of results.entries()) {
      const { unit, pr } = wanted[i] as { unit: string; pr: number };
      if (!r.ok) {
        // A PR that no longer exists has no state, as in the fake forge.
        if (r.error.kind === "not-found") continue;
        return r;
      }
      const body = asObj(r.value.body);
      const state = body?.["state"];
      const head = str(body?.["head"], "sha");
      if ((state !== "open" && state !== "closed") || head === undefined) return malformed(op, `PR #${pr}`);
      const merged = body?.["merged"] === true || typeof body?.["merged_at"] === "string";
      states[unit] = { number: pr, state: merged ? "merged" : state, head_sha: head };
    }
    return forgeOk(states);
  }

  /** Runs `body` unless the signal is already aborted; turns a throw into `transient`. */
  async function guarded<T>(operation: ForgeOperation, opts: CallOpts, body: (ctx: Ctx) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> {
    if (opts.signal.aborted) return deadlinePassed(operation);
    try {
      return await body({ signal: opts.signal, latest: null });
    } catch (e) {
      if (opts.signal.aborted) return deadlinePassed(operation);
      return forgeErr("transient", tokens.redact(`${operation}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  async function snapshot(opts: Parameters<Forge["snapshot"]>[0]): Promise<ForgeResult<ForgeSnapshot>> {
    const read = opts.read ?? (() => false);
    return guarded("snapshot", opts, async (ctx) => {
      options.onRead?.("ledger");
      const ledger = await readLedger(ctx);
      if (!ledger.ok) return ledger;
      options.onRead?.("main");
      const main = await readMain(ctx, read);
      if (!main.ok) return main;
      options.onRead?.("prs");
      const prs = await readPrs(ctx, ledger.value.files);
      if (!prs.ok) return prs;
      if (ctx.latest === null) return forgeErr("transient", "snapshot: GitHub sent no Date header");
      return forgeOk({ now: formatDate(ctx.latest), ledger: ledger.value, main: main.value, prs: prs.value });
    });
  }

  async function ledgerSwap(oldSha: GitSha, commit: LedgerCommit, opts: CallOpts): Promise<ForgeResult<{ readonly tip: GitSha }>> {
    return guarded("ledgerSwap", opts, async (ctx) => {
      const tip = await readRef(ctx, ledgerBranch);
      if (!tip.ok) {
        return tip.error.kind === "not-found" ? forgeErr("conflict", `ledgerSwap: ${ledgerBranch} is missing, not at ${oldSha}`) : tip;
      }
      if (tip.value !== oldSha) return forgeErr("conflict", `ledgerSwap: ${ledgerBranch} is at ${tip.value}, not ${oldSha}`);
      const oldTree = await commitTree(ctx, oldSha);
      if (!oldTree.ok) return oldTree;
      const entries = await readTree(ctx, oldTree.value);
      if (!entries.ok) return entries;
      const existing = new Map(entries.value.filter((e) => e.type === "blob").map((e) => [e.path, e]));

      const writes = Object.entries(commit.writes);
      const blobOp = GITHUB_OPERATIONS.createBlob;
      const blobs = await Promise.all(writes.map(([, text]) => api(ctx, blobOp, "/git/blobs", { content: text, encoding: "utf-8" })));
      const items: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
      for (const [i, r] of blobs.entries()) {
        if (!r.ok) return r;
        const sha = str(r.value.body, "sha");
        if (sha === undefined) return malformed(blobOp, "no sha");
        const path = (writes[i] as [string, string])[0];
        items.push({ path, mode: existing.get(path)?.mode ?? "100644", type: "blob", sha });
      }
      for (const path of commit.deletes) {
        const entry = existing.get(path);
        if (entry !== undefined && !(path in commit.writes)) items.push({ path, mode: entry.mode, type: "blob", sha: null });
      }

      let newTree = oldTree.value;
      if (items.length > 0) {
        const treeOp = GITHUB_OPERATIONS.createTree;
        const body = oldTree.value === EMPTY_TREE ? { tree: items } : { base_tree: oldTree.value, tree: items };
        const tree = await api(ctx, treeOp, "/git/trees", body);
        if (!tree.ok) return tree;
        const sha = str(tree.value.body, "sha");
        if (sha === undefined) return malformed(treeOp, "no sha");
        newTree = sha;
      }

      const commitOp = GITHUB_OPERATIONS.createCommit;
      const created = await api(ctx, commitOp, "/git/commits", { message: commit.message, tree: newTree, parents: [oldSha] });
      if (!created.ok) return created;
      const sha = str(created.value.body, "sha");
      if (sha === undefined) return malformed(commitOp, "no sha");

      const moved = await api(ctx, GITHUB_OPERATIONS.updateRef, `/git/refs/heads/${encodeBranch(ledgerBranch)}`, { sha, force: false });
      if (!moved.ok) return moved;
      return forgeOk({ tip: sha });
    });
  }

  // ------------------------------------------------------------ pushBranch

  const repoUrl = `${(options.gitUrl ?? DEFAULT_GIT_URL).replace(/\/+$/, "")}/${owner}/${name}.git`;

  /** A git run whose failure to run at all is already a forge error. */
  async function git(ctx: Ctx, gitDir: string, args: readonly string[], token?: string): Promise<ForgeResult<GitRun>> {
    const r = await runGit(gitDir, args, { signal: ctx.signal, credential: token === undefined ? undefined : { url: repoUrl, token } });
    return r.ok ? r : redacted(r);
  }

  async function pushBranch(lease: PushLease, opts: CallOpts): Promise<ForgeResult<{ readonly sha: GitSha }>> {
    return guarded("pushBranch", opts, async (ctx) => {
      const gitDir = options.runnerGit;
      if (gitDir === undefined) return forgeErr("forbidden", "pushBranch: no runner.git configured");
      const { branch, sha, expected_sha: expected } = lease;
      if (branch === mainBranch || branch === ledgerBranch) return forgeErr("forbidden", `pushBranch: ${branch} is reserved`);
      if (!SHA_PATTERN.test(sha)) return forgeErr("not-found", `pushBranch: ${JSON.stringify(sha)} is not a commit SHA`);
      if (expected !== null && !SHA_PATTERN.test(expected)) {
        return forgeErr("not-found", `pushBranch: ${JSON.stringify(expected)} is not a commit SHA`);
      }
      const format = await git(ctx, gitDir, ["check-ref-format", `refs/heads/${branch}`]);
      if (!format.ok) return format;
      if (format.value.code !== 0) return forgeErr("forbidden", `pushBranch: ${JSON.stringify(branch)} is not a valid branch name`);
      const exists = await git(ctx, gitDir, ["cat-file", "-e", `${sha}^{commit}`]);
      if (!exists.ok) return exists;
      if (exists.value.code !== 0) return forgeErr("not-found", `pushBranch: no commit ${sha} in runner.git`);
      const token = await tokens.get(ctx.signal);
      if (!token.ok) return redacted(token);
      const ref = `refs/heads/${branch}`;
      const pushed = await git(ctx, gitDir, ["push", "--porcelain", `--force-with-lease=${ref}:${expected ?? ""}`, repoUrl, `${sha}:${ref}`], token.value);
      if (!pushed.ok) return pushed;
      const mapped = mapPushResult(lease, pushed.value);
      if (!mapped.ok && mapped.error.kind === "auth") tokens.invalidate(token.value);
      return mapped.ok ? mapped : redacted(mapped);
    });
  }

  // ------------------------------------------------------------ PRs

  /** A REST pull as a `ForgePr`; `undefined` when malformed. */
  function toPr(body: unknown): ForgePr | undefined {
    const b = asObj(body);
    const number = b?.["number"];
    const state = b?.["state"];
    const branch = str(b?.["head"], "ref");
    const head = str(b?.["head"], "sha");
    const base = str(b?.["base"], "ref");
    const title = b?.["title"];
    const text = b?.["body"] ?? "";
    if (typeof number !== "number" || (state !== "open" && state !== "closed") || branch === undefined || head === undefined || base === undefined) {
      return undefined;
    }
    if (typeof title !== "string" || typeof text !== "string") return undefined;
    const merged = b?.["merged"] === true || typeof b?.["merged_at"] === "string";
    return { number, branch, base, state: merged ? "merged" : state, head_sha: head, title, body: text };
  }

  function prResult(op: Operation, body: unknown): ForgeResult<ForgePr> {
    const pr = toPr(body);
    return pr === undefined ? malformed(op, "not a pull request") : forgeOk(pr);
  }

  /** `GET /pulls/{n}`: a 404 is `not-found`. */
  async function getPr(ctx: Ctx, pr: number): Promise<ForgeResult<ForgePr>> {
    const op = GITHUB_OPERATIONS.getPull;
    const r = await api(ctx, op, `/pulls/${pr}`);
    return r.ok ? prResult(op, r.value.body) : r;
  }

  /** The `errors[]` of a 422 body. */
  function validationErrors(body: unknown): Obj[] {
    const errors = asObj(body)?.["errors"];
    return Array.isArray(errors) ? errors.flatMap((e) => (asObj(e) === undefined ? [] : [asObj(e) as Obj])) : [];
  }

  async function openPr(req: Parameters<Forge["openPr"]>[0], opts: CallOpts): Promise<ForgeResult<ForgePr>> {
    return guarded("openPr", opts, async (ctx) => {
      const op = GITHUB_OPERATIONS.createPull;
      const r = await apiReply(ctx, op, "/pulls", { title: req.title, body: req.body, head: req.branch, base: req.base });
      if (!r.ok) return r;
      if (r.value.status === 422) {
        const errors = validationErrors(r.value.body);
        const what = `${op.name}: 422 ${errors.map((e) => str(e, "message") ?? `${str(e, "field") ?? "?"} ${str(e, "code") ?? "invalid"}`).join("; ")}`;
        if (errors.some((e) => /already exists/i.test(str(e, "message") ?? ""))) return redacted(forgeErr("conflict", what));
        if (errors.some((e) => e["field"] === "head" || e["field"] === "base")) return redacted(forgeErr("not-found", what));
      }
      if (!isSuccess(r.value.status)) return redacted(mapHttpError(op, r.value));
      return prResult(op, r.value.body);
    });
  }

  /** PATCH a PR that is not merged; a 422 that mentions "merged" is `conflict`. */
  async function patchPr(ctx: Ctx, pr: number, patch: Readonly<Record<string, string>>, operation: string): Promise<ForgeResult<ForgePr>> {
    const current = await getPr(ctx, pr);
    if (!current.ok) return current;
    if (current.value.state === "merged") return forgeErr("conflict", `${operation}: PR #${pr} is merged`);
    if (Object.keys(patch).length === 0) return current;
    const op = GITHUB_OPERATIONS.updatePull;
    const r = await apiReply(ctx, op, `/pulls/${pr}`, patch);
    if (!r.ok) return r;
    if (r.value.status === 422 && /merged/i.test(JSON.stringify(r.value.body))) return forgeErr("conflict", `${operation}: PR #${pr} is merged`);
    if (!isSuccess(r.value.status)) return redacted(mapHttpError(op, r.value));
    return prResult(op, r.value.body);
  }

  async function updatePr(pr: number, req: Parameters<Forge["updatePr"]>[1], opts: CallOpts): Promise<ForgeResult<ForgePr>> {
    return guarded("updatePr", opts, (ctx) => {
      const patch: Record<string, string> = {};
      if (req.title !== undefined) patch["title"] = req.title;
      if (req.body !== undefined) patch["body"] = req.body;
      return patchPr(ctx, pr, patch, "updatePr");
    });
  }

  async function closePr(pr: number, opts: CallOpts): Promise<ForgeResult<ForgePr>> {
    return guarded("closePr", opts, (ctx) => patchPr(ctx, pr, { state: "closed" }, "closePr"));
  }

  /** Reads a paged list: `PER_PAGE` a page until a short page, at most `MAX_PAGES`. */
  async function paged(ctx: Ctx, op: Operation, path: (page: number) => string, items: (body: unknown) => unknown[] | undefined): Promise<ForgeResult<unknown[]>> {
    const all: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const r = await api(ctx, op, path(page));
      if (!r.ok) return r;
      const got = items(r.value.body);
      if (got === undefined) return malformed(op, `page ${page} is not a list`);
      all.push(...got);
      if (got.length < PER_PAGE) return forgeOk(all);
    }
    return forgeErr("transient", `${op.name}: more than ${MAX_PAGES} pages`);
  }

  async function listPrsByBranch(branch: string, opts: CallOpts): Promise<ForgeResult<readonly ForgePr[]>> {
    return guarded("listPrsByBranch", opts, async (ctx) => {
      const op = GITHUB_OPERATIONS.listPulls;
      const head = encodeURIComponent(`${owner}:${branch}`);
      const r = await paged(ctx, op, (page) => `/pulls?head=${head}&state=all&per_page=${PER_PAGE}&page=${page}`, (b) => (Array.isArray(b) ? b : undefined));
      if (!r.ok) return r;
      const prs: ForgePr[] = [];
      for (const raw of r.value) {
        const pr = toPr(raw);
        if (pr === undefined) return malformed(op, "not a pull request");
        if (pr.branch === branch) prs.push(pr);
      }
      return forgeOk(prs.sort((a, b) => a.number - b.number));
    });
  }

  async function comment(pr: number, body: string, opts: CallOpts): Promise<ForgeResult<{ readonly id: string }>> {
    return guarded("comment", opts, async (ctx) => {
      const found = await getPr(ctx, pr);
      if (!found.ok) return found;
      const op = GITHUB_OPERATIONS.createComment;
      const r = await api(ctx, op, `/issues/${pr}/comments`, { body });
      if (!r.ok) return r;
      const id = asObj(r.value.body)?.["id"];
      if (typeof id !== "number" && typeof id !== "string") return malformed(op, "no id");
      return forgeOk({ id: String(id) });
    });
  }

  // ------------------------------------------------------------ prefetch

  /** The log text of one Actions job: downloaded from the redirect without `Authorization`. */
  async function jobLog(ctx: Ctx, id: number): Promise<ForgeResult<string>> {
    const op = GITHUB_OPERATIONS.getJobLogs;
    const r = await apiReply(ctx, op, `/actions/jobs/${id}/logs`, undefined, "manual");
    if (!r.ok) return r;
    const unavailable = (status: number) => forgeOk(`logs unavailable (${status})\n`);
    if (r.value.status === 404 || r.value.status === 410) return unavailable(r.value.status);
    if (isSuccess(r.value.status)) return forgeOk(r.value.text);
    const location = r.value.headers.get("location");
    if (r.value.status < 300 || r.value.status >= 400 || location === null) return redacted(mapHttpError(op, r.value));
    const down = GITHUB_OPERATIONS.downloadLog;
    const d = await request({ op: down, url: location, token: null, signal: ctx.signal, fetch: options.fetch });
    if (!d.ok) return redacted(d);
    if (d.value.status === 404 || d.value.status === 410) return unavailable(d.value.status);
    if (!isSuccess(d.value.status)) return redacted(mapHttpError(down, d.value));
    return forgeOk(d.value.text);
  }

  /** The text written for a check run that is not an Actions job. */
  function outputText(run: Obj): string {
    const output = asObj(run["output"]);
    const parts = [str(output, "title"), str(output, "summary"), str(output, "text"), str(run, "details_url")];
    return `${parts.filter((p): p is string => p !== undefined && p !== "").join("\n\n")}\n`;
  }

  async function prefetchCiLogs(req: PrefetchRequest, opts: CallOpts): Promise<ForgeResult<{ readonly files: readonly string[] }>> {
    return guarded("prefetch", opts, async (ctx) => {
      if (req.kind !== "ci-log") return forgeErr("forbidden", `prefetch: unknown kind ${JSON.stringify(req.kind)}`);
      if (!SHA_PATTERN.test(req.sha)) return forgeErr("not-found", `prefetch: ${JSON.stringify(req.sha)} is not a commit SHA`);
      const op = GITHUB_OPERATIONS.listCheckRuns;
      const runs = await paged(
        ctx,
        op,
        (page) => `/commits/${req.sha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${page}`,
        (b) => {
          const list = asObj(b)?.["check_runs"];
          return Array.isArray(list) ? list : undefined;
        },
      );
      if (!runs.ok) return runs;
      const failing: Obj[] = [];
      for (const raw of runs.value) {
        const run = asObj(raw);
        if (run === undefined || typeof run["name"] !== "string") return malformed(op, "not a check run");
        const conclusion = run["conclusion"];
        if (run["status"] === "completed" && typeof conclusion === "string" && !PASSING_CONCLUSIONS.includes(conclusion)) failing.push(run);
      }
      const logs: { name: string; text: string }[] = [];
      for (const run of failing) {
        const id = run["id"];
        if (str(run["app"], "slug") === "github-actions") {
          if (typeof id !== "number") return malformed(op, "a check run has no id");
          const text = await jobLog(ctx, id);
          if (!text.ok) return text;
          logs.push({ name: run["name"] as string, text: text.value });
        } else {
          logs.push({ name: run["name"] as string, text: outputText(run) });
        }
      }
      const dir = resolve(req.dir);
      await mkdir(dir, { recursive: true });
      const taken = new Set<string>();
      const files: string[] = [];
      for (const log of logs) {
        if (ctx.signal.aborted) return deadlinePassed("prefetch");
        const path = resolve(dir, logFileName(log.name, taken));
        await writeFile(path, log.text);
        files.push(path);
      }
      return forgeOk({ files });
    });
  }

  /** A stub: `forbidden` until the Story that implements it. */
  function stub<T>(operation: ForgeOperation): (...args: readonly unknown[]) => Promise<ForgeResult<T>> {
    return async (...args) => {
      const opts = args[args.length - 1] as CallOpts;
      if (opts.signal.aborted) return deadlinePassed(operation);
      return forgeErr("forbidden", `${operation}: not implemented until Story 1.10`);
    };
  }

  return {
    snapshot,
    ledgerSwap,
    pushBranch,
    openPr,
    updatePr,
    closePr,
    listPrsByBranch,
    comment,
    checks: stub("checks"),
    enqueue: stub("enqueue"),
    dequeue: stub("dequeue"),
    alert: stub("alert"),
    prefetch: prefetchCiLogs,
  };
}
