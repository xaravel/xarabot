import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseLedger } from "../../../core/ledger/codec.ts";
import type { LedgerCommit } from "../../../core/ledger/edits.ts";
import { PR_REVIEW_DECISIONS, type PrReview, type PrState } from "../../../core/schemas/snapshot.ts";
import {
  deadlinePassed,
  DEFAULT_UNIT_BRANCH_PREFIX,
  forgeErr,
  forgeOk,
  type CallOpts,
  type Forge,
  type ForgeCheck,
  type ForgeError,
  type ForgeOperation,
  type ForgePr,
  type ForgeResult,
  type ForgeReview,
  type GitSha,
  inBranchNamespace,
  type InboxComment,
  type InboxIssue,
} from "../../../ports/forge.ts";

/**
 * An in-memory `Forge` for tests (AR28, AR33). State lives in memory only and
 * the fake never touches the network; `prefetch` writes the log files it is
 * asked for. Each call makes one attempt and yields a macrotask before any
 * state change, so concurrent calls interleave; the compare-and-set itself is
 * synchronous. Blob SHAs are real git blob SHA-1s; commit SHAs are
 * deterministic per forge instance. Tests drive it through `control`, which
 * is not part of `Forge`. An inbox comment's id comes from the counter PR
 * comments and reviews share, so ids rise with time across all of them;
 * `readRulings` returns the comments posted before it began, and its cursor
 * is the id of the last comment it returned.
 */

export type FakeForgeOptions = {
  /** The forge's server time; default `2026-01-01T00:00:00Z`. */
  readonly now?: string;
  /** `main`'s files (path → text); default none. */
  readonly main?: Readonly<Record<string, string>>;
  /** The number the first opened PR gets; default 1. */
  readonly firstPrNumber?: number;
  /** The ledger root's files (path → JSON text); default none. */
  readonly ledger?: Readonly<Record<string, string>>;
  /** The login `postReview`'s reviews are by; default `FAKE_BOT_LOGIN`. */
  readonly botLogin?: string;
  /** The number the first inbox issue gets; default 1001, apart from PR numbers. */
  readonly firstIssueNumber?: number;
  /** The repo's web URL, for inbox issue links; default `FAKE_REPO_URL`. */
  readonly repoUrl?: string;
  /** The runner's unit-branch namespace, the only one `deleteBranch` deletes in; default `xarabot/`. */
  readonly unitBranchPrefix?: string;
};

/** The repo web URL the fake's inbox issues link under, unless `repoUrl` names another. */
export const FAKE_REPO_URL = "https://github.com/fake/repo";
/** The title `openInbox` gives an inbox it creates. */
export const FAKE_INBOX_TITLE = "🤖 Xarabot inbox";

/** The bot account the fake's own reviews are by, unless `botLogin` names another. */
export const FAKE_BOT_LOGIN = "fake-xarabot[bot]";

/** One commit on the ledger branch. `parent` is `null` for the empty root. */
export type FakeLedgerCommit = {
  readonly sha: GitSha;
  readonly parent: GitSha | null;
  readonly message: string;
};

export type FakeAlert = { readonly condition: string; readonly main_sha: GitSha };

/** An inbox issue as the fake holds it. */
export type FakeInbox = {
  readonly number: number;
  readonly title: string;
  readonly owner: string | null;
  readonly body: string;
  readonly open: boolean;
};

/** Runs inside `ledgerSwap` after its yield and before the compare-and-set. */
export type BeforeSwapHook = (call: { readonly n: number; readonly oldSha: GitSha }) => void | Promise<void>;

export type FakeForgeControl = {
  /** Replaces `main`'s files as one new commit; returns its SHA. */
  setMain(files: Readonly<Record<string, string>>): GitSha;
  setNow(now: string): void;
  /** Writes a ledger commit on the current tip as another lane would; returns the new tip. */
  writeForeignLedger(commit: LedgerCommit): GitSha;
  /** A fresh commit SHA to push. */
  makeCommit(): GitSha;
  setChecks(sha: GitSha, checks: readonly ForgeCheck[]): void;
  setCiLog(sha: GitSha, check: string, log: string): void;
  /** The next call of `operation` returns `error` and changes nothing. */
  injectError(operation: ForgeOperation, error: ForgeError): void;
  /** Later pushes to `branch` are `rejected`, as a repository rule refuses them, and move nothing. */
  refusePushes(branch: string): void;
  /** Runs `hook` before every swap's compare-and-set; `null` removes it. */
  beforeSwap(hook: BeforeSwapHook | null): void;
  /** The next `ledgerSwap` that lands returns `transient` "ack lost", as a lost acknowledgement does. */
  loseSwapAck(): void;
  /** Merges the PR at the head of the queue onto `main`; `null` when the queue is empty. */
  mergeQueueHead(): ForgePr | null;
  /** Takes a queued PR out of the queue without merging it, as an ejection does; `false` when it was not queued. */
  eject(pr: number): boolean;
  /** Appends a review to PR `pr` (which must exist), as its author submitting it would. */
  addReview(pr: number, review: ForgeReview): void;
  /** Comment bodies on PR `pr`, oldest first. */
  comments(pr: number): string[];
  /** The bodies of the reviews `postReview` posted on PR `pr`, oldest first. */
  reviewBodies(pr: number): string[];
  alerts(): FakeAlert[];
  /** Every inbox issue, open or closed, ascending by number. */
  inboxes(): FakeInbox[];
  /** Comment bodies on inbox issue `issue`, oldest first. */
  inboxComments(issue: number): string[];
  /** Adds a comment by `author` on inbox issue `issue` (which must exist) at the forge's time, as that user posting it would; returns its id. */
  addInboxComment(issue: number, author: string, body: string): string;
  /**
   * Adds a comment as `addInboxComment` does, once, while the next
   * `readRulings` runs: just before it reads open inbox `read`'s comments,
   * after it read every lower-numbered one. Several run in the order added.
   */
  addInboxCommentBeforeRead(read: number, issue: number, author: string, body: string): void;
  /** Closes inbox issue `issue`, as its owner closing it would; `false` when there is none. */
  closeInbox(issue: number): boolean;
  /**
   * Opens an issue labelled with the inbox label, as a person labelling one
   * would: `by_runner` false, assigned to `owner` (`null` for nobody), with
   * `body`. Returns its number.
   */
  labelIssue(owner: string | null, body: string): number;
  /** Queued PR numbers, head first. */
  queue(): number[];
  /** Reads `snapshot` made, in order: `ledger`, `main`, `prs`. */
  trace(): string[];
  /** Ledger commits, root first. */
  ledgerLog(): FakeLedgerCommit[];
};

export type FakeForge = { readonly forge: Forge; readonly control: FakeForgeControl };

const DEFAULT_NOW = "2026-01-01T00:00:00Z";
/** Branches only the forge itself writes. */
const RESERVED_BRANCHES: readonly string[] = ["main", "xarabot/claims"];
const PASSING_CONCLUSIONS: readonly string[] = ["success", "neutral", "skipped"];
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A GitHub login, as the GitHub adapter checks one. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function sha1(...parts: (string | Uint8Array)[]): string {
  const hasher = new Bun.CryptoHasher("sha1");
  for (const part of parts) hasher.update(part);
  return hasher.digest("hex");
}

/** The git blob SHA-1 of `text`, as `git hash-object` computes it. */
export function gitBlobSha(text: string): GitSha {
  const bytes = new TextEncoder().encode(text);
  return sha1(`blob ${bytes.byteLength}\0`, bytes);
}

/** Yields one macrotask. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * A file name for a check's log: unsafe characters become `-`. `taken` holds
 * lowercased names, so names differing only in case never collide on a
 * case-insensitive filesystem.
 */
function logFileName(check: string, taken: Set<string>): string {
  const base = check.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "check";
  let name = `${base}.log`;
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${base}-${i}.log`;
  taken.add(name.toLowerCase());
  return name;
}

type PrRecord = {
  number: number;
  branch: string;
  base: string;
  state: ForgePr["state"];
  head_sha: GitSha;
  title: string;
  body: string;
  /** The `main` SHA `mergeQueueHead` made; `null` until then. */
  merge_sha: GitSha | null;
};

/** A comment on an inbox issue; `id` is numeric. */
type InboxCommentRecord = { readonly id: number; readonly author: string; readonly body: string; readonly created_at: string };

type InboxRecord = { number: number; title: string; owner: string | null; body: string; open: boolean; by_runner: boolean; comments: InboxCommentRecord[] };

/** A cursor `readRulings` issues: a comment id. */
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export function createFakeForge(options: FakeForgeOptions = {}): FakeForge {
  let commits = 0;
  const newSha = (kind: string): GitSha => sha1(`fake-forge ${kind} ${commits++}`);

  let now = options.now ?? DEFAULT_NOW;

  const rootSha = newSha("ledger");
  let ledgerTip = rootSha;
  let ledgerFiles: Record<string, string> = { ...options.ledger };
  const ledgerLog: FakeLedgerCommit[] = [{ sha: rootSha, parent: null, message: "root" }];

  let mainSha = newSha("main");
  let mainFiles: Record<string, string> = { ...options.main };

  const branches = new Map<string, GitSha>();
  const prs = new Map<number, PrRecord>();
  let nextPr = options.firstPrNumber ?? 1;
  const comments = new Map<number, string[]>();
  const reviews = new Map<number, ForgeReview[]>();
  const reviewBodies = new Map<number, string[]>();
  const botLogin = options.botLogin ?? FAKE_BOT_LOGIN;
  let nextComment = 1;
  const checks = new Map<GitSha, ForgeCheck[]>();
  const ciLogs = new Map<GitSha, Map<string, string>>();
  const queue: number[] = [];
  const alerts: FakeAlert[] = [];
  const inboxes = new Map<number, InboxRecord>();
  /** Comments `readRulings` adds just before it reads an inbox's comments, by that inbox's number. */
  const beforeRead = new Map<number, (() => void)[]>();
  let nextIssue = options.firstIssueNumber ?? 1001;
  const repoUrl = options.repoUrl ?? FAKE_REPO_URL;
  const unitBranchPrefix = options.unitBranchPrefix ?? DEFAULT_UNIT_BRANCH_PREFIX;
  const inboxView = (i: InboxRecord): InboxIssue => ({ number: i.number, owner: i.owner, body: i.body, url: `${repoUrl}/issues/${i.number}`, by_runner: i.by_runner });
  const commentView = (i: InboxRecord, c: InboxCommentRecord): InboxComment => ({
    id: String(c.id),
    issue: i.number,
    author: c.author,
    body: c.body,
    created_at: c.created_at,
    url: `${repoUrl}/issues/${i.number}#issuecomment-${c.id}`,
  });
  const findInbox = (issue: number, operation: string): ForgeResult<InboxRecord> => {
    const i = inboxes.get(issue);
    return i === undefined ? forgeErr("not-found", `${operation}: no issue #${issue}`) : forgeOk(i);
  };
  const injected = new Map<ForgeOperation, ForgeError>();
  const refused = new Set<string>();
  let hook: BeforeSwapHook | null = null;
  let loseAck = false;
  let swaps = 0;
  const trace: string[] = [];

  const view = (p: PrRecord): ForgePr => ({ ...p });

  function applyLedger(commit: LedgerCommit): GitSha {
    const files = { ...ledgerFiles };
    for (const path of commit.deletes) delete files[path];
    for (const [path, text] of Object.entries(commit.writes)) files[path] = text;
    const sha = newSha("ledger");
    ledgerLog.push({ sha, parent: ledgerTip, message: commit.message });
    ledgerTip = sha;
    ledgerFiles = files;
    return sha;
  }

  function dequeueNumber(pr: number): void {
    const i = queue.indexOf(pr);
    if (i !== -1) queue.splice(i, 1);
  }

  /**
   * One call: fails `transient` on a passed deadline, yields, then returns
   * any injected error before running `body`. `body` re-checks the signal
   * itself if it awaits before changing state.
   */
  async function call<T>(
    operation: ForgeOperation,
    opts: CallOpts,
    body: (signal: AbortSignal) => ForgeResult<T> | Promise<ForgeResult<T>>,
  ): Promise<ForgeResult<T>> {
    try {
      const signal = opts.signal;
      if (signal.aborted) return deadlinePassed(operation);
      await tick();
      if (signal.aborted) return deadlinePassed(operation);
      const error = injected.get(operation);
      if (error !== undefined) {
        injected.delete(operation);
        return { ok: false, error };
      }
      return await body(signal);
    } catch (e) {
      return forgeErr("transient", `${operation}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Each reviewer's latest decisive review (logins compared
   * case-insensitively), oldest first, as GitHub's `latestOpinionatedReviews`
   * reports them; a review with no `submitted_at` never counts.
   */
  function latestDecisive(list: readonly ForgeReview[]): PrReview[] {
    const latest = new Map<string | null, PrReview>();
    for (const r of list) {
      if (r.submitted_at === null || !(PR_REVIEW_DECISIONS as readonly string[]).includes(r.state)) continue;
      const key = r.author?.toLowerCase() ?? null;
      latest.delete(key);
      latest.set(key, { author: r.author, state: r.state as PrReview["state"], commit_sha: r.commit_sha, submitted_at: r.submitted_at });
    }
    return [...latest.values()];
  }

  function findPr(pr: number, operation: string): ForgeResult<PrRecord> {
    const p = prs.get(pr);
    return p === undefined ? forgeErr("not-found", `${operation}: no PR #${pr}`) : forgeOk(p);
  }

  const forge: Forge = {
    snapshot: (opts) =>
      call("snapshot", opts, async (signal) => {
        const read = opts.read ?? (() => false);
        trace.push("ledger");
        const ledger = { tip: ledgerTip, files: { ...ledgerFiles } };
        await tick();
        if (signal.aborted) return deadlinePassed("snapshot");
        trace.push("main");
        const tree = Object.keys(mainFiles).sort();
        const files: Record<string, string> = {};
        const blobShas: Record<string, string> = {};
        for (const path of tree) {
          const text = mainFiles[path] as string;
          blobShas[path] = gitBlobSha(text);
          if (read(path)) files[path] = text;
        }
        const main = { sha: mainSha, tree, files, blob_shas: blobShas };
        await tick();
        if (signal.aborted) return deadlinePassed("snapshot");
        trace.push("prs");
        const states: Record<string, PrState> = {};
        const parsed = parseLedger(ledger.files);
        if (parsed.ok) {
          for (const [unit, record] of parsed.value.units) {
            if (record.pr === null) continue;
            const p = prs.get(record.pr);
            if (p !== undefined) states[unit] = { number: p.number, state: p.state, head_sha: p.head_sha, reviews: latestDecisive(reviews.get(p.number) ?? []) };
          }
        }
        return forgeOk({ now, ledger, main, prs: states });
      }),

    ledgerSwap: (oldSha, commit, opts) =>
      call("ledgerSwap", opts, async (signal) => {
        swaps += 1;
        if (hook !== null) await hook({ n: swaps, oldSha });
        if (signal.aborted) return deadlinePassed("ledgerSwap");
        if (ledgerTip !== oldSha) return forgeErr("conflict", `ledgerSwap: tip is ${ledgerTip}, not ${oldSha}`);
        const tip = applyLedger(commit);
        if (loseAck) {
          loseAck = false;
          return forgeErr("transient", "ledgerSwap: ack lost");
        }
        return forgeOk({ tip });
      }),

    pushBranch: (lease, opts) =>
      call("pushBranch", opts, () => {
        if (RESERVED_BRANCHES.includes(lease.branch)) return forgeErr("forbidden", `pushBranch: ${lease.branch} is protected`);
        if (refused.has(lease.branch)) {
          return forgeErr("rejected", `pushBranch: ${lease.branch}: [remote rejected] (push declined due to repository rule violations)`);
        }
        if (!SHA_PATTERN.test(lease.sha)) return forgeErr("not-found", `pushBranch: no commit ${lease.sha}`);
        const head = branches.get(lease.branch) ?? null;
        if (head !== lease.expected_sha) {
          return forgeErr("conflict", `pushBranch: ${lease.branch} is at ${head ?? "nothing"}, not ${lease.expected_sha ?? "nothing"}`);
        }
        branches.set(lease.branch, lease.sha);
        for (const p of prs.values()) {
          if (p.branch === lease.branch && p.state === "open" && p.head_sha !== lease.sha) {
            p.head_sha = lease.sha;
            dequeueNumber(p.number);
          }
        }
        return forgeOk({ sha: lease.sha });
      }),

    branchHead: (branch, opts) => call("branchHead", opts, () => forgeOk(branches.get(branch) ?? null)),

    deleteBranch: (branch, opts) =>
      call("deleteBranch", opts, () => {
        if (RESERVED_BRANCHES.includes(branch)) return forgeErr("forbidden", `deleteBranch: ${branch} is protected`);
        if (!inBranchNamespace(unitBranchPrefix, branch)) {
          return forgeErr("forbidden", `deleteBranch: ${JSON.stringify(branch)} is outside the runner's branches ${JSON.stringify(unitBranchPrefix)}`);
        }
        for (const p of prs.values()) {
          if (p.branch === branch && p.state === "open") return forgeErr("conflict", `deleteBranch: ${branch} has open PR #${p.number}`);
        }
        return forgeOk({ deleted: branches.delete(branch) });
      }),

    openPr: (request, opts) =>
      call("openPr", opts, () => {
        const head = branches.get(request.branch);
        if (head === undefined) return forgeErr("not-found", `openPr: no branch ${request.branch}`);
        if (request.base !== "main" && !branches.has(request.base)) return forgeErr("not-found", `openPr: no base ${request.base}`);
        for (const p of prs.values()) {
          if (p.branch === request.branch && p.state === "open") {
            return forgeErr("conflict", `openPr: ${request.branch} already has open PR #${p.number}`);
          }
        }
        const p: PrRecord = { number: nextPr++, ...request, state: "open", head_sha: head, merge_sha: null };
        prs.set(p.number, p);
        return forgeOk(view(p));
      }),

    updatePr: (pr, request, opts) =>
      call("updatePr", opts, () => {
        const found = findPr(pr, "updatePr");
        if (!found.ok) return found;
        const p = found.value;
        if (p.state === "merged") return forgeErr("conflict", `updatePr: PR #${pr} is merged`);
        if (request.title !== undefined) p.title = request.title;
        if (request.body !== undefined) p.body = request.body;
        return forgeOk(view(p));
      }),

    closePr: (pr, opts) =>
      call("closePr", opts, () => {
        const found = findPr(pr, "closePr");
        if (!found.ok) return found;
        const p = found.value;
        if (p.state === "merged") return forgeErr("conflict", `closePr: PR #${pr} is merged`);
        p.state = "closed";
        dequeueNumber(pr);
        return forgeOk(view(p));
      }),

    listPrsByBranch: (branch, opts) =>
      call("listPrsByBranch", opts, () =>
        forgeOk(
          [...prs.values()]
            .filter((p) => p.branch === branch)
            .sort((a, b) => a.number - b.number)
            .map(view),
        ),
      ),

    reviews: (pr, opts) =>
      call("reviews", opts, () => {
        const found = findPr(pr, "reviews");
        if (!found.ok) return found;
        return forgeOk((reviews.get(pr) ?? []).map((r) => ({ ...r })));
      }),

    comment: (pr, body, opts) =>
      call("comment", opts, () => {
        const found = findPr(pr, "comment");
        if (!found.ok) return found;
        const list = comments.get(pr) ?? [];
        list.push(body);
        comments.set(pr, list);
        return forgeOk({ id: String(nextComment++) });
      }),

    postReview: (pr, review, opts) =>
      call("postReview", opts, () => {
        const found = findPr(pr, "postReview");
        if (!found.ok) return found;
        const list = reviews.get(pr) ?? [];
        list.push({ author: botLogin, state: "commented", commit_sha: review.commit_sha, submitted_at: now });
        reviews.set(pr, list);
        reviewBodies.set(pr, [...(reviewBodies.get(pr) ?? []), review.body]);
        return forgeOk({ id: String(nextComment++) });
      }),

    checks: (sha, opts) => call("checks", opts, () => forgeOk({ checks: (checks.get(sha) ?? []).map((c) => ({ ...c })) })),

    enqueue: (pr, expectedHead, opts) =>
      call("enqueue", opts, () => {
        const found = findPr(pr, "enqueue");
        if (!found.ok) return found;
        const p = found.value;
        if (p.state !== "open") return forgeErr("conflict", `enqueue: PR #${pr} is ${p.state}`);
        if (p.head_sha !== expectedHead) return forgeErr("conflict", `enqueue: PR #${pr} head is ${p.head_sha}, not ${expectedHead}`);
        if (!queue.includes(pr)) queue.push(pr);
        return forgeOk({ queued: true as const });
      }),

    dequeue: (pr, opts) =>
      call("dequeue", opts, () => {
        const found = findPr(pr, "dequeue");
        if (!found.ok) return found;
        dequeueNumber(pr);
        return forgeOk({ queued: false as const });
      }),

    queueState: (pr, opts) =>
      call("queueState", opts, () => {
        const found = findPr(pr, "queueState");
        if (!found.ok) return found;
        const p = found.value;
        return forgeOk({ state: p.state, head_sha: p.head_sha, queued: queue.includes(pr) });
      }),

    alert: (condition, sha, opts) =>
      call<{ readonly posted: boolean }>("alert", opts, () => {
        if (alerts.some((a) => a.condition === condition && a.main_sha === sha)) return forgeOk({ posted: false });
        alerts.push({ condition, main_sha: sha });
        return forgeOk({ posted: true });
      }),

    prefetch: (request, opts) =>
      call("prefetch", opts, async (signal) => {
        const failing = (checks.get(request.sha) ?? []).filter(
          (c) => c.status === "completed" && c.conclusion !== null && !PASSING_CONCLUSIONS.includes(c.conclusion),
        );
        const logs = ciLogs.get(request.sha);
        const dir = resolve(request.dir);
        await mkdir(dir, { recursive: true });
        const taken = new Set<string>();
        const files: string[] = [];
        for (const c of failing) {
          if (signal.aborted) return deadlinePassed("prefetch");
          const path = resolve(dir, logFileName(c.name, taken));
          await writeFile(path, logs?.get(c.name) ?? "");
          files.push(path);
        }
        if (signal.aborted) return deadlinePassed("prefetch");
        return forgeOk({ files });
      }),

    inboxes: (opts) =>
      call("inboxes", opts, () =>
        forgeOk(
          [...inboxes.values()]
            .filter((i) => i.open)
            .sort((a, b) => a.number - b.number)
            .map(inboxView),
        ),
      ),

    openInbox: (owner, opts) =>
      call("openInbox", opts, () => {
        if (!LOGIN_PATTERN.test(owner)) return forgeErr("rejected", `openInbox: ${JSON.stringify(owner)} is not a GitHub login`);
        const mine = [...inboxes.values()].filter((i) => i.open && i.owner?.toLowerCase() === owner.toLowerCase()).sort((a, b) => a.number - b.number);
        const found = mine[0];
        if (found !== undefined) return forgeOk(inboxView(found));
        const created: InboxRecord = { number: nextIssue++, title: FAKE_INBOX_TITLE, owner, body: "", open: true, by_runner: true, comments: [] };
        inboxes.set(created.number, created);
        return forgeOk(inboxView(created));
      }),

    setInboxBody: (issue, body, opts) =>
      call("setInboxBody", opts, () => {
        const found = findInbox(issue, "setInboxBody");
        if (!found.ok) return found;
        found.value.body = body;
        return forgeOk(inboxView(found.value));
      }),

    inboxComment: (issue, body, opts) =>
      call("inboxComment", opts, () => {
        const found = findInbox(issue, "inboxComment");
        if (!found.ok) return found;
        const id = nextComment++;
        found.value.comments.push({ id, author: botLogin, body, created_at: now });
        return forgeOk({ id: String(id) });
      }),

    readRulings: (cursor, opts) =>
      call("readRulings", opts, () => {
        // A cursor is an id the forge handed out: numeric and below the next one.
        if (cursor !== null && (!CURSOR_PATTERN.test(cursor) || Number(cursor) >= nextComment)) {
          return forgeErr("rejected", `readRulings: ${JSON.stringify(cursor)} is not a cursor this forge issued`);
        }
        const after = cursor === null ? 0 : Number(cursor);
        // Only the comments posted before the read began: one posted while it reads the inboxes is left for a later read.
        const end = nextComment;
        const list: { readonly id: number; readonly view: InboxComment }[] = [];
        for (const i of [...inboxes.values()].sort((a, b) => a.number - b.number)) {
          if (!i.open) continue;
          for (const add of beforeRead.get(i.number) ?? []) add();
          beforeRead.delete(i.number);
          for (const c of i.comments) if (c.id > after && c.id < end) list.push({ id: c.id, view: commentView(i, c) });
        }
        list.sort((a, b) => a.id - b.id);
        const last = list.at(-1);
        return forgeOk({ comments: list.map((c) => c.view), cursor: last === undefined ? cursor : String(last.id) });
      }),
  };

  const control: FakeForgeControl = {
    setMain(files) {
      mainFiles = { ...files };
      mainSha = newSha("main");
      return mainSha;
    },
    setNow(value) {
      now = value;
    },
    writeForeignLedger: (commit) => applyLedger(commit),
    makeCommit: () => newSha("commit"),
    setChecks(sha, list) {
      checks.set(
        sha,
        list.map((c) => ({ ...c })),
      );
    },
    setCiLog(sha, check, log) {
      const logs = ciLogs.get(sha) ?? new Map<string, string>();
      logs.set(check, log);
      ciLogs.set(sha, logs);
    },
    injectError(operation, error) {
      injected.set(operation, error);
    },
    refusePushes(branch) {
      refused.add(branch);
    },
    beforeSwap(h) {
      hook = h;
    },
    loseSwapAck() {
      loseAck = true;
    },
    mergeQueueHead() {
      const number = queue.shift();
      if (number === undefined) return null;
      const p = prs.get(number) as PrRecord;
      p.state = "merged";
      mainSha = newSha("main");
      p.merge_sha = mainSha;
      return view(p);
    },
    eject(pr) {
      if (!queue.includes(pr)) return false;
      dequeueNumber(pr);
      return true;
    },
    addReview(pr, review) {
      if (!prs.has(pr)) throw new Error(`addReview: no PR #${pr}`);
      const list = reviews.get(pr) ?? [];
      list.push({ ...review });
      reviews.set(pr, list);
    },
    comments: (pr) => [...(comments.get(pr) ?? [])],
    reviewBodies: (pr) => [...(reviewBodies.get(pr) ?? [])],
    alerts: () => alerts.map((a) => ({ ...a })),
    inboxes: () =>
      [...inboxes.values()]
        .sort((a, b) => a.number - b.number)
        .map((i) => ({ number: i.number, title: i.title, owner: i.owner, body: i.body, open: i.open })),
    inboxComments: (issue) => (inboxes.get(issue)?.comments ?? []).map((c) => c.body),
    addInboxComment(issue, author, body) {
      const i = inboxes.get(issue);
      if (i === undefined) throw new Error(`addInboxComment: no issue #${issue}`);
      const id = nextComment++;
      i.comments.push({ id, author, body, created_at: now });
      return String(id);
    },
    addInboxCommentBeforeRead(read, issue, author, body) {
      if (!inboxes.has(issue)) throw new Error(`addInboxCommentBeforeRead: no issue #${issue}`);
      beforeRead.set(read, [...(beforeRead.get(read) ?? []), () => control.addInboxComment(issue, author, body)]);
    },
    closeInbox(issue) {
      const i = inboxes.get(issue);
      if (i === undefined) return false;
      i.open = false;
      return true;
    },
    labelIssue(owner, body) {
      const n = nextIssue++;
      inboxes.set(n, { number: n, title: "A labelled issue", owner, body, open: true, by_runner: false, comments: [] });
      return n;
    },
    queue: () => [...queue],
    trace: () => [...trace],
    ledgerLog: () => ledgerLog.map((c) => ({ ...c })),
  };

  return { forge, control };
}
