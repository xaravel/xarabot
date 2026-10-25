import { approvalPaths } from "../core/ci/approval.ts";
import { pollDelayMs } from "../core/ci/checks.ts";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { ATTEMPTS_CAP, ejected, heartbeat, markMerged, park, startMerging } from "../core/ledger/edits.ts";
import type { NextStory } from "../core/next/next.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import type { LaneIdentity, UnitRecord } from "../core/schemas/ledger.ts";
import { isBackoffKind, type Forge, type ForgeError, type ForgeSnapshot } from "../ports/forge.ts";
import { graphDeltaComment, graphRefusalComment, type GraphDelta } from "../core/graph/graph-gate.ts";
import type { DiffPaths } from "./diff-paths.ts";
import { gateGraph } from "./graph-gate.ts";
import type { GraphTrees } from "./graph-trees.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep, type Sleep } from "./ledger-cas.ts";
import { message, readsPath, stepKit, type StepOutput } from "./session.ts";

/**
 * The merge step after CI passes (FR6, FR13, FR22, AR7, AR8, AR20, AR21). It
 * re-checks the config and Standing Authority on fresh `main`, then reads the
 * PR's changed paths. A PR touching an owner-approval or protected path parks
 * `awaiting-approval` for its owner; once the owner approves its current head,
 * the coordinator's `reconcile` queues it (Story 2.6).
 * Before that gate, the graph-change gate (Story 2.8) recomputes the PR's
 * merge with fresh `main`: a refused merge result parks `blocked`
 * `graph-invalid`; a changed graph parks `awaiting-approval` for the
 * Maintainer, with one comment carrying the delta, then any gated paths; a
 * conflicting merge, or a `main` that does not resolve, is a failed attempt.
 * Any other PR is fenced, written `merging`, enqueued at its head and watched
 * until it merges, is ejected (back to `claimed`, for the CI step to run
 * again) or fails. Every enqueue retry is fenced again, and every move out
 * of `merging` other than to `merged` fences and dequeues the PR first.
 * A record already `merging` (a stale takeover, Story 2.2) skips the gate,
 * the fence, `startMerging` and the enqueue, and is only watched.
 * There is no merge call: the merge queue does every merge. It never throws.
 */

export type MergeStepInput = {
  readonly unit: NextStory;
  /**
   * The claimed record whose PR's checks just passed, or the `merging` record
   * a stale takeover holds, with its `pr` and `head_sha` set.
   */
  readonly record: UnitRecord;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
};

/** `ejected`: the queue ejected the PR; the unit is `claimed` again for another CI round. */
export type MergeStepOutput = StepOutput;

/** Takes a unit's passing PR through the gate and the merge queue. Never throws. */
export type MergeStep = (input: MergeStepInput) => Promise<MergeStepOutput>;

export type MergeStepDeps = {
  readonly forge: Forge;
  readonly diffPaths: DiffPaths;
  /** `main`'s tree and the PR's merge tree, for the graph-change gate. */
  readonly graphTrees: GraphTrees;
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

/** The 🤖 comment on a PR parked for its owner's approval. */
export function approvalComment(p: { readonly storyId: string; readonly paths: readonly string[] }): string {
  return gateComment(`Story ${p.storyId}`, p.paths);
}

/** The approval gate's 🤖 comment for `subject` (`Story <id>`, or a coordinator unit), capped at the comment limit. */
export function gateComment(subject: string, gatedPaths: readonly string[]): string {
  const paths = gatedPaths.map((path) => sanitizeAgentText(path).replace(/\s+/g, " ")).join(", ");
  return capText(
    `🤖 ${sanitizeAgentText(subject)}: this PR changes paths that need the owner's approval: ${paths}.\n\n` +
      "It is parked awaiting approval and was not queued. Once the owner approves the PR's current head, a coordinator lane running Story 2.6 adds it to the merge queue.\n",
    FORGE_TEXT_LIMITS.comment,
  );
}

function describeError(e: ForgeError): string {
  return `${e.kind}: ${e.message}`;
}

export function createMergeStep(deps: MergeStepDeps): MergeStep {
  const { forge, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;

  return async (input: MergeStepInput): Promise<MergeStepOutput> => {
    const story = input.unit;
    const unit = story.unit;
    const kit = stepKit({
      name: "merge step",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
      beforeFail: () => leaveMerging(),
    });
    const { generation, reasons, note, end, forgeNow, call, swap, failed, lost, held, beat } = kit;

    /**
     * Before any move out of `merging` other than to `merged`: fence, then
     * dequeue the PR. A lost fence ends the step with no dequeue and no edit;
     * a fence or dequeue that fails otherwise (and does not stop the lane)
     * ends it `failed` with the record still `merging` and no edit. The fence
     * is a direct swap, so it never recurses into `failed`.
     */
    const leaveMerging = async (): Promise<void> => {
      if (kit.record.state !== "merging") return;
      const pr = kit.record.pr;
      if (pr === null) return;
      const fenced = await swap(heartbeat({ unit, by: identity, now: forgeNow(), generation }));
      if (fenced.kind === "lost") lost("dequeue fence", fenced.message);
      if (fenced.kind === "failed") {
        reasons.push(`dequeue fence: ${fenced.message}; the record stays merging`);
        note(`dequeue fence failed: ${fenced.message}; the record stays merging`);
        throw end("failed", "merging");
      }
      const r = await call("dequeue", (o) => forge.dequeue(pr, o));
      if (r.ok) {
        note(`dequeued PR #${pr}`);
        return;
      }
      reasons.push(`dequeue PR #${pr} ${describeError(r.error)}; the record stays merging`);
      note(`dequeue failed: ${describeError(r.error)}; the record stays merging`);
      throw end("failed", "merging");
    };

    const merged = async (pr: number): Promise<never> => {
      await held("markMerged", markMerged({ unit, by: identity, now: forgeNow() }));
      // A no-op (the tip already holds `merged`) writes no record to read back.
      if (kit.record.state !== "merged") kit.record = { ...kit.record, state: "merged", park: null };
      reasons.push(`PR #${pr} merged`);
      note(`PR #${pr} merged`);
      throw end("progress", kit.record.state);
    };

    /** The unit budget passed: a failed attempt, after leaving `merging`. */
    const aborted = async (): Promise<void> => {
      if (input.signal.aborted) await failed("unit budget passed during the merge step");
    };

    /**
     * 2. The approval gate, then 3. fence, `merging` and enqueue; a park ends
     * the step. A changed graph (`graph`) always parks, for the Maintainer.
     */
    const gateAndEnqueue = async (
      head: string,
      pr: number,
      main: string,
      gatedGlobs: readonly string[],
      graph: { readonly delta: GraphDelta; readonly maintainer: string } | null,
    ): Promise<void> => {
      let changed: Awaited<ReturnType<DiffPaths>>;
      try {
        changed = await deps.diffPaths({ headSha: head, mainSha: main, signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]) });
      } catch (e) {
        changed = { ok: false, error: { kind: "transient", message: `diff paths threw: ${message(e)}` } };
      }
      await aborted();
      if (!changed.ok) return await failed(`diff paths ${changed.error.kind}: ${changed.error.message}`);
      const gated = approvalPaths(changed.value, gatedGlobs);
      if (graph !== null) {
        await held(
          "park",
          park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: changed.value, inboxOwner: graph.maintainer }),
        );
        reasons.push(`awaiting the Maintainer's approval: the merge result changes the Epic graph to ${graph.delta.hash}${gated.length > 0 ? `; gated paths: ${gated.join(", ")}` : ""}`);
        note(`parked awaiting-approval for the Maintainer ${graph.maintainer}: the graph changes to ${graph.delta.hash}`);
        const body = graphDeltaComment(`Story ${story.story_id}`, { delta: graph.delta, maintainer: graph.maintainer, gatedPaths: gated });
        const commented = await call("comment", (o) => forge.comment(pr, body, o));
        if (!commented.ok) {
          reasons.push(`graph delta comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`graph delta comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", kit.record.state);
      }
      if (gated.length > 0) {
        await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: changed.value }));
        reasons.push(`awaiting approval: ${gated.join(", ")}`);
        note(`parked awaiting-approval: ${gated.join(", ")}`);
        const commented = await call("comment", (o) => forge.comment(pr, approvalComment({ storyId: story.story_id, paths: gated }), o));
        if (!commented.ok) {
          reasons.push(`approval comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`approval comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", kit.record.state);
      }

      // 3. Fence, merging, enqueue.
      await beat("fence", { passed_sha: head });
      // The queue heartbeat counts from the host time after each beat's swap.
      kit.lastBeat = clock();
      await held("startMerging", startMerging({ unit, by: identity, now: forgeNow(), generation }));
      note(`merging at ${head}`);
      for (let n = 0; ; n += 1) {
        await aborted();
        // The first enqueue follows the fence and startMerging; each retry is fenced again.
        if (n > 0) {
          await beat("fence");
          kit.lastBeat = clock();
        }
        const r = await call("enqueue", (o) => forge.enqueue(pr, head, o));
        if (r.ok) break;
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) return await failed(`enqueue ${describeError(r.error)}`);
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
      note(`enqueued PR #${pr} at ${head}`);
    };

    /**
     * The graph-change gate on the PR's merge with fresh `main`: the delta
     * when the graph changes, `null` when it does not. A refusal parks
     * `blocked` `graph-invalid` and ends the step; a conflict or an error is a
     * failed attempt.
     */
    const graphGate = async (head: string, pr: number, main: string, snap: ForgeSnapshot): Promise<GraphDelta | null> => {
      const g = await gateGraph(deps.graphTrees, {
        headSha: head,
        mainSha: main,
        ledgerFiles: snap.ledger.files,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        listPrsByBranch: (branch) => call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o)),
      });
      await aborted();
      switch (g.kind) {
        case "pass":
          note(`graph gate: unchanged (${g.hash})`);
          return null;
        case "change":
          note(`graph gate: changed from ${g.mainHash} to ${g.mergedHash}`);
          return g.delta;
        case "conflict":
          return await failed(`graph gate: the merge with main ${main} conflicts: ${g.paths.join(", ")}`);
        case "error":
          return await failed(`graph gate: ${g.message}`);
        case "refuse": {
          await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "graph-invalid" }));
          reasons.push(`graph-invalid: ${g.refusals.join("; ")}`);
          note(`parked blocked graph-invalid: ${g.refusals.join("; ")}`);
          const commented = await call("comment", (o) => forge.comment(pr, graphRefusalComment(`Story ${story.story_id}`, g.refusals), o));
          if (!commented.ok) {
            reasons.push(`graph refusal comment on PR #${pr} failed: ${describeError(commented.error)}`);
            note(`graph refusal comment failed: ${describeError(commented.error)}`);
          }
          throw end("progress", kit.record.state);
        }
      }
    };

    const steps = async (): Promise<never> => {
      await aborted();
      const head = kit.record.head_sha;
      const pr = kit.record.pr;
      if (head === null || pr === null) return await failed("the record has no PR or head_sha to merge");

      // 1. Fresh main: the config and Standing Authority re-check.
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) return await failed(`snapshot ${describeError(snapped.error)}`);
      const snap: ForgeSnapshot = snapped.value;
      kit.see(snap.now);
      const main = snap.main.sha;
      kit.mainSha = main;
      const loaded = loadRepoConfig({ repo: deps.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!loaded.ok) {
        reasons.push(`config ${loaded.error.kind}: ${loaded.error.message}`);
        note(`stop: config ${loaded.error.kind}: ${loaded.error.message}`);
        throw end("stop", kit.record.state);
      }
      const policy = loaded.value.repo.policy;
      const prState = snap.prs[unit];
      if (prState?.state === "merged") return await merged(pr);
      if (prState === undefined) return await failed(`PR #${pr} is not known to the forge`);
      if (prState.state === "closed") return await failed(`PR #${pr} is closed`);
      if (prState.head_sha !== head) return await failed(`PR #${pr} head is ${prState.head_sha}, not ${head}`);
      note(`PR #${pr} at ${head}, fresh main ${main}`);

      if (input.record.state === "merging") {
        // A stale takeover's record: already gated, fenced, merging and queued, but only at its passed head.
        if (kit.record.passed_sha !== head) {
          return await failed(`PR #${pr} is queued at ${head}, not at its passed_sha ${kit.record.passed_sha ?? "none"}`);
        }
        note(`watching PR #${pr}, already merging at ${head}`);
      } else {
        const graph = await graphGate(head, pr, main, snap);
        await gateAndEnqueue(head, pr, main, [...policy.owner_approval_paths, ...policy.effective_protected_paths], graph === null ? null : { delta: graph, maintainer: loaded.value.repo.config.maintainer });
      }

      // 4. Watch the queue.
      for (let n = 0; ; n += 1) {
        await aborted();
        if (clock() - kit.lastBeat >= QUEUE_HEARTBEAT_MS) {
          await beat("heartbeat");
          kit.lastBeat = clock();
        }
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
        if (kit.record.attempts >= ATTEMPTS_CAP) {
          await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "attempts-cap" }));
          note(`parked blocked attempts-cap after ${kit.record.attempts} attempts`);
          throw end("progress", kit.record.state);
        }
        throw end("progress", kit.record.state, { ejected: true });
      }
    };

    return kit.run(steps);
  };
}
