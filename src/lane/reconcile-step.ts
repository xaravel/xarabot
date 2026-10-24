import { approvalPaths } from "../core/ci/approval.ts";
import { classifyChecks, pollDelayMs } from "../core/ci/checks.ts";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import {
  deleteMerged,
  deleteReleasedReconcile,
  failAttempt,
  fenced,
  finishRecurring,
  heartbeat,
  markMerged,
  park,
  releaseDeadReconcile,
  releaseReconcile,
  startMerging,
  type HeartbeatSet,
  type LedgerEdit,
} from "../core/ledger/edits.ts";
import { reconcileNumber } from "../core/next/coordinator.ts";
import { planReconcile, type PlanTarget, type ReconcilePlan } from "../core/reconcile/plan.ts";
import { sanitizeAgentText } from "../core/sanitize.ts";
import type { LaneIdentity, ParkReason, UnitRecord } from "../core/schemas/ledger.ts";
import { isBackoffKind, isLaneStopKind, type CallOpts, type Forge, type ForgeError, type ForgeResult, type ForgeSnapshot } from "../ports/forge.ts";
import type { CoordinatorStep, CoordinatorStepInput } from "./coordinator-process.ts";
import { DEFAULT_CALL_TIMEOUT_MS, readsPath, writtenRecord, type PrStepOutput } from "./lane-process.ts";
import { defaultSleep, swapLedger, type Sleep } from "./ledger-cas.ts";
import { ENQUEUE_TRIES, gateComment } from "./merge-step.ts";
import type { ReconcileCommitter } from "./reconcile-commit.ts";

/**
 * The `reconcile` step (FR2, NFR20, AR4, AR10, AR14, AD-9): runner code only,
 * with no agent session, no review, no loopback and no CI-fix session. It
 * plans from the round's snapshot (`planReconcile`), then does the ledger
 * work, each item one swap fenced on its own unit: records whose PR merged
 * become `merged`; earlier `reconcile` runs are checked (a queued PR is left,
 * an ejected, dequeued or closed one is closed and its record released with
 * no attempt, a dead run's record released with an attempt, a released one's
 * PR closed and its record deleted); `merged` records done on `main` are
 * deleted.
 *
 * With no status change, no `sprint-status.yaml`, or another `reconcile` PR
 * open, the run finishes `merged` with no PR and the older `merged`
 * `reconcile` records are deleted. Otherwise it commits the edited file onto
 * the snapshot's `main`, pushes `<branches.xarabot>reconcile-<n>` as a new
 * branch, opens the PR, polls its checks, re-checks the Standing Authority on
 * fresh `main`, keeps the protected-path gate (the PR is exempt from
 * `owner_approval_paths` only), and enqueues it itself: the step ends
 * `merging` and never watches the queue. Every push, PR change and enqueue is
 * fenced. It never throws; a lost unit ends `failed` with state `null`.
 */

export type ReconcileStepDeps = {
  readonly forge: Forge;
  readonly committer: ReconcileCommitter;
  /** Who writes the ledger records: the coordinator lane. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the Standing Authority check. */
  readonly repo: string;
  /** Each forge call's (and the commit's) deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The poll, enqueue retry and ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

const MINUTE_MS = 60_000;

/** Ends the step with `out`. */
class End {
  constructor(readonly out: PrStepOutput) {}
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeError(e: ForgeError): string {
  return `${e.kind}: ${e.message}`;
}

/** The `reconcile` PR's branch: `<branches.xarabot>reconcile-<n>`. */
export function reconcileBranch(xarabotPrefix: string, unit: string): string {
  return `${xarabotPrefix}reconcile-${reconcileNumber(unit) ?? 0}`;
}

/** The commit message, PR title and PR body for the changes in `summary`. */
export function reconcilePrText(unit: string, path: string, summary: readonly string[]): { readonly message: string; readonly title: string; readonly body: string } {
  const lines = summary.map((s) => `- ${sanitizeAgentText(s).replace(/\s+/g, " ").trim()}`);
  const title = `${unit}: sprint status for merged units`;
  const body = [
    `🤖 ${unit}: runner-written by reconcile, with no agent session.`,
    "",
    `Changes to \`${sanitizeAgentText(path)}\`:`,
    "",
    ...lines,
    "",
    "The Standing Authority exempts reconcile PRs from owner approval: the runner queues this PR once its checks pass, unless a Protected Path gates it.",
    "",
  ].join("\n");
  return { message: `${title}\n\n${lines.join("\n")}\n`, title, body };
}

export function createReconcileStep(deps: ReconcileStepDeps): CoordinatorStep {
  const { forge, committer, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });

  return async (input: CoordinatorStepInput): Promise<PrStepOutput> => {
    const unit = input.unit.unit;
    const snapshot = input.snapshot;
    const generation = input.record.generation;
    let record: UnitRecord = input.record;
    let mainSha: string = snapshot.main_sha;
    let base: { readonly now: string; readonly at: number } = { now: snapshot.now, at: clock() };
    const reasons: string[] = [];

    const note = (text: string): void => {
      try {
        input.log(`reconcile step: ${text}`);
      } catch {
        // A log that cannot be written never ends the step.
      }
    };
    const end = (outcome: PrStepOutput["outcome"], state: PrStepOutput["state"]): End => {
      const r = reasons.length === 0 ? undefined : reasons.join("; ");
      return new End({ outcome, state, record, ...(r !== undefined ? { reason: r } : {}) });
    };
    const forgeNow = (): string => new Date(Date.parse(base.now) + Math.max(0, clock() - base.at)).toISOString();

    const laneStop = async (condition: string, why: string): Promise<never> => {
      try {
        await forge.alert(condition, mainSha, deadline());
      } catch {
        // The alert is best effort; the lane stops either way.
      }
      reasons.push(`${condition}: ${why}`);
      note(`stop: ${condition}: ${why}`);
      throw end("stop", record.state);
    };

    /** One forge call under its own deadline; a lane-stop kind stops the lane. */
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

    /** One ledger edit through the CAS loop; the run's own record is read back from what it wrote. */
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

    /** A failed attempt: released (or parked at the attempts cap from `claimed`). */
    const failed = async (why: string): Promise<never> => {
      reasons.push(why);
      note(`failed: ${why}`);
      const r = await swap(failAttempt({ unit, by: identity, now: forgeNow(), generation }));
      if (r.kind === "ok") {
        note(`failAttempt: ${record.state}`);
        throw end("failed", record.state);
      }
      reasons.push(`failAttempt: ${r.message}`);
      note(`failAttempt failed: ${r.message}`);
      throw end("failed", null);
    };

    /** An edit of the run's own record: a lost unit ends the step, any other failure is a failed attempt. */
    const held = async (what: string, edit: LedgerEdit): Promise<void> => {
      const r = await swap(edit);
      if (r.kind === "lost") lost(what, r.message);
      if (r.kind === "failed") await failed(`${what}: ${r.message}`);
    };

    const beat = (what: string, set?: HeartbeatSet): Promise<void> =>
      held(what, heartbeat({ unit, by: identity, now: forgeNow(), generation, ...(set !== undefined ? { set } : {}) }));

    /** The unit or the coordinator claim was lost: end `failed`, the record left for the process to judge. */
    const aborted = (): void => {
      if (!input.signal.aborted) return;
      reasons.push("the unit or the coordinator claim was lost during the reconcile step");
      note("aborted");
      throw end("failed", record.state);
    };

    const parkBlocked = async (reason: ParkReason, why: string): Promise<never> => {
      reasons.push(why);
      note(`parking blocked ${reason}: ${why}`);
      await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason }));
      throw end("progress", record.state);
    };

    // ------------------------------------------------------------ ledger work

    /**
     * One ledger item, fenced on the run's own record in the same swap. A
     * refused item is re-fenced alone: a lost unit ends the step, otherwise the
     * item's record moved on and is left to a later run.
     */
    const item = async (what: string, edit: LedgerEdit): Promise<boolean> => {
      aborted();
      const r = await swap(fenced(heartbeat({ unit, by: identity, now: forgeNow(), generation }), edit));
      if (r.kind === "ok") {
        note(what);
        return true;
      }
      if (r.kind === "failed") await failed(`${what}: ${r.message}`);
      await beat("fence");
      reasons.push(`${what} skipped: ${r.message}`);
      note(`${what} skipped: ${r.message}`);
      return false;
    };

    /** A fenced PR change on another record's PR; `false` when it failed (noted) and the record is left. */
    const prChange = async (what: string, pr: number, run: (opts: CallOpts) => Promise<ForgeResult<unknown>>): Promise<boolean> => {
      aborted();
      await beat("fence");
      const r = await call(what, run);
      if (r.ok) {
        note(`${what} PR #${pr}`);
        return true;
      }
      if (what === "closePr" && r.error.kind === "not-found") return true;
      reasons.push(`${what} PR #${pr} ${describeError(r.error)}; left for a later run`);
      note(`${what} PR #${pr} failed: ${describeError(r.error)}`);
      return false;
    };

    /** Best effort: closes this run's own PR that no ledger record carries, noting the result. */
    const closeOrphan = async (pr: number): Promise<void> => {
      const r = await call("closePr", (o) => forge.closePr(pr, o));
      if (r.ok) {
        reasons.push(`closed PR #${pr}, which no record carries`);
        note(`closed PR #${pr}, which no record carries`);
      } else {
        reasons.push(`closePr PR #${pr} ${describeError(r.error)}; it stays open with no record`);
        note(`closePr PR #${pr} failed: ${describeError(r.error)}`);
      }
    };

    /** Best effort after a failed `openPr`: each open PR on `branch` closed, behind a fence. */
    const closeOrphans = async (branch: string): Promise<void> => {
      const listed = await call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o));
      if (!listed.ok) {
        reasons.push(`listPrsByBranch ${branch} ${describeError(listed.error)}`);
        note(`listPrsByBranch ${branch} failed: ${describeError(listed.error)}`);
        return;
      }
      for (const p of listed.value.filter((x) => x.state === "open")) {
        const fence = await swap(heartbeat({ unit, by: identity, now: forgeNow(), generation }));
        if (fence.kind !== "ok") {
          reasons.push(`fence before closing PR #${p.number}: ${fence.message}; it stays open`);
          note(`fence before closing PR #${p.number} failed: ${fence.message}`);
          return;
        }
        await closeOrphan(p.number);
      }
    };

    const closeIfOpen = (t: PlanTarget): Promise<boolean> => {
      const pr = t.pr;
      if (pr === null || t.pr_state !== "open") return Promise.resolve(true);
      return prChange("closePr", pr, (o) => forge.closePr(pr, o));
    };

    const release = (t: PlanTarget): Promise<boolean> =>
      item(`releaseReconcile ${t.unit}`, releaseReconcile({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));

    /** 2. An earlier run's `merging` record: left while queued at its head, else closed and released. */
    const checkQueue = async (t: PlanTarget): Promise<void> => {
      const pr = t.pr;
      if (pr === null) {
        await release(t);
        return;
      }
      const q = await call("queueState", (o) => forge.queueState(pr, o));
      if (!q.ok) {
        if (q.error.kind !== "not-found") {
          reasons.push(`queueState PR #${pr} of ${t.unit} ${describeError(q.error)}; left for a later run`);
          note(`queueState PR #${pr} failed: ${describeError(q.error)}`);
          return;
        }
      } else {
        const s = q.value;
        if (s.state === "merged") {
          await item(`markMerged ${t.unit}`, markMerged({ unit: t.unit, by: identity, now: forgeNow() }));
          return;
        }
        if (s.state === "open" && s.queued && s.head_sha === t.head_sha) {
          note(`${t.unit}: PR #${pr} still queued at ${s.head_sha}`);
          return;
        }
        if (s.state === "open" && s.queued && !(await prChange("dequeue", pr, (o) => forge.dequeue(pr, o)))) return;
        if (s.state === "open" && !(await prChange("closePr", pr, (o) => forge.closePr(pr, o)))) return;
      }
      await release(t);
    };

    const ledgerWork = async (plan: ReconcilePlan): Promise<void> => {
      for (const u of plan.markMerged) await item(`markMerged ${u}`, markMerged({ unit: u, by: identity, now: forgeNow() }));
      for (const t of plan.checkQueue) await checkQueue(t);
      for (const t of plan.releaseDead) {
        if (!(await closeIfOpen(t))) continue;
        await item(`releaseDeadReconcile ${t.unit}`, releaseDeadReconcile({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));
      }
      for (const t of plan.deleteReleased) {
        if (!(await closeIfOpen(t))) continue;
        await item(`deleteReleasedReconcile ${t.unit}`, deleteReleasedReconcile({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));
      }
      for (const u of plan.deleteMerged) await item(`deleteMerged ${u}`, deleteMerged({ unit: u, by: identity, now: forgeNow() }));
    };

    // ------------------------------------------------------------ ending

    /** No PR this run: `merged` with no PR, then the older `merged` reconcile records deleted. */
    const finish = async (plan: ReconcilePlan, why: string): Promise<never> => {
      aborted();
      await held("finishRecurring", finishRecurring({ unit, by: identity, now: forgeNow(), generation }));
      reasons.push(why);
      note(`finished with no PR: ${why}`);
      for (const u of plan.supersededMerged) {
        const r = await swap(deleteMerged({ unit: u, by: identity, now: forgeNow() }));
        if (r.kind === "ok") note(`deleteMerged ${u}`);
        else {
          reasons.push(`deleteMerged ${u}: ${r.message}`);
          note(`deleteMerged ${u} failed: ${r.message}`);
        }
      }
      throw end("progress", record.state);
    };

    /** Polls `sha` until it passes or fails; parks `ci-timeout` past the max wait. */
    const poll = async (sha: string, waitMs: number, expected: readonly string[]): Promise<readonly string[] | "passed"> => {
      const startedAt = clock();
      for (let n = 0; ; n += 1) {
        aborted();
        const r = await call("checks", (o) => forge.checks(sha, o));
        let delay = pollDelayMs(n);
        if (!r.ok) {
          if (!isBackoffKind(r.error.kind)) return await failed(`checks ${describeError(r.error)}`);
          if (r.error.kind === "rate-limited") delay = Math.max(delay, r.error.retry_after * 1000);
          note(`checks ${describeError(r.error)}: counted as pending`);
        } else {
          const c = classifyChecks(r.value.checks, expected);
          if (c.kind === "passed") return "passed";
          if (c.kind === "failed") return c.failing;
        }
        if (clock() - startedAt >= waitMs) {
          return await parkBlocked("ci-timeout", `CI on ${sha} still pending after ${Math.round(waitMs / MINUTE_MS)} min`);
        }
        await sleep(delay, input.signal);
      }
    };

    /** The PR path: commit, push, open, CI, the re-check and the gate, then `merging` and the enqueue. */
    const openAndQueue = async (path: string, text: string, summary: readonly string[]): Promise<never> => {
      const prText = reconcilePrText(unit, path, summary);
      const branch = reconcileBranch(snapshot.config.branches.xarabot, unit);

      // 1. The bot commit onto the snapshot's main.
      let committed: Awaited<ReturnType<ReconcileCommitter["commit"]>>;
      try {
        committed = await committer.commit({
          unit,
          ontoSha: snapshot.main_sha,
          message: prText.message,
          files: { [path]: text },
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        });
      } catch (e) {
        committed = { ok: false, error: { kind: "transient", message: `commit threw: ${message(e)}` } };
      }
      aborted();
      if (!committed.ok) return await failed(`commit ${committed.error.kind}: ${committed.error.message}`);
      const { head_sha: head, base_sha: onto } = committed.value;
      note(`committed ${head} onto ${onto}`);

      // 2. Fence, then push the new branch.
      await beat("fence");
      aborted();
      const pushed = await call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: null, sha: head }, o));
      if (!pushed.ok) return await failed(`pushBranch ${branch} ${describeError(pushed.error)}`);
      note(`pushed ${head} to ${branch}`);

      // 3. Fence, then open the PR and record it.
      await beat("fence");
      aborted();
      const opened = await call("openPr", (o) => forge.openPr({ branch, base: "main", title: prText.title, body: prText.body }, o));
      if (!opened.ok) {
        // The forge may have opened it anyway: no record carries it, so close any open PR on the branch.
        await closeOrphans(branch);
        return await failed(`openPr ${describeError(opened.error)}`);
      }
      const pr = opened.value.number;
      note(`opened PR #${pr}`);
      const recorded = await swap(heartbeat({ unit, by: identity, now: forgeNow(), generation, set: { pr, pr_owner: identity.owner, head_sha: head, base_sha: onto } }));
      if (recorded.kind !== "ok") {
        // No record carries the PR, so no later run would see it: close it.
        await closeOrphan(pr);
        if (recorded.kind === "lost") lost("record", recorded.message);
        return await failed(`record: ${recorded.message}`);
      }

      // 4. CI, with no fix session.
      const polled = await poll(head, snapshot.config.ci_max_wait_minutes * MINUTE_MS, snapshot.policy.expected_checks);
      if (polled !== "passed") return await parkBlocked("verification", `CI failed on ${head}: ${polled.join(", ")}`);
      note(`CI passed on ${head}`);

      // 5. Fresh main: the Standing Authority re-check.
      aborted();
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) return await failed(`snapshot ${describeError(snapped.error)}`);
      const snap: ForgeSnapshot = snapped.value;
      base = { now: snap.now, at: clock() };
      mainSha = snap.main.sha;
      const loaded = loadRepoConfig({ repo: deps.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!loaded.ok) {
        reasons.push(`config ${loaded.error.kind}: ${loaded.error.message}`);
        note(`stop: config ${loaded.error.kind}: ${loaded.error.message}`);
        throw end("stop", record.state);
      }
      const prState = snap.prs[unit];
      if (prState?.state === "merged") {
        await held("markMerged", markMerged({ unit, by: identity, now: forgeNow() }));
        if (record.state !== "merged") record = { ...record, state: "merged", park: null };
        reasons.push(`PR #${pr} merged`);
        throw end("progress", record.state);
      }
      if (prState === undefined) return await failed(`PR #${pr} is not known to the forge`);
      if (prState.state === "closed") return await failed(`PR #${pr} is closed`);
      if (prState.head_sha !== head) return await failed(`PR #${pr} head is ${prState.head_sha}, not ${head}`);

      // The protected-path gate stays; owner_approval_paths does not apply to a reconcile PR.
      const gated = approvalPaths([path], loaded.value.repo.policy.effective_protected_paths);
      if (gated.length > 0) {
        await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: [path] }));
        reasons.push(`awaiting approval: ${gated.join(", ")}`);
        note(`parked awaiting-approval: ${gated.join(", ")}`);
        const commented = await call("comment", (o) => forge.comment(pr, gateComment(`Unit ${unit}`, gated), o));
        if (!commented.ok) {
          reasons.push(`approval comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`approval comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", record.state);
      }

      // 6. Fence, merging, enqueue; the queue is not watched.
      await beat("fence", { passed_sha: head });
      await held("startMerging", startMerging({ unit, by: identity, now: forgeNow(), generation }));
      note(`merging at ${head}`);
      for (let n = 0; ; n += 1) {
        aborted();
        if (n > 0) await beat("fence");
        const r = await call("enqueue", (o) => forge.enqueue(pr, head, o));
        if (r.ok) {
          reasons.push(`PR #${pr} enqueued at ${head}`);
          note(`enqueued PR #${pr} at ${head}`);
          throw end("progress", record.state);
        }
        if (r.error.kind === "conflict") {
          // A disposable reconcile PR: closed, and the record released with no attempt.
          note(`enqueue conflict: ${r.error.message}`);
          reasons.push(`enqueue PR #${pr} ${describeError(r.error)}: closed, released`);
          await beat("fence");
          const closed = await call("closePr", (o) => forge.closePr(pr, o));
          if (!closed.ok) reasons.push(`closePr PR #${pr} ${describeError(closed.error)}`);
          await held("releaseReconcile", releaseReconcile({ unit, by: identity, now: forgeNow(), generation }));
          throw end("progress", record.state);
        }
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) return await failed(`enqueue ${describeError(r.error)}`);
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
    };

    const steps = async (): Promise<never> => {
      aborted();
      const path = snapshot.config.sprint_status_path;
      const statusText = Object.hasOwn(input.files, path) ? (input.files[path] as string) : null;
      const plan = planReconcile(snapshot, unit, statusText);
      note(
        `plan: ${plan.markMerged.length} to mark merged, ${plan.checkQueue.length} merging, ${plan.releaseDead.length} dead, ` +
          `${plan.deleteReleased.length} released, ${plan.deleteMerged.length} done on main; status ${plan.status.kind}`,
      );
      await ledgerWork(plan);

      if (plan.openPr !== null) return await finish(plan, `${plan.openPr.unit}'s PR #${plan.openPr.pr} is open: no new reconcile PR this run`);
      const status = plan.status;
      switch (status.kind) {
        case "none":
          return await finish(plan, "no status change");
        case "absent":
          return await finish(plan, `${plan.path} is absent: no status change written`);
        case "invalid":
          return await failed(`${plan.path} cannot be edited: ${status.message}`);
        case "edit":
          for (const s of status.summary) note(`status: ${s}`);
          return await openAndQueue(plan.path, status.text, status.summary);
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
