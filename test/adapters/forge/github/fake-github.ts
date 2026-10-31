import { createVerify, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { LedgerCommit } from "../../../../src/core/ledger/edits.ts";
import type { FetchLike } from "../../../../src/adapters/forge/github/http.ts";
import type { ForgeCheck, ForgePr } from "../../../../src/ports/forge.ts";

/**
 * An in-process GitHub emulator: a `fetch` for the endpoints the GitHub forge
 * adapter calls. It holds git objects, refs, PRs, a clock that sets `Date`,
 * App JWT and installation-token checks, pull requests, issues and their
 * comments, PR reviews, check runs, commit statuses, a merge queue behind a GraphQL
 * endpoint, Actions job logs (redirected to a log host it also serves), a
 * request log and one-shot hooks and response injections. Each request yields a macrotask and checks its signal
 * before any change, so an aborted request changes nothing.
 */

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const API = "https://api.github.test";
/** The host job-log redirects point at; it needs no credential. */
export const LOGS_HOST = "https://logs.github.test";
const TOKEN_TTL_MS = 60 * 60 * 1000;

export type FakeGitHubOptions = {
  readonly owner?: string;
  readonly name?: string;
  readonly appId?: number;
  /** The App's public key, for JWT checks. */
  readonly publicKey: KeyObject;
  readonly installationId?: number;
  /** The clock, epoch ms; default `2026-01-01T00:00:00Z`. */
  readonly now?: number;
  readonly ledgerBranch?: string;
  readonly mainBranch?: string;
  /** The App's slug; comments made with an installation token are by `<slug>[bot]`. Default `alice-xarabot`. */
  readonly appSlug?: string;
  /** The bot account's user id, served at `GET /users/<slug>[bot]`; default 41898282. */
  readonly botUserId?: number;
};

export type LoggedRequest = {
  readonly method: string;
  /** `api` or `logs`. */
  readonly host: "api" | "logs";
  /** Path and query below the host's URL. */
  readonly path: string;
  /** `jwt`, `token` or `none`. */
  readonly auth: "jwt" | "token" | "none";
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
};

export type InjectedResponse = {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

export type FakePull = {
  readonly state: "open" | "closed";
  readonly merged: boolean;
  /** The head SHA; an open PR's head follows its branch ref when the branch exists. */
  readonly head_sha: string;
  /** Default `pr-<number>`. */
  readonly branch?: string;
  /** Default `main`. */
  readonly base?: string;
  readonly title?: string;
  /** `null` as GitHub sends for an empty body; default `""`. */
  readonly body?: string | null;
  /** The merge commit GitHub reports for a merged PR; default `null`. */
  readonly merge_commit_sha?: string | null;
};

/** A check run: a `ForgeCheck` plus what GitHub reports beside it. */
export type FakeCheckRun = ForgeCheck & {
  /** The app's slug; default `github-actions`. */
  readonly app?: string;
  readonly output?: { readonly title?: string | null; readonly summary?: string | null; readonly text?: string | null };
  readonly details_url?: string;
};

/** A commit status as `setStatuses` takes it. */
export type FakeStatus = { readonly context: string; readonly state: "success" | "failure" | "error" | "pending" };

/**
 * An issue as the emulator holds it. `author` is its opener's login, sent as
 * its `user`: the bot account for one `POST /issues` creates; absent sends
 * `user: null`.
 */
export type FakeIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly author?: string;
};

/**
 * A PR review as `addReview` takes it: `state` is GitHub's uppercase state
 * (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`), sent
 * as given; a `null` login sends `user: null`, as for a deleted account.
 */
export type FakeReview = {
  readonly login: string | null;
  readonly state: string;
  readonly commit_id: string | null;
  readonly submitted_at: string | null;
  /** The review's body; default `""`. */
  readonly body?: string;
};

/** A comment on an issue or PR. */
export type FakeComment = { readonly id: number; readonly body: string; readonly login: string; readonly created_at: string };

type Entry = { readonly mode: string; readonly sha: string };
type Commit = { readonly tree: string; readonly parents: readonly string[]; readonly message: string };
type Matcher = { readonly method: string; readonly path: RegExp };

export type FakeGitHubControl = {
  readonly apiUrl: string;
  readonly installationId: number;
  /** Epoch ms. */
  clock(): number;
  setClock(ms: number): void;
  setNow(iso: string): void;
  advance(ms: number): void;
  setInstalled(installed: boolean): void;
  /** Replaces `main`'s files as one new commit; returns its SHA. */
  setMain(files: Readonly<Record<string, string>>): string;
  /** Writes a ledger commit on the ledger tip (creating the branch if missing); returns the new tip. */
  writeForeignLedger(commit: LedgerCommit): string;
  /** The SHA a branch points at, or `undefined`. */
  ref(branch: string): string | undefined;
  /** A branch's files at its tip. */
  files(branch: string): Record<string, string>;
  commit(sha: string): Commit | undefined;
  setPull(number: number, pull: FakePull): void;
  /** The PR as GitHub would return it, or `undefined`. */
  pull(number: number): Record<string, unknown> | undefined;
  /** Points a branch at `sha` (as a git push does), without needing the commit. */
  setBranch(branch: string, sha: string): void;
  /** True when `token` is a live installation token (for the git remote). */
  tokenValid(token: string): boolean;
  /** The bodies of the comments on issue or PR `number`, oldest first. */
  comments(number: number): string[];
  /** Every comment on issue or PR `number`, oldest first. */
  commentRecords(number: number): FakeComment[];
  /** Appends a review to PR `number`, which must exist. */
  addReview(number: number, review: FakeReview): void;
  /** Every review on PR `number`, oldest first, as `POST /pulls/<n>/reviews` and `addReview` stored them. */
  reviews(number: number): FakeReview[];
  /** The bodies of the bot's reviews on PR `number` (`POST /pulls/<n>/reviews`), oldest first. */
  reviewBodies(number: number): string[];
  /** Adds a comment by `login` on issue or PR `number`, at the clock's time. */
  addComment(number: number, body: string, login: string): void;
  /** Every issue (not PRs), ascending by number. */
  issues(): FakeIssue[];
  /** Creates or replaces an issue; `number` defaults to the next free one. Returns its number. */
  setIssue(issue: Omit<FakeIssue, "number"> & { readonly number?: number }): number;
  /** Queued PR numbers, head first; an entry whose PR closed or whose head moved is dropped. */
  queue(): number[];
  /** Merges the PR at the head of the queue onto `main`; `null` when the queue is empty. */
  mergeQueueHead(): ForgePr | null;
  /** Replaces the commit statuses on `sha`. */
  setStatuses(sha: string, statuses: readonly FakeStatus[]): void;
  /** Replaces the check runs on `sha`. */
  setChecks(sha: string, checks: readonly FakeCheckRun[]): void;
  /** Sets the log of the Actions job behind check `check` on `sha`. */
  setCiLog(sha: string, check: string, log: string): void;
  /** Revokes every installation token minted so far. */
  revokeTokens(): void;
  /** Every installation token minted, oldest first. */
  tokens(): string[];
  mints(): number;
  /** Makes every recursive tree read report `truncated`. */
  truncateTrees(on: boolean): void;
  /** The next request matching `method` and `path` gets `response` and changes nothing. */
  inject(method: string, path: RegExp, response: InjectedResponse | "network-error"): void;
  /** Runs `fn` once, before handling the next request matching `method` and `path`. */
  before(method: string, path: RegExp, fn: () => void): void;
  /** Leaves the `Date` header off every response. */
  omitDate(on: boolean): void;
  log(): LoggedRequest[];
  clearLog(): void;
};

export type FakeGitHub = { readonly fetch: FetchLike; readonly control: FakeGitHubControl };

function sha1(text: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

function gitBlobSha(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): { status: number; body: unknown; headers: Record<string, string> } {
  return { status, body, headers };
}

const notFound = () => json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });
const unprocessable = (message: string) => json(422, { message });

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function createFakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const owner = options.owner ?? "acme";
  const name = options.name ?? "widgets";
  const appId = options.appId ?? 4242;
  const installationId = options.installationId ?? 777;
  const ledgerBranch = options.ledgerBranch ?? "xarabot/claims";
  const mainBranch = options.mainBranch ?? "main";
  const botLogin = `${options.appSlug ?? "alice-xarabot"}[bot]`;
  const botUserId = options.botUserId ?? 41898282;
  let clock = options.now ?? Date.parse("2026-01-01T00:00:00Z");
  let installed = true;
  let truncate = false;
  let withDate = true;
  let commitCounter = 0;

  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, ReadonlyMap<string, Entry>>([[EMPTY_TREE, new Map()]]);
  const commits = new Map<string, Commit>();
  /** Each commit's committer date: the clock when it was made. */
  const commitDates = new Map<string, number>();
  const refs = new Map<string, string>();
  type PullRecord = {
    state: "open" | "closed";
    merged: boolean;
    head_sha: string;
    branch: string;
    base: string;
    title: string;
    body: string | null;
    merge_commit_sha: string | null;
  };
  const pulls = new Map<number, PullRecord>();
  const comments = new Map<number, FakeComment[]>();
  const reviews = new Map<number, (FakeReview & { readonly id: number })[]>();
  let reviewCounter = 9000;
  const issues = new Map<number, FakeIssue>();
  /** Merge-queue entries, head first, with the PR head at enqueue time. */
  const queue: { number: number; head: string }[] = [];
  const statuses = new Map<string, FakeStatus[]>();
  let commentCounter = 1000;
  type CheckRunRecord = FakeCheckRun & { readonly id: number };
  const checkRuns = new Map<string, CheckRunRecord[]>();
  let checkCounter = 5000;
  /** Job id to log text. */
  const jobLogs = new Map<number, string>();
  /** Signed log-host path to job id. */
  const logUrls = new Map<string, number>();
  const tokens = new Map<string, { expiresAt: number; revoked: boolean }>();
  const minted: string[] = [];
  const log: LoggedRequest[] = [];
  const injections: { m: Matcher; r: InjectedResponse | "network-error" }[] = [];
  const hooks: { m: Matcher; fn: () => void }[] = [];

  const repoPrefix = `/repos/${owner}/${name}`;

  function putBlob(bytes: Uint8Array): string {
    const sha = gitBlobSha(bytes);
    blobs.set(sha, bytes);
    return sha;
  }

  function putTree(entries: ReadonlyMap<string, Entry>): string {
    if (entries.size === 0) return EMPTY_TREE;
    const lines = [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => `${e.mode} ${p} ${e.sha}\n`);
    const sha = sha1(`tree\n${lines.join("")}`);
    trees.set(sha, new Map(entries));
    return sha;
  }

  function putCommit(c: Commit): string {
    const sha = sha1(`commit ${c.tree} ${c.parents.join(",")} ${c.message} ${commitCounter++}`);
    commits.set(sha, c);
    commitDates.set(sha, clock);
    return sha;
  }

  function filesAt(commitSha: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (commitSha === undefined) return out;
    const tree = trees.get(commits.get(commitSha)?.tree ?? "") ?? new Map<string, Entry>();
    for (const [path, e] of tree) out[path] = new TextDecoder().decode(blobs.get(e.sha));
    return out;
  }

  function treeOf(files: Readonly<Record<string, string>>): string {
    const entries = new Map<string, Entry>();
    for (const [path, text] of Object.entries(files)) entries.set(path, { mode: "100644", sha: putBlob(new TextEncoder().encode(text)) });
    return putTree(entries);
  }

  function isAncestor(ancestor: string, of: string): boolean {
    const seen = new Set<string>();
    const stack = [of];
    while (stack.length > 0) {
      const s = stack.pop() as string;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(commits.get(s)?.parents ?? []));
    }
    return false;
  }

  function verifyJwt(jwt: string): boolean {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(options.publicKey, Buffer.from(s, "base64url"));
    if (!ok) return false;
    try {
      const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>;
      const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
      const now = Math.floor(clock / 1000);
      return (
        header["alg"] === "RS256" &&
        claims["iss"] === appId &&
        typeof claims["iat"] === "number" &&
        typeof claims["exp"] === "number" &&
        claims["iat"] <= now + 60 &&
        claims["exp"] > now &&
        claims["exp"] - claims["iat"] <= 600
      );
    } catch {
      return false;
    }
  }

  function headOf(p: PullRecord): string {
    const ref = refs.get(p.branch);
    return p.state === "open" && !p.merged && ref !== undefined ? ref : p.head_sha;
  }

  function pullJson(n: number, p: PullRecord): Record<string, unknown> {
    return {
      number: n,
      state: p.state,
      merged: p.merged,
      merged_at: p.merged ? "2026-01-01T00:00:00Z" : null,
      title: p.title,
      body: p.body,
      merge_commit_sha: p.merge_commit_sha,
      head: { ref: p.branch, sha: headOf(p), label: `${owner}:${p.branch}` },
      base: { ref: p.base, label: `${owner}:${p.base}` },
    };
  }

  function nextNumber(): number {
    return Math.max(0, ...pulls.keys(), ...issues.keys()) + 1;
  }

  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  /** Drops queue entries whose PR is no longer open or whose head moved. */
  function pruneQueue(): void {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const e = queue[i] as { number: number; head: string };
      const p = pulls.get(e.number);
      if (p === undefined || p.state !== "open" || p.merged || headOf(p) !== e.head) queue.splice(i, 1);
    }
  }

  function addComment(n: number, text: string, login: string): FakeComment {
    const c: FakeComment = { id: commentCounter++, body: text, login, created_at: iso(clock) };
    comments.set(n, [...(comments.get(n) ?? []), c]);
    return c;
  }

  /** A comment on issue or PR `n` as GitHub returns it, with its web link. */
  const commentJson = (n: number, c: FakeComment) => ({
    id: c.id,
    body: c.body,
    user: { login: c.login },
    created_at: c.created_at,
    updated_at: c.created_at,
    html_url: `https://github.com/${owner}/${name}/${pulls.has(n) ? "pull" : "issues"}/${n}#issuecomment-${c.id}`,
  });

  function issueJson(i: FakeIssue): Record<string, unknown> {
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels.map((name) => ({ name })),
      assignees: i.assignees.map((login) => ({ login })),
      assignee: i.assignees[0] === undefined ? null : { login: i.assignees[0] },
      user: i.author === undefined ? null : { login: i.author },
      html_url: `https://github.com/${owner}/${name}/issues/${i.number}`,
    };
  }

  const gqlError = (type: string, message: string) => json(200, { data: null, errors: [{ type, message }] });

  /**
   * PR `n`'s `latestOpinionatedReviews` nodes: each login's latest
   * `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` review, oldest first.
   */
  function latestOpinionated(n: number): Record<string, unknown>[] {
    const latest = new Map<string | null, FakeReview>();
    for (const r of reviews.get(n) ?? []) {
      if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
      const key = r.login?.toLowerCase() ?? null;
      latest.delete(key);
      latest.set(key, r);
    }
    return [...latest.values()].map((r) => ({
      author: r.login === null ? null : { login: r.login },
      state: r.state,
      commit: r.commit_id === null ? null : { oid: r.commit_id },
      submittedAt: r.submitted_at,
    }));
  }

  /** `POST /graphql`: the blob read, the snapshot's PR read, the queue-state query and the enqueue and dequeue mutations. */
  function handleGraphql(body: unknown): Reply {
    const b = obj(body);
    const query = b?.["query"];
    const vars = obj(b?.["variables"]) ?? {};
    if (typeof query !== "string") return json(200, { errors: [{ message: "A query attribute must be specified and must be a string." }] });
    pruneQueue();
    const byNode = (id: unknown): number | undefined => {
      const m = typeof id === "string" ? /^PR_(\d+)$/.exec(id) : null;
      return m === null || !pulls.has(Number(m[1])) ? undefined : Number(m[1]);
    };
    if (/\.\.\. on Blob\b/.test(query)) {
      if (vars["owner"] !== owner || vars["name"] !== name) {
        return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${String(vars["owner"])}/${String(vars["name"])}'.` }] });
      }
      const repository: Record<string, unknown> = {};
      for (const [key, sha] of Object.entries(vars)) {
        const m = /^o(\d+)$/.exec(key);
        if (m === null) continue;
        const bytes = typeof sha === "string" ? blobs.get(sha) : undefined;
        repository[`b${m[1]}`] = bytes === undefined ? null : { text: new TextDecoder().decode(bytes), isTruncated: false, isBinary: false };
      }
      return json(200, { data: { repository } });
    }
    if (/\benqueuePullRequest\b/.test(query)) {
      const n = byNode(vars["pullRequestId"]);
      if (n === undefined) return gqlError("NOT_FOUND", `Could not resolve to a node with the global id of '${String(vars["pullRequestId"])}'`);
      const p = pulls.get(n) as PullRecord;
      if (p.state !== "open" || p.merged) return gqlError("UNPROCESSABLE", "Pull request is not open");
      if (vars["expectedHeadOid"] !== headOf(p)) return gqlError("UNPROCESSABLE", "Pull request head has moved");
      if (queue.some((e) => e.number === n)) return gqlError("UNPROCESSABLE", "Pull request is already queued");
      queue.push({ number: n, head: headOf(p) });
      return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: `MQE_${n}` } } } });
    }
    if (/\bdequeuePullRequest\b/.test(query)) {
      const n = byNode(vars["id"]);
      if (n === undefined) return gqlError("NOT_FOUND", `Could not resolve to a node with the global id of '${String(vars["id"])}'`);
      const i = queue.findIndex((e) => e.number === n);
      if (i === -1) return gqlError("UNPROCESSABLE", "Pull request is not in the queue");
      queue.splice(i, 1);
      return json(200, { data: { dequeuePullRequest: { mergeQueueEntry: { id: `MQE_${n}` } } } });
    }
    if (/\bpullRequest\s*\(/.test(query) && /\blatestOpinionatedReviews\b/.test(query)) {
      if (vars["owner"] !== owner || vars["name"] !== name) {
        return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${String(vars["owner"])}/${String(vars["name"])}'.` }] });
      }
      const n = vars["number"];
      const p = typeof n === "number" ? pulls.get(n) : undefined;
      if (typeof n !== "number" || p === undefined) {
        return json(200, {
          data: { repository: { pullRequest: null } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: `Could not resolve to a PullRequest with the number of ${String(n)}.` }],
        });
      }
      const state = p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED";
      return json(200, { data: { repository: { pullRequest: { state, headRefOid: headOf(p), latestOpinionatedReviews: { nodes: latestOpinionated(n) } } } } });
    }
    if (/\bpullRequest\s*\(/.test(query) && /\bmergeQueueEntry\b/.test(query)) {
      if (vars["owner"] !== owner || vars["name"] !== name) {
        return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${String(vars["owner"])}/${String(vars["name"])}'.` }] });
      }
      const n = vars["number"];
      const p = typeof n === "number" ? pulls.get(n) : undefined;
      if (p === undefined) {
        return json(200, {
          data: { repository: { pullRequest: null } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: `Could not resolve to a PullRequest with the number of ${String(n)}.` }],
        });
      }
      const state = p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED";
      const queued = queue.some((e) => e.number === n);
      return json(200, {
        data: { repository: { pullRequest: { id: `PR_${String(n)}`, state, headRefOid: headOf(p), mergeQueueEntry: queued ? { id: `MQE_${String(n)}` } : null } } },
      });
    }
    return json(200, { errors: [{ message: "Parse error on query" }] });
  }

  function validation(errors: readonly Record<string, unknown>[]): Reply {
    return json(422, { message: "Validation Failed", errors, documentation_url: "https://docs.github.com/rest" });
  }

  function tokenValid(token: string): boolean {
    const t = tokens.get(token);
    return t !== undefined && !t.revoked && t.expiresAt > clock;
  }

  function takeMatch<T extends { m: Matcher }>(list: T[], method: string, path: string): T | undefined {
    const i = list.findIndex((x) => x.m.method === method && x.m.path.test(path));
    if (i === -1) return undefined;
    return list.splice(i, 1)[0];
  }

  type Reply = { status: number; body: unknown; headers: Record<string, string> };

  function handleJwt(method: string, path: string, body: unknown): Reply {
    if (method === "GET" && path === `${repoPrefix}/installation`) {
      return installed ? json(200, { id: installationId, app_id: appId }) : notFound();
    }
    const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === "POST" && m !== null) {
      if (!installed || Number(m[1]) !== installationId) return notFound();
      const repos = obj(body)?.["repositories"];
      if (repos !== undefined && (!Array.isArray(repos) || !repos.every((r) => r === name))) {
        return unprocessable("There is at least one repository that does not exist or is not accessible to the parent installation.");
      }
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = clock + TOKEN_TTL_MS;
      tokens.set(token, { expiresAt, revoked: false });
      minted.push(token);
      return json(201, { token, expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"), permissions: { contents: "write" } });
    }
    return notFound();
  }

  function handleRepo(method: string, rest: string, body: unknown): Reply {
    const b = obj(body);
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) !== null) {
      const branch = (m[1] as string).split("/").map(decodeURIComponent).join("/");
      const sha = refs.get(branch);
      return sha === undefined ? notFound() : json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }
    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) !== null) {
      const c = commits.get(m[1] as string);
      if (c === undefined) return notFound();
      const date = iso(commitDates.get(m[1] as string) ?? clock);
      return json(200, {
        sha: m[1],
        tree: { sha: c.tree },
        parents: c.parents.map((sha) => ({ sha })),
        message: c.message,
        committer: { name: "xarabot", email: "x@xarabot.invalid", date },
        author: { name: "xarabot", email: "x@xarabot.invalid", date },
      });
    }
    if (method === "GET" && (m = /^\/git\/trees\/([0-9a-f]{40})(\?recursive=1)?$/.exec(rest)) !== null) {
      const t = trees.get(m[1] as string);
      if (t === undefined) return notFound();
      const dirs = new Set<string>();
      const tree: { path: string; mode: string; type: string; sha: string }[] = [];
      for (const [path, e] of t) {
        const segs = path.split("/");
        for (let i = 1; i < segs.length; i += 1) dirs.add(segs.slice(0, i).join("/"));
        tree.push({ path, mode: e.mode, type: "blob", sha: e.sha });
      }
      for (const d of dirs) tree.push({ path: d, mode: "040000", type: "tree", sha: sha1(`dir ${d}`) });
      tree.sort((a, b) => (a.path < b.path ? -1 : 1));
      const shown = m[2] === undefined ? tree.filter((e) => !e.path.includes("/")) : tree;
      return json(200, { sha: m[1], tree: shown, truncated: truncate });
    }
    if (method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) !== null) {
      const bytes = blobs.get(m[1] as string);
      if (bytes === undefined) return notFound();
      // GitHub wraps base64 content at 60 columns.
      const content = (Buffer.from(bytes).toString("base64").match(/.{1,60}/g) ?? []).join("\n");
      return json(200, { sha: m[1], size: bytes.byteLength, content: content === "" ? "" : `${content}\n`, encoding: "base64" });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const content = b?.["content"];
      const encoding = b?.["encoding"] ?? "utf-8";
      if (typeof content !== "string" || (encoding !== "utf-8" && encoding !== "base64")) return unprocessable("Invalid request.");
      const bytes = encoding === "base64" ? new Uint8Array(Buffer.from(content, "base64")) : new TextEncoder().encode(content);
      return json(201, { sha: putBlob(bytes) });
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = b?.["base_tree"];
      const items = b?.["tree"];
      if (!Array.isArray(items)) return unprocessable("Invalid tree info");
      let entries = new Map<string, Entry>();
      if (base !== undefined) {
        const t = typeof base === "string" ? trees.get(base) : undefined;
        if (t === undefined) return unprocessable("base_tree is not a valid tree oid");
        entries = new Map(t);
      }
      for (const raw of items) {
        const item = obj(raw);
        const path = item?.["path"];
        const mode = item?.["mode"];
        const sha = item?.["sha"];
        if (typeof path !== "string" || typeof mode !== "string" || item?.["type"] !== "blob") return unprocessable("Invalid tree info");
        if (sha === null) entries.delete(path);
        else if (typeof sha === "string" && blobs.has(sha)) entries.set(path, { mode, sha });
        else return unprocessable("tree.sha is not a valid blob");
      }
      return json(201, { sha: putTree(entries) });
    }
    if (method === "POST" && rest === "/git/commits") {
      const message = b?.["message"];
      const tree = b?.["tree"];
      const parents = b?.["parents"] ?? [];
      if (typeof message !== "string" || typeof tree !== "string" || !trees.has(tree)) return unprocessable("Tree SHA does not exist");
      if (!Array.isArray(parents) || !parents.every((p) => typeof p === "string" && commits.has(p))) {
        return unprocessable("Parent SHA does not exist or is not a commit object");
      }
      return json(201, { sha: putCommit({ tree, parents: parents as string[], message }) });
    }
    if (method === "POST" && rest === "/git/refs") {
      const ref = b?.["ref"];
      const sha = b?.["sha"];
      if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || typeof sha !== "string" || !commits.has(sha)) {
        return unprocessable("Invalid request.");
      }
      const branch = ref.slice("refs/heads/".length);
      if (refs.has(branch)) return unprocessable("Reference already exists");
      refs.set(branch, sha);
      return json(201, { ref, object: { sha, type: "commit" } });
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) !== null) {
      const branch = (m[1] as string).split("/").map(decodeURIComponent).join("/");
      const current = refs.get(branch);
      const sha = b?.["sha"];
      if (current === undefined) return unprocessable("Reference does not exist");
      if (typeof sha !== "string" || !commits.has(sha)) return unprocessable("Object does not exist");
      if (b?.["force"] !== true && !isAncestor(current, sha)) return unprocessable("Update is not a fast forward");
      refs.set(branch, sha);
      return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }
    if (method === "DELETE" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) !== null) {
      // GitHub closes an open PR whose head branch is deleted, keeping its last head.
      const branch = (m[1] as string).split("/").map(decodeURIComponent).join("/");
      if (!refs.has(branch)) return unprocessable("Reference does not exist");
      for (const p of pulls.values()) {
        if (p.branch === branch && p.state === "open") {
          p.head_sha = headOf(p);
          p.state = "closed";
        }
      }
      refs.delete(branch);
      return { status: 204, body: undefined, headers: {} };
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(rest)) !== null) {
      const n = Number(m[1]);
      const p = pulls.get(n);
      if (p === undefined) return notFound();
      return json(200, pullJson(n, p));
    }
    if (method === "PATCH" && (m = /^\/pulls\/(\d+)$/.exec(rest)) !== null) {
      const n = Number(m[1]);
      const p = pulls.get(n);
      if (p === undefined) return notFound();
      if (p.merged) return validation([{ resource: "PullRequest", code: "custom", message: "Cannot update a merged pull request" }]);
      const title = b?.["title"];
      const text = b?.["body"];
      const state = b?.["state"];
      if (title !== undefined && typeof title !== "string") return unprocessable("Invalid request.");
      if (text !== undefined && typeof text !== "string") return unprocessable("Invalid request.");
      if (state !== undefined && state !== "open" && state !== "closed") return unprocessable("Invalid request.");
      if (typeof title === "string") p.title = title;
      if (typeof text === "string") p.body = text;
      if (state === "closed" && p.state === "open") {
        p.head_sha = headOf(p);
        p.state = "closed";
      }
      return json(200, pullJson(n, p));
    }
    const [route = "", query = ""] = rest.split("?", 2);
    const params = new URLSearchParams(query);
    if (method === "GET" && route === "/pulls") {
      const head = params.get("head");
      const state = params.get("state") ?? "open";
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const list = [...pulls]
        .filter(([, p]) => head === null || `${owner}:${p.branch}` === head)
        .filter(([, p]) => state === "all" || p.state === state)
        .sort(([a], [b2]) => b2 - a)
        .map(([n, p]) => pullJson(n, p));
      return json(200, list.slice((page - 1) * perPage, page * perPage));
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/reviews$/.exec(route)) !== null) {
      const n = Number(m[1]);
      if (!pulls.has(n)) return notFound();
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const list = (reviews.get(n) ?? []).map((r) => ({
        id: r.id,
        user: r.login === null ? null : { login: r.login },
        state: r.state,
        commit_id: r.commit_id,
        submitted_at: r.submitted_at,
        body: r.body ?? "",
      }));
      return json(200, list.slice((page - 1) * perPage, page * perPage));
    }
    if (method === "POST" && (m = /^\/pulls\/(\d+)\/reviews$/.exec(route)) !== null) {
      const n = Number(m[1]);
      const p = pulls.get(n);
      if (p === undefined) return notFound();
      const commitId = b?.["commit_id"];
      const text = b?.["body"];
      const event = b?.["event"];
      if (typeof commitId !== "string" || typeof text !== "string" || typeof event !== "string") return unprocessable("Invalid request.");
      // An App's installation token may only comment here: an approval or a change request is refused.
      if (event !== "COMMENT") return unprocessable(`Unprocessable Entity: event ${event} is not allowed`);
      const review = { login: botLogin, state: "COMMENTED", commit_id: commitId, submitted_at: iso(clock), body: text, id: reviewCounter++ };
      reviews.set(n, [...(reviews.get(n) ?? []), review]);
      return json(200, { id: review.id, user: { login: botLogin }, state: review.state, commit_id: commitId, submitted_at: review.submitted_at, body: text });
    }
    if (method === "POST" && route === "/pulls") {
      const title = b?.["title"];
      const head = b?.["head"];
      const base = b?.["base"];
      const text = b?.["body"];
      if (typeof title !== "string" || typeof head !== "string" || typeof base !== "string") return unprocessable("Invalid request.");
      const branch = head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : head;
      const errors: Record<string, unknown>[] = [];
      if (!refs.has(base)) errors.push({ resource: "PullRequest", field: "base", code: "invalid" });
      if (!refs.has(branch)) errors.push({ resource: "PullRequest", field: "head", code: "invalid" });
      if (errors.length > 0) return validation(errors);
      for (const p of pulls.values()) {
        if (p.branch === branch && p.base === base && p.state === "open") {
          return validation([{ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${owner}:${branch}.` }]);
        }
      }
      const n = nextNumber();
      const p: PullRecord = { state: "open", merged: false, head_sha: refs.get(branch) as string, branch, base, title, body: typeof text === "string" ? text : null, merge_commit_sha: null };
      pulls.set(n, p);
      return json(201, pullJson(n, p));
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(route)) !== null) {
      const n = Number(m[1]);
      if (!pulls.has(n) && !issues.has(n)) return notFound();
      const text = b?.["body"];
      if (typeof text !== "string") return unprocessable("Invalid request.");
      return json(201, commentJson(n, addComment(n, text, botLogin)));
    }
    if (method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(route)) !== null) {
      const n = Number(m[1]);
      if (!pulls.has(n) && !issues.has(n)) return notFound();
      const since = params.get("since");
      const from = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
      if (Number.isNaN(from)) return unprocessable("Invalid since");
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const list = (comments.get(n) ?? []).filter((c) => Date.parse(c.created_at) >= from).map((c) => commentJson(n, c));
      return json(200, list.slice((page - 1) * perPage, page * perPage));
    }
    if (method === "GET" && route === "/issues") {
      const labels = (params.get("labels") ?? "").split(",").filter((l) => l !== "");
      const assignee = params.get("assignee");
      const state = params.get("state") ?? "open";
      const direction = params.get("direction") ?? "desc";
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const list = [...issues.values()]
        .filter((i) => labels.every((l) => i.labels.includes(l)))
        .filter((i) => assignee === null || i.assignees.includes(assignee))
        .filter((i) => state === "all" || i.state === state)
        .sort((x, y) => (direction === "asc" ? x.number - y.number : y.number - x.number))
        .map(issueJson);
      return json(200, list.slice((page - 1) * perPage, page * perPage));
    }
    if (method === "POST" && route === "/issues") {
      const title = b?.["title"];
      const text = b?.["body"] ?? "";
      const labels = b?.["labels"] ?? [];
      const assignees = b?.["assignees"] ?? [];
      if (typeof title !== "string" || typeof text !== "string") return unprocessable("Invalid request.");
      if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) return unprocessable("Invalid request.");
      if (!Array.isArray(assignees) || !assignees.every((l) => typeof l === "string")) return unprocessable("Invalid request.");
      const issue: FakeIssue = { number: nextNumber(), title, body: text, state: "open", labels: labels as string[], assignees: assignees as string[], author: botLogin };
      issues.set(issue.number, issue);
      return json(201, issueJson(issue));
    }
    if (method === "PATCH" && (m = /^\/issues\/(\d+)$/.exec(route)) !== null) {
      const n = Number(m[1]);
      const issue = issues.get(n);
      if (issue === undefined) return notFound();
      const title = b?.["title"];
      const text = b?.["body"];
      const state = b?.["state"];
      if (title !== undefined && typeof title !== "string") return unprocessable("Invalid request.");
      if (text !== undefined && text !== null && typeof text !== "string") return unprocessable("Invalid request.");
      if (state !== undefined && state !== "open" && state !== "closed") return unprocessable("Invalid request.");
      const updated: FakeIssue = {
        ...issue,
        ...(typeof title === "string" ? { title } : {}),
        ...(text !== undefined ? { body: text ?? "" } : {}),
        ...(state === "open" || state === "closed" ? { state } : {}),
      };
      issues.set(n, updated);
      return json(200, issueJson(updated));
    }
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]{40})\/status$/.exec(route)) !== null) {
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const list = (statuses.get(m[1] as string) ?? []).map((st, i) => ({ id: 9000 + i, context: st.context, state: st.state, description: null, target_url: null }));
      const states = list.map((x) => x.state);
      const combined = states.length === 0 ? "pending" : states.some((x) => x === "failure" || x === "error") ? "failure" : states.every((x) => x === "success") ? "success" : "pending";
      return json(200, { state: combined, sha: m[1], total_count: list.length, statuses: list.slice((page - 1) * perPage, page * perPage) });
    }
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(route)) !== null) {
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const runs = (checkRuns.get(m[1] as string) ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        app: { slug: c.app ?? "github-actions" },
        output: { title: c.output?.title ?? null, summary: c.output?.summary ?? null, text: c.output?.text ?? null },
        details_url: c.details_url ?? `https://github.test/${owner}/${name}/runs/${c.id}`,
      }));
      return json(200, { total_count: runs.length, check_runs: runs.slice((page - 1) * perPage, page * perPage) });
    }
    if (method === "GET" && (m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(route)) !== null) {
      const id = Number(m[1]);
      if (!jobLogs.has(id)) return notFound();
      const signed = `/jobs/${id}/${randomBytes(8).toString("hex")}`;
      logUrls.set(signed, id);
      return { status: 302, body: undefined, headers: { location: `${LOGS_HOST}${signed}?sig=x` } };
    }
    return notFound();
  }

  const fetch: FetchLike = async (url, init) => {
    const signal = init.signal ?? undefined;
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) throw abortError();
    await tick();
    if (signal?.aborted) throw abortError();

    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    if (url.startsWith(`${LOGS_HOST}/`)) {
      const path = url.slice(LOGS_HOST.length);
      const auth = headers["authorization"] === undefined ? "none" : headers["authorization"].split(".").length === 3 ? "jwt" : "token";
      log.push({ method, host: "logs", path, auth, body: undefined, headers });
      const id = logUrls.get(path.split("?")[0] as string);
      if (method !== "GET" || id === undefined) return new Response("not found", { status: 404 });
      return new Response(jobLogs.get(id) ?? "", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (!url.startsWith(API)) throw new TypeError(`fake GitHub: unexpected host in ${url}`);
    const path = url.slice(API.length);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const authHeader = headers["authorization"] ?? "";
    const credential = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isJwt = credential.split(".").length === 3;
    log.push({ method, host: "api", path, auth: credential === "" ? "none" : isJwt ? "jwt" : "token", body, headers });

    const hook = takeMatch(hooks, method, path);
    hook?.fn();

    const date = new Date(clock).toUTCString();
    const respond = (r: Reply): Response => {
      const h: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...r.headers };
      if (withDate) h["date"] = date;
      if (r.body === undefined) delete h["content-type"];
      // A 204 carries no body at all.
      return new Response(r.status === 204 ? null : r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: h });
    };

    const injected = takeMatch(injections, method, path);
    if (injected !== undefined) {
      if (injected.r === "network-error") throw new TypeError("fetch failed: connection reset");
      return respond({ status: injected.r.status, body: injected.r.body ?? {}, headers: { ...injected.r.headers } });
    }

    if (headers["accept"] !== "application/vnd.github+json" || headers["x-github-api-version"] !== "2022-11-28") {
      return respond(json(400, { message: "missing Accept or X-GitHub-Api-Version" }));
    }
    const appRoute = path.startsWith("/app/") || path === `${repoPrefix}/installation`;
    if (appRoute) {
      if (!isJwt || !verifyJwt(credential)) return respond(json(401, { message: "A JSON web token could not be decoded" }));
      return respond(handleJwt(method, path, body));
    }
    if (method === "GET" && path.startsWith("/users/")) {
      // Public users need no credential; only the App's bot account exists.
      const login = decodeURIComponent(path.slice("/users/".length));
      if (login !== botLogin) return respond(notFound());
      return respond(json(200, { login: botLogin, id: botUserId, type: "Bot" }));
    }
    if (!tokenValid(credential)) return respond(json(401, { message: "Bad credentials" }));
    if (method === "POST" && path === "/graphql") return respond(handleGraphql(body));
    if (!path.startsWith(`${repoPrefix}/`)) return respond(notFound());
    return respond(handleRepo(method, path.slice(repoPrefix.length), body));
  };

  const control: FakeGitHubControl = {
    apiUrl: API,
    installationId,
    clock: () => clock,
    setClock(ms) {
      clock = ms;
    },
    setNow(iso) {
      clock = Date.parse(iso);
    },
    advance(ms) {
      clock += ms;
    },
    setInstalled(on) {
      installed = on;
    },
    setMain(files) {
      const parent = refs.get(mainBranch);
      const sha = putCommit({ tree: treeOf(files), parents: parent === undefined ? [] : [parent], message: "main" });
      refs.set(mainBranch, sha);
      return sha;
    },
    writeForeignLedger(commit) {
      let tip = refs.get(ledgerBranch);
      if (tip === undefined) {
        tip = putCommit({ tree: EMPTY_TREE, parents: [], message: "foreign root" });
        refs.set(ledgerBranch, tip);
      }
      const files = filesAt(tip);
      for (const path of commit.deletes) delete files[path];
      Object.assign(files, commit.writes);
      const sha = putCommit({ tree: treeOf(files), parents: [tip], message: commit.message });
      refs.set(ledgerBranch, sha);
      return sha;
    },
    ref: (branch) => refs.get(branch),
    files: (branch) => filesAt(refs.get(branch)),
    commit: (sha) => commits.get(sha),
    setPull(number, pull) {
      pulls.set(number, {
        state: pull.state,
        merged: pull.merged,
        head_sha: pull.head_sha,
        branch: pull.branch ?? `pr-${number}`,
        base: pull.base ?? mainBranch,
        title: pull.title ?? `PR ${number}`,
        body: pull.body === undefined ? "" : pull.body,
        merge_commit_sha: pull.merge_commit_sha ?? null,
      });
    },
    pull: (number) => {
      const p = pulls.get(number);
      return p === undefined ? undefined : pullJson(number, p);
    },
    setBranch(branch, sha) {
      refs.set(branch, sha);
    },
    tokenValid,
    comments: (number) => (comments.get(number) ?? []).map((c) => c.body),
    commentRecords: (number) => [...(comments.get(number) ?? [])],
    addReview(number, review) {
      if (!pulls.has(number)) throw new Error(`addReview: no PR #${number}`);
      reviews.set(number, [...(reviews.get(number) ?? []), { ...review, id: reviewCounter++ }]);
    },
    reviews: (number) => (reviews.get(number) ?? []).map(({ id: _id, ...r }) => ({ ...r })),
    reviewBodies: (number) => (reviews.get(number) ?? []).filter((r) => r.login === botLogin).map((r) => r.body ?? ""),
    addComment(number, text, login) {
      addComment(number, text, login);
    },
    issues: () => [...issues.values()].sort((a, b) => a.number - b.number),
    setIssue(issue) {
      const number = issue.number ?? nextNumber();
      issues.set(number, { ...issue, number });
      return number;
    },
    queue() {
      pruneQueue();
      return queue.map((e) => e.number);
    },
    mergeQueueHead() {
      pruneQueue();
      const entry = queue.shift();
      if (entry === undefined) return null;
      const p = pulls.get(entry.number) as PullRecord;
      p.head_sha = headOf(p);
      p.merged = true;
      p.state = "closed";
      const parent = refs.get(mainBranch);
      const merge = putCommit({ tree: commits.get(parent ?? "")?.tree ?? EMPTY_TREE, parents: parent === undefined ? [] : [parent], message: `merge #${entry.number}` });
      refs.set(mainBranch, merge);
      p.merge_commit_sha = merge;
      return { number: entry.number, branch: p.branch, base: p.base, state: "merged", head_sha: p.head_sha, title: p.title, body: p.body ?? "", merge_sha: merge };
    },
    setStatuses(sha, list) {
      statuses.set(
        sha,
        list.map((x) => ({ ...x })),
      );
    },
    setChecks(sha, checks) {
      const old = checkRuns.get(sha) ?? [];
      checkRuns.set(
        sha,
        checks.map((c) => ({ ...c, id: old.find((o) => o.name === c.name)?.id ?? checkCounter++ })),
      );
    },
    setCiLog(sha, check, text) {
      const run = (checkRuns.get(sha) ?? []).find((c) => c.name === check);
      if (run === undefined) throw new Error(`fake GitHub: no check ${check} on ${sha}`);
      jobLogs.set(run.id, text);
    },
    revokeTokens() {
      for (const t of tokens.values()) t.revoked = true;
    },
    tokens: () => [...minted],
    mints: () => minted.length,
    truncateTrees(on) {
      truncate = on;
    },
    inject(method, path, response) {
      injections.push({ m: { method, path }, r: response });
    },
    before(method, path, fn) {
      hooks.push({ m: { method, path }, fn });
    },
    omitDate(on) {
      withDate = !on;
    },
    log: () => [...log],
    clearLog() {
      log.length = 0;
    },
  };

  // A repo starts with an empty `main`.
  control.setMain({});
  return { fetch, control };
}

let keys: { readonly privateKey: KeyObject; readonly publicKey: KeyObject } | undefined;

/** One RSA key pair per test process (generating one takes a while). */
export function testKeys(): { readonly privateKey: KeyObject; readonly publicKey: KeyObject } {
  keys ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return keys;
}
