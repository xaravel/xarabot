import { approvalPaths } from "../core/ci/approval.ts";
import { pollDelayMs } from "../core/ci/checks.ts";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { ATTEMPTS_CAP, ejected, failAttempt, heartbeat, markMerged, park, startMerging, type HeartbeatSet, type LedgerEdit } from "../core/ledger/edits.ts";
import type { NextStory } from "../core/next/next.ts";
import { sanitizeAgentText } from "../core/sanitize.ts";
import type { LaneIdentity, UnitRecord } from "../core/schemas/ledger.ts";
import { isBackoffKind, isLaneStopKind, type CallOpts, type Forge, type ForgeError, type ForgeResult, type ForgeSnapshot } from "../ports/forge.ts";
import type { DiffPaths } from "./diff-paths.ts";
import { DEFAULT_CALL_TIMEOUT_MS, readsPath, writtenRecord, type PrStepOutput } from "./lane-process.ts";
import { defaultSleep, swapLedger, type Sleep } from "./ledger-cas.ts";

/**
 * The merge step after CI passes (FR6, FR13, FR22, AR7, AR8, AR20, AR21). It
 * re-checks the config and Standing Authority on fresh `main`, then reads the
 * PR's changed paths. A PR touching an owner-approval or protected path parks
 * `awaiting-approval` for the Maintainer, who approves and queues it by hand.
 * Any other PR is fenced, written `merging`, enqueued at its head and watched
 * until it merges, is ejected (back to `claimed`, for the CI step to run
 * again) or fails. Every move out of `merging` other than to `merged`
 * dequeues the PR first. There is no merge call: the merge queue does every
 * merge. It never throws.
 */

export type MergeStepInput = {
  readonly unit: NextStory;
  /** The claimed record whose PR's checks just passed, with its `pr` and `head_sha` set. */
  readonly record: UnitRecord;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
};

/** `ejected`: the queue ejected the PR; the unit is `claimed` again for another CI round. */
export type MergeStepOutput = PrStepOutput & { readonly ejected?: true };

/** Takes a unit's passing PR through the gate and the merge queue. Never throws. */
export type MergeStep = (input: MergeStepInput) => Promise<MergeStepOutput>;

export type MergeStepDeps = {
  readonly forge: Forge;
  readonly diffPaths: DiffPaths;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the Standing Authority check. */
  readonly repo: string;
  /** Each forge call's (and the diff's) deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The queue poll, enqueue retry and ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

/** `enqueue` calls in all before a back-off reply counts as a failure. */
export const ENQUEUE_TRIES = 3;
/** Host time between heartbeats while the PR is queued. */
export const QUEUE_HEARTBEAT_MS = 5 * 60_000;

const ZERO_SHA = "0".repeat(40);

/** The 🤖 comment on a PR parked for its owner's approval. */
export function approvalComment(p: { readonly storyId: string; readonly paths: readonly string[] }): string {
  const paths = p.paths.map((path) => sanitizeAgentText(path).replace(/\s+/g, " ")).join(", ");
  return (
    `🤖 Story ${sanitizeAgentText(p.storyId)}: this PR changes paths that need the owner's approval: ${paths}.\n\n` +
    "It is parked awaiting approval and was not queued. The Maintainer approves it and queues it by hand.\n"
  );
}

/** Ends the step with `out`. */
class End {
  constructor(readonly out: MergeStepOutput) {}
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeError(e: ForgeError): string {
  return `${e.kind}: ${e.message}`;
}

export function createMergeStep(deps: MergeStepDeps): MergeStep {
  const { forge, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });

  return async (input: MergeStepInput): Promise<MergeStepOutput> => {
    const story = input.unit;
    const unit = story.unit;
    const generation = input.record.generation;
    let record: UnitRecord = input.record;
    let mainSha: string | null = null;
    let base: { readonly now: string; readonly at: number } | null = null;
    const reasons: string[] = [];

    const note = (text: string): void => {
      try {
        input.log(`merge step: ${text}`);
      } catch {
        // A log that cannot be written never ends the step.
      }
    };
    const end = (outcome: MergeStepOutput["outcome"], state: MergeStepOutput["state"], extra: { readonly ejected?: true } = {}): End => {
      const r = reasons.length === 0 ? undefined : reasons.join("; ");
      return new End({ outcome, state, record, ...(r !== undefined ? { reason: r } : {}), ...extra });
    };
    const forgeNow = (): string => {
      if (base === null) return new Date(clock()).toISOString();
      return new Date(Date.parse(base.now) + Math.max(0, clock() - base.at)).toISOString();
    };

    const laneStop = async (condition: string, why: string): Promise<never> => {
      try {
        await forge.alert(condition, mainSha ?? ZERO_SHA, deadline());
      } catch {
        // The alert is best effort; the lane stops either way.
      }
      reasons.push(`${condition}: ${why}`);
      note(`stop: ${condition}: ${why}`);
      throw end("stop", record.state);
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

    type Swapped = { readonly kind: "ok" } | { readonly kind: "lost" | "failed"; readonly message: string };

    const swap = async (edit: LedgerEdit): Promise<Swapped> => {
      const r = await swapLedger({
        forge,
        edit,
        signal: AbortSignal.timeout(callTimeoutMs),
        sleep,
        ...(deps.random !== undefined ? { random: deps.random } : {}),
      });
      if (r.ok) {
        const written = writtenRecord(r.value.commit, unit);
        if (written !== null) record = written;
        return { kind: "ok" };
      }
      const e = r.error;
      if (e.kind === "edit" && e.edit === "stop") await laneStop("ledger-schema-version", e.message);
      if (e.kind === "forge" && isLaneStopKind(e.forge.kind)) await laneStop(`forge-${e.forge.kind}`, e.message);
      if (e.kind === "edit" && e.edit === "precondition") return { kind: "lost", message: e.message };
      return { kind: "failed", message: `ledger ${e.kind}: ${e.message}` };
    };

    const lost = (what: string, why: string): never => {
      reasons.push(`${what}: unit lost: ${why}`);
      note(`${what}: unit lost: ${why}`);
      throw end("failed", null);
    };

    /**
     * Before any move out of `merging` other than to `merged`: dequeue the PR.
     * A dequeue that fails (and does not stop the lane) ends the step `failed`
     * with the record still `merging` and no edit.
     */
    const leaveMerging = async (): Promise<void> => {
      if (record.state !== "merging") return;
      const pr = record.pr;
      if (pr === null) return;
      const r = await call("dequeue", (o) => forge.dequeue(pr, o));
      if (r.ok) {
        note(`dequeued PR #${pr}`);
        return;
      }
      reasons.push(`dequeue PR #${pr} ${describeError(r.error)}; the record stays merging`);
      note(`dequeue failed: ${describeError(r.error)}; the record stays merging`);
      throw end("failed", "merging");
    };

    /** A failed attempt: released (or parked at the attempts cap), after leaving `merging`. */
    const failed = async (why: string): Promise<never> => {
      reasons.push(why);
      note(`failed: ${why}`);
      await leaveMerging();
      const r = await swap(failAttempt({ unit, by: identity, now: forgeNow(), generation: record.generation }));
      if (r.kind === "ok") {
        note(`failAttempt: ${record.state}`);
        throw end("failed", record.state);
      }
      reasons.push(`failAttempt: ${r.message}`);
      note(`failAttempt failed: ${r.message}`);
      throw end("failed", null);
    };

    /** A held edit: a lost unit ends the step, any other failure is a failed attempt. */
    const held = async (what: string, edit: LedgerEdit): Promise<void> => {
      const r = await swap(edit);
      if (r.kind === "lost") lost(what, r.message);
      if (r.kind === "failed") await failed(`${what}: ${r.message}`);
    };

    let lastBeat = clock();
    const beat = async (what: string, set?: HeartbeatSet): Promise<void> => {
      await held(what, heartbeat({ unit, by: identity, now: forgeNow(), generation, ...(set !== undefined ? { set } : {}) }));
      lastBeat = clock();
    };

    const merged = async (pr: number): Promise<never> => {
      await held("markMerged", markMerged({ unit, by: identity, now: forgeNow() }));
      // A no-op (the tip already holds `merged`) writes no record to read back.
      if (record.state !== "merged") record = { ...record, state: "merged", park: null };
      reasons.push(`PR #${pr} merged`);
      note(`PR #${pr} merged`);
      throw end("progress", record.state);
    };

    /** The unit budget passed: a failed attempt, after leaving `merging`. */
    const aborted = async (): Promise<void> => {
      if (input.signal.aborted) await failed("unit budget passed during the merge step");
    };

    const steps = async (): Promise<never> => {
      await aborted();
      const head = record.head_sha;
      const pr = record.pr;
      if (head === null || pr === null) return await failed("the record has no PR or head_sha to merge");

      // 1. Fresh main: the config and Standing Authority re-check.
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) return await failed(`snapshot ${describeError(snapped.error)}`);
      const snap: ForgeSnapshot = snapped.value;
      base = { now: snap.now, at: clock() };
      const main = snap.main.sha;
      mainSha = main;
      const loaded = loadRepoConfig({ repo: deps.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!loaded.ok) {
        reasons.push(`config ${loaded.error.kind}: ${loaded.error.message}`);
        note(`stop: config ${loaded.error.kind}: ${loaded.error.message}`);
        throw end("stop", record.state);
      }
      const policy = loaded.value.repo.policy;
      const prState = snap.prs[unit];
      if (prState?.state === "merged") return await merged(pr);
      if (prState === undefined) return await failed(`PR #${pr} is not known to the forge`);
      if (prState.state === "closed") return await failed(`PR #${pr} is closed`);
      if (prState.head_sha !== head) return await failed(`PR #${pr} head is ${prState.head_sha}, not ${head}`);
      note(`PR #${pr} at ${head}, fresh main ${main}`);

      // 2. The approval gate.
      let changed: Awaited<ReturnType<DiffPaths>>;
      try {
        changed = await deps.diffPaths({ headSha: head, mainSha: main, signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]) });
      } catch (e) {
        changed = { ok: false, error: { kind: "transient", message: `diff paths threw: ${message(e)}` } };
      }
      await aborted();
      if (!changed.ok) return await failed(`diff paths ${changed.error.kind}: ${changed.error.message}`);
      const gated = approvalPaths(changed.value, [...policy.owner_approval_paths, ...policy.effective_protected_paths]);
      if (gated.length > 0) {
        await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: changed.value }));
        reasons.push(`awaiting approval: ${gated.join(", ")}`);
        note(`parked awaiting-approval: ${gated.join(", ")}`);
        const commented = await call("comment", (o) => forge.comment(pr, approvalComment({ storyId: story.story_id, paths: gated }), o));
        if (!commented.ok) {
          reasons.push(`approval comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`approval comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", record.state);
      }

      // 3. Fence, merging, enqueue.
      await beat("fence", { passed_sha: head });
      await held("startMerging", startMerging({ unit, by: identity, now: forgeNow(), generation }));
      note(`merging at ${head}`);
      for (let n = 0; ; n += 1) {
        await aborted();
        const r = await call("enqueue", (o) => forge.enqueue(pr, head, o));
        if (r.ok) break;
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) return await failed(`enqueue ${describeError(r.error)}`);
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
      note(`enqueued PR #${pr} at ${head}`);

      // 4. Watch the queue.
      for (let n = 0; ; n += 1) {
        await aborted();
        if (clock() - lastBeat >= QUEUE_HEARTBEAT_MS) await beat("heartbeat");
        const r = await call("queueState", (o) => forge.queueState(pr, o));
        let delay = pollDelayMs(n);
        if (!r.ok) {
          if (!isBackoffKind(r.error.kind)) return await failed(`queueState ${describeError(r.error)}`);
          if (r.error.kind === "rate-limited") delay = Math.max(delay, r.error.retry_after * 1000);
          note(`queueState ${describeError(r.error)}: counted as pending`);
          await sleep(delay, input.signal);
          continue;
        }
        const q = r.value;
        if (q.state === "merged") return await merged(pr);
        if (q.state === "closed") return await failed(`PR #${pr} was closed while queued`);
        if (q.head_sha !== head) return await failed(`PR #${pr} head moved to ${q.head_sha} while queued`);
        if (q.queued) {
          await sleep(delay, input.signal);
          continue;
        }

        // Ejected: open, not queued, at the same head.
        note(`PR #${pr} was ejected from the merge queue`);
        await leaveMerging();
        await held("ejected", ejected({ unit, by: identity, now: forgeNow(), generation }));
        reasons.push(`PR #${pr} ejected from the merge queue`);
        if (record.attempts >= ATTEMPTS_CAP) {
          await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "attempts-cap" }));
          note(`parked blocked attempts-cap after ${record.attempts} attempts`);
          throw end("progress", record.state);
        }
        throw end("progress", record.state, { ejected: true });
      }
    };

    try {
      return await steps();
    } catch (e) {
      if (e instanceof End) return e.out;
      try {
        return await failed(`unexpected error: ${message(e)}`);
      } catch (inner) {
        if (inner instanceof End) return inner.out;
        reasons.push(`unexpected error: ${message(inner)}`);
        return { outcome: "failed", state: null, record, reason: reasons.join("; ") };
      }
    }
  };
}
