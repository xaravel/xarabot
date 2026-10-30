import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { classifyChecks, pollDelayMs } from "../core/ci/checks.ts";
import { loadRepoConfig, type RepoConfig } from "../core/config/load-repo-config.ts";
import { unattendedRefusal } from "../core/lane/runner.ts";
import { RESULT_LINGER_MS, RESULT_POLL_MS, SESSION_MS, usageLimitSleepMs } from "../core/lane/waits.ts";
import {
  coordinatorFenced,
  failAttempt,
  failClaimed,
  heartbeat,
  park,
  parkText,
  type CoordinatorFence,
  type HeartbeatSet,
  type LedgerEdit,
  type LedgerFence,
} from "../core/ledger/edits.ts";
import type { NextStory } from "../core/next/next.ts";
import { err, ok, type Result } from "../core/result.ts";
import { allowanceRefusal } from "../core/review/allowance.ts";
import type { JournalCost, JournalTokens, LaneOutcome, UnitJournalRecord } from "../core/schemas/journal.ts";
import type { LaneIdentity, ParkReason, UnitRecord, UnitState } from "../core/schemas/ledger.ts";
import type { Policy } from "../core/schemas/policy.ts";
import { parseSessionResult, type BuildResult, type ResultKind, type SessionResultOf } from "../core/schemas/session-result.ts";
import type { Agent, AgentSettings, AgentUnit, AgentUsage } from "../ports/agent.ts";
import { isBackoffKind, isLaneStopKind, type CallOpts, type Forge, type ForgeError, type ForgeResult, type ForgeSnapshot } from "../ports/forge.ts";
import type { LaneStore } from "../ports/lane-store.ts";
import type { LaunchSpec, ProxyRequest, Sandbox, SandboxProfile, SandboxResult, SandboxRun } from "../ports/sandbox.ts";
import { emptyDir } from "../sandbox/vendor-home.ts";
import { needCommit } from "./clone.ts";
import type { Heartbeat } from "./heartbeat.ts";
import { DEFAULT_CALL_TIMEOUT_MS, swapLedger, writtenRecord, type Sleep } from "./ledger-cas.ts";
import type { LaneLayout } from "./lane-store.ts";
import type { Waiter, WaitResult } from "./wait.ts";
import type { FetchShas, Workspace, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The one session runner and step helper set (Story 2.6a, AR1, AR3, AR23).
 * The lane process and the coordinator process use it, and so do the PR, CI,
 * merge and `reconcile` steps; Stories 2.7, 2.9 and 2.10 (planning, retro
 * and retro-item sessions) and Epic 3's reviews build on it next.
 *
 * - The shared lane types: the PR step's input and output, the session
 *   limits, the run's result, and the `Halt` family a process ends through.
 * - `forgeClock`: the last forge time seen, advanced by the host time since.
 * - `forgeOps`: one forge call or ledger swap under its own deadline. A port
 *   method that throws is a `transient` error; a lane-stop kind posts a
 *   best-effort alert and calls the caller's `stop`.
 * - `bestEffortOps` (Epic 4 retro, D2): the log and forge calls of the
 *   `reconcile` sub-steps that never fail the run, the inbox and rulings
 *   steps: a failed or throwing call is logged and skipped.
 * - `stepKit`: a step's ending (`End`), its reasons, and its fenced edits on
 *   its own record (`held`, `beat`, `failed`, `lost`), on top of `forgeOps`.
 * - `stepOps`: what the CI step and the coordinator steps share on top of a
 *   kit: the abort check, the `blocked` park, fresh `main`, the CI poll, and
 *   closing the PRs no record carries, and a fix session's result pushed;
 *   with `describeError` and `message`.
 * - The review plumbing (Story 3.5): `allowanceReason`, the allowance
 *   re-check on a fresh `main` policy, which `sessionAllowance` runs before
 *   each fresh session on one fresh snapshot; `callPassedGate` and
 *   `passedGate`, the passed gate under its deadline; and `haveCommits`, the
 *   commits a runner.git check needs, fetching only the missing ones.
 * - The unit track both processes keep: the keeper check, a held edit on the
 *   unit, a failed attempt, its retry before the trailing wait when the
 *   ledger did not take it, and the unit's journal record.
 * - `createSessionRunner`: prepare, the sandboxed run under the unit budget
 *   and the session limit, the kill `RESULT_LINGER_MS` after the result file
 *   first appears, the fresh run plus one resume, the usage-limit sleep with
 *   its `usage-limit` span, and the result parse for a `ResultKind`. Usage is
 *   read from each run's stdout and the lane's vendor home; a failed turn the
 *   agent reports fails the attempt with no resume, a rewritten home
 *   credential is journaled as a `credential-rewrite` span, and every proxy
 *   request goes in the unit log. It holds no Story logic: the caller passes
 *   the prompt and the result kind.
 *
 * `heartbeat.ts` must never import this module.
 */

export const MAX_CLAIM_ROUNDS = 3;
/** The wait between the retries of a failed attempt the ledger did not take (C4b). */
export const FAIL_RETRY_MS = 60 * 1000;
export const ZERO_SHA = "0".repeat(40);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Installed tool trees: skills for the agents and the BMAD install. The runner
 * reads none of their contents, and a repo holds hundreds of files there.
 */
const UNREAD_TREES = [".claude/", ".agents/", "_bmad/"];

/** One proxy request as a unit-log line. */
function proxyLine(p: ProxyRequest): string {
  return `${p.allowed ? "allow" : "deny"} ${p.target}${p.reason === null ? "" : ` (${p.reason})`}\n`;
}

/** The `main` paths a snapshot reads the contents of. */
export function readsPath(path: string): boolean {
  if (UNREAD_TREES.some((t) => path.startsWith(t))) return false;
  return path.startsWith(".xarabot/") || /\.(?:md|ya?ml)$/.test(path);
}

/** The CI-fix session's log file in `tmp`. */
export const CI_FIX_LOG = "ci-fix-log.md";

/** The loopback session's review findings file in `tmp` (Story 3.5). */
export const REVIEW_FINDINGS = "review-findings.md";

export type AllowanceParams = {
  readonly forge: Forge;
  /** The repo slug, for the config loaded from the snapshot. */
  readonly repo: string;
  /** The lane's agent, which the policy must allow unattended. */
  readonly agent: string;
  /** The unit's `builder_providers[]` now, for the reviewer choice. */
  readonly builderProviders: () => readonly string[];
  /** Other adapters the session runs, which the policy must allow too (a reviewer); default none. */
  readonly also?: () => readonly string[];
  /** The snapshot's deadline. */
  readonly callTimeoutMs: number;
};

/**
 * The allowance re-check on fresh `main`'s policy (Story 3.5, AD-16):
 * `allowance: <why>` when it no longer allows the lane's `agent` unattended,
 * or a reviewer for `builderProviders`; `null` when it does.
 */
export function allowanceReason(policy: Pick<Policy, "unattended_adapters">, agent: string, builderProviders: readonly string[]): string | null {
  const refused = allowanceRefusal(policy, agent, builderProviders);
  return refused === null ? null : `allowance: ${refused}`;
}

/**
 * The allowance re-check a session context runs before each session (Story
 * 3.5, AD-16, AD-21): one snapshot of fresh `main` and its config, then
 * `allowanceReason` on its policy. A failed snapshot or an invalid config
 * is a refusal reason too. `null` when the session may run. Never throws.
 */
export function sessionAllowance(p: AllowanceParams): () => Promise<string | null> {
  return async () => {
    try {
      const snapped = await p.forge.snapshot({ signal: AbortSignal.timeout(p.callTimeoutMs), read: readsPath });
      if (!snapped.ok) return `allowance: snapshot ${snapped.error.kind}: ${snapped.error.message}`;
      const snap = snapped.value;
      const loaded = loadRepoConfig({ repo: p.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!loaded.ok) return `allowance: config ${loaded.error.kind}: ${loaded.error.message}`;
      const policy = loaded.value.repo.policy;
      const refused = allowanceReason(policy, p.agent, p.builderProviders());
      if (refused !== null) return refused;
      for (const other of p.also?.() ?? []) {
        const r = unattendedRefusal(policy, other);
        if (!r.ok) return `allowance: ${r.error.message}`;
      }
      return null;
    } catch (e) {
      return `allowance: ${message(e)}`;
    }
  };
}

/**
 * The unit a PR, CI or merge step works on (Story 2.10): its id, and the
 * subject its 🤖 comments and merge commits name: `Story <id>` for a Story
 * (`storySubject`), `Unit <unit>` for a coordinator unit (`unitSubject`).
 */
export type StepUnit = { readonly unit: string; readonly subject: string };

/** A Story's subject in step texts: `Story <id>`. */
export function storySubject(storyId: string): string {
  return `Story ${storyId}`;
}

/** A coordinator unit's subject in step texts: `Unit <unit>`. */
export function unitSubject(unit: string): string {
  return `Unit ${unit}`;
}

/** What the PR step gets after a `done` result whose spec checks out. */
export type PrStepInput = {
  readonly unit: NextStory;
  /** The claimed ledger record. */
  readonly record: UnitRecord;
  readonly result: BuildResult;
  /** The spec file's repo-relative path in the clone. */
  readonly specPath: string;
  /** The `blocked` spec files the `done` spec supersedes: dropped from the squash. */
  readonly superseded: readonly string[];
  readonly clone: string;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
  /** `fix`: a CI fix pushed to the open PR, whose title and body stay as they are. Default `build`. */
  readonly kind?: "build" | "fix";
};

export type PrStepOutput = {
  readonly outcome: LaneOutcome;
  readonly state: UnitState | null;
  /** The latest ledger record the step saw or wrote. */
  readonly record?: UnitRecord;
  /** Why the step ended as it did; added to the journal reason. */
  readonly reason?: string;
};

/** A step's output; `ejected`: the queue ejected the PR, the unit `claimed` again for another CI round. */
export type StepOutput = PrStepOutput & { readonly ejected?: true };

/** Commits, pushes and opens the PR (Story 1.16a). Never throws. */
export type PrStep = (input: PrStepInput) => Promise<PrStepOutput>;

/** A fix session's result (a CI-fix, conflict or loopback session). */
export type CiSessionDone = {
  readonly result: BuildResult;
  /** The spec file's repo-relative path in the clone; `null` for a `blocked` or `no-op` result, or a unit that needs none. */
  readonly specPath: string | null;
  /** The `blocked` spec files the `done` spec supersedes: dropped from the squash. */
  readonly superseded: readonly string[];
};

/** A `done` CI-fix, conflict or loopback session's fix, to push to the open PR. */
export type CiFix = CiSessionDone & {
  /** The claimed record as the step last saw it, with its `pr` and `head_sha`. */
  readonly record: UnitRecord;
};

/** Commits and pushes a fix to the open PR, keeping its title and body. Never throws. */
export type PushFix = (fix: CiFix) => Promise<PrStepOutput>;

export type PassedGateRequest = {
  /** The PR's head. */
  readonly headSha: string;
  /** The record's `passed_sha`; `null` when no review round passed a head. */
  readonly passedSha: string | null;
  /** The fresh `main`. */
  readonly mainSha: string;
  readonly signal: AbortSignal;
};

export type PassedGateOutcome =
  | { readonly kind: "passed"; readonly how: "head" | "clean-merge" }
  | { readonly kind: "unreviewed"; readonly why: string };

/** Whether the head passed a review (`passed-gate.ts`); an error when git cannot tell. Never throws. */
export type PassedGate = (request: PassedGateRequest) => Promise<Result<PassedGateOutcome, WorkspaceErrorKind>>;

/** An agent session's limits (AR3); defaults 3 h, 5 min and 5 s. */
export type SessionLimits = {
  /** A run still going after this is killed; with no result it is a failed attempt. */
  readonly sessionMs?: number;
  /** A run still going this long after its result file is first seen is killed. */
  readonly resultLingerMs?: number;
  /** How often the lane looks for the result file during a run. */
  readonly resultPollMs?: number;
};

/** Why a run ended `stop` after a STOP during a usage-limit sleep. */
export const LIMIT_STOP_REASON = "STOP during a usage-limit sleep";

/**
 * A run's outcome. `laneStop` is set, to the stop's reason, when the outcome
 * is `stop` for any reason but a STOP marker (the host or lane `STOP`, or a
 * STOP during a usage-limit sleep): `lane run` counts it as a failed start.
 */
export type LaneProcessResult = { readonly outcome: LaneOutcome; readonly laneStop?: string };

/** Ends the run early with `outcome`. */
export class Halt extends Error {
  constructor(
    readonly outcome: LaneOutcome,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** The heartbeat keeper lost or released the unit: abandon it, with no further edit. */
export class Abandon extends Halt {}

/** A host or lane STOP marker ends the run: the operator's choice, never a lane stop. */
export class MarkerStop extends Halt {}

/** A regular file's text; a symlink or anything else is refused. */
export function readRegular(path: string): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) return null;
  return readFileSync(path, "utf8");
}

/** A thrown value's text. */
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A host or lane STOP marker (or one that can't be read) ends the run with `stop`. */
export function checkStop(store: LaneStore): void {
  const s = store.stopMarkers();
  if (!s.ok) throw new Halt("stop", `STOP markers unreadable, stopping: ${s.error.message}`);
  if (s.value.host) throw new MarkerStop("stop", "host STOP marker present");
  if (s.value.lane) throw new MarkerStop("stop", "lane STOP marker present");
}

/** A lane store write's result, for `ReportStore`. */
export type StoreWrite = { readonly ok: boolean; readonly error?: { readonly kind: string; readonly message: string } };

/** Reports a failed lane store write; the outcome stays. */
export type ReportStore = (r: StoreWrite, what: string) => void;

// ------------------------------------------------------------ forge time

export type ForgeClock = {
  /** Records forge time `now`, seen at the current host time. */
  see(now: string): void;
  /** The last forge time seen plus the host time since; the host time before any. */
  forgeNow(): string;
  /** `forgeNow` at host time `hostMs`. */
  forgeAt(hostMs: number): string;
  /** The host time the last forge time was seen at (0 before any). */
  seenAt(): number;
};

/**
 * The forge's time as last seen, advanced by the host clock; `seed` is a
 * forge time seen at host time `seedAt`, default now.
 */
export function forgeClock(clock: () => number, seed?: string, seedAt?: number): ForgeClock {
  let last: string | null = seed ?? null;
  let at = seed === undefined ? 0 : (seedAt ?? clock());
  const forgeAt = (hostMs: number): string =>
    last === null ? new Date(hostMs).toISOString() : new Date(Date.parse(last) + Math.max(0, hostMs - at)).toISOString();
  const forgeNow = (): string => forgeAt(clock());
  return {
    see(now) {
      last = now;
      at = clock();
    },
    forgeNow,
    forgeAt,
    seenAt: () => at,
  };
}

// ------------------------------------------------------------ forge calls

/**
 * A coordinator lane's forge (Q5): every swap `forgeOps` makes through it,
 * and so every step kit's, first applies `ledgerFence` to its edit. `lane
 * run` and the coordinator process hand it to everything that writes the
 * ledger for the coordinator, the CI, review and merge steps a retro item
 * runs included.
 */
export type FencedForge = Forge & { readonly ledgerFence: LedgerFence };

/** `forge` with its ledger edits fenced on `coordinator.json`'s holder and generation (`coordinatorFenced`); an earlier fence is replaced. */
export function fenceForge(forge: Forge, fence: CoordinatorFence): FencedForge {
  return { ...forge, ledgerFence: (edit) => coordinatorFenced(fence, edit) };
}

/** The fence of a `FencedForge`; for any other forge, the edit as it is. */
export function ledgerFenceOf(forge: Forge): LedgerFence {
  const fence = (forge as Partial<FencedForge>).ledgerFence;
  return fence ?? ((edit) => edit);
}

/** A ledger swap's outcome: the record it wrote for the unit (or `null`), else lost or failed. */
export type Swapped =
  | { readonly kind: "ok"; readonly record: UnitRecord | null }
  | { readonly kind: "lost"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export type ForgeOpsParams = {
  readonly forge: Forge;
  /** Each forge call's and each swap's deadline. */
  readonly callTimeoutMs: number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly clock: ForgeClock;
  /** The `main` SHA a lane-stop alert names; the zero SHA when `null`. */
  readonly alertSha: () => string | null;
  /** Ends the caller after a lane-stop alert; it throws. */
  readonly stop: (condition: string, why: string) => never;
};

export type ForgeOps = {
  /** One forge call under its own deadline; a throw is `transient`, a lane-stop kind stops the lane. */
  call<T>(operation: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>>;
  /** One ledger edit, behind a `FencedForge`'s fence, through the CAS loop under its own deadline; a ledger or forge stop stops the lane. */
  swap(edit: LedgerEdit, unit: string): Promise<Swapped>;
  /** Posts the alert (its failure ignored), then `stop`. */
  laneStop(condition: string, why: string): Promise<never>;
  /** The forge's current time for a ledger edit, from a fresh snapshot; the estimate when the read fails. */
  freshNow(): Promise<string>;
};

export function forgeOps(p: ForgeOpsParams): ForgeOps {
  const { forge, callTimeoutMs } = p;
  const fence = ledgerFenceOf(forge);
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });

  const laneStop = async (condition: string, why: string): Promise<never> => {
    try {
      await forge.alert(condition, p.alertSha() ?? ZERO_SHA, deadline());
    } catch {
      // The alert is best effort; the lane stops either way.
    }
    return p.stop(condition, why);
  };

  const call = async <T>(operation: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> => {
    let r: ForgeResult<T>;
    try {
      r = await run(deadline());
    } catch (e) {
      return { ok: false, error: { kind: "transient", message: `${operation} threw: ${message(e)}` } };
    }
    if (!r.ok && isLaneStopKind(r.error.kind)) await laneStop(`forge-${r.error.kind}`, `${operation}: ${r.error.message}`);
    return r;
  };

  const swap = async (edit: LedgerEdit, unit: string): Promise<Swapped> => {
    const r = await swapLedger({
      forge,
      edit: fence(edit),
      signal: AbortSignal.timeout(callTimeoutMs),
      ...(p.sleep !== undefined ? { sleep: p.sleep } : {}),
      ...(p.random !== undefined ? { random: p.random } : {}),
    });
    if (r.ok) return { kind: "ok", record: writtenRecord(r.value.commit, unit) };
    const e = r.error;
    if (e.kind === "edit" && e.edit === "stop") await laneStop("ledger-schema-version", e.message);
    if (e.kind === "forge" && isLaneStopKind(e.forge.kind)) await laneStop(`forge-${e.forge.kind}`, e.message);
    if (e.kind === "edit" && e.edit === "precondition") return { kind: "lost", message: e.message };
    return { kind: "failed", message: `ledger ${e.kind}: ${e.message}` };
  };

  const freshNow = async (): Promise<string> => {
    const s = await call("snapshot", (o) => forge.snapshot(o));
    if (s.ok) {
      p.clock.see(s.value.now);
      return s.value.now;
    }
    return p.clock.forgeNow();
  };

  return { call, swap, laneStop, freshNow };
}

// ------------------------------------------------------------ best-effort steps

/** One best-effort forge call's outcome: its value, or the failure's message, already logged. */
export type BestEffortCall<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export type BestEffortOpsParams = {
  readonly log: (line: string) => void;
  /** Joined with each call's own deadline. */
  readonly signal: AbortSignal;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
};

export type BestEffortOps = {
  /** `<step> step: <line>` to the caller's log, best effort: it never throws. */
  log(line: string): void;
  /** One forge call under its own deadline and the step's signal; a failure or a throw is logged as `<what> failed|threw: …; skipped`. It never throws. */
  call<T>(what: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<BestEffortCall<T>>;
};

/**
 * The log and forge calls of a `reconcile` sub-step whose errors never fail
 * or stop the run (the inbox and rulings steps, Stories 4.2 and 4.5): no
 * lane-stop alert, unlike `forgeOps`.
 */
export function bestEffortOps(step: string, p: BestEffortOpsParams): BestEffortOps {
  const timeout = p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const log = (line: string): void => {
    try {
      p.log(`${step} step: ${line}`);
    } catch {
      // Logging is best effort.
    }
  };
  const call = async <T>(what: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<BestEffortCall<T>> => {
    let r: ForgeResult<T>;
    try {
      r = await run({ signal: AbortSignal.any([p.signal, AbortSignal.timeout(timeout)]) });
    } catch (e) {
      log(`${what} threw: ${message(e)}; skipped`);
      return { ok: false, message: message(e) };
    }
    if (r.ok) return { ok: true, value: r.value };
    log(`${what} failed: ${r.error.kind}: ${r.error.message}; skipped`);
    return { ok: false, message: `${r.error.kind}: ${r.error.message}` };
  };
  return { log, call };
}

// ------------------------------------------------------------ step kit

/** Ends a step with `out`. */
export class End {
  constructor(readonly out: StepOutput) {}
}

export type StepKitParams = {
  /** The step's log prefix: `PR step`, `CI step`, `merge step`, `reconcile step`. */
  readonly name: string;
  readonly forge: Forge;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The record the step starts from; the kit's unit and generation are its. */
  readonly record: UnitRecord;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
  /** The host clock in epoch ms. */
  readonly clock: () => number;
  readonly callTimeoutMs: number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** A forge time already seen (the round's snapshot `now`); default none. */
  readonly seen?: string;
  /** The `main` SHA lane-stop alerts name until the step sees a fresher one. */
  readonly mainSha?: string;
  /** Runs before `failed`'s `failAttempt` (the merge step leaves `merging`). */
  readonly beforeFail?: () => Promise<void>;
};

export type StepKit = {
  readonly unit: string;
  /** The input record's generation: every held edit fences on it. */
  readonly generation: number;
  /** The latest record the step saw or wrote. */
  record: UnitRecord;
  /** The `main` SHA a lane-stop alert names. */
  mainSha: string | null;
  readonly reasons: string[];
  /** The host time of the last good `beat` (the kit's start before any). */
  lastBeat: number;
  readonly End: typeof End;
  /** Writes `<name>: <text>`; a log that cannot be written never ends the step. */
  note(text: string): void;
  see(now: string): void;
  forgeNow(): string;
  /** The step's ending, carrying the record and the reasons so far. */
  end(outcome: LaneOutcome, state: UnitState | null, extra?: { readonly ejected?: true }): End;
  laneStop(condition: string, why: string): Promise<never>;
  call<T>(operation: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>>;
  /** One ledger edit; the record it wrote for the kit's unit is adopted. */
  swap(edit: LedgerEdit): Promise<Swapped>;
  /** A failed attempt: released, or parked at the attempts cap. */
  failed(why: string): Promise<never>;
  /** The unit was lost to another writer: no further ledger edit. */
  lost(what: string, why: string): never;
  /** A held edit: a lost unit ends the step, any other failure is a failed attempt. */
  held(what: string, edit: LedgerEdit): Promise<void>;
  /** A fenced heartbeat at the kit's generation, with `set`. */
  beat(what: string, set?: HeartbeatSet): Promise<void>;
  /** Runs the step's body: an `End` is its output; anything else is one failed attempt. Never throws. */
  run(body: () => Promise<StepOutput>): Promise<StepOutput>;
};

export function stepKit(p: StepKitParams): StepKit {
  const unit = p.record.unit;
  const generation = p.record.generation;
  const { identity } = p;
  const fc = forgeClock(p.clock, p.seen);
  const reasons: string[] = [];

  const note = (text: string): void => {
    try {
      p.log(`${p.name}: ${text}`);
    } catch {
      // A log that cannot be written never ends the step.
    }
  };
  const end = (outcome: LaneOutcome, state: UnitState | null, extra: { readonly ejected?: true } = {}): End => {
    const r = reasons.length === 0 ? undefined : reasons.join("; ");
    return new End({ outcome, state, record: kit.record, ...(r !== undefined ? { reason: r } : {}), ...extra });
  };
  const ops = forgeOps({
    forge: p.forge,
    callTimeoutMs: p.callTimeoutMs,
    ...(p.sleep !== undefined ? { sleep: p.sleep } : {}),
    ...(p.random !== undefined ? { random: p.random } : {}),
    clock: fc,
    alertSha: () => kit.mainSha,
    stop: (condition, why) => {
      reasons.push(`${condition}: ${why}`);
      note(`stop: ${condition}: ${why}`);
      throw end("stop", kit.record.state);
    },
  });

  const swap = async (edit: LedgerEdit): Promise<Swapped> => {
    const r = await ops.swap(edit, unit);
    if (r.kind === "ok" && r.record !== null) kit.record = r.record;
    return r;
  };

  const failed = async (why: string): Promise<never> => {
    reasons.push(why);
    note(`failed: ${why}`);
    if (p.beforeFail !== undefined) await p.beforeFail();
    const r = await swap(failAttempt({ unit, by: identity, now: fc.forgeNow(), generation }));
    if (r.kind === "ok") {
      note(`failAttempt: ${kit.record.state}`);
      throw end("failed", kit.record.state);
    }
    reasons.push(`failAttempt: ${r.message}`);
    note(`failAttempt failed: ${r.message}`);
    throw end("failed", null);
  };

  const lost = (what: string, why: string): never => {
    reasons.push(`${what}: unit lost: ${why}`);
    note(`${what}: unit lost: ${why}`);
    throw end("failed", null);
  };

  const held = async (what: string, edit: LedgerEdit): Promise<void> => {
    const r = await swap(edit);
    if (r.kind === "lost") lost(what, r.message);
    if (r.kind === "failed") await failed(`${what}: ${r.message}`);
  };

  const beat = async (what: string, set?: HeartbeatSet): Promise<void> => {
    // The host time of the beat's stamp, read once: the baseline the merge step's queue heartbeat counts from.
    const at = p.clock();
    await held(what, heartbeat({ unit, by: identity, now: fc.forgeAt(at), generation, ...(set !== undefined ? { set } : {}) }));
    kit.lastBeat = at;
  };

  const run = async (body: () => Promise<StepOutput>): Promise<StepOutput> => {
    try {
      return await body();
    } catch (e) {
      if (e instanceof End) return e.out;
      // An unexpected error: try one failed attempt, never throw.
      try {
        return await failed(`unexpected error: ${message(e)}`);
      } catch (inner) {
        if (inner instanceof End) return inner.out;
        reasons.push(`unexpected error: ${message(inner)}`);
        return { outcome: "failed", state: null, record: kit.record, reason: reasons.join("; ") };
      }
    }
  };

  const kit: StepKit = {
    unit,
    generation,
    record: p.record,
    mainSha: p.mainSha ?? null,
    reasons,
    lastBeat: p.clock(),
    End,
    note,
    see: fc.see,
    forgeNow: fc.forgeNow,
    end,
    laneStop: ops.laneStop,
    call: ops.call,
    swap,
    failed,
    lost,
    held,
    beat,
    run,
  };
  return kit;
}

// ------------------------------------------------------------ step ops

/** A forge error in a step's reasons and notes: `<kind>: <message>`. */
export function describeError(e: ForgeError): string {
  return `${e.kind}: ${e.message}`;
}

/** Fresh `main`: its snapshot, and the config and Standing Authority loaded from it. */
export type FreshMain = { readonly snap: ForgeSnapshot; readonly config: RepoConfig };

export type StepOpsParams = {
  /** The step's kit: every op reasons, notes, edits and ends through it. */
  readonly kit: StepKit;
  readonly forge: Forge;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the config and Standing Authority loaded from fresh `main`. */
  readonly repo: string;
  /**
   * Aborts when the step must give up: the unit or the coordinator claim
   * lost (a coordinator step), or the unit budget passed (the CI step). The
   * CI poll's sleeps end on it too.
   */
  readonly signal: AbortSignal;
  /** The reason `aborted` ends the step with. */
  readonly abortReason: string;
  /** The host clock in epoch ms. */
  readonly clock: () => number;
  /** The CI poll's sleep. */
  readonly sleep: Sleep;
  /** The lane's known secrets, redacted from a park's `text` (Story 4.2); default none. */
  readonly secrets?: readonly string[];
};

export type StepOps = {
  /** Once `signal` aborted: ends the step `failed`, the record left as it is for the process (or the lane's budget rule) to judge. */
  aborted(): void;
  /**
   * Parks the unit `blocked` for `reason`, then ends the step `progress`.
   * `text`, the session's own words (a `blocked.text` or a readiness
   * summary), is kept as `park.text`, sanitized and capped (`parkText`).
   */
  parkBlocked(reason: ParkReason, why: string, text?: string): Promise<never>;
  /**
   * Fresh `main`, after `aborted`: one snapshot, then the config and
   * Standing Authority loaded from it. An invalid one ends the step `stop`;
   * a failed snapshot that does not stop the lane is returned for the caller
   * to judge.
   */
  freshMain(): Promise<ForgeResult<FreshMain>>;
  /**
   * Polls the checks on `sha` until they pass (`passed`) or fail (the failing
   * names). A `transient` or `rate-limited` error counts as pending, any other
   * is a failed attempt; past `waitMs` the unit parks `ci-timeout`.
   */
  poll(sha: string, waitMs: number, expected: readonly string[]): Promise<readonly string[] | "passed">;
  /** Best effort: closes PR `pr`, which no ledger record carries, noting the result. */
  closeOrphan(pr: number): Promise<void>;
  /**
   * Best effort after a failed `openPr`: each open PR on `branch` closed,
   * each behind its own fence. A fence that fails leaves the rest open.
   */
  closeOrphans(branch: string): Promise<void>;
  /**
   * The `record` beat for the PR just opened. When it fails, no record
   * carries the PR, so the next attempt would not adopt it and its own
   * `openPr` would fail on it: the PR is closed, then the unit is lost or
   * the attempt failed.
   */
  recordPr(pr: number, set: HeartbeatSet): Promise<void>;
  /**
   * A `what` session's result (a CI-fix, conflict or loopback session):
   * `blocked` parks with its kind, `no-op` parks `no-op`, a `done` one with
   * no spec when `needsSpec` is a failed attempt; otherwise the fix goes
   * through `push` and its record is adopted. Returns once the fix is pushed
   * and the unit is still `claimed`; any other ending of the push ends the
   * step with it.
   */
  pushSessionFix(what: string, done: CiSessionDone, needsSpec: boolean, push: PushFix): Promise<void>;
};

export function stepOps(p: StepOpsParams): StepOps {
  const { kit, forge, identity } = p;
  const { unit, generation, reasons } = kit;

  const aborted = (): void => {
    if (!p.signal.aborted) return;
    reasons.push(p.abortReason);
    kit.note(`aborted: ${p.abortReason}`);
    throw kit.end("failed", kit.record.state);
  };

  const parkBlocked = async (reason: ParkReason, why: string, text?: string): Promise<never> => {
    reasons.push(why);
    kit.note(`parking blocked ${reason}: ${why}`);
    const kept = text === undefined ? undefined : parkText(text, p.secrets ?? []);
    await kit.held("park", park({ unit, by: identity, now: kit.forgeNow(), generation, kind: "blocked", reason, ...(kept !== undefined ? { text: kept } : {}) }));
    throw kit.end("progress", kit.record.state);
  };

  const freshMain = async (): Promise<ForgeResult<FreshMain>> => {
    aborted();
    const snapped = await kit.call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
    if (!snapped.ok) return snapped;
    const snap: ForgeSnapshot = snapped.value;
    kit.see(snap.now);
    kit.mainSha = snap.main.sha;
    const loaded = loadRepoConfig({ repo: p.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
    if (!loaded.ok) {
      reasons.push(`config ${loaded.error.kind}: ${loaded.error.message}`);
      kit.note(`stop: config ${loaded.error.kind}: ${loaded.error.message}`);
      throw kit.end("stop", kit.record.state);
    }
    return { ok: true, value: { snap, config: loaded.value } };
  };

  const poll = async (sha: string, waitMs: number, expected: readonly string[]): Promise<readonly string[] | "passed"> => {
    const startedAt = p.clock();
    for (let n = 0; ; n += 1) {
      aborted();
      const r = await kit.call("checks", (o) => forge.checks(sha, o));
      let delay = pollDelayMs(n);
      if (!r.ok) {
        if (!isBackoffKind(r.error.kind)) return await kit.failed(`checks ${describeError(r.error)}`);
        if (r.error.kind === "rate-limited") delay = Math.max(delay, r.error.retry_after * 1000);
        kit.note(`checks ${describeError(r.error)}: counted as pending`);
      } else {
        const c = classifyChecks(r.value.checks, expected);
        if (c.kind === "passed") return "passed";
        if (c.kind === "failed") return c.failing;
      }
      if (p.clock() - startedAt >= waitMs) {
        return await parkBlocked("ci-timeout", `CI on ${sha} still pending after ${Math.round(waitMs / MINUTE_MS)} min`);
      }
      await p.sleep(delay, p.signal);
    }
  };

  const closeOrphan = async (pr: number): Promise<void> => {
    const r = await kit.call("closePr", (o) => forge.closePr(pr, o));
    if (r.ok) {
      reasons.push(`closed PR #${pr}, which no record carries`);
      kit.note(`closed PR #${pr}, which no record carries`);
    } else {
      reasons.push(`closePr PR #${pr} ${describeError(r.error)}; it stays open with no record`);
      kit.note(`closePr PR #${pr} failed: ${describeError(r.error)}`);
    }
  };

  const closeOrphans = async (branch: string): Promise<void> => {
    const listed = await kit.call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o));
    if (!listed.ok) {
      reasons.push(`listPrsByBranch ${branch} ${describeError(listed.error)}`);
      kit.note(`listPrsByBranch ${branch} failed: ${describeError(listed.error)}`);
      return;
    }
    for (const pr of listed.value.filter((x) => x.state === "open")) {
      const fence = await kit.swap(heartbeat({ unit, by: identity, now: kit.forgeNow(), generation }));
      if (fence.kind !== "ok") {
        reasons.push(`fence before closing PR #${pr.number}: ${fence.message}; it stays open`);
        kit.note(`fence before closing PR #${pr.number} failed: ${fence.message}`);
        return;
      }
      await closeOrphan(pr.number);
    }
  };

  const recordPr = async (pr: number, set: HeartbeatSet): Promise<void> => {
    const recorded = await kit.swap(heartbeat({ unit, by: identity, now: kit.forgeNow(), generation, set }));
    if (recorded.kind === "ok") return;
    await closeOrphan(pr);
    if (recorded.kind === "lost") kit.lost("record", recorded.message);
    await kit.failed(`record: ${recorded.message}`);
  };

  const pushSessionFix = async (what: string, done: CiSessionDone, needsSpec: boolean, push: PushFix): Promise<void> => {
    const { result, specPath, superseded } = done;
    kit.note(`${what} result: ${result.outcome}`);
    if (result.outcome === "blocked") return await parkBlocked(result.blocked.kind, `${what} blocked ${result.blocked.kind}: ${result.blocked.text}`, result.blocked.text);
    if (result.outcome === "no-op") return await parkBlocked("no-op", `${what}: no-op`);
    if (needsSpec && specPath === null) return await kit.failed(`${what} session: a done result with no spec file`);
    let out: PrStepOutput;
    try {
      out = await push({ record: kit.record, result, specPath, superseded });
    } catch (e) {
      return await kit.failed(`PR step threw: ${message(e)}`);
    }
    if (out.record !== undefined) kit.record = out.record;
    if (out.reason !== undefined) reasons.push(out.reason);
    kit.note(`PR step (fix): ${out.outcome} (${out.state ?? "unknown"})`);
    if (out.outcome !== "progress" || out.state !== "claimed") throw kit.end(out.outcome, out.state);
  };

  return { aborted, parkBlocked, freshMain, poll, closeOrphan, closeOrphans, recordPr, pushSessionFix };
}

// ------------------------------------------------------------ the review plumbing

export type PassedGateCall = Omit<PassedGateRequest, "signal"> & {
  readonly passed: PassedGate;
  /** The step's signal; the call's deadline is added to it. */
  readonly signal: AbortSignal;
  /** The call's deadline. */
  readonly callTimeoutMs: number;
};

/** One passed-gate call (Story 3.5), under `callTimeoutMs` as well as `signal`; a throw is a `transient` error. Never throws. */
export async function callPassedGate(p: PassedGateCall): Promise<Result<PassedGateOutcome, WorkspaceErrorKind>> {
  try {
    return await p.passed({ headSha: p.headSha, passedSha: p.passedSha, mainSha: p.mainSha, signal: AbortSignal.any([p.signal, AbortSignal.timeout(p.callTimeoutMs)]) });
  } catch (e) {
    return err("transient", `passed gate threw: ${message(e)}`);
  }
}

export type PassedGateParams = Omit<PassedGateCall, "passedSha"> & {
  /** The step's abort check, run once the gate returns. */
  readonly after: () => void | Promise<void>;
};

/**
 * The passed gate at `headSha` for the kit's record's `passed_sha` (Story
 * 3.5), then the step's abort check; a gate error is a failed attempt.
 */
export async function passedGate(kit: StepKit, p: PassedGateParams): Promise<PassedGateOutcome> {
  const gate = await callPassedGate({ ...p, passedSha: kit.record.passed_sha });
  await p.after();
  if (!gate.ok) return await kit.failed(`passed gate ${gate.error.kind}: ${gate.error.message}`);
  return gate.value;
}

/**
 * Each of `shas` (`[name, sha]`) a commit in runner.git at `gitDir`, the
 * missing ones fetched once through `fetch`; `what` starts each error. An
 * error when a SHA is not a full hex one, the fetch fails, or a fetched SHA
 * is still not a commit there. Never throws.
 */
export async function haveCommits(
  gitDir: string,
  fetch: FetchShas,
  what: string,
  shas: readonly (readonly [string, string])[],
  signal: AbortSignal,
): Promise<Result<void, WorkspaceErrorKind>> {
  const missing: string[] = [];
  for (const [name, sha] of shas) {
    const has = await needCommit(gitDir, sha, `${what}: ${name}`, signal);
    if (has.ok) continue;
    if (has.error.kind !== "missing-object") return has;
    if (!missing.includes(sha)) missing.push(sha);
  }
  if (missing.length === 0) return ok(undefined);
  let fetched: Result<void>;
  try {
    fetched = await fetch(missing, signal);
  } catch (e) {
    fetched = err("fetch", message(e));
  }
  if (!fetched.ok) return err("fetch", `${what}: fetching ${missing.join(", ")}: ${fetched.error.message}`);
  for (const sha of missing) {
    const has = await needCommit(gitDir, sha, `${what}: after fetch`, signal);
    if (!has.ok) return has;
  }
  return ok(undefined);
}

// ------------------------------------------------------------ the unit track

/** The unit a process is handling, for its journal record. */
export type UnitTrack = {
  readonly unit: string;
  readonly startedMs: number;
  readonly logName: string;
  record: UnitRecord | null;
  state: UnitState | null;
  sessions: number;
  /** Of `sessions`, the review sessions' runs (Epic 3 retro item 5): they run in `<lane>/review`, never the clone. */
  reviewSessions: number;
  tokens: JournalTokens | null;
  cost: JournalCost | null;
  /** A run reported no cost. */
  uncosted: boolean;
  /** The last model a run reported, or `null` when none did. */
  reportedModel: string | null;
  reason: string | null;
};

/** A fresh track for `unit`, with no record, session or cost yet. */
export function newTrack(p: { readonly unit: string; readonly startedMs: number; readonly logName: string; readonly state: UnitState | null }): UnitTrack {
  return { ...p, record: null, sessions: 0, reviewSessions: 0, tokens: null, cost: null, uncosted: false, reportedModel: null, reason: null };
}

/** Adds one usage to the track's sums; `uncosted`: some run in it reported no cost, which makes the cost an estimate. */
function addUsage(t: UnitTrack, tokens: JournalTokens | null, cost: JournalCost | null, uncosted: boolean): void {
  if (tokens !== null) {
    const a = t.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    t.tokens = {
      input: a.input + tokens.input,
      output: a.output + tokens.output,
      cacheRead: a.cacheRead + tokens.cacheRead,
      cacheCreation: a.cacheCreation + tokens.cacheCreation,
    };
  }
  if (uncosted) t.uncosted = true;
  if (cost !== null || t.cost !== null) {
    t.cost = {
      usd: (t.cost?.usd ?? 0) + (cost?.usd ?? 0),
      estimate: (t.cost?.estimate ?? false) || (cost?.estimate ?? false) || t.uncosted,
    };
  }
}

/**
 * Adds a review pass's runs, tokens and cost, kept on the pass's own track,
 * to the unit's track, so they reach the unit's journal record (Epic 3 retro
 * item 5, AR25). The unit's reported model stays the builder's: the
 * reviewer's model goes in the pass's reason instead.
 */
export function addReviewUsage(t: UnitTrack, pass: UnitTrack): void {
  t.sessions += pass.sessions;
  t.reviewSessions += pass.sessions;
  addUsage(t, pass.tokens, pass.cost, pass.uncosted);
}

/** Appends `reason` to the unit's reason unless it is already there. */
export function addReason(t: UnitTrack, reason: string): void {
  if (t.reason === null) t.reason = reason;
  else if (t.reason !== reason && !t.reason.endsWith(`; ${reason}`)) t.reason = `${t.reason}; ${reason}`;
}

export type TrackOpsParams = {
  readonly ops: ForgeOps;
  readonly identity: LaneIdentity;
  readonly note: (text: string) => void;
  /** The unit's heartbeat keeper, once it runs. */
  readonly keeper: () => Heartbeat | null;
};

export type TrackOps = {
  /**
   * Throws `Abandon` (`failed`) once the keeper lost or released the unit,
   * with the unit's state and record from the keeper's end: `null` when lost
   * or lapsed, the released record when released. A keeper that met a
   * lane-stop condition stops the lane instead: the alert, then `stop`, the
   * record left as it is.
   */
  checkHeld(t: UnitTrack): Promise<void>;
  /** Applies a held edit to the claimed unit; records the state after. None once the keeper lost the unit. */
  held(t: UnitTrack, make: (now: string, generation: number) => LedgerEdit, what: string): Promise<boolean>;
  /** A failed attempt: released, or parked at the attempts cap. */
  failUnit(t: UnitTrack, reason: string): Promise<LaneOutcome>;
  /**
   * Before the journal record and the trailing wait (C4b): a `failed` run
   * that left its unit's state unknown, the record last seen `claimed` and
   * its keeper still beating, tries the failed attempt again (`failClaimed`),
   * at once and then every `FAIL_RETRY_MS` through `waiter`, until it lands,
   * the unit is lost or the keeper ends, or `waitMs` has passed. So an outage
   * that ends within the trailing wait releases the unit, instead of the
   * keeper holding the claim through the wait and the record then going
   * stale. Returns the trailing wait left to wait: `null` for none, as when a
   * retry's wait ended early (woken, a STOP, a failed sleep). A lane-stop
   * condition throws its `Halt`; nothing else throws.
   */
  retryFail(t: UnitTrack, outcome: LaneOutcome, p: RetryFailParams): Promise<number | null>;
};

export type RetryFailParams = {
  readonly waiter: Waiter;
  /** The outcome's trailing wait; `null` for none (one retry, no wait). */
  readonly waitMs: number | null;
  /** The host clock in epoch ms. */
  readonly clock: () => number;
};

export function trackOps(p: TrackOpsParams): TrackOps {
  const { ops, identity, note } = p;

  const checkHeld = async (t: UnitTrack): Promise<void> => {
    const end = p.keeper()?.end() ?? null;
    if (end === null || end.kind === "moved-on") return;
    if (end.kind === "stop") {
      note(`stopping the lane: heartbeat: ${end.message}`);
      await ops.laneStop(end.condition, `heartbeat: ${end.message}`);
    }
    if (end.kind === "released") {
      if (end.record !== null) t.record = end.record;
      t.state = "released";
    } else {
      t.state = null;
    }
    note(`abandoning the unit: heartbeat: ${end.message}`);
    throw new Abandon("failed", `heartbeat: ${end.message}`);
  };

  const held = async (t: UnitTrack, make: (now: string, generation: number) => LedgerEdit, what: string): Promise<boolean> => {
    await checkHeld(t);
    const generation = t.record?.generation;
    if (generation === undefined) {
      t.state = null;
      return false;
    }
    const r = await ops.swap(make(await ops.freshNow(), generation), t.unit);
    if (r.kind === "ok") {
      if (r.record !== null) t.record = r.record;
      t.state = r.record?.state ?? null;
      note(`${what}: ${t.state ?? "unknown"}`);
      return true;
    }
    t.state = null;
    t.reason = t.reason === null ? `${what}: ${r.message}` : `${t.reason}; ${what}: ${r.message}`;
    note(`${what} failed: ${r.message}`);
    return false;
  };

  const failUnit = async (t: UnitTrack, reason: string): Promise<LaneOutcome> => {
    t.reason = reason;
    note(`failed: ${reason}`);
    await held(t, (now, generation) => failAttempt({ unit: t.unit, by: identity, now, generation }), "failAttempt");
    return "failed";
  };

  /** One retry of the failed attempt; `true` when there is nothing more to try. */
  const retryOnce = async (t: UnitTrack, n: number): Promise<boolean> => {
    const end = p.keeper()?.end() ?? null;
    const generation = t.record?.generation;
    if (end !== null || generation === undefined) return true;
    let r: Swapped;
    try {
      r = await ops.swap(failClaimed({ unit: t.unit, by: identity, now: await ops.freshNow(), generation }), t.unit);
    } catch (e) {
      if (e instanceof Halt) throw e;
      note(`failAttempt retry ${n} threw: ${message(e)}`);
      return true;
    }
    if (r.kind === "ok") {
      if (r.record !== null) t.record = r.record;
      t.state = r.record?.state ?? null;
      addReason(t, `failAttempt recorded on retry ${n}`);
      note(`failAttempt retry ${n}: ${t.state ?? "unknown"}`);
      return true;
    }
    note(`failAttempt retry ${n} ${r.kind === "lost" ? "lost the unit" : "failed"}: ${r.message}`);
    return r.kind === "lost";
  };

  const retryFail = async (t: UnitTrack, outcome: LaneOutcome, r: RetryFailParams): Promise<number | null> => {
    const keeper = p.keeper();
    if (outcome !== "failed" || t.state !== null || t.record?.state !== "claimed" || keeper === null || keeper.end() !== null) return r.waitMs;
    const until = r.clock() + (r.waitMs ?? 0);
    note(`failAttempt not recorded: retrying every ${FAIL_RETRY_MS} ms for up to ${r.waitMs ?? 0} ms`);
    for (let n = 1; ; n += 1) {
      if (await retryOnce(t, n)) break;
      const left = until - r.clock();
      if (left <= 0) break;
      let waited: WaitResult;
      try {
        waited = await r.waiter.wait({ ms: Math.min(FAIL_RETRY_MS, left) });
      } catch (e) {
        waited = { end: "failed", message: message(e) };
      }
      if (waited.end !== "elapsed") {
        note(`failAttempt retries end: the wait ended ${waited.end}${waited.message === undefined ? "" : ` (${waited.message})`}`);
        return null;
      }
    }
    return r.waitMs === null ? null : Math.max(0, until - r.clock());
  };

  return { checkHeld, held, failUnit, retryFail };
}

export type JournalDeps = {
  readonly store: LaneStore;
  readonly clock: () => number;
  readonly identity: LaneIdentity;
  /** The lane's agent, model and effort, as configured. */
  readonly agent: UnitJournalRecord["agent"];
  readonly model: string;
  readonly effort: UnitJournalRecord["effort"];
  /** The lane's `logs` folder, for a log path the store could not report. */
  readonly logsDir: string;
  readonly reportStore: ReportStore;
};

export type JournalEntry = {
  readonly unit: string;
  readonly logName: string;
  readonly startedMs: number;
  readonly record: UnitRecord | null;
  readonly state: UnitState | null;
  readonly outcome: LaneOutcome;
  readonly reason: string | null;
  readonly tokens?: JournalTokens | null;
  readonly cost?: JournalCost | null;
  readonly sessions?: number;
  /** A build session's result, when one ran. */
  readonly result?: BuildResult | null;
  /** The wip ref a `blocked` park's work is saved under. */
  readonly wipRef?: string | null;
  /** The last model a run reported, when any did. */
  readonly reportedModel?: string | null;
};

/** Appends one unit journal record, after flushing the unit's log. */
export function journalUnit(d: JournalDeps, e: JournalEntry): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  const endedMs = d.clock();
  const logged = d.store.appendLog(e.logName, "");
  const record: UnitJournalRecord = {
    schema_version: 1,
    type: "unit",
    unit: e.unit,
    lane: d.identity.lane,
    generation: e.record?.generation ?? null,
    started_at: iso(e.startedMs),
    ended_at: iso(endedMs),
    duration_ms: Math.max(0, endedMs - e.startedMs),
    agent: d.agent,
    model: d.model,
    ...(e.reportedModel !== undefined && e.reportedModel !== null ? { reported_model: e.reportedModel } : {}),
    effort: d.effort,
    tokens: e.tokens ?? null,
    cost: e.cost ?? null,
    sessions: e.sessions ?? 0,
    outcome: e.outcome,
    result: e.result?.outcome ?? null,
    state: e.state,
    attempts: e.record?.attempts ?? 0,
    loopbacks: e.record?.loopbacks ?? 0,
    ci_fixes: e.record?.ci_fixes ?? 0,
    denied_actions: [...(e.result?.denied_actions ?? [])],
    reason: e.reason,
    log: logged.ok ? logged.value : join(d.logsDir, e.logName),
    ...(e.wipRef !== undefined && e.wipRef !== null ? { wip_ref: e.wipRef } : {}),
  };
  d.reportStore(d.store.appendJournal(record), "journal");
}

// ------------------------------------------------------------ the session runner

export type SessionRunnerDeps = {
  readonly agent: Agent;
  readonly sandbox: Sandbox;
  readonly store: LaneStore;
  readonly workspace: Workspace;
  /** Runs the usage-limit sleeps. */
  readonly waiter: Waiter;
  /** The temp folder the runner empties and the result path it reads: the session profile's own `tempDir` and `resultPath`. */
  readonly layout: Pick<LaneLayout, "tmp" | "resultPath">;
  readonly settings: AgentSettings;
  readonly limits?: SessionLimits;
  /** The host clock in epoch ms. */
  readonly clock: () => number;
  /** Writes a `== <time> <text> ==` line to the unit log. */
  readonly note: (text: string) => void;
  /** Writes raw text to the unit log. */
  readonly log: (text: string) => void;
  readonly reportStore: ReportStore;
};

/** One unit's session context: its track, its clone's branch, its budget and its keeper. */
export type SessionContext = {
  readonly track: UnitTrack;
  readonly branch: string;
  readonly profile: SandboxProfile;
  /** The unit budget's signal. */
  readonly budget: AbortSignal;
  /** The reason a passed budget gives. */
  readonly overBudget: () => string;
  /** The keeper signals to join into a run's or a wait's signal. */
  readonly signals: () => AbortSignal[];
  /** Throws once the keeper lost or released the unit (`TrackOps.checkHeld`). */
  readonly checkHeld: () => Promise<void>;
  /** A STOP ended a usage-limit sleep: release the unit; the session then fails with `LIMIT_STOP_REASON`. */
  readonly onLimitStop: () => Promise<void>;
  /**
   * The allowance re-check (Story 3.5): run at the start of each fresh
   * session, a restart after a usage limit included. A reason fails the
   * session with it, before any sandbox run; `null` lets it run. Default:
   * no check.
   */
  readonly allowed?: () => Promise<string | null>;
};

/** A prompt for the fresh run, built after `prepare`, else the failure's reason. */
export type PromptOutcome = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

export type SessionRequest<K extends ResultKind> = {
  /** The SHA the clone starts at. */
  readonly at: string;
  readonly kind: K;
  readonly prompt: () => PromptOutcome | Promise<PromptOutcome>;
};

export type SessionOutcome<K extends ResultKind> = { readonly ok: true; readonly result: SessionResultOf<K> } | { readonly ok: false; readonly reason: string };

export type SandboxedRun = { readonly run: SandboxResult<SandboxRun>; readonly timedOut: boolean };

export type SessionRunner = {
  /** The limits in force, defaults filled in. */
  readonly limits: Required<SessionLimits>;
  /** Checks the profile's `tempDir` and `resultPath` are the runner's, empties `tmp` and prepares the clone at `at`; the failure's reason, else `null`. */
  prepare(ctx: SessionContext, at: string): Promise<string | null>;
  /**
   * One sandboxed run under one signal: the unit budget, the session limit,
   * the keeper, and an abort `resultLingerMs` after the result file is first
   * seen. `timedOut` says the session limit fired.
   */
  sandboxed(ctx: SessionContext, spec: LaunchSpec): Promise<SandboxedRun>;
  /** A sandboxed run's exit and output, into the unit log. */
  logRun(what: string, r: SandboxRun): void;
  /**
   * One agent session at `at`: prepare, the prompt, the fresh run and its one
   * resume, a usage-limit sleep and a fresh start as often as a limit hits,
   * then the result file parsed as `kind`.
   */
  session<K extends ResultKind>(ctx: SessionContext, req: SessionRequest<K>): Promise<SessionOutcome<K>>;
};

export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  const { agent, sandbox, store, workspace, layout, settings, clock, note, log, reportStore } = deps;
  const limits: Required<SessionLimits> = {
    sessionMs: deps.limits?.sessionMs ?? SESSION_MS,
    resultLingerMs: deps.limits?.resultLingerMs ?? RESULT_LINGER_MS,
    resultPollMs: deps.limits?.resultPollMs ?? RESULT_POLL_MS,
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  /** The model every run must report. */
  const configuredModel = settings.model ?? agent.defaultModel;

  const logRun = (what: string, r: SandboxRun): void =>
    log(
      `== ${iso(clock())} ${what} pid ${r.pid} exit ${r.exitCode ?? "none"} signal ${r.signal ?? "none"} ${r.durationMs} ms ==\n` +
        `--- stdout ---\n${r.stdout}${r.stdout.endsWith("\n") || r.stdout === "" ? "" : "\n"}` +
        `--- stderr ---\n${r.stderr}${r.stderr.endsWith("\n") || r.stderr === "" ? "" : "\n"}` +
        (r.proxyRequests === undefined ? "" : `--- proxy ---\n${r.proxyRequests.map(proxyLine).join("")}`),
    );

  const prepare = async (ctx: SessionContext, at: string): Promise<string | null> => {
    // The runner empties and reads only the profile's own folder: a result anywhere else is never this session's.
    const { tempDir, resultPath } = ctx.profile;
    if (resolve(tempDir) !== resolve(layout.tmp) || resolve(resultPath) !== resolve(layout.resultPath)) {
      return `profile: tempDir ${tempDir} and resultPath ${resultPath} are not the runner's ${layout.tmp} and ${layout.resultPath}`;
    }
    try {
      emptyDir(layout.tmp);
    } catch (e) {
      return `tmp: cannot empty ${layout.tmp}: ${message(e)}`;
    }
    const generation = ctx.track.record?.generation ?? 1;
    let prepared: Awaited<ReturnType<Workspace["prepare"]>>;
    try {
      prepared = await workspace.prepare({ unit: ctx.track.unit, branch: ctx.branch, start: at, generation, fetch: [at], signal: ctx.budget });
    } catch (e) {
      return `prepare: ${message(e)}`;
    }
    if (ctx.budget.aborted) return ctx.overBudget();
    if (!prepared.ok) return `prepare ${prepared.error.kind}: ${prepared.error.message}`;
    note(`clone at ${prepared.value.sha}${prepared.value.resumed ? " (wip resumed)" : ""}`);
    return null;
  };

  const resultSeen = (): boolean => {
    try {
      return lstatSync(layout.resultPath, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  };

  const sandboxed = async (ctx: SessionContext, spec: LaunchSpec): Promise<SandboxedRun> => {
    const session = new AbortController();
    const linger = new AbortController();
    const sessionTimer = setTimeout(() => session.abort(), limits.sessionMs);
    let lingerTimer: ReturnType<typeof setTimeout> | null = null;
    const poll = setInterval(() => {
      if (lingerTimer === null && resultSeen()) lingerTimer = setTimeout(() => linger.abort(), limits.resultLingerMs);
    }, limits.resultPollMs);
    // The keeper's signal kills the run when the unit is lost or released.
    const signal = AbortSignal.any([ctx.budget, session.signal, linger.signal, ...ctx.signals()]);
    const command = basename(spec.argv[0] ?? "");
    let run: SandboxResult<SandboxRun>;
    try {
      run = await sandbox.run(spec, ctx.profile, signal, { onSpawn: (pid) => reportStore(store.writePid("agent", pid, command), "agent.pid") });
    } catch (e) {
      run = { ok: false as const, error: { kind: "refused" as const, message: `sandbox threw: ${message(e)}` } };
    } finally {
      clearTimeout(sessionTimer);
      clearInterval(poll);
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      reportStore(store.clearPid("agent"), "agent.pid");
    }
    if (linger.signal.aborted && !session.signal.aborted) note(`run killed ${limits.resultLingerMs} ms after its result appeared`);
    return { run, timedOut: session.signal.aborted && !ctx.budget.aborted };
  };
  const sessionPast = (): string => `agent session ran past ${limits.sessionMs / HOUR_MS} h`;

  /** A run whose CLI rewrote the credential seeded in its vendor home: one `credential-rewrite` span over the run. */
  const credentialRewrite = (n: number, u: AgentUnit, r: SandboxRun, spec: LaunchSpec): void => {
    if (r.credentialRewritten !== true) return;
    const file = spec.credential !== undefined && "homeFile" in spec.credential ? spec.credential.homeFile : "the credential file";
    note(`run ${n} (${u.kind}) rewrote ${file} in the vendor home; the operator's credential is left as it is`);
    const span = store.appendJournal({
      schema_version: 1,
      type: "span",
      span: "credential-rewrite",
      reason: `run ${n} (${u.kind}) rewrote ${file} in the vendor home; not copied back`,
      started_at: iso(r.startedAt),
      ended_at: iso(r.endedAt),
    });
    reportStore(span, "journal");
  };

  type Once = {
    readonly sessionId: string | null;
    readonly usageLimit: AgentUsage["usageLimit"];
    readonly timedOut: boolean;
    /** The run reported no model: the `model-mismatch` reason, failing the session only where it would go on. */
    readonly noModel: string | null;
  };

  /** One sandboxed run: its session id, usage limit and whether the session limit fired, else the failure. */
  const runOnce = async (ctx: SessionContext, u: AgentUnit): Promise<Once | { readonly fail: string }> => {
    const t = ctx.track;
    const spec = agent.launchSpec(u, settings, layout.resultPath);
    if (!spec.ok) return { fail: `launch spec: ${spec.error.message}` };
    const n = t.sessions + 1;
    await ctx.checkHeld();
    note(`run ${n} (${u.kind}) starts`);
    const { run, timedOut } = await sandboxed(ctx, spec.value);
    if (!run.ok) {
      await ctx.checkHeld();
      return { fail: `sandbox refused: ${run.error.message}` };
    }
    t.sessions = n;
    const r = run.value;
    logRun(`run ${n} (${u.kind})`, r);
    credentialRewrite(n, u, r, spec.value);
    const usage = agent.parseUsage(r.stdout, ctx.profile.vendorHome, r.startedAt);
    // A run that reported no cost makes the sum an estimate.
    addUsage(t, usage.tokens, usage.cost, usage.cost === null);
    if (usage.model !== null) t.reportedModel = usage.model;
    // A unit the keeper lost or released during the run is abandoned here, before any resume.
    await ctx.checkHeld();
    // A run that ran another model fails the session at once; one that reported none fails it in `after` (Story 2.6b).
    const model = agent.checkModel(usage, configuredModel);
    if (!model.ok && usage.model !== null) return { fail: `model-mismatch: ${model.error.message}` };
    // A turn the CLI reports failed (not a usage limit) fails the attempt, with no resume.
    if (usage.failure !== undefined) return { fail: `agent turn failed: ${usage.failure}` };
    const noModel = model.ok ? null : `model-mismatch: ${model.error.message}`;
    return { sessionId: usage.sessionId, usageLimit: usage.usageLimit, timedOut, noModel };
  };

  const resultText = (): string | null => {
    try {
      return readRegular(layout.resultPath);
    } catch {
      return null;
    }
  };

  type Runs = { readonly text: string | null; readonly limit: NonNullable<AgentUsage["usageLimit"]> | null } | { readonly fail: string };

  /**
   * Re-checks the allowance (`ctx.allowed`), prepares the clone at `at`,
   * builds the prompt and runs the session with its one resume. A run that hit a usage limit and left no result returns
   * that `limit`, with no further run.
   */
  const sessionRuns = async (ctx: SessionContext, at: string, buildPrompt: SessionRequest<ResultKind>["prompt"]): Promise<Runs> => {
    if (ctx.allowed !== undefined) {
      let refused: string | null;
      try {
        refused = await ctx.allowed();
      } catch (e) {
        refused = `allowance: ${message(e)}`;
      }
      if (refused !== null) {
        note(`no session: ${refused}`);
        return { fail: refused };
      }
    }
    const setUpFailed = await prepare(ctx, at);
    if (setUpFailed !== null) return { fail: setUpFailed };
    const prompt = await buildPrompt();
    if (!prompt.ok) return { fail: prompt.reason };

    /**
     * After a run: the budget, then the result, the session limit and the
     * usage limit decide. A run that reported no model fails only where the
     * session would go on: with a result, or with no limit hit.
     */
    const after = (once: Once): Runs | null => {
      if (ctx.budget.aborted) return { fail: ctx.overBudget() };
      const text = resultText();
      if (text !== null) return once.noModel !== null ? { fail: once.noModel } : { text, limit: null };
      if (once.timedOut) return { fail: sessionPast() };
      if (once.usageLimit !== null) return { text: null, limit: once.usageLimit };
      if (once.noModel !== null) return { fail: once.noModel };
      return null;
    };
    const first = await runOnce(ctx, { kind: "fresh", prompt: prompt.value });
    if ("fail" in first) return first;
    const firstEnd = after(first);
    if (firstEnd !== null) return firstEnd;
    if (first.sessionId === null) return { text: null, limit: null };
    const second = await runOnce(ctx, { kind: "resume", sessionId: first.sessionId });
    if ("fail" in second) return second;
    return after(second) ?? { text: null, limit: null };
  };

  /**
   * Sleeps through a usage limit under the budget, the heartbeat keeper
   * stamping the claim meanwhile, then journals one `usage-limit` span.
   * `null` means the session starts again; otherwise the failure's reason.
   * A STOP runs `onLimitStop`; a unit the keeper lost or released is abandoned.
   */
  const usageLimitSleep = async (ctx: SessionContext, resetAt: number | null): Promise<string | null> => {
    const startedMs = clock();
    const ms = usageLimitSleepMs(resetAt, startedMs);
    const reset = resetAt === null ? "unknown" : iso(resetAt);
    note(`usage limit, reset ${reset}: sleeping ${ms} ms`);
    let waited: WaitResult;
    try {
      waited = await deps.waiter.wait({ ms, signal: AbortSignal.any([ctx.budget, ...ctx.signals()]) });
    } catch (e) {
      waited = { end: "failed", message: message(e) };
    }
    const span = store.appendJournal({
      schema_version: 1,
      type: "span",
      span: "usage-limit",
      reason: `usage limit; reset ${reset}`,
      started_at: iso(startedMs),
      ended_at: iso(clock()),
    });
    reportStore(span, "journal");
    note(`usage-limit sleep: ${waited.end}${waited.message === undefined ? "" : ` (${waited.message})`}`);
    await ctx.checkHeld();
    switch (waited.end) {
      case "elapsed":
      case "woken":
        return null;
      case "aborted":
        return ctx.overBudget();
      case "failed":
        return `usage-limit sleep failed: ${waited.message ?? "no message"}`;
      case "stopped":
        await ctx.onLimitStop();
        return LIMIT_STOP_REASON;
    }
  };

  const session = async <K extends ResultKind>(ctx: SessionContext, req: SessionRequest<K>): Promise<SessionOutcome<K>> => {
    const fail = (reason: string): SessionOutcome<K> => ({ ok: false, reason });
    let text: string | null = null;
    for (;;) {
      const attempt = await sessionRuns(ctx, req.at, req.prompt);
      if ("fail" in attempt) return fail(attempt.fail);
      if (attempt.limit === null) {
        text = attempt.text;
        break;
      }
      const slept = await usageLimitSleep(ctx, attempt.limit.resetAt);
      if (slept !== null) return fail(slept);
      note("usage-limit sleep over: the session starts again");
    }
    if (text === null) return fail(`no result at ${layout.resultPath} after ${ctx.track.sessions} run(s)`);
    const parsed = parseSessionResult(layout.resultPath, text, req.kind);
    if (!parsed.ok) return fail(`result ${parsed.error.kind}: ${parsed.error.message}`);
    return { ok: true, result: parsed.value };
  };

  return { limits, prepare, sandboxed, logRun, session };
}
