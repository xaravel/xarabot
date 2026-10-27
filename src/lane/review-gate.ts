import { loopback, markMerged, park } from "../core/ledger/edits.ts";
import type { Result } from "../core/result.ts";
import { findingsText } from "../core/review/findings.ts";
import { LOOPBACK_CAP, reviewNext } from "../core/review/gate.ts";
import type { LaneIdentity, UnitRecord } from "../core/schemas/ledger.ts";
import type { ReviewFinding } from "../core/schemas/session-result.ts";
import type { Forge } from "../ports/forge.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep, type Sleep } from "./ledger-cas.ts";
import type { ReviewStep, ReviewStepInput } from "./review-step.ts";
import {
  allowanceReason,
  describeError,
  End,
  Halt,
  message,
  passedGate,
  stepKit,
  stepOps,
  type CiSessionDone,
  type FreshMain,
  type PassedGate,
  type PushFix,
  type StepKit,
  type StepOps,
  type StepOutput,
  type StepUnit,
  type UnitTrack,
} from "./session.ts";

/**
 * The review gate (Story 3.5, FR8, AR17, AR20, AR21, AD-16): after CI
 * passes and before the merge step, on a claimed record with an open PR.
 *
 * 1. Fresh `main` (an invalid config ends the step `stop`).
 * 2. The passed gate at the record's head: a head a review passed (or a
 *    chain of clean merges with `main` back to it) ends the step `progress`
 *    `claimed`, with no review. A gate error is a failed attempt.
 * 3. Otherwise one review round (the review step). Any ending other than
 *    `progress` `claimed` is passed through as it is.
 * 4. `reviewNext` decides: `pass` (a round with no blocking pass, at any
 *    loopback count; the review step set `passed_sha` to the head) ends
 *    `progress` `claimed`, for the merge step; `cap` (a blocking round
 *    after `LOOPBACK_CAP` loopbacks) parks `blocked` `review-cap` in the
 *    writer's inbox (the record's owner); `loopback` counts the loopback
 *    (`loopback`, cap `LOOPBACK_CAP`), then runs a loopback session at the
 *    head with the round's findings text.
 * 5. After the loopback session: `blocked` parks with its kind, `no-op`
 *    parks `no-op`; a `done` result (with its spec when `needsSpec`) is
 *    pushed through `pushFix`, and the step ends `progress` `claimed` with
 *    `pushed: true`, for the caller to take the new head through CI again.
 *
 * A `Halt` from the review or the session reaches the caller; anything else
 * never throws.
 */

export type LoopbackRequest = {
  /** The SHA the clone starts at: the reviewed head. */
  readonly start: string;
  /** The findings text the session is told: written to `tmp/review-findings.md`. */
  readonly findingsText: string;
};

/** One builder session in `loopback` mode; a failure is a failed attempt. May throw a `Halt`. */
export type LoopbackSession = (request: LoopbackRequest) => Promise<Result<CiSessionDone>>;

export type ReviewGateInput = {
  readonly unit: StepUnit;
  /** The Story's id, whose spec the review reads; `null` for a unit with none (a retro item). */
  readonly storyId: string | null;
  /** The claimed record, with its open PR at `head_sha`. */
  readonly record: UnitRecord;
  /** The caller's track, for the review step. */
  readonly track: UnitTrack;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
  /** Whether a `done` loopback needs a spec file: a Story's does, a retro item's does not. */
  readonly needsSpec: boolean;
  readonly session: LoopbackSession;
  readonly pushFix: PushFix;
};

/** `pushed`: a loopback fix was pushed; the caller takes the new head through CI again. */
export type ReviewGateOutput = StepOutput & { readonly pushed?: true };

/** Runs the review gate. Never throws, except a `Halt` from the review or the session. */
export type ReviewGateStep = (input: ReviewGateInput) => Promise<ReviewGateOutput>;

export type ReviewGateDeps = {
  readonly forge: Forge;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the config loaded from fresh `main`. */
  readonly repo: string;
  readonly review: ReviewStep;
  readonly passed: PassedGate;
  /** The lane's credentials, redacted from the findings text; default none. */
  readonly secrets?: readonly string[];
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

export function createReviewGateStep(deps: ReviewGateDeps): ReviewGateStep {
  const { forge, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const secrets = deps.secrets ?? [];

  return async (input: ReviewGateInput): Promise<ReviewGateOutput> => {
    const unit = input.unit.unit;
    const kit = stepKit({
      name: "review gate",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    const { generation, reasons, note, end, forgeNow, failed, held } = kit;
    const { aborted, parkBlocked, freshMain, pushSessionFix } = stepOps({
      kit,
      forge,
      identity,
      repo: deps.repo,
      signal: input.signal,
      abortReason: "unit budget passed during the review gate",
      clock,
      sleep,
      secrets,
    });

    /** The loopback session's result, pushed as a fix; returns once the fix is pushed. */
    const loopbackSession = async (head: string, text: string): Promise<void> => {
      await held("loopback", loopback({ unit, by: identity, now: forgeNow(), generation, cap: LOOPBACK_CAP }));
      if (kit.record.state === "parked") {
        reasons.push(`review loopback cap of ${LOOPBACK_CAP} reached`);
        note("parked review-cap before the loopback");
        throw end("progress", kit.record.state);
      }
      note(`loopback ${kit.record.loopbacks} of ${LOOPBACK_CAP} at ${head}`);
      aborted();
      let ran: Awaited<ReturnType<LoopbackSession>>;
      try {
        ran = await input.session({ start: head, findingsText: text });
      } catch (e) {
        if (e instanceof Halt) throw e;
        ran = { ok: false, error: { kind: "threw", message: e instanceof End ? (e.out.reason ?? "the session ended early") : message(e) } };
      }
      aborted();
      if (!ran.ok) return await failed(`loopback session ${ran.error.kind}: ${ran.error.message}`);
      await pushSessionFix("loopback", ran.value, input.needsSpec, input.pushFix);
    };

    const steps = async (): Promise<ReviewGateOutput> => {
      aborted();
      const head = kit.record.head_sha;
      const pr = kit.record.pr;
      if (head === null || pr === null) return await failed("the record has no PR or head_sha to review");

      // 1. Fresh main.
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const main = fresh.value.snap.main.sha;

      // 2. The passed gate at the record's head.
      const gate = await passedGate(kit, { passed: deps.passed, headSha: head, mainSha: main, signal: input.signal, callTimeoutMs, after: aborted });
      if (gate.kind === "passed") {
        note(`passed gate: ${head} passed (${gate.how}): no review`);
        throw end("progress", kit.record.state);
      }
      note(`passed gate: unreviewed: ${gate.why}`);

      // 3. One review round; the session runs outside `kit.run`, so a `Halt` reaches the caller.
      const out = await deps.review({ unit: input.unit, storyId: input.storyId, record: kit.record, track: input.track, signal: input.signal, log: input.log });
      if (out.record !== undefined) kit.record = out.record;
      if (out.outcome !== "progress" || out.state !== "claimed" || out.review === undefined) return out;
      if (out.reason !== undefined) reasons.push(out.reason);
      const round = out.review;

      // 4. Pass, loopback or cap.
      const decision = reviewNext({ loopbacks: kit.record.loopbacks, blocking: round.blocking });
      note(`review of ${round.sha}: ${round.blocking ? "blocking" : "passed"}, ${round.findings.length} finding(s), loopbacks ${kit.record.loopbacks}: ${decision}`);
      if (decision === "cap") {
        return await parkBlocked("review-cap", `review loopback cap of ${LOOPBACK_CAP} reached: the round after the last loopback blocked at ${round.sha}`);
      }
      if (decision === "pass") throw end("progress", kit.record.state);

      // 5. A loopback session with the round's findings, pushed as a fix.
      const text = findingsText({ subject: input.unit.subject, sha: round.sha, blocking: round.blocking, findings: round.findings, secrets });
      await loopbackSession(round.sha, text);
      const done = end("progress", kit.record.state).out;
      return { ...done, pushed: true };
    };

    try {
      return await steps();
    } catch (e) {
      if (e instanceof End) return e.out;
      if (e instanceof Halt) throw e;
      return kit.run(() => failed(`unexpected error: ${message(e)}`));
    }
  };
}

export type ReviewOrParkParams = {
  /** The caller's kit: the gate's notes, reasons and endings go through it, and it adopts the review's record. */
  readonly kit: StepKit;
  readonly aborted: StepOps["aborted"];
  /** Who writes the park. */
  readonly identity: LaneIdentity;
  /** Fresh `main`'s `config.maintainer`: a blocking round parks in the Maintainer's inbox. */
  readonly maintainer: string;
  readonly passed: PassedGate;
  readonly review: ReviewStep;
  /** The review step's input but the record, which is the kit's. */
  readonly input: Omit<ReviewStepInput, "record">;
  /** The PR's head, as the record and fresh `main`'s snapshot show it. */
  readonly head: string;
  /** Fresh `main`. */
  readonly mainSha: string;
  /** The passed gate's deadline. */
  readonly callTimeoutMs: number;
};

/**
 * A coordinator PR's review before its approval gate or enqueue (Story 3.5:
 * planning and retro): the passed gate at `head`; a head no review passed
 * gets one review round, and a blocking round parks `blocked`
 * `review-findings` for the Maintainer (`inbox_owner`), with no loopback.
 * Returns once the head passed (the gate, or a round with no blocking
 * pass): `true` when a review round ran, so the caller starts its checks
 * again on fresh `main`; otherwise ends the
 * caller's step through its kit (`End`). A gate error is a failed attempt;
 * a `Halt` from the review reaches the caller.
 */
export async function reviewOrPark(p: ReviewOrParkParams): Promise<boolean> {
  const { kit, head } = p;
  const gate = await passedGate(kit, { passed: p.passed, headSha: head, mainSha: p.mainSha, signal: p.input.signal, callTimeoutMs: p.callTimeoutMs, after: p.aborted });
  if (gate.kind === "passed") {
    kit.note(`passed gate: ${head} passed (${gate.how}): no review`);
    return false;
  }
  kit.note(`passed gate: unreviewed: ${gate.why}`);
  const out = await p.review({ ...p.input, record: kit.record });
  if (out.record !== undefined) kit.record = out.record;
  if (out.reason !== undefined) kit.reasons.push(out.reason);
  if (out.outcome !== "progress" || out.state !== "claimed" || out.review === undefined) throw kit.end(out.outcome, out.state);
  p.aborted();
  const round = out.review;
  if (round.blocking) {
    const why = `review of ${round.sha} blocked (${blockedBy(round.findings)}): no loopback for this unit`;
    kit.reasons.push(why);
    kit.note(`parking blocked review-findings for the Maintainer ${p.maintainer}: ${why}`);
    await kit.held("park", park({ unit: kit.unit, by: p.identity, now: kit.forgeNow(), generation: kit.generation, kind: "blocked", reason: "review-findings", inboxOwner: p.maintainer }));
    throw kit.end("progress", kit.record.state);
  }
  kit.note(`review of ${round.sha} passed`);
  return true;
}

export type CoordinatorChecksParams = Omit<ReviewOrParkParams, "maintainer" | "mainSha" | "aborted"> & {
  readonly ops: Pick<StepOps, "aborted" | "parkBlocked" | "freshMain" | "poll">;
  /** The lane's agent, which fresh `main`'s policy must still allow. */
  readonly agent: string;
  readonly pr: number;
  /** The round's `ci_max_wait_minutes`, in ms. */
  readonly ciWaitMs: number;
  /** The round's `expected_checks`. */
  readonly expectedChecks: readonly string[];
};

/**
 * The checks before a coordinator PR's approval gate or enqueue (Stories
 * 2.7, 2.9 and 3.5: planning and retro), at its `head`:
 *
 * 1. CI, with no fix session: failing checks park `blocked` `verification`.
 * 2. Fresh `main` (an invalid config ends the step `stop`, a failed
 *    snapshot is a failed attempt), and the PR as it shows it: merged ends
 *    the step `progress` `merged`; unknown, closed or at another head is a
 *    failed attempt.
 * 3. `reviewOrPark`. A review round that passed took a session's time, so
 *    every check runs again once on fresh `main`, where the gate now passes
 *    the head; a head still unreviewed then is a failed attempt.
 * 4. The allowance on fresh `main`'s policy (`allowanceReason`): refused is
 *    a failed attempt.
 *
 * Returns fresh `main` once all pass; otherwise ends the caller's step
 * through its kit. A `Halt` from the review reaches the caller.
 */
export async function coordinatorChecks(p: CoordinatorChecksParams): Promise<FreshMain> {
  const { kit, ops, head, pr } = p;
  for (let again = false; ; again = true) {
    // 1. CI, with no fix session.
    const polled = await ops.poll(head, p.ciWaitMs, p.expectedChecks);
    if (polled !== "passed") return await ops.parkBlocked("verification", `CI failed on ${head}: ${polled.join(", ")}`);
    kit.note(`CI passed on ${head}`);

    // 2. Fresh main: the Standing Authority re-check, and the PR as the forge shows it.
    const fresh = await ops.freshMain();
    if (!fresh.ok) return await kit.failed(`snapshot ${describeError(fresh.error)}`);
    const { snap, config: repo } = fresh.value;
    const prState = snap.prs[kit.unit];
    if (prState?.state === "merged") {
      await kit.held("markMerged", markMerged({ unit: kit.unit, by: p.identity, now: kit.forgeNow() }));
      if (kit.record.state !== "merged") kit.record = { ...kit.record, state: "merged", park: null };
      kit.reasons.push(`PR #${pr} merged`);
      throw kit.end("progress", kit.record.state);
    }
    if (prState === undefined) return await kit.failed(`PR #${pr} is not known to the forge`);
    if (prState.state === "closed") return await kit.failed(`PR #${pr} is closed`);
    if (prState.head_sha !== head) return await kit.failed(`PR #${pr} head is ${prState.head_sha}, not ${head}`);

    // 3. The passed gate, then one review round for a head no review passed (Story 3.5): a blocking one parks.
    const reviewed = await reviewOrPark({ ...p, aborted: ops.aborted, maintainer: repo.repo.config.maintainer, mainSha: snap.main.sha });
    if (reviewed) {
      if (again) return await kit.failed(`the passed gate still finds ${head} unreviewed after its review passed`);
      kit.note(`review of ${head} passed: CI and the gates again on fresh main`);
      continue;
    }

    // 4. The allowance (Story 3.5): fresh main's policy must still allow the lane's agent and a reviewer.
    const refused = allowanceReason(repo.repo.policy, p.agent, kit.record.builder_providers);
    if (refused !== null) return await kit.failed(refused);
    return fresh.value;
  }
}

/** What blocked a round: its blocking findings, or, with none, its `changes-requested` verdict. */
function blockedBy(findings: readonly ReviewFinding[]): string {
  const blocking = findings.filter((f) => f.blocking).length;
  if (blocking > 0) return `${blocking} blocking finding(s) of ${findings.length}`;
  return `its verdict changes-requested, with no blocking finding of ${findings.length}`;
}
