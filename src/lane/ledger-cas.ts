import type { LedgerCommit, LedgerEdit, LedgerEditErrorKind, LedgerFiles } from "../core/ledger/edits.ts";
import { unitPath, UnitRecordSchema, type UnitRecord } from "../core/schemas/ledger.ts";
import type { Forge, ForgeError, GitSha } from "../ports/forge.ts";

/**
 * The ledger compare-and-swap retry loop (AR7). Each try re-fetches the tip
 * with `snapshot` (no `main` reads), re-applies the pure edit to the tip's
 * files and swaps. A conflict backs off with full jitter and retries;
 * `rate-limited` waits `retry_after` and `transient` jitters, both counting
 * as tries. It gives up after `maxTries` tries or when the signal aborts.
 *
 * A swap can land and still report `transient` (a lost acknowledgement).
 * After a `transient` swap the next try compares tips: a re-fetched tip that
 * moved, and whose files equal the old files with the attempted commit
 * applied, is that swap, so the loop returns `ok` without writing again.
 *
 * It also holds `writtenRecord` and the forge call deadline every lane module
 * shares, so `heartbeat.ts` and `session.ts` depend only on this module.
 */

/** Each forge call's (and each ledger swap's) default deadline. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** The record `commit` writes for `unit`, or `null`. */
export function writtenRecord(commit: LedgerCommit | null, unit: string): UnitRecord | null {
  const text = commit?.writes[unitPath(unit)];
  if (text === undefined) return null;
  try {
    const parsed = UnitRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const CAS_MAX_TRIES = 10;
export const CAS_BACKOFF_BASE_MS = 100;
export const CAS_BACKOFF_CAP_MS = 5_000;

/** Waits `ms`, resolving early when `signal` aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type SwapLedgerParams = {
  readonly forge: Forge;
  readonly edit: LedgerEdit;
  readonly signal: AbortSignal;
  readonly sleep?: Sleep;
  /** Uniform in `[0, 1)`; default `Math.random`. */
  readonly random?: () => number;
  readonly maxTries?: number;
};

export type SwapLedgerErrorKind = "edit" | "forge" | "exhausted" | "deadline";

export type SwapLedgerError =
  /** The edit failed against the tip; the caller runs `next` again. */
  | { readonly kind: "edit"; readonly message: string; readonly tries: number; readonly edit: LedgerEditErrorKind }
  /** A forge error that is not retried here (`not-fast-forward`, `auth`, `forbidden`, `uninstalled`, `not-found`, `rejected`). */
  | { readonly kind: "forge"; readonly message: string; readonly tries: number; readonly forge: ForgeError }
  | { readonly kind: "exhausted"; readonly message: string; readonly tries: number; readonly last: ForgeError }
  | { readonly kind: "deadline"; readonly message: string; readonly tries: number };

export type SwapLedgerValue = {
  /** The tip after the swap, or the tip the edit found already done. */
  readonly tip: GitSha;
  /** The commit written, or `null` when the tip already held the target. */
  readonly commit: LedgerCommit | null;
  readonly tries: number;
};

export type SwapLedgerOutcome =
  | { readonly ok: true; readonly value: SwapLedgerValue }
  | { readonly ok: false; readonly error: SwapLedgerError };

/** The full-jitter back-off before the try after `failedTry`. */
export function jitterDelay(failedTry: number, random: () => number): number {
  return random() * Math.min(CAS_BACKOFF_CAP_MS, CAS_BACKOFF_BASE_MS * 2 ** (failedTry - 1));
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const RETRIED: readonly ForgeError["kind"][] = ["conflict", "rate-limited", "transient"];

/** The files of `files` with `commit` applied. */
function applyCommit(files: LedgerFiles, commit: LedgerCommit): Record<string, string> {
  const out: Record<string, string> = { ...files };
  for (const path of commit.deletes) delete out[path];
  for (const [path, text] of Object.entries(commit.writes)) out[path] = text;
  return out;
}

function sameFiles(a: LedgerFiles, b: LedgerFiles): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** A swap that reported `transient` and may have landed. */
type Unacked = { readonly oldTip: GitSha; readonly expected: LedgerFiles; readonly commit: LedgerCommit };

export async function swapLedger(params: SwapLedgerParams): Promise<SwapLedgerOutcome> {
  const { forge, edit, signal } = params;
  const sleep = params.sleep ?? defaultSleep;
  const random = params.random ?? Math.random;
  const maxTries = params.maxTries ?? CAS_MAX_TRIES;
  if (!Number.isInteger(maxTries) || maxTries < 1) {
    throw new RangeError(`swapLedger: maxTries must be a positive integer, got ${maxTries}`);
  }

  const deadline = (tries: number): SwapLedgerOutcome => ({
    ok: false,
    error: { kind: "deadline", message: `ledger swap: deadline passed after ${tries} tries`, tries },
  });

  let unacked: Unacked | null = null;

  for (let tries = 1; ; tries += 1) {
    if (signal.aborted) return deadline(tries - 1);

    let failure: ForgeError;
    const snap = await forge.snapshot({ signal });
    if (!snap.ok) {
      failure = snap.error;
    } else {
      const tip = snap.value.ledger.tip;
      if (unacked !== null) {
        const landed = tip !== unacked.oldTip && sameFiles(snap.value.ledger.files, unacked.expected);
        if (landed) return { ok: true, value: { tip, commit: unacked.commit, tries } };
        unacked = null;
      }
      const applied = edit(snap.value.ledger.files);
      if (!applied.ok) {
        return {
          ok: false,
          error: { kind: "edit", message: applied.error.message, tries, edit: applied.error.kind },
        };
      }
      const commit = applied.value;
      if (commit === null) return { ok: true, value: { tip, commit: null, tries } };
      const swapped = await forge.ledgerSwap(tip, commit, { signal });
      if (swapped.ok) return { ok: true, value: { tip: swapped.value.tip, commit, tries } };
      failure = swapped.error;
      if (failure.kind === "transient") unacked = { oldTip: tip, expected: applyCommit(snap.value.ledger.files, commit), commit };
    }

    if (!RETRIED.includes(failure.kind)) {
      return { ok: false, error: { kind: "forge", message: failure.message, tries, forge: failure } };
    }
    if (signal.aborted) return deadline(tries);
    if (tries >= maxTries) {
      return {
        ok: false,
        error: {
          kind: "exhausted",
          message: `ledger swap: gave up after ${tries} tries: ${failure.message}`,
          tries,
          last: failure,
        },
      };
    }
    const wait = failure.kind === "rate-limited" ? failure.retry_after * 1000 : jitterDelay(tries, random);
    await sleep(wait, signal);
    if (signal.aborted) return deadline(tries);
  }
}
