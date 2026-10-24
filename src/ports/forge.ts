import type { LedgerCommit } from "../core/ledger/edits.ts";
import type { AssembleInput } from "../core/next/snapshot.ts";
import { ok } from "../core/result.ts";
import type { PrState } from "../core/schemas/snapshot.ts";

/**
 * The `Forge` port (FR24, AR1, AR28, AR33): everything the runner asks of a
 * forge. An adapter makes one attempt per call, never throws, and returns a
 * `ForgeResult`. Every call takes an `AbortSignal` deadline as its last
 * argument; a call whose signal is aborted before it completes returns
 * `transient` and changes nothing. There is deliberately no approve, merge,
 * admin-merge, auto-merge or branch-delete operation.
 */

/** A full lowercase hex git SHA (40 or 64 digits). */
export type GitSha = string;

export const FORGE_ERROR_KINDS = [
  "conflict",
  "not-fast-forward",
  "auth",
  "forbidden",
  "rate-limited",
  "not-found",
  "uninstalled",
  "transient",
] as const;
export type ForgeErrorKind = (typeof FORGE_ERROR_KINDS)[number];

/** Kinds that stop the lane (with an alert, Story 1.16). */
export const LANE_STOP_KINDS = ["auth", "forbidden", "uninstalled"] as const satisfies readonly ForgeErrorKind[];
/** Kinds a caller backs off on and retries. */
export const BACKOFF_KINDS = ["rate-limited", "transient"] as const satisfies readonly ForgeErrorKind[];

export type LaneStopKind = (typeof LANE_STOP_KINDS)[number];
export type BackoffKind = (typeof BACKOFF_KINDS)[number];

export type ForgeError =
  | { readonly kind: Exclude<ForgeErrorKind, "rate-limited">; readonly message: string }
  /** `retry_after`: whole seconds ≥ 0 to wait before the next call. */
  | { readonly kind: "rate-limited"; readonly message: string; readonly retry_after: number };

export type ForgeFailure = { readonly ok: false; readonly error: ForgeError };
export type ForgeResult<T> = { readonly ok: true; readonly value: T } | ForgeFailure;

export function forgeOk<T>(value: T): { readonly ok: true; readonly value: T } {
  return ok(value);
}

export function forgeErr(kind: Exclude<ForgeErrorKind, "rate-limited">, message: string): ForgeFailure {
  return { ok: false, error: { kind, message } };
}

/** A `rate-limited` failure; `retryAfter` is rounded up to whole seconds, never below 0. */
export function rateLimited(retryAfter: number, message: string): ForgeFailure {
  const seconds = Number.isFinite(retryAfter) ? Math.max(0, Math.ceil(retryAfter)) : 0;
  return { ok: false, error: { kind: "rate-limited", message, retry_after: seconds } };
}

/** The `transient` failure of a call whose deadline passed. */
export function deadlinePassed(operation: string): ForgeFailure {
  return forgeErr("transient", `${operation}: deadline passed`);
}

export function isLaneStopKind(kind: ForgeErrorKind): kind is LaneStopKind {
  return (LANE_STOP_KINDS as readonly string[]).includes(kind);
}

export function isBackoffKind(kind: ForgeErrorKind): kind is BackoffKind {
  return (BACKOFF_KINDS as readonly string[]).includes(kind);
}

/** The deadline every call carries. */
export type CallOpts = { readonly signal: AbortSignal };

export type SnapshotOpts = CallOpts & {
  /** Which `main` paths to read the contents of; default none. */
  readonly read?: (path: string) => boolean;
};

/**
 * One forge read: the ledger tip and files (read first), then `main`, then
 * the PR state of every unit record whose `pr` is set, keyed by unit id.
 * `now` is the forge's server time. The parts feed `assembleSnapshot`.
 */
export type ForgeSnapshot = {
  readonly now: AssembleInput["now"];
  readonly ledger: { readonly tip: GitSha; readonly files: AssembleInput["ledger_files"] };
  readonly main: {
    readonly sha: GitSha;
    readonly tree: AssembleInput["tree"];
    readonly files: AssembleInput["files"];
    readonly blob_shas: AssembleInput["blob_shas"];
  };
  readonly prs: AssembleInput["prs"];
};

export type ForgePrState = PrState["state"];

export type ForgePr = {
  readonly number: number;
  readonly branch: string;
  readonly base: string;
  readonly state: ForgePrState;
  readonly head_sha: GitSha;
  readonly title: string;
  readonly body: string;
};

/** A push with a lease: `expected_sha: null` means the branch must not exist yet. */
export type PushLease = {
  readonly branch: string;
  readonly expected_sha: GitSha | null;
  readonly sha: GitSha;
};

export type OpenPrRequest = {
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
};

export type UpdatePrRequest = { readonly title?: string; readonly body?: string };

export type CheckStatus = "queued" | "in_progress" | "completed";

export type ForgeCheck = {
  readonly name: string;
  readonly status: CheckStatus;
  readonly conclusion: string | null;
};

export type PrefetchRequest = {
  readonly kind: "ci-log";
  readonly sha: GitSha;
  /** Directory the logs are written into, one file per failing check. */
  readonly dir: string;
};

/** A PR as the merge queue sees it: an ejected PR is `open`, not `queued`, at the same head. */
export type QueueState = {
  readonly state: ForgePrState;
  readonly head_sha: GitSha;
  readonly queued: boolean;
};

export type Forge = {
  snapshot(opts: SnapshotOpts): Promise<ForgeResult<ForgeSnapshot>>;
  /** Fast-forward only: the tip must still be `oldSha`, else `conflict`. One new commit. */
  ledgerSwap(oldSha: GitSha, commit: LedgerCommit, opts: CallOpts): Promise<ForgeResult<{ readonly tip: GitSha }>>;
  /** A remote head other than `lease.expected_sha` is `conflict`. */
  pushBranch(lease: PushLease, opts: CallOpts): Promise<ForgeResult<{ readonly sha: GitSha }>>;
  /** A missing branch is `not-found`; a second open PR on one branch is `conflict`. */
  openPr(request: OpenPrRequest, opts: CallOpts): Promise<ForgeResult<ForgePr>>;
  /** Updating a merged PR is `conflict`. */
  updatePr(pr: number, request: UpdatePrRequest, opts: CallOpts): Promise<ForgeResult<ForgePr>>;
  /** Closing a merged PR is `conflict`. */
  closePr(pr: number, opts: CallOpts): Promise<ForgeResult<ForgePr>>;
  /** Every PR on `branch` in any state, ascending by number. */
  listPrsByBranch(branch: string, opts: CallOpts): Promise<ForgeResult<readonly ForgePr[]>>;
  /** Posts `body` verbatim as one comment on PR `pr`. */
  comment(pr: number, body: string, opts: CallOpts): Promise<ForgeResult<{ readonly id: string }>>;
  /** The checks on `sha`; an empty list means pending. */
  checks(sha: GitSha, opts: CallOpts): Promise<ForgeResult<{ readonly checks: readonly ForgeCheck[] }>>;
  /** The PR must be open with head `expectedHead`, else `conflict`. Already queued is `ok`. */
  enqueue(pr: number, expectedHead: GitSha, opts: CallOpts): Promise<ForgeResult<{ readonly queued: true }>>;
  /** `ok` when not queued. */
  dequeue(pr: number, opts: CallOpts): Promise<ForgeResult<{ readonly queued: false }>>;
  /** A PR's state, head and whether it is in the merge queue. Read-only; a missing PR is `not-found`. */
  queueState(pr: number, opts: CallOpts): Promise<ForgeResult<QueueState>>;
  /** Posts once per (`condition`, `mainSha`) pair; a repeat posts nothing. */
  alert(condition: string, mainSha: GitSha, opts: CallOpts): Promise<ForgeResult<{ readonly posted: boolean }>>;
  /** Writes the failing checks' logs for `sha` into `dir`; returns their absolute paths. */
  prefetch(request: PrefetchRequest, opts: CallOpts): Promise<ForgeResult<{ readonly files: readonly string[] }>>;
};

export type ForgeOperation = keyof Forge;

/** Every `Forge` operation, in declaration order. */
export const FORGE_OPERATIONS = [
  "snapshot",
  "ledgerSwap",
  "pushBranch",
  "openPr",
  "updatePr",
  "closePr",
  "listPrsByBranch",
  "comment",
  "checks",
  "enqueue",
  "dequeue",
  "queueState",
  "alert",
  "prefetch",
] as const satisfies readonly ForgeOperation[];

/* Compile-time check: `FORGE_OPERATIONS` lists every key of `Forge`. */
type True<T extends true> = T;
type _OperationsComplete = True<[ForgeOperation] extends [(typeof FORGE_OPERATIONS)[number]] ? true : false>;
