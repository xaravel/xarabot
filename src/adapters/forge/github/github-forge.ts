import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseLedger } from "../../../core/ledger/codec.ts";
import type { LedgerCommit } from "../../../core/ledger/edits.ts";
import { IsoDateTime } from "../../../core/schemas/common.ts";
import { PR_REVIEW_DECISIONS, type PrReview, type PrState } from "../../../core/schemas/snapshot.ts";
import {
  deadlinePassed,
  forgeErr,
  forgeOk,
  type CallOpts,
  type Forge,
  type ForgeCheck,
  type ForgeFailure,
  type ForgeOperation,
  type ForgePr,
  type ForgePrState,
  type ForgeResult,
  type ForgeReview,
  type ForgeSnapshot,
  type GitSha,
  type PrefetchRequest,
  type PushLease,
  type QueueState,
  rateLimited,
  REVIEW_STATES,
  type ReviewState,
} from "../../../ports/forge.ts";
import type { AppCredentials } from "./credentials.ts";
import {
  formatDate,
  GITHUB_OPERATIONS,
  isSuccess,
  mapGraphqlErrors,
  mapHttpError,
  request,
  type GraphqlError,
  type FetchLike,
  type HttpReply,
  type Operation,
  type Redirect,
} from "./http.ts";
import { runGit, type GitRun } from "./runner-git.ts";
import { createTokenSource } from "./tokens.ts";

/**
 * The GitHub `Forge` adapter (FR6, FR9, FR13, FR24, AR7, AR16, AR19, AR24,
 * AR27, AR38, AR39). `snapshot` and `ledgerSwap` work over the REST git data
 * API (`snapshot` reads blobs and each unit's PR, with its reviewers' latest
 * decisive reviews, over GraphQL); `pushBranch` runs `git push
 * --force-with-lease` from the lane's private `runner.git`; the PR
 * operations, `comment`, `checks` (check runs plus the combined commit
 * status) and the CI-log prefetch use REST; `enqueue` and
 * `dequeue` read the PR's merge-queue state over GraphQL (as the read-only
 * `queueState` does) and then call `enqueuePullRequest` or
 * `dequeuePullRequest` (the merge queue is the only merge path; the adapter
 * has no direct or admin merge call); `alert`
 * posts one deduplicated comment on the Maintainer's inbox issue. Each call
 * makes one attempt, never throws, and returns `transient` for an
 * already-aborted signal before any request.
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
/** Blobs read per GraphQL request. */
export const BLOBS_PER_QUERY = 100;

/** The GraphQL query reading `n` blobs by object id, as aliases `b0`… from variables `$o0`…. */
function blobsQuery(n: number): string {
  const vars = Array.from({ length: n }, (_, i) => `$o${i}: GitObjectID!`).join(", ");
  const fields = Array.from({ length: n }, (_, i) => `b${i}: object(oid: $o${i}) { ... on Blob { text isTruncated isBinary } }`).join(" ");
  return `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`;
}
/** Check conclusions that are not failures. */
const PASSING_CONCLUSIONS: readonly string[] = ["success", "neutral", "skipped"];
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A GitHub login: alphanumerics and single inner hyphens, at most 39 characters. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const DEFAULT_INBOX_LABEL = "xarabot-inbox";
export const INBOX_TITLE = "🤖 Xarabot inbox";
/** How far before `mainSha`'s committer date the alert dedupe scan starts. */
const ALERT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** The hidden marker an alert comment carries for (`condition`, `mainSha`). */
export function alertMarker(condition: string, mainSha: GitSha): string {
  return `<!-- xarabot-alert ${encodeURIComponent(condition)} ${mainSha} -->`;
}

/** The builders' coordinator-claim alerts (Story 2.4), which stop nothing: condition → the claim's state. */
const COORDINATOR_ALERTS: Readonly<Record<string, string>> = { "coordinator-missing": "missing", "coordinator-expired": "expired" };

/** The body of the alert comment for (`condition`, `mainSha`) to `maintainer`. */
export function alertBody(maintainer: string, condition: string, mainSha: GitSha): string {
  const shown = condition.replace(/`/g, "'").replace(/\r\n|\r|\n/g, " ");
  const claim = Object.hasOwn(COORDINATOR_ALERTS, condition) ? COORDINATOR_ALERTS[condition] : undefined;
  const what = claim === undefined ? " stops every lane" : `: the coordinator claim is ${claim}; builders keep going`;
  return `🤖 @${maintainer} Xarabot alert: \`${shown}\`${what} (main \`${mainSha}\`).\n\n${alertMarker(condition, mainSha)}`;
}

/** The merge-queue state of one PR, by number. */
const PULL_QUEUE_STATE_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id state headRefOid mergeQueueEntry { id } } } }";
/**
 * A unit's PR for the snapshot, by number: its state, head and each
 * reviewer's latest decisive review, in one call (retro item 13).
 */
const PULL_SNAPSHOT_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state headRefOid latestOpinionatedReviews(first: 100) { nodes { author { login } state commit { oid } submittedAt } } } } }";
const ENQUEUE_MUTATION =
  "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { id } } }";
const DEQUEUE_MUTATION = "mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }";
/** An enqueue refused because the PR is already queued. */
const ALREADY_QUEUED = /already (?:queued|enqueued|in (?:the )?(?:merge )?queue)/i;
/** A dequeue refused because the PR is not queued. */
const NOT_QUEUED = /not in (?:the )?(?:merge )?queue|not queued/i;

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
  /** The Maintainer's GitHub login, whom `alert` @mentions and assigns the inbox to. */
  readonly maintainer?: string;
  /** The inbox issue's label; default `xarabot-inbox`. */
  readonly inboxLabel?: string;
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
      if (/remote rejected/.test(summary)) return forgeErr(/lock/i.test(summary) ? "transient" : "rejected", `${what}: ${summary}`);
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
    return send(ctx, op, `${repoPath}${path}`, body, redirect);
  }

  /** One installation-token call to `path` below the API URL (not repo-prefixed). */
  async function send(ctx: Ctx, op: Operation, path: string, body?: unknown, redirect?: Redirect): Promise<ForgeResult<HttpReply>> {
    const token = await tokens.get(ctx.signal);
    if (!token.ok) return redacted(token);
    const r = await request({
      op,
      path,
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

  /**
   * Reads the blobs of `entries`, keyed by path: one GraphQL request per
   * `BLOBS_PER_QUERY` distinct blobs, never one request per file, which GitHub
   * answers with a secondary rate limit. A blob GraphQL leaves out (truncated,
   * binary or missing) is read over REST, one at a time.
   */
  async function readBlobs(ctx: Ctx, entries: readonly TreeEntry[]): Promise<ForgeResult<Record<string, string>>> {
    const op = GITHUB_OPERATIONS.readBlobs;
    const shas = [...new Set(entries.map((e) => e.sha))];
    const texts = new Map<string, string>();
    for (let start = 0; start < shas.length; start += BLOBS_PER_QUERY) {
      const chunk = shas.slice(start, start + BLOBS_PER_QUERY);
      const variables: Record<string, string> = { owner, name };
      chunk.forEach((sha, i) => (variables[`o${i}`] = sha));
      const r = await graphql(ctx, op, blobsQuery(chunk.length), variables);
      if (!r.ok) return r;
      if (r.value.errors.length > 0) return redacted(mapGraphqlErrors(op, r.value.errors, "transient"));
      const repository = asObj(r.value.data?.["repository"]);
      if (repository === undefined) return malformed(op, "no repository");
      for (const [i, sha] of chunk.entries()) {
        const blob = asObj(repository[`b${i}`]);
        const text = blob?.["text"];
        if (typeof text === "string" && blob?.["isTruncated"] !== true && blob?.["isBinary"] !== true) texts.set(sha, text);
      }
    }
    const files: Record<string, string> = {};
    for (const e of entries) {
      let text = texts.get(e.sha);
      if (text === undefined) {
        const r = await readBlob(ctx, e.sha);
        if (!r.ok) return r;
        text = r.value;
        texts.set(e.sha, text);
      }
      files[e.path] = text;
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

  /**
   * The PR state of every ledger record with a `pr`, one GraphQL read per PR
   * (`PULL_SNAPSHOT_QUERY`, under `pullQueueState`, the adapter's GraphQL PR
   * read): state, head and each reviewer's latest decisive review. A PR that
   * no longer exists has no state, as in the fake forge.
   */
  async function readPrs(ctx: Ctx, ledgerFiles: Readonly<Record<string, string>>): Promise<ForgeResult<ForgeSnapshot["prs"]>> {
    const parsed = parseLedger(ledgerFiles);
    if (!parsed.ok) return forgeOk({});
    const wanted = [...parsed.value.units].flatMap(([unit, record]) => (record.pr === null ? [] : [{ unit, pr: record.pr }]));
    const op = GITHUB_OPERATIONS.pullQueueState;
    const results = await Promise.all(wanted.map((w) => graphql(ctx, op, PULL_SNAPSHOT_QUERY, { owner, name, number: w.pr })));
    const states: Record<string, PrState> = {};
    for (const [i, r] of results.entries()) {
      const { unit, pr } = wanted[i] as { unit: string; pr: number };
      if (!r.ok) return r;
      const pull = asObj(r.value.data?.["repository"])?.["pullRequest"];
      if (r.value.errors.length > 0) {
        if ((pull === null || pull === undefined) && r.value.errors.every((e) => e.type === "NOT_FOUND")) continue;
        return redacted(mapGraphqlErrors(op, r.value.errors, "transient"));
      }
      const state = str(pull, "state");
      const head = str(pull, "headRefOid");
      const reviews = toSnapshotReviews(asObj(asObj(pull)?.["latestOpinionatedReviews"])?.["nodes"]);
      if ((state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") || head === undefined || reviews === undefined) return malformed(op, `PR #${pr}`);
      states[unit] = { number: pr, state: state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "merged", head_sha: head, reviews };
    }
    return forgeOk(states);
  }

  /** `latestOpinionatedReviews` nodes as the snapshot's reviews, decisive ones only; `undefined` when malformed. */
  function toSnapshotReviews(nodes: unknown): PrReview[] | undefined {
    if (!Array.isArray(nodes)) return undefined;
    const list: PrReview[] = [];
    for (const raw of nodes) {
      const n = asObj(raw);
      if (n === undefined) return undefined;
      const state = typeof n["state"] === "string" ? n["state"].toLowerCase() : undefined;
      if (state === undefined || !(REVIEW_STATES as readonly string[]).includes(state)) return undefined;
      const author = n["author"];
      const commit = n["commit"];
      if ((author !== null && asObj(author) === undefined) || (commit !== null && asObj(commit) === undefined)) return undefined;
      const login = author === null ? null : str(author, "login");
      const sha = commit === null ? null : str(commit, "oid");
      const submitted = n["submittedAt"];
      if (login === undefined || sha === undefined || (sha !== null && !SHA_PATTERN.test(sha)) || (submitted !== null && typeof submitted !== "string")) return undefined;
      // A pending or commented review, or one never submitted, decides nothing.
      if (!(PR_REVIEW_DECISIONS as readonly string[]).includes(state) || submitted === null) continue;
      if (!IsoDateTime.safeParse(submitted).success) return undefined;
      list.push({ author: login, state: state as PrReview["state"], commit_sha: sha, submitted_at: submitted });
    }
    return list;
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

  /** `GET /git/ref/heads/{branch}`: a missing branch is `null`. */
  async function branchHead(branch: string, opts: CallOpts): Promise<ForgeResult<GitSha | null>> {
    return guarded<GitSha | null>("branchHead", opts, async (ctx) => {
      const r = await readRef(ctx, branch);
      if (!r.ok) return r.error.kind === "not-found" ? forgeOk(null) : r;
      return r;
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
    const mergeSha = b?.["merge_commit_sha"];
    const merge_sha = merged && typeof mergeSha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeSha) ? mergeSha : null;
    return { number, branch, base, state: merged ? "merged" : state, head_sha: head, title, body: text, merge_sha };
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

  /** A review item as a `ForgeReview`: GitHub's uppercase state lowercased; `undefined` when malformed. */
  function toReview(raw: unknown): ForgeReview | undefined {
    const r = asObj(raw);
    if (r === undefined) return undefined;
    const state = typeof r["state"] === "string" ? r["state"].toLowerCase() : undefined;
    if (state === undefined || !(REVIEW_STATES as readonly string[]).includes(state)) return undefined;
    const user = r["user"];
    if (user !== null && user !== undefined && asObj(user) === undefined) return undefined;
    const author = str(user, "login") ?? null;
    const commit = r["commit_id"] ?? null;
    const submitted = r["submitted_at"] ?? null;
    if ((commit !== null && typeof commit !== "string") || (submitted !== null && typeof submitted !== "string")) return undefined;
    return { author, state: state as ReviewState, commit_sha: commit, submitted_at: submitted };
  }

  async function reviews(pr: number, opts: CallOpts): Promise<ForgeResult<readonly ForgeReview[]>> {
    return guarded("reviews", opts, async (ctx) => {
      const op = GITHUB_OPERATIONS.listReviews;
      const r = await paged(ctx, op, (page) => `/pulls/${pr}/reviews?per_page=${PER_PAGE}&page=${page}`, (b) => (Array.isArray(b) ? b : undefined));
      if (!r.ok) return r;
      const list: ForgeReview[] = [];
      for (const raw of r.value) {
        const review = toReview(raw);
        if (review === undefined) return malformed(op, "not a review");
        list.push(review);
      }
      return forgeOk(list);
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

  // ------------------------------------------------------------ checks

  /** A check run as a `ForgeCheck`; `undefined` when malformed. */
  function toCheck(raw: unknown): ForgeCheck | undefined {
    const run = asObj(raw);
    const name = run?.["name"];
    if (typeof name !== "string") return undefined;
    const given = run?.["status"];
    const status = given === "completed" || given === "in_progress" ? given : "queued";
    const conclusion = run?.["conclusion"];
    return { name, status, conclusion: status === "completed" && typeof conclusion === "string" ? conclusion : null };
  }

  /** A commit status as a `ForgeCheck`; `undefined` when malformed. */
  function statusCheck(raw: unknown): ForgeCheck | undefined {
    const name = str(raw, "context");
    const state = str(raw, "state");
    if (name === undefined) return undefined;
    if (state === "success" || state === "failure" || state === "error") return { name, status: "completed", conclusion: state };
    if (state === "pending") return { name, status: "in_progress", conclusion: null };
    return undefined;
  }

  async function checks(sha: GitSha, opts: CallOpts): Promise<ForgeResult<{ readonly checks: readonly ForgeCheck[] }>> {
    return guarded("checks", opts, async (ctx) => {
      if (!SHA_PATTERN.test(sha)) return forgeErr("not-found", `checks: ${JSON.stringify(sha)} is not a commit SHA`);
      const runOp = GITHUB_OPERATIONS.listCheckRuns;
      const runs = await paged(ctx, runOp, (page) => `/commits/${sha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${page}`, (b) => {
        const list = asObj(b)?.["check_runs"];
        return Array.isArray(list) ? list : undefined;
      });
      if (!runs.ok) return runs;
      const statusOp = GITHUB_OPERATIONS.getCombinedStatus;
      const statuses = await paged(ctx, statusOp, (page) => `/commits/${sha}/status?per_page=${PER_PAGE}&page=${page}`, (b) => {
        const list = asObj(b)?.["statuses"];
        return Array.isArray(list) ? list : undefined;
      });
      if (!statuses.ok) return statuses;
      const out: ForgeCheck[] = [];
      for (const raw of runs.value) {
        const c = toCheck(raw);
        if (c === undefined) return malformed(runOp, "not a check run");
        out.push(c);
      }
      for (const raw of statuses.value) {
        const c = statusCheck(raw);
        if (c === undefined) return malformed(statusOp, "not a commit status");
        out.push(c);
      }
      return forgeOk({ checks: out });
    });
  }

  // ------------------------------------------------------------ merge queue

  type GraphqlReply = { readonly data: Obj | undefined; readonly errors: readonly GraphqlError[] };

  /** One GraphQL call: a non-2xx reply is mapped by `mapHttpError`; `errors[]` comes back for the caller. */
  async function graphql(ctx: Ctx, op: Operation, query: string, variables: Readonly<Record<string, unknown>>): Promise<ForgeResult<GraphqlReply>> {
    const r = await send(ctx, op, "/graphql", { query, variables });
    if (!r.ok) return r;
    if (!isSuccess(r.value.status)) return redacted(mapHttpError(op, r.value));
    const body = asObj(r.value.body);
    if (body === undefined) return malformed(op, "not a GraphQL reply");
    const raw = body["errors"];
    const errors: GraphqlError[] = [];
    if (Array.isArray(raw)) {
      for (const e of raw) {
        const type = str(e, "type");
        const message = str(e, "message");
        errors.push({ ...(type === undefined ? {} : { type }), ...(message === undefined ? {} : { message }) });
      }
    }
    return forgeOk({ data: asObj(body["data"]), errors });
  }

  type PullQueue = { readonly id: string; readonly state: string; readonly head: string; readonly queued: boolean };

  /** The PR's node id, state, head and whether it has a merge-queue entry; a missing PR is `not-found`. */
  async function readQueueState(ctx: Ctx, pr: number, operation: string): Promise<ForgeResult<PullQueue>> {
    const op = GITHUB_OPERATIONS.pullQueueState;
    const r = await graphql(ctx, op, PULL_QUEUE_STATE_QUERY, { owner, name, number: pr });
    if (!r.ok) return r;
    if (r.value.errors.length > 0) return redacted(mapGraphqlErrors(op, r.value.errors, "transient"));
    const repository = r.value.data?.["repository"];
    if (repository === null) return forgeErr("not-found", `${operation}: no repository ${owner}/${name}`);
    const pull = asObj(repository)?.["pullRequest"];
    if (pull === null || pull === undefined) {
      return asObj(repository) === undefined ? malformed(op, "no repository") : forgeErr("not-found", `${operation}: no PR #${pr}`);
    }
    const id = str(pull, "id");
    const state = str(pull, "state");
    const head = str(pull, "headRefOid");
    const entry = asObj(pull)?.["mergeQueueEntry"];
    if (id === undefined || state === undefined || head === undefined || entry === undefined) return malformed(op, `PR #${pr}`);
    return forgeOk({ id, state, head, queued: entry !== null });
  }

  /** A mutation's errors: `ok` when every one matches `fine`, else `mapGraphqlErrors` with fallback `conflict`. */
  function mutationResult(op: Operation, errors: readonly GraphqlError[], fine: RegExp): ForgeResult<null> {
    if (errors.length === 0) return forgeOk(null);
    if (errors.every((e) => fine.test(e.message ?? ""))) return forgeOk(null);
    return redacted(mapGraphqlErrors(op, errors, "conflict"));
  }

  async function enqueue(pr: number, expectedHead: GitSha, opts: CallOpts): Promise<ForgeResult<{ readonly queued: true }>> {
    return guarded("enqueue", opts, async (ctx) => {
      const current = await readQueueState(ctx, pr, "enqueue");
      if (!current.ok) return current;
      const { id, state, head, queued } = current.value;
      if (state !== "OPEN") return forgeErr("conflict", `enqueue: PR #${pr} is ${state.toLowerCase()}`);
      if (head !== expectedHead) return forgeErr("conflict", `enqueue: PR #${pr} head is ${head}, not ${expectedHead}`);
      if (queued) return forgeOk({ queued: true as const });
      const op = GITHUB_OPERATIONS.enqueuePullRequest;
      const r = await graphql(ctx, op, ENQUEUE_MUTATION, { pullRequestId: id, expectedHeadOid: expectedHead });
      if (!r.ok) return r;
      const done = mutationResult(op, r.value.errors, ALREADY_QUEUED);
      return done.ok ? forgeOk({ queued: true as const }) : done;
    });
  }

  async function dequeue(pr: number, opts: CallOpts): Promise<ForgeResult<{ readonly queued: false }>> {
    return guarded("dequeue", opts, async (ctx) => {
      const current = await readQueueState(ctx, pr, "dequeue");
      if (!current.ok) return current;
      if (!current.value.queued) return forgeOk({ queued: false as const });
      const op = GITHUB_OPERATIONS.dequeuePullRequest;
      const r = await graphql(ctx, op, DEQUEUE_MUTATION, { id: current.value.id });
      if (!r.ok) return r;
      const done = mutationResult(op, r.value.errors, NOT_QUEUED);
      return done.ok ? forgeOk({ queued: false as const }) : done;
    });
  }

  /** The read-only merge-queue state: `OPEN`, `CLOSED` and `MERGED` map to lowercase; any other state is malformed. */
  async function queueState(pr: number, opts: CallOpts): Promise<ForgeResult<QueueState>> {
    return guarded("queueState", opts, async (ctx) => {
      const current = await readQueueState(ctx, pr, "queueState");
      if (!current.ok) return current;
      const { state, head, queued } = current.value;
      const mapped: ForgePrState | undefined = state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : state === "MERGED" ? "merged" : undefined;
      if (mapped === undefined) return malformed(GITHUB_OPERATIONS.pullQueueState, `PR #${pr} state ${JSON.stringify(state)}`);
      return forgeOk({ state: mapped, head_sha: head, queued });
    });
  }

  // ------------------------------------------------------------ alert

  const inboxLabel = options.inboxLabel ?? DEFAULT_INBOX_LABEL;
  const botLogin = `${options.credentials.app.slug}[bot]`;

  /** The lowest-numbered open inbox issue assigned to `maintainer`, created when missing. */
  async function inboxIssue(ctx: Ctx, maintainer: string): Promise<ForgeResult<number>> {
    const listOp = GITHUB_OPERATIONS.listIssues;
    const query = `labels=${encodeURIComponent(inboxLabel)}&assignee=${encodeURIComponent(maintainer)}&state=open&sort=created&direction=asc`;
    const listed = await paged(ctx, listOp, (page) => `/issues?${query}&per_page=${PER_PAGE}&page=${page}`, (b) => (Array.isArray(b) ? b : undefined));
    if (!listed.ok) return listed;
    let lowest: number | undefined;
    for (const raw of listed.value) {
      const issue = asObj(raw);
      const number = issue?.["number"];
      if (typeof number !== "number") return malformed(listOp, "not an issue");
      if (issue?.["pull_request"] !== undefined) continue;
      if (lowest === undefined || number < lowest) lowest = number;
    }
    if (lowest !== undefined) return forgeOk(lowest);
    const createOp = GITHUB_OPERATIONS.createIssue;
    const body = `🤖 Xarabot posts alerts for @${maintainer} here: each comment names a condition that stops every lane.`;
    const created = await api(ctx, createOp, "/issues", { title: INBOX_TITLE, body, labels: [inboxLabel], assignees: [maintainer] });
    if (!created.ok) return created;
    const number = asObj(created.value.body)?.["number"];
    return typeof number === "number" ? forgeOk(number) : malformed(createOp, "no number");
  }

  /** The dedupe scan's lower bound: `mainSha`'s committer date less 24 h; `null` when GitHub has no such commit. */
  async function alertSince(ctx: Ctx, mainSha: GitSha): Promise<ForgeResult<string | null>> {
    const op = GITHUB_OPERATIONS.getCommit;
    const r = await apiReply(ctx, op, `/git/commits/${mainSha}`);
    if (!r.ok) return r;
    if (r.value.status === 404 || r.value.status === 422) return forgeOk(null);
    if (!isSuccess(r.value.status)) return redacted(mapHttpError(op, r.value));
    const date = str(asObj(r.value.body)?.["committer"], "date");
    const at = date === undefined ? Number.NaN : Date.parse(date);
    if (!Number.isFinite(at)) return malformed(op, "no committer.date");
    return forgeOk(formatDate(at - ALERT_LOOKBACK_MS));
  }

  async function alert(condition: string, mainSha: GitSha, opts: CallOpts): Promise<ForgeResult<{ readonly posted: boolean }>> {
    return guarded<{ readonly posted: boolean }>("alert", opts, async (ctx) => {
      const maintainer = options.maintainer;
      if (maintainer === undefined || !LOGIN_PATTERN.test(maintainer)) {
        return forgeErr("forbidden", `alert: maintainer ${JSON.stringify(maintainer ?? null)} is not a GitHub login`);
      }
      if (!SHA_PATTERN.test(mainSha)) return forgeErr("not-found", `alert: ${JSON.stringify(mainSha)} is not a commit SHA`);
      const issue = await inboxIssue(ctx, maintainer);
      if (!issue.ok) return issue;
      const since = await alertSince(ctx, mainSha);
      if (!since.ok) return since;
      const marker = alertMarker(condition, mainSha);
      const listOp = GITHUB_OPERATIONS.listIssueComments;
      const sinceQuery = since.value === null ? "" : `since=${encodeURIComponent(since.value)}&`;
      const comments = await paged(
        ctx,
        listOp,
        (page) => `/issues/${issue.value}/comments?${sinceQuery}per_page=${PER_PAGE}&page=${page}`,
        (b) => (Array.isArray(b) ? b : undefined),
      );
      if (!comments.ok) return comments;
      for (const raw of comments.value) {
        const login = str(asObj(raw)?.["user"], "login");
        const body = str(raw, "body");
        if (login === botLogin && body !== undefined && body.includes(marker)) return forgeOk({ posted: false });
      }
      const postOp = GITHUB_OPERATIONS.createIssueComment;
      const posted = await api(ctx, postOp, `/issues/${issue.value}/comments`, { body: alertBody(maintainer, condition, mainSha) });
      if (!posted.ok) return posted;
      return forgeOk({ posted: true });
    });
  }

  return {
    snapshot,
    ledgerSwap,
    pushBranch,
    branchHead,
    openPr,
    updatePr,
    closePr,
    listPrsByBranch,
    reviews,
    comment,
    checks,
    enqueue,
    dequeue,
    queueState,
    alert,
    prefetch: prefetchCiLogs,
  };
}
