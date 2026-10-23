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
  type ForgeResult,
  type ForgeSnapshot,
  type GitSha,
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
} from "./http.ts";
import { createTokenSource } from "./tokens.ts";

/**
 * The GitHub `Forge` adapter (FR24, AR27, AR39). `snapshot` and `ledgerSwap`
 * work over the REST git data API; the other operations are stubs until
 * Stories 1.9 and 1.10. Each call makes one attempt, never throws, and
 * returns `transient` for an already-aborted signal before any request.
 */

export const DEFAULT_LEDGER_BRANCH = "xarabot/claims";
export const DEFAULT_MAIN_BRANCH = "main";
/** git's empty tree. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const LEDGER_ROOT_MESSAGE = "xarabot ledger root [skip ci]";

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

const STORY_1_9: readonly ForgeOperation[] = ["pushBranch", "openPr", "updatePr", "closePr", "listPrsByBranch", "comment"];

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
    const token = await tokens.get(ctx.signal);
    if (!token.ok) return redacted(token);
    const r = await request({ op, path: `${repoPath}${path}`, token: token.value, signal: ctx.signal, fetch: options.fetch, apiUrl: options.apiUrl, body });
    if (!r.ok) return redacted(r);
    if (r.value.date !== null) {
      const at = Date.parse(r.value.date);
      if (Number.isFinite(at) && (ctx.latest === null || at > ctx.latest)) ctx.latest = at;
    }
    if (r.value.status === 401) tokens.invalidate(token.value);
    if (!isSuccess(r.value.status)) return redacted(mapHttpError(op, r.value));
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

  /** A stub: `forbidden` until the Story that implements it. */
  function stub<T>(operation: ForgeOperation): (...args: readonly unknown[]) => Promise<ForgeResult<T>> {
    const story = STORY_1_9.includes(operation) ? "1.9" : "1.10";
    return async (...args) => {
      const opts = args[args.length - 1] as CallOpts;
      if (opts.signal.aborted) return deadlinePassed(operation);
      return forgeErr("forbidden", `${operation}: not implemented until Story ${story}`);
    };
  }

  return {
    snapshot,
    ledgerSwap,
    pushBranch: stub("pushBranch"),
    openPr: stub("openPr"),
    updatePr: stub("updatePr"),
    closePr: stub("closePr"),
    listPrsByBranch: stub("listPrsByBranch"),
    comment: stub("comment"),
    checks: stub("checks"),
    enqueue: stub("enqueue"),
    dequeue: stub("dequeue"),
    alert: stub("alert"),
    prefetch: stub("prefetch"),
  };
}
