import { approvalPaths } from "../core/ci/approval.ts";
import { pollDelayMs } from "../core/ci/checks.ts";
import {
  changeRulingLists,
  deleteMerged,
  deleteReleasedRecurring,
  fenced,
  finishRecurring,
  heartbeat,
  isDisposable,
  markMerged,
  park,
  recordRulings,
  releaseDeadReconcile,
  reparkGraph,
  releaseDisposable,
  releaseEjected,
  rulingListsOf,
  stampDigest,
  startMerging,
  takeApproved,
  type HeartbeatSet,
  type LedgerEdit,
} from "../core/ledger/edits.ts";
import { openDeferred } from "../core/inbox/deferred.ts";
import { digestDue, digestSlot } from "../core/inbox/digest-time.ts";
import { renderDigest } from "../core/inbox/render-digest.ts";
import { unitBranch } from "../core/next/coordinator.ts";
import { standingApproval } from "../core/reconcile/approval.ts";
import { planReconcile, type ApprovalTarget, type GatedTarget, type PlanTarget, type ReconcilePlan } from "../core/reconcile/plan.ts";
import { judgeRulings, rulingAdds, rulingsDrops, rulingsEdit, rulingsView, withPending, type JudgedRuling } from "../core/rulings/effects.ts";
import type { PendingRuling } from "../core/schemas/ledger.ts";
import type { Snapshot } from "../core/schemas/snapshot.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import { GRAPH_PSEUDO_GLOB, unitKind, type LaneIdentity } from "../core/schemas/ledger.ts";
import { isBackoffKind, type CallOpts, type Forge, type ForgeResult, type ForgeSnapshot, type InboxComment } from "../ports/forge.ts";
import { graphDeltaComment, graphRefusalComment, type GraphDelta } from "../core/graph/graph-gate.ts";
import type { CoordinatorStep, CoordinatorStepInput } from "./coordinator-process.ts";
import { gateGraph, type GraphGateOutcome } from "./graph-gate.ts";
import type { GraphTrees } from "./graph-trees.ts";
import { syncInboxes } from "./inbox-step.ts";
import { answerRulings } from "./rulings-step.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep, swapLedger, type Sleep } from "./ledger-cas.ts";
import { ENQUEUE_TRIES, gateComment } from "./merge-step.ts";
import type { ReconcileCommitter } from "./reconcile-commit.ts";
import { allowanceReason, callPassedGate, describeError, ledgerFenceOf, message, stepKit, stepOps, type FreshMain, type PassedGate, type PrStepOutput } from "./session.ts";

/**
 * The `reconcile` step (FR2, NFR20, AR4, AR10, AR14, AD-9): runner code only,
 * with no agent session, no review, no loopback and no CI-fix session. It
 * plans from the round's snapshot (`planReconcile`), then does the ledger
 * work, each item one swap fenced on its own unit: records whose PR merged
 * become `merged`; earlier `reconcile` runs are checked (a queued PR is left,
 * an ejected, dequeued or closed one is closed and its record released with
 * no attempt, a dead run's record released with an attempt, a released
 * one's record deleted; before a dead or released record is touched, every
 * open PR on its branch is closed, found by listing the branch, so an orphan
 * PR no record carries is closed too); `merged` records done on `main` are
 * deleted. An ungated status planning PR (`approved_sha` `null`, Story 2.7)
 * is disposable like a `reconcile` PR, and a `released` planning record
 * whose PR is not open is deleted the same way (`deleteReleasedRecurring`).
 * Once a disposable record is released, its branch is deleted too
 * (`Forge.deleteBranch`, Epic 2 retro item 21); a failed delete is noted and
 * leaves the branch. A released disposable record's branch is deleted before
 * the record (Epic 2 retro item 37), so a failed delete also leaves the
 * record `released` for a later run to retry. A `reconcile` PR an owner
 * approved that the runner took and failed to enqueue is closed and replaced
 * like any other, never enqueued again (Q4).
 *
 * Approval-gated PRs (Story 2.6, FR13, AR8, AR17, AD-14): a `parked`
 * `awaiting-approval` record whose PR is open at the parked head is taken
 * once its owner's approval of that head stands (`standingApproval` over
 * `Forge.reviews`). A builder's first park counts any owner approval, even
 * one given while CI still ran, and so does the coordinator's own first park
 * (a planning or `reconcile` gate park, with no `enqueued_sha`); only a re-park
 * of a record the coordinator took (its `lane` is `coordinator` and it has an
 * `enqueued_sha`) needs a review submitted after the park.
 * Before the first take the run re-checks the Standing Authority on fresh
 * `main`. Before a take of a unit that is not `reconcile` (Story 3.5), fresh
 * `main`'s policy must still allow the lane's agent and a reviewer
 * (`allowanceReason`: refused, no such take this run), and the approved
 * head must pass the passed gate (`passed_sha`, or its clean merge with
 * `main`): an unreviewed head, or a gate error, is not taken and stays
 * `parked`. It then takes the record at `generation` + 1 (`takeApproved`,
 * `approved_sha` = head, `enqueued_sha` cleared, `passed_sha` kept), fences
 * it, enqueues the PR at that head and records the enqueue (`enqueued_sha` =
 * head). Later runs check
 * the queue of these coordinator-held `merging` records, whichever
 * coordinator lane took them: merged is `merged`, queued at `approved_sha` is
 * left; one open at `approved_sha` and out of the queue that the runner never
 * enqueued (no `enqueued_sha`: a failed enqueue, fence or read after the take,
 * or a run that died) is parked again with `enqueued_sha` still unset and taken
 * again in the same run on its standing approval, so the runner's own
 * failure never costs a review; anything else (an ejection, a moved head, a
 * closed PR; dequeued after a fenced `dequeue` when queued at another head)
 * parks it `awaiting-approval` again with `approved_sha` cleared and
 * `enqueued_sha` set, so only a fresh approval re-takes it. A conflicting
 * enqueue parks it again in the same run, or for a disposable `reconcile` PR
 * closes the PR and releases the record.
 *
 * An ungated retro or retro-item PR (Stories 2.9, 2.10: `merging` under the
 * coordinator with no `approved_sha`, queued by its own step) follows a
 * Story's path: merged is `merged`, queued at its head is left, and anything
 * else (dequeued first when queued at another head) is released with an
 * attempt (`releaseEjected`), its PR kept, so the next claim adopts an open
 * PR and takes it through CI again; it is never parked awaiting approval.
 *
 * The graph-change gate (Story 2.8) runs on each approved PR but a
 * `reconcile` one, before the take, on its merge with fresh `main`. An
 * unchanged graph keeps the owner's rule. A changed one is bound to the
 * delta the runner posted (retro item 24, AD-11): when the merge result's
 * hash is not the park's `graph_posted`, or none was posted (a builder's or
 * a planning step's park), the delta is posted and the record parked again
 * (`parked → parked`) in the Maintainer's inbox with that hash, stamped with
 * the forge time of the latest snapshot read before its reviews, so only an
 * approval submitted after that takes it; whoever's approval stood, it is
 * not taken. At the posted hash it is taken only on the Maintainer's standing
 * approval of the head (an owner who is not the Maintainer never suffices),
 * holding `xarabot:graph` with `approved_graph` set to that hash; another
 * record holding an overlapping glob refuses the take, and the PR waits. A
 * refused merge result is taken and parked `blocked` `graph-invalid`; a
 * conflicting merge is taken and parked again (`conflict`); a `main` that
 * does not resolve, or a failed read, skips the take. After the fence, a
 * record with `approved_graph` re-reads fresh `main`: when it moved, the gate
 * runs again, and a refusal parks `blocked` `graph-invalid`, a different hash
 * voids the approval (the new delta posted, then parked again for the
 * Maintainer with it as `graph_posted`), and an equal hash enqueues. A record
 * taken again after the runner never enqueued it keeps its `approved_graph`
 * as `graph_posted`: a merge result that hashes otherwise is parked again
 * with the new delta, so a stale approval never queues a delta the
 * Maintainer has not seen.
 *
 * Story 2.9: each `retro:<N>` record `merged` as of the run, with a
 * `retro_result` and no `retro` entry for `<N>` on `main`, has its verdict
 * and items written to `retro-gates.yaml` (`planReconcile`'s `retroGates`),
 * once; a merged retro record with no result is logged and skipped, and a
 * file that cannot be written fails the run.
 *
 * Story 2.10: each `retro-item:<id>` record `merged` as of the run whose
 * item `retro-gates.yaml` lists and not `done` has that item set `done`, in
 * the same rewrite; a merged one whose item is not listed is logged and
 * skipped (`retroItemsMissing`). Once that PR merges, the record is done on
 * `main` and a later run deletes it.
 *
 * With no status or retro-gates change, another `reconcile` PR open that
 * the ledger work did not close or settle, or a branch whose open PRs the
 * ledger work failed to list or close (2.5 F1: one may be an orphan no
 * record carries), the run finishes `merged` with no PR and the older
 * `merged` `reconcile` records are deleted. Otherwise it commits the changed files onto
 * the snapshot's `main`, pushes `<branches.xarabot>reconcile-<n>` as a new
 * branch, opens the PR, polls its checks, re-checks the Standing Authority on
 * fresh `main`, keeps the protected-path gate (the PR is exempt from
 * `owner_approval_paths` only), and enqueues it itself: the step ends
 * `merging` and never watches the queue; it gets no review and no passed
 * gate, and its enqueue fence records `enqueued_sha`. Every push, PR change
 * and enqueue is fenced. It never throws; a lost unit ends `failed` with state `null`.
 *
 * Story 4.2: right after the ledger work, before the PR branches, the inbox
 * step (`syncInboxes`) brings the owners' inbox issues up to date from the
 * run's snapshot (`renderDigest` over it and `main`'s Story specs; a spec
 * whose frontmatter does not parse is logged and skipped): each body is
 * rewritten only when it differs, an owner with no items is cleared to the
 * empty text, and when today's digest slot passed unposted, `digest_posted_at`
 * is stamped (`stampDigest`, fenced on the run's own record and held at the
 * snapshot's coordinator generation) before one mention per non-empty inbox
 * is posted. Its forge errors are logged and skipped: they never fail or
 * stop the run.
 *
 * Story 4.5: right after the ledger work and before the inbox step, the
 * rulings step (`answerRulings`) reads the inbox comments posted after the
 * snapshot's `coordinator.json` `rulings_cursor` (`Forge.readRulings`). When
 * the forge's cursor moved, the batch is judged in order (`judgeRulings`,
 * Story 4.6), each valid `rebuild`'s open PR closed, and one swap writes
 * `fenced(heartbeat(run record), allOf(recordRulings(...), ...applyRuling
 * edits))`, held at the snapshot's coordinator generation and refused once
 * another run moved the cursor: `recordRulings` moves the cursor, adds the
 * batch's pending `retro-gates.yaml` rulings and dismissals, and drops the
 * pending rulings `main` shows (none while the snapshot shows a `reconcile`
 * PR open, Epic 4 retro item 1, or merged with its record not yet `merged`,
 * Epic 4 retro item 7) and the dismissals whose item came back as a
 * new instance. Only after it lands is each ruling answered with one 🤖
 * reply on its own inbox, at most once. With nothing new to read but
 * something to drop, the swap holds only `recordRulings`. With no
 * `coordinator.json` the step is skipped; its read, swap and reply errors are
 * logged and skipped: they never fail or stop the run.
 *
 * Story 4.6: after the rulings step, `retro_gates_path` is planned again
 * with the pending rulings as they now stand, so this run's PR carries the
 * batch's `go`, `block`, `unblock`, `done` and `defer` (each pending ruling
 * is written again on every run until `main` shows it), and the inboxes
 * render from the final view: pending rulings applied, released records out
 * and dismissed items left out. A swap that did not land leaves the
 * snapshot's view.
 */

export type ReconcileStepDeps = {
  readonly forge: Forge;
  readonly committer: ReconcileCommitter;
  /** `main`'s tree and a PR's merge tree, for the graph-change gate. */
  readonly graphTrees: GraphTrees;
  /** Who writes the ledger records: the coordinator lane. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the Standing Authority check and the inbox links (`https://github.com/<repo>`). */
  readonly repo: string;
  /** The lane's agent, which fresh `main`'s policy must still allow before a take (Story 3.5). */
  readonly agent: string;
  /** Whether an approved head is one a review passed (Story 3.5). */
  readonly passed: PassedGate;
  /** Each forge call's (and the commit's) deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The poll, enqueue retry and ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

const MINUTE_MS = 60_000;

/** The `reconcile` PR's branch: `<branches.xarabot>reconcile-<n>` (`unitBranch`). */
export function reconcileBranch(xarabotPrefix: string, unit: string): string {
  return unitBranch(xarabotPrefix, unit);
}

/** One file a `reconcile` PR changes: its path, its new text and one line per change. */
export type ReconcileFileChange = { readonly path: string; readonly text: string; readonly summary: readonly string[] };

/**
 * The commit message, PR title and PR body for the changed files, in order:
 * `sprint_status_path`, then `retro_gates_path` (Story 2.9), each with its
 * changes. The title names what changed: the sprint status, the retro
 * gates, or both.
 */
export function reconcilePrText(
  unit: string,
  files: readonly Pick<ReconcileFileChange, "path" | "summary">[],
  kinds: { readonly status: boolean; readonly retroGates: boolean } = { status: true, retroGates: false },
): { readonly message: string; readonly title: string; readonly body: string } {
  const what = kinds.status && kinds.retroGates ? "sprint status and retro gates" : kinds.retroGates ? "retro gates" : "sprint status";
  const title = capText(`${unit}: ${what} for merged units`, FORGE_TEXT_LIMITS.title);
  const sections = files.map((f) => {
    const lines = f.summary.map((s) => `- ${sanitizeAgentText(s).replace(/\s+/g, " ").trim()}`);
    return { path: sanitizeAgentText(f.path), lines };
  });
  const body = [
    `🤖 ${unit}: runner-written by reconcile, with no agent session.`,
    "",
    ...sections.flatMap((x) => [`Changes to \`${x.path}\`:`, "", ...x.lines, ""]),
    "The Standing Authority exempts reconcile PRs from owner approval: the runner queues this PR once its checks pass, unless a Protected Path gates it.",
    "",
  ].join("\n");
  const messageLines = sections.length === 1 ? (sections[0]?.lines ?? []) : sections.flatMap((x) => [`${x.path}:`, ...x.lines]);
  return { message: `${title}\n\n${messageLines.join("\n")}\n`, title, body: capText(body, FORGE_TEXT_LIMITS.body) };
}

/** Why a gated PR parked again, which picks its 🤖 comment. */
export type ReparkCause = "not-queued" | "conflict" | "head-moved" | "closed";

const REPARK_TEXT: Readonly<Record<ReparkCause, string>> = {
  "not-queued":
    "this PR is not in the merge queue and is parked awaiting approval again.\n\n" +
    "A new approving review of its current head from its owner re-queues it.\n",
  conflict:
    "the merge queue refused this PR, and it is parked awaiting approval again.\n\n" +
    "Once it can merge, a new approving review of its current head from its owner re-queues it. " +
    "A pushed fix moves its head: then queue it by hand or run `xarabot rule rebuild`.\n",
  "head-moved":
    "this PR's head moved after it was approved, and it is parked awaiting approval again.\n\n" +
    "A moved head is never queued automatically: queue it by hand or run `xarabot rule rebuild`.\n",
  closed:
    "this PR is closed and is parked awaiting approval again.\n\n" +
    "Reopen it, then approve its current head again, or run `xarabot rule rebuild`.\n",
};

/**
 * The 🤖 comment on a graph change parked again with a new delta (retro
 * item 24): `graphDeltaComment`, saying that only an approval after it counts.
 */
export function graphRepostComment(unit: string, delta: GraphDelta, maintainer: string, voided: boolean): string {
  const body = graphDeltaComment(`Unit ${unit}`, { delta, maintainer, ...(voided ? { voided: true } : {}) });
  const i = body.indexOf("\n");
  const note = " An approval submitted before this comment does not count.";
  return capText(i === -1 ? `${body}${note}` : `${body.slice(0, i)}${note}${body.slice(i)}`, FORGE_TEXT_LIMITS.comment);
}

/** The 🤖 comment on a gated PR parked again for `cause`. */
export function reparkComment(unit: string, cause: ReparkCause): string {
  return capText(`🤖 Unit ${sanitizeAgentText(unit)}: ${REPARK_TEXT[cause]}`, FORGE_TEXT_LIMITS.comment);
}

export function createReconcileStep(deps: ReconcileStepDeps): CoordinatorStep {
  const { forge, committer, identity } = deps;
  // A coordinator forge's fence (Q5), for the swaps made here and not through the step kit.
  const ledgerFence = ledgerFenceOf(forge);
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;

  return async (input: CoordinatorStepInput): Promise<PrStepOutput> => {
    const unit = input.unit.unit;
    const snapshot = input.snapshot;
    const kit = stepKit({
      name: "reconcile step",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
      seen: snapshot.now,
      mainSha: snapshot.main_sha,
    });
    const { generation, reasons, note, end, forgeNow, call, swap, failed, lost, held, beat } = kit;
    const { aborted, parkBlocked, freshMain, poll, closeOrphan, closeOrphans } = stepOps({
      kit,
      forge,
      identity,
      repo: deps.repo,
      signal: input.signal,
      abortReason: "the unit or the coordinator claim was lost during the reconcile step",
      clock,
      sleep,
    });

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

    /** A fenced PR change on `of`'s PR; `false` when it failed (noted) and the record is left. */
    const prChange = async (of: string, what: string, pr: number, run: (opts: CallOpts) => Promise<ForgeResult<unknown>>): Promise<boolean> => {
      aborted();
      await beat("fence");
      const r = await call(what, run);
      if (r.ok) {
        note(`${of}: ${what} PR #${pr}`);
        return true;
      }
      if (what === "closePr" && r.error.kind === "not-found") return true;
      reasons.push(`${of}: ${what} PR #${pr} ${describeError(r.error)}; left for a later run`);
      note(`${of}: ${what} PR #${pr} failed: ${describeError(r.error)}`);
      return false;
    };

    /**
     * Epic 2 retro item 21: the branch of `of`, a disposable record (a
     * `reconcile` one, or an ungated status planning one) whose open PRs are
     * closed: just released (called right after that swap, which fenced the
     * run's own record), or `released` and about to be deleted
     * (`deleteReleased`, which fences first). Hygiene only: a failure, or an
     * open PR still on the branch (`conflict`), is noted and leaves the
     * branch; `false` then, and `deleteReleased` leaves the record `released`
     * so a later run tries again.
     */
    const dropBranch = async (of: string): Promise<boolean> => {
      const branch = unitBranch(snapshot.config.branches.xarabot, of);
      aborted();
      const r = await call("deleteBranch", (o) => forge.deleteBranch(branch, o));
      if (r.ok) {
        if (r.value.deleted) note(`${of}: deleted branch ${branch}`);
        return true;
      }
      reasons.push(`${of}: deleteBranch ${branch} ${describeError(r.error)}; the branch is left`);
      note(`${of}: deleteBranch ${branch} failed: ${describeError(r.error)}`);
      return false;
    };

    /** Whether `of`'s record, as the round's snapshot shows it, is disposable (`isDisposable`). */
    const disposable = (of: string): boolean => {
      const rec = snapshot.ledger.units.find((r) => r.unit === of);
      return rec === undefined ? unitKind(of) === "reconcile" : isDisposable(rec);
    };

    /**
     * Before a dead or released record is released or deleted: every open PR
     * on its branch closed, each by a fenced PR change, plus the record's own
     * PR when the snapshot shows it open and the listing missed it. A unit
     * whose open PRs were all closed joins `settled`. `false` (a listing failure or a
     * failed close) leaves the record for a later run, and ends this run with
     * no new PR (2.5 F1): a PR left open on the branch would be a second one.
     */
    const closeBranchPrs = async (t: PlanTarget, settled: Set<string>): Promise<boolean> => {
      const branch = unitBranch(snapshot.config.branches.xarabot, t.unit);
      const listed = await call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o));
      if (!listed.ok) {
        reasons.push(`listPrsByBranch ${branch} ${describeError(listed.error)}; ${t.unit} left for a later run`);
        note(`listPrsByBranch ${branch} failed: ${describeError(listed.error)}`);
        return false;
      }
      const open = listed.value.filter((p) => p.state === "open").map((p) => p.number);
      if (t.pr !== null && t.pr_state === "open" && !open.includes(t.pr)) open.push(t.pr);
      for (const pr of open) {
        if (!(await prChange(t.unit, "closePr", pr, (o) => forge.closePr(pr, o)))) return false;
      }
      // Settled only once every close succeeded: one still open keeps stopping a new PR.
      if (open.length > 0) settled.add(t.unit);
      return true;
    };

    const release = (t: PlanTarget): Promise<boolean> =>
      item(`releaseDisposable ${t.unit}`, releaseDisposable({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));

    /**
     * 2. An earlier run's `merging` record: left while queued at its head,
     * else closed and released, and its branch deleted; either ending joins
     * `settled`. This holds for a `reconcile` PR the runner took on an
     * approval and never enqueued (Q4, 2026-10-25): it is closed and
     * replaced, never taken or enqueued again, since a `reconcile` PR needs no
     * owner's approval.
     */
    const checkQueue = async (t: PlanTarget, settled: Set<string>): Promise<void> => {
      const pr = t.pr;
      const released = async (): Promise<void> => {
        if (!(await release(t))) return;
        settled.add(t.unit);
        await dropBranch(t.unit);
      };
      if (pr === null) return await released();
      const q = await call("queueState", (o) => forge.queueState(pr, o));
      if (!q.ok) {
        if (q.error.kind !== "not-found") {
          reasons.push(`${t.unit}: queueState PR #${pr} ${describeError(q.error)}; left for a later run`);
          note(`${t.unit}: queueState PR #${pr} failed: ${describeError(q.error)}`);
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
        if (s.state === "open" && s.queued && !(await prChange(t.unit, "dequeue", pr, (o) => forge.dequeue(pr, o)))) return;
        if (s.state === "open") {
          if (!(await prChange(t.unit, "closePr", pr, (o) => forge.closePr(pr, o)))) return;
          settled.add(t.unit);
        }
      }
      await released();
    };

    /**
     * A gated record back to `parked` `awaiting-approval`, holding its diff's
     * paths, `approved_sha` cleared, `heartbeat_at` stamped and `lane`
     * `coordinator`. With `enqueuedSha`, `enqueued_sha` is set to it, so only
     * a review submitted after the park re-takes the PR. With `graphPosted`,
     * the park keeps the hash of the graph delta posted on the PR.
     */
    const parkAwaiting = (t: GatedTarget, enqueuedSha: string | null, inboxOwner: string | null = null, graphPosted: string | null = null): Promise<boolean> => {
      // Only the Maintainer's approval re-takes a graph change, so it lands in the Maintainer's inbox.
      const graph = graphPosted !== null || t.globs.includes(GRAPH_PSEUDO_GLOB);
      const inbox = inboxOwner ?? (graph ? snapshot.config.maintainer : t.pr_owner);
      return item(
        `park ${t.unit}`,
        park({
          unit: t.unit,
          by: identity,
          now: forgeNow(),
          generation: t.generation,
          kind: "awaiting-approval",
          diffPaths: t.globs.filter((g) => g !== GRAPH_PSEUDO_GLOB),
          ...(inbox !== null ? { inboxOwner: inbox } : {}),
          ...(enqueuedSha !== null ? { enqueuedSha } : {}),
          ...(graphPosted !== null ? { graphPosted } : {}),
        }),
      );
    };

    /**
     * A gated record parked again for a fresh approval (`parkAwaiting`, with
     * `enqueued_sha` set at its approved head when the take left it unset), then
     * a best-effort 🤖 comment on its PR chosen by `cause` (`null`: no comment).
     * The park keeps `posted`, the hash of the graph delta already on the PR
     * (default the approved one). With `graph`, its delta comment is posted
     * first instead, and the park records `graph.hash` only once it is
     * posted (retro item 24): a failed comment leaves none posted.
     */
    const repark = async (
      t: GatedTarget,
      why: string,
      cause: ReparkCause | null,
      graph: { readonly inboxOwner: string; readonly body: string; readonly hash: string } | null = null,
      posted: string | null = t.approved_graph,
    ): Promise<void> => {
      const enqueuedSha = t.enqueued_sha === null ? (t.approved_sha ?? t.head_sha) : null;
      let graphPosted = posted;
      if (graph !== null) {
        aborted();
        await beat("fence");
        const commented = await call("comment", (o) => forge.comment(t.pr, graph.body, o));
        graphPosted = commented.ok ? graph.hash : null;
        if (!commented.ok) {
          reasons.push(`${t.unit}: graph delta comment on PR #${t.pr} failed: ${describeError(commented.error)}`);
          note(`${t.unit}: graph delta comment on PR #${t.pr} failed: ${describeError(commented.error)}`);
        }
      }
      const parked = await parkAwaiting(t, enqueuedSha, graph?.inboxOwner ?? null, graphPosted);
      if (!parked) return;
      reasons.push(`${t.unit}: PR #${t.pr} ${why}: parked awaiting approval again`);
      if (graph !== null || cause === null) return;
      const commented = await call("comment", (o) => forge.comment(t.pr, reparkComment(t.unit, cause), o));
      if (!commented.ok) {
        reasons.push(`${t.unit}: re-park comment on PR #${t.pr} failed: ${describeError(commented.error)}`);
        note(`${t.unit}: re-park comment on PR #${t.pr} failed: ${describeError(commented.error)}`);
      }
    };

    /**
     * A taken record the runner never enqueued, open at its approved head
     * `head` and out of the queue: parked again with `enqueued_sha` unset, so
     * its standing approval still counts, and returned as a candidate for
     * this run's takes, which re-check that approval, fresh `main` and the
     * graph gate before enqueueing it. Its `approved_graph`, the hash of the
     * delta the approval was given after, is kept as the park's
     * `graph_posted`, so a merge result that now hashes otherwise is parked
     * again with the new delta. No comment: the owner has nothing to do.
     */
    const untake = async (t: GatedTarget, head: string): Promise<ApprovalTarget | null> => {
      if (!(await parkAwaiting(t, null, null, t.approved_graph))) return null;
      reasons.push(`${t.unit}: PR #${t.pr} was never enqueued after its take: parked on its standing approval, to be taken again`);
      if (t.pr_owner === null) return null;
      // The take keeps `passed_sha` and the providers: the record as the round's snapshot shows it holds them.
      const held = snapshot.ledger.units.find((r) => r.unit === t.unit);
      return {
        unit: t.unit,
        generation: t.generation,
        pr: t.pr,
        pr_owner: t.pr_owner,
        head_sha: head,
        parked_at: null,
        passed_sha: held?.passed_sha ?? null,
        builder_providers: held?.builder_providers ?? [],
        globs: t.globs.filter((g) => g !== GRAPH_PSEUDO_GLOB),
        graph_posted: t.approved_graph,
      };
    };

    /**
     * 3. A gated record the coordinator took: left while queued at
     * `approved_sha`, `merged` once merged, returned to its standing approval
     * when the runner never enqueued it (`untake`, the candidate returned),
     * else parked again.
     */
    const checkGated = async (t: GatedTarget): Promise<ApprovalTarget | null> => {
      const pr = t.pr;
      const q = await call("queueState", (o) => forge.queueState(pr, o));
      if (!q.ok) {
        if (q.error.kind === "not-found") {
          await repark(t, "is not known to the forge", null);
          return null;
        }
        reasons.push(`${t.unit}: queueState PR #${pr} ${describeError(q.error)}; left for a later run`);
        note(`${t.unit}: queueState PR #${pr} failed: ${describeError(q.error)}`);
        return null;
      }
      const s = q.value;
      if (s.state === "merged") {
        await item(`markMerged ${t.unit}`, markMerged({ unit: t.unit, by: identity, now: forgeNow() }));
        return null;
      }
      const at = t.approved_sha ?? t.head_sha;
      if (s.state === "open" && s.queued && s.head_sha === at) {
        note(`${t.unit}: PR #${pr} still queued at ${s.head_sha}`);
        return null;
      }
      if (s.state === "open" && s.queued) {
        if (await prChange(t.unit, "dequeue", pr, (o) => forge.dequeue(pr, o))) await repark(t, `was queued at ${s.head_sha}, not ${at ?? "its approved head"}`, "head-moved");
        return null;
      }
      if (s.head_sha !== at) await repark(t, `head moved to ${s.head_sha}`, "head-moved");
      else if (s.state === "closed") await repark(t, "is closed", "closed");
      // Taken on an approval but never enqueued: the runner's own failure, so the approval stands.
      else if (t.approved_sha !== null && t.enqueued_sha === null) return await untake(t, s.head_sha);
      else await repark(t, "is not in the merge queue", "not-queued");
      return null;
    };

    /** 3a. An ungated retro or retro-item record: left while queued at its head, `merged` once merged, else released with an attempt. */
    const checkUngated = async (t: PlanTarget): Promise<void> => {
      const pr = t.pr;
      const releaseIt = async (why: string): Promise<void> => {
        const done = await item(`releaseEjected ${t.unit}`, releaseEjected({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));
        if (done) reasons.push(`${t.unit}: PR #${pr ?? "none"} ${why}: released with an attempt, to be taken through CI again`);
      };
      if (pr === null) return await releaseIt("is missing");
      const q = await call("queueState", (o) => forge.queueState(pr, o));
      if (!q.ok) {
        if (q.error.kind === "not-found") return await releaseIt("is not known to the forge");
        reasons.push(`${t.unit}: queueState PR #${pr} ${describeError(q.error)}; left for a later run`);
        note(`${t.unit}: queueState PR #${pr} failed: ${describeError(q.error)}`);
        return;
      }
      const s = q.value;
      if (s.state === "merged") {
        await item(`markMerged ${t.unit}`, markMerged({ unit: t.unit, by: identity, now: forgeNow() }));
        return;
      }
      if (s.state === "open" && s.queued && s.head_sha === t.head_sha) {
        note(`${t.unit}: PR #${pr} still queued at ${s.head_sha}`);
        return;
      }
      if (s.state === "open" && s.queued) {
        if (await prChange(t.unit, "dequeue", pr, (o) => forge.dequeue(pr, o))) await releaseIt(`was queued at ${s.head_sha}, not ${t.head_sha ?? "its head"}`);
        return;
      }
      await releaseIt(s.state === "closed" ? "is closed" : s.head_sha !== t.head_sha ? `head moved to ${s.head_sha}` : "is not in the merge queue");
    };

    /** A taken record parked `blocked` `graph-invalid` (from `merging`), then a best-effort 🤖 comment naming the refusals. */
    const blockGraph = async (t: GatedTarget, refusals: readonly string[]): Promise<void> => {
      const parked = await item(
        `park ${t.unit}`,
        park({
          unit: t.unit,
          by: identity,
          now: forgeNow(),
          generation: t.generation,
          kind: "blocked",
          reason: "graph-invalid",
          ...(t.pr_owner !== null ? { inboxOwner: t.pr_owner } : {}),
        }),
      );
      if (!parked) return;
      reasons.push(`${t.unit}: PR #${t.pr} graph-invalid: ${refusals.join("; ")}`);
      const posted = await call("comment", (o) => forge.comment(t.pr, graphRefusalComment(`Unit ${t.unit}`, refusals), o));
      if (!posted.ok) {
        reasons.push(`${t.unit}: graph refusal comment on PR #${t.pr} failed: ${describeError(posted.error)}`);
        note(`${t.unit}: graph refusal comment on PR #${t.pr} failed: ${describeError(posted.error)}`);
      }
    };

    /** The graph gate on `t`'s merge with `snap`'s `main`. */
    const runGate = (t: ApprovalTarget, snap: ForgeSnapshot): Promise<GraphGateOutcome> =>
      gateGraph(deps.graphTrees, {
        headSha: t.head_sha,
        mainSha: snap.main.sha,
        ledgerFiles: snap.ledger.files,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        listPrsByBranch: (branch) => call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o)),
      });

    /** What happens after the take: enqueue (`null`), park `blocked` `graph-invalid`, or park again (`conflict`). */
    type AfterTake =
      | { readonly kind: "refuse"; readonly refusals: readonly string[] }
      | { readonly kind: "conflict"; readonly paths: readonly string[] }
      | null;

    /**
     * Retro item 24 (AD-11): a parked graph change whose merge result hashes
     * `hash`, not the park's `graph_posted` (or with none posted). The delta
     * is posted first; once it is, the record is parked again (`parked →
     * parked`, `reparkGraph`) in the Maintainer's inbox with `graph_posted`
     * = `hash`, stamped `at`, the forge time read before the reviews were, so
     * only an approval submitted after that re-takes it. A failed comment
     * leaves the record as it was, for a later run. `voided`: the
     * Maintainer's approval stood on another delta.
     */
    const repostGraph = async (t: ApprovalTarget, delta: GraphDelta, hash: string, maintainer: string, at: string, voided: boolean): Promise<void> => {
      aborted();
      await beat("fence");
      const posted = await call("comment", (o) => forge.comment(t.pr, graphRepostComment(t.unit, delta, maintainer, voided), o));
      if (!posted.ok) {
        reasons.push(`${t.unit}: graph delta comment on PR #${t.pr} ${describeError(posted.error)}; not taken, left parked`);
        note(`${t.unit}: graph delta comment on PR #${t.pr} failed: ${describeError(posted.error)}; not taken`);
        return;
      }
      const parked = await item(`reparkGraph ${t.unit}`, reparkGraph({ unit: t.unit, by: identity, now: at, generation: t.generation, graphPosted: hash, inboxOwner: maintainer }));
      if (!parked) return;
      const was = t.graph_posted === null ? "no delta was posted" : `the posted delta is ${t.graph_posted}`;
      reasons.push(`${t.unit}: PR #${t.pr} changes the Epic graph to ${hash}, but ${was}: parked again with the new delta for the Maintainer's (${maintainer}) approval`);
    };

    /**
     * The `approved_graph` re-check after the fence: fresh `main` re-read;
     * when it moved from the `main` the gate ran on, the gate runs again. `true` enqueues;
     * `false` means the record was parked or left `merging` for the next run.
     */
    const recheckGraph = async (t: ApprovalTarget, taken: GatedTarget, approved: { readonly hash: string; readonly mainSha: string }): Promise<boolean> => {
      const f = await freshMain();
      if (!f.ok) {
        reasons.push(`${t.unit}: snapshot ${describeError(f.error)} before the enqueue; PR #${t.pr} not enqueued, left merging for the next run's queue check`);
        note(`${t.unit}: graph re-check snapshot failed: ${describeError(f.error)}`);
        return false;
      }
      const { snap, config } = f.value;
      if (snap.main.sha === approved.mainSha) return true;
      note(`${t.unit}: main moved from ${approved.mainSha} to ${snap.main.sha} after the take: the graph gate runs again`);
      const g = await runGate(t, snap);
      aborted();
      switch (g.kind) {
        case "error":
          reasons.push(`${t.unit}: graph gate ${g.message}; PR #${t.pr} not enqueued, left merging for the next run's queue check`);
          note(`${t.unit}: graph re-check failed: ${g.message}`);
          return false;
        case "conflict":
          await repark(taken, `conflicts with main ${snap.main.sha}: ${g.paths.join(", ")}`, "conflict");
          return false;
        case "refuse":
          await blockGraph(taken, g.refusals);
          return false;
        case "pass":
        case "change": {
          const hash = g.kind === "pass" ? g.hash : g.mergedHash;
          if (hash === approved.hash) return true;
          const maintainer = config.repo.config.maintainer;
          await repark(taken, `merge result's graph is now ${hash}, not the approved ${approved.hash}: the approval is void`, null, {
            inboxOwner: maintainer,
            body: graphDeltaComment(`Unit ${t.unit}`, { delta: g.delta, maintainer, voided: true }),
            hash,
          });
          return false;
        }
      }
    };

    /**
     * Takes one approved PR: `takeApproved` at its head (with `approvedGraph`
     * for a graph change), a fence on the taken record, the `approved_graph`
     * re-check, then the enqueue, each retry fenced again, and once it is
     * queued the enqueue recorded (`enqueued_sha` = head). A conflict parks it
     * again (a `reconcile` PR is closed and released instead); any other
     * failure leaves it `merging` with no `enqueued_sha`, for the next run's
     * queue check to take it again on its standing approval. With `after`,
     * the taken record is parked at once instead.
     */
    const take = async (
      t: ApprovalTarget,
      approver: string,
      settled: Set<string>,
      graph: { readonly hash: string; readonly mainSha: string } | null = null,
      after: AfterTake = null,
    ): Promise<void> => {
      const head = t.head_sha;
      const pr = t.pr;
      const taken = await item(
        `takeApproved ${t.unit}`,
        takeApproved({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation, approvedSha: head, ...(graph !== null ? { approvedGraph: graph.hash } : {}) }),
      );
      if (!taken) return;
      const generation2 = t.generation + 1;
      const takenTarget: GatedTarget = {
        unit: t.unit,
        generation: generation2,
        pr,
        pr_owner: t.pr_owner,
        head_sha: head,
        approved_sha: head,
        approved_graph: graph?.hash ?? null,
        enqueued_sha: null,
        globs: graph !== null ? [...new Set([...t.globs, GRAPH_PSEUDO_GLOB])] : t.globs,
      };
      const fence = (set?: HeartbeatSet): Promise<boolean> =>
        item(`heartbeat ${t.unit}`, heartbeat({ unit: t.unit, by: identity, now: forgeNow(), generation: generation2, ...(set !== undefined ? { set } : {}) }));
      if (!(await fence())) {
        note(`${t.unit}: the fence on the taken record was refused; PR #${pr} not enqueued, left for the queue check`);
        return;
      }
      // Each re-park sets `enqueued_sha`, so it needs an approval submitted after it, as an enqueue conflict's does.
      if (after?.kind === "refuse") return await blockGraph(takenTarget, after.refusals);
      // The delta already posted stays on the PR, so the park keeps its hash.
      if (after?.kind === "conflict") return await repark(takenTarget, `conflicts with main: ${after.paths.join(", ")}`, "conflict", null, t.graph_posted);
      if (graph !== null && !(await recheckGraph(t, takenTarget, graph))) return;
      for (let n = 0; ; n += 1) {
        aborted();
        if (n > 0 && !(await fence())) return;
        const r = await call("enqueue", (o) => forge.enqueue(pr, head, o));
        if (r.ok) {
          reasons.push(`${t.unit}: PR #${pr} approved by ${approver}, enqueued at ${head}`);
          note(`${t.unit}: enqueued PR #${pr} at ${head}`);
          // Recorded, a later ejection parks it for a fresh approval; unrecorded, an ejection is taken again once on the same one.
          if (!(await fence({ enqueued_sha: head }))) note(`${t.unit}: the enqueue of PR #${pr} at ${head} is not recorded on the taken record`);
          return;
        }
        if (r.error.kind === "conflict") {
          note(`${t.unit}: enqueue conflict: ${r.error.message}`);
          if (unitKind(t.unit) === "reconcile") {
            // A disposable reconcile PR: closed, and the record released with no attempt.
            if (!(await prChange(t.unit, "closePr", pr, (o) => forge.closePr(pr, o)))) return;
            settled.add(t.unit);
            const released = await item(`releaseDisposable ${t.unit}`, releaseDisposable({ unit: t.unit, by: identity, now: forgeNow(), generation: generation2 }));
            if (!released) return;
            reasons.push(`${t.unit}: enqueue PR #${pr} ${describeError(r.error)}: closed, released`);
            await dropBranch(t.unit);
            return;
          }
          return await repark(takenTarget, `enqueue ${describeError(r.error)}`, "conflict");
        }
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) {
          reasons.push(`${t.unit}: enqueue PR #${pr} ${describeError(r.error)}; left merging for the next run's queue check`);
          note(`${t.unit}: enqueue PR #${pr} failed: ${describeError(r.error)}`);
          return;
        }
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`${t.unit}: enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
    };

    /**
     * 4. The parked PRs whose owner's approval of their head stands. Before
     * the first take, fresh `main`'s Standing Authority is re-checked (invalid:
     * the step ends `stop`, the record left `parked`); a failed snapshot skips
     * every take this run. A PR the fresh snapshot shows closed, merged or at
     * another head is skipped. Before a take of a unit that is not
     * `reconcile` (Story 3.5): the allowance on fresh `main`'s policy
     * (refused: no such take this run), then the passed gate at the approved
     * head (unreviewed, or an error: not taken, left `parked`). A graph
     * change is taken only at the hash of the delta posted on its PR and on
     * the Maintainer's approval after it (retro item 24): any other hash, or
     * none posted, re-parks it with the new delta (`repostGraph`), stamped
     * with the forge time of the latest snapshot read before its reviews
     * (fresh `main` once read, else the round's).
     */
    const takeApprovedWork = async (targets: readonly ApprovalTarget[], settled: Set<string>): Promise<void> => {
      let fresh: FreshMain | null = null;
      /** Set once the allowance refused a take: no take of a unit that is not `reconcile` this run. */
      let refusedAll = false;
      /** The allowance, then the passed gate at `t`'s approved head; `true` when `t` may be taken. */
      const reviewed = async (t: ApprovalTarget, f: FreshMain): Promise<boolean> => {
        if (refusedAll) return false;
        const refused = allowanceReason(f.config.repo.policy, deps.agent, t.builder_providers);
        if (refused !== null) {
          refusedAll = true;
          reasons.push(`${refused}: no approved PR taken this run`);
          note(`${refused}; no approved PR taken this run`);
          return false;
        }
        const gate = await callPassedGate({ passed: deps.passed, headSha: t.head_sha, passedSha: t.passed_sha, mainSha: f.snap.main.sha, signal: input.signal, callTimeoutMs });
        aborted();
        if (!gate.ok) {
          reasons.push(`${t.unit}: passed gate ${gate.error.kind}: ${gate.error.message}; not taken`);
          note(`${t.unit}: passed gate failed: ${gate.error.kind}: ${gate.error.message}; not taken`);
          return false;
        }
        if (gate.value.kind === "unreviewed") {
          reasons.push(`${t.unit}: PR #${t.pr} is unreviewed at ${t.head_sha} (${gate.value.why}); not taken, left parked`);
          note(`${t.unit}: passed gate: unreviewed: ${gate.value.why}; not taken`);
          return false;
        }
        note(`${t.unit}: passed gate: ${t.head_sha} passed (${gate.value.how})`);
        return true;
      };
      for (const t of targets) {
        aborted();
        // Q3: a graph re-park is stamped no later than the reviews read, so an approval given after the read still counts.
        const readAt = fresh?.snap.now ?? snapshot.now;
        const listed = await call("reviews", (o) => forge.reviews(t.pr, o));
        if (!listed.ok) {
          reasons.push(`${t.unit}: reviews PR #${t.pr} ${describeError(listed.error)}; left for a later run`);
          note(`${t.unit}: reviews PR #${t.pr} failed: ${describeError(listed.error)}`);
          continue;
        }
        const since = t.parked_at !== null ? ` since ${t.parked_at}` : "";
        const query = (owner: string) => standingApproval(listed.value, { owner, head: t.head_sha, parkedAt: t.parked_at });
        const ownerApproval = query(t.pr_owner);
        // The round's Maintainer, to tell whether fresh main is worth reading; the gate uses fresh main's.
        const anyApproval = ownerApproval ?? query(fresh?.config.repo.config.maintainer ?? snapshot.config.maintainer);
        if (anyApproval === null) {
          note(`${t.unit}: no standing approval of ${t.head_sha} on PR #${t.pr}${since}`);
          continue;
        }
        if (fresh === null) {
          const f = await freshMain();
          if (!f.ok) {
            reasons.push(`snapshot ${describeError(f.error)}: no approved PR taken this run`);
            note(`snapshot failed: ${describeError(f.error)}; no approved PR taken this run`);
            return;
          }
          fresh = f.value;
        }
        const snap = fresh.snap;
        const now = snap.prs[t.unit];
        if (now?.state !== "open" || now.head_sha !== t.head_sha) {
          const where = now === undefined ? "unknown" : now.state !== "open" ? now.state : `at ${now.head_sha}`;
          reasons.push(`${t.unit}: PR #${t.pr} is ${where} on fresh main, not open at ${t.head_sha}; not taken`);
          note(`${t.unit}: PR #${t.pr} is ${where} on fresh main; not taken`);
          continue;
        }

        // A reconcile PR holds only runner-written status entries: no graph input, so no graph gate.
        if (unitKind(t.unit) === "reconcile") {
          if (ownerApproval === null) {
            note(`${t.unit}: no standing approval of ${t.head_sha} on PR #${t.pr} from its owner${since}`);
            continue;
          }
          await take(t, ownerApproval.author ?? t.pr_owner, settled);
          continue;
        }

        // Story 3.5: the allowance, then the passed gate, before any take of a unit that is not reconcile.
        if (!(await reviewed(t, fresh))) continue;

        const g = await runGate(t, snap);
        aborted();
        const approver = anyApproval.author ?? t.pr_owner;
        switch (g.kind) {
          case "error":
            reasons.push(`${t.unit}: graph gate ${g.message}; not taken`);
            note(`${t.unit}: graph gate failed: ${g.message}; not taken`);
            continue;
          case "conflict":
            note(`${t.unit}: graph gate: the merge with main ${snap.main.sha} conflicts: ${g.paths.join(", ")}`);
            await take(t, approver, settled, null, { kind: "conflict", paths: g.paths });
            continue;
          case "refuse":
            note(`${t.unit}: graph gate refused: ${g.refusals.join("; ")}`);
            await take(t, approver, settled, null, { kind: "refuse", refusals: g.refusals });
            continue;
          case "pass":
            if (ownerApproval === null) {
              note(`${t.unit}: no standing approval of ${t.head_sha} on PR #${t.pr} from its owner${since}`);
              continue;
            }
            await take(t, ownerApproval.author ?? t.pr_owner, settled);
            continue;
          case "change": {
            const maintainer = fresh.config.repo.config.maintainer;
            const approval = query(maintainer);
            if (t.graph_posted !== g.mergedHash) {
              // Retro item 24: no approval binds a delta the runner has not posted; post this one and wait for a later approval.
              note(`${t.unit}: the graph changes to ${g.mergedHash}; the posted delta is ${t.graph_posted ?? "none"}; parked again with the new delta`);
              await repostGraph(t, g.delta, g.mergedHash, maintainer, readAt, approval !== null && t.graph_posted !== null);
              continue;
            }
            if (approval === null) {
              note(`${t.unit}: the graph changes; no standing approval from the Maintainer ${maintainer}${since}; left parked for the Maintainer`);
              continue;
            }
            await take(t, approval.author ?? maintainer, settled, { hash: g.mergedHash, mainSha: snap.main.sha });
            continue;
          }
        }
      }
    };

    /**
     * The ledger work. Returns the settled units: those whose PR it closed or
     * whose record it released or deleted, whose open PR no longer stops a new
     * one; and the unclosed ones, whose `closeBranchPrs` failed.
     */
    const ledgerWork = async (plan: ReconcilePlan): Promise<{ readonly settled: ReadonlySet<string>; readonly unclosed: readonly string[] }> => {
      const settled = new Set<string>();
      const unclosed: string[] = [];
      for (const u of plan.markMerged) await item(`markMerged ${u}`, markMerged({ unit: u, by: identity, now: forgeNow() }));
      for (const t of plan.checkQueue) await checkQueue(t, settled);
      // A taken record the runner never enqueued joins this run's takes, on its standing approval.
      const untaken: ApprovalTarget[] = [];
      for (const t of plan.checkGated) {
        const back = await checkGated(t);
        if (back !== null) untaken.push(back);
      }
      for (const t of plan.checkUngated) await checkUngated(t);
      await takeApprovedWork([...plan.takeApproved, ...untaken], settled);
      for (const t of plan.releaseDead) {
        if (!(await closeBranchPrs(t, settled))) {
          unclosed.push(t.unit);
          continue;
        }
        const done = await item(`releaseDeadReconcile ${t.unit}`, releaseDeadReconcile({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));
        if (!done) continue;
        settled.add(t.unit);
        await dropBranch(t.unit);
      }
      for (const t of plan.deleteReleased) {
        if (!(await closeBranchPrs(t, settled))) {
          unclosed.push(t.unit);
          continue;
        }
        // The branch before the record (Epic 2 retro item 37): a failed delete leaves the `released` record for a later run to retry.
        if (disposable(t.unit)) {
          await beat("fence");
          if (!(await dropBranch(t.unit))) continue;
        }
        const done = await item(`deleteReleasedRecurring ${t.unit}`, deleteReleasedRecurring({ unit: t.unit, by: identity, now: forgeNow(), generation: t.generation }));
        if (!done) continue;
        settled.add(t.unit);
      }
      for (const u of plan.deleteMerged) await item(`deleteMerged ${u}`, deleteMerged({ unit: u, by: identity, now: forgeNow() }));
      return { settled, unclosed };
    };

    // ------------------------------------------------------------ rulings

    /** The view the inboxes render from, and the pending rulings this run's `retro-gates.yaml` edit carries. */
    type RulingsOutcome = { readonly view: Snapshot; readonly pending: readonly PendingRuling[] };

    /**
     * One `coordinator.json` swap (`edit` fenced on the run's own record
     * unless `bare`), for the rulings and the digest stamp; `true` once it
     * landed, else `<what> refused or failed: …` is noted.
     */
    const coordinatorSwap = async (what: string, edit: LedgerEdit, bare = false): Promise<boolean> => {
      const r = await swapLedger({
        forge,
        edit: ledgerFence(bare ? edit : fenced(heartbeat({ unit, by: identity, now: forgeNow(), generation }), edit)),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        sleep,
        ...(deps.random !== undefined ? { random: deps.random } : {}),
      });
      if (r.ok) return true;
      note(`${what} refused or failed: ${r.error.message}`);
      return false;
    };

    /**
     * Stories 4.5 and 4.6: the inbox comments after `rulings_cursor`, judged
     * as a batch; the rebuild closes; one fenced swap with the cursor and
     * every effect; then one reply per ruling. Never fails the run.
     */
    const rulings = async (): Promise<RulingsOutcome> => {
      aborted();
      const coordinator = snapshot.ledger.coordinator;
      const unchanged: RulingsOutcome = { view: withPending(snapshot), pending: rulingListsOf(coordinator).pending };
      if (coordinator === null) {
        note("rulings step: no coordinator.json in the snapshot; skipped");
        return unchanged;
      }
      /** The final view and pending list once the swap of `judged` with `drops` landed. */
      const landed = (judged: readonly JudgedRuling[], drops: ReturnType<typeof rulingsDrops>): RulingsOutcome => ({
        view: rulingsView(snapshot, judged, drops),
        pending: changeRulingLists(rulingListsOf(coordinator), drops, rulingAdds(judged)).pending,
      });
      let outcome = unchanged;
      const commit = async (from: string | null, to: string, judged: readonly JudgedRuling<InboxComment>[]): Promise<boolean> => {
        const drops = rulingsDrops(rulingsView(snapshot, judged), snapshot);
        const edit = rulingsEdit({ by: identity, now: forgeNow(), coordinatorGeneration: coordinator.generation, cursor: { from, to }, judged, drops });
        const ok = await coordinatorSwap("rulings: recordRulings", edit);
        if (ok) outcome = landed(judged, drops);
        return ok;
      };
      const r = await answerRulings({
        forge,
        cursor: coordinator.rulings_cursor,
        judge: (comments) => judgeRulings(snapshot, comments, "comment").judged,
        commit,
        log: note,
        signal: input.signal,
        callTimeoutMs,
      });
      if (r.tried) return outcome;
      // No batch this run: still drop what main shows, and the dismissals of items come back as new instances.
      const drops = rulingsDrops(unchanged.view, snapshot);
      if (drops.pending.length === 0 && drops.dismissals.length === 0) return outcome;
      aborted();
      const dropped = await coordinatorSwap(
        "rulings: recordRulings (drops only)",
        recordRulings({ by: identity, now: forgeNow(), generation: coordinator.generation, drop: drops }),
        true,
      );
      if (!dropped) return outcome;
      note(`rulings: dropped ${drops.pending.length} pending ruling(s) main shows and ${drops.dismissals.length} expired dismissal(s)`);
      return landed([], drops);
    };

    // ------------------------------------------------------------ inboxes

    /**
     * Story 4.2: the owners' inboxes from `view` (Story 4.6: the rulings
     * step's final view of the run's snapshot), then, when the digest is
     * due, the stamp and the mentions. Never fails the run.
     */
    const inboxes = async (view: Snapshot): Promise<void> => {
      aborted();
      const config = snapshot.config;
      const coordinator = snapshot.ledger.coordinator;
      let digests: ReturnType<typeof renderDigest>;
      try {
        for (const s of openDeferred(config.story_spec_path, Object.keys(input.files), input.files).skipped) note(`deferred entries: ${s.message}; skipped`);
        digests = renderDigest({ snapshot: view, files: input.files, repoUrl: `https://github.com/${deps.repo}` });
      } catch (e) {
        // Pure code, so never expected; still, the inboxes never fail the run.
        note(`inbox step: rendering threw: ${message(e)}; no inbox rewritten this run`);
        return;
      }
      const due = digestDue(snapshot.now, config.digest_time, coordinator?.digest_posted_at ?? null);
      const stamp = async (): Promise<boolean> => {
        if (coordinator === null) {
          note("digest: no coordinator.json in the snapshot; not stamped");
          return false;
        }
        const slot = digestSlot(snapshot.now, config.digest_time);
        return await coordinatorSwap("digest: stampDigest", stampDigest({ by: identity, now: forgeNow(), generation: coordinator.generation, slot }));
      };
      await syncInboxes({ forge, digests, digestDue: due, stamp, log: note, signal: input.signal, callTimeoutMs });
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
      throw end("progress", kit.record.state);
    };

    /** The PR path: commit, push, open, CI, the re-check and the gate, then `merging` and the enqueue. */
    const openAndQueue = async (changes: readonly ReconcileFileChange[], kinds: { readonly status: boolean; readonly retroGates: boolean }): Promise<never> => {
      const prText = reconcilePrText(unit, changes, kinds);
      const branch = reconcileBranch(snapshot.config.branches.xarabot, unit);
      const paths = changes.map((c) => c.path);

      // 1. The bot commit onto the snapshot's main.
      let committed: Awaited<ReturnType<ReconcileCommitter["commit"]>>;
      try {
        committed = await committer.commit({
          unit,
          ontoSha: snapshot.main_sha,
          message: prText.message,
          files: Object.fromEntries(changes.map((c) => [c.path, c.text])),
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
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const { snap, config } = fresh.value;
      const prState = snap.prs[unit];
      if (prState?.state === "merged") {
        await held("markMerged", markMerged({ unit, by: identity, now: forgeNow() }));
        if (kit.record.state !== "merged") kit.record = { ...kit.record, state: "merged", park: null };
        reasons.push(`PR #${pr} merged`);
        throw end("progress", kit.record.state);
      }
      if (prState === undefined) return await failed(`PR #${pr} is not known to the forge`);
      if (prState.state === "closed") return await failed(`PR #${pr} is closed`);
      if (prState.head_sha !== head) return await failed(`PR #${pr} head is ${prState.head_sha}, not ${head}`);

      // The protected-path gate stays, over every file the PR changes; owner_approval_paths does not apply to a reconcile PR.
      const gated = approvalPaths(paths, config.repo.policy.effective_protected_paths);
      if (gated.length > 0) {
        await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: paths }));
        reasons.push(`awaiting approval: ${gated.join(", ")}`);
        note(`parked awaiting-approval: ${gated.join(", ")}`);
        const commented = await call("comment", (o) => forge.comment(pr, gateComment(`Unit ${unit}`, gated), o));
        if (!commented.ok) {
          reasons.push(`approval comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`approval comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", kit.record.state);
      }

      // 6. Fence, merging, enqueue; the queue is not watched. A reconcile PR gets no review and no passed gate.
      await beat("fence", { enqueued_sha: head });
      await held("startMerging", startMerging({ unit, by: identity, now: forgeNow(), generation }));
      note(`merging at ${head}`);
      for (let n = 0; ; n += 1) {
        aborted();
        if (n > 0) await beat("fence");
        const r = await call("enqueue", (o) => forge.enqueue(pr, head, o));
        if (r.ok) {
          reasons.push(`PR #${pr} enqueued at ${head}`);
          note(`enqueued PR #${pr} at ${head}`);
          throw end("progress", kit.record.state);
        }
        if (r.error.kind === "conflict") {
          // A disposable reconcile PR: closed, and the record released with no attempt.
          note(`enqueue conflict: ${r.error.message}`);
          reasons.push(`enqueue PR #${pr} ${describeError(r.error)}: closed, released`);
          await beat("fence");
          const closed = await call("closePr", (o) => forge.closePr(pr, o));
          if (!closed.ok) reasons.push(`closePr PR #${pr} ${describeError(closed.error)}`);
          await held("releaseDisposable", releaseDisposable({ unit, by: identity, now: forgeNow(), generation }));
          if (closed.ok) await dropBranch(unit);
          throw end("progress", kit.record.state);
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
      const gatesPath = snapshot.config.retro_gates_path;
      const gatesText = Object.hasOwn(input.files, gatesPath) ? (input.files[gatesPath] as string) : null;
      const plan = planReconcile(snapshot, unit, statusText, gatesText);
      note(
        `plan: ${plan.markMerged.length} to mark merged, ${plan.checkQueue.length} merging, ${plan.checkGated.length} gated merging, ${plan.checkUngated.length} ungated merging, ` +
          `${plan.takeApproved.length} awaiting approval, ${plan.releaseDead.length} dead, ` +
          `${plan.deleteReleased.length} released, ${plan.deleteMerged.length} done on main; status ${plan.status.kind}; retro gates ${plan.retroGates.kind}`,
      );
      for (const u of plan.retroWithoutResult) {
        reasons.push(`${u} merged with no retro_result: skipped`);
        note(`${u} merged with no retro_result: no verdict to record, skipped`);
      }
      for (const u of plan.retroItemsMissing) {
        reasons.push(`${u} merged but its item is not listed: skipped`);
        note(`${u} merged but ${snapshot.config.retro_gates_path} does not list its item: nothing to set done, skipped`);
      }
      const { settled, unclosed } = await ledgerWork(plan);
      const ruled = await rulings();
      await inboxes(ruled.view);

      // 2.5 F1: a failed close may leave a PR open that no record carries, so this run opens none.
      if (unclosed.length > 0) {
        const branches = unclosed.map((u) => unitBranch(snapshot.config.branches.xarabot, u));
        return await finish(plan, `not every open PR on ${branches.join(", ")} was closed: no new reconcile PR this run`);
      }
      // A PR the ledger work closed, or whose record it released or deleted, no longer stops a new one.
      const open = plan.openPrs.find((o) => !settled.has(o.unit));
      if (open !== undefined) return await finish(plan, `${open.unit}'s PR #${open.pr} is open: no new reconcile PR this run`);
      const status = plan.status;
      // Story 4.6: the gates edit carries the pending rulings as the rulings step left them.
      const gates = planReconcile(snapshot, unit, statusText, gatesText, ruled.pending).retroGates;
      note(`retro gates after the rulings step: ${gates.kind}`);
      if (status.kind === "invalid") return await failed(`${plan.path} cannot be edited: ${status.message}`);
      if (gates.kind === "invalid") return await failed(`${plan.retroGatesPath} cannot be written: ${gates.message}`);
      const changes: ReconcileFileChange[] = [];
      if (status.kind === "edit") {
        for (const s of status.summary) note(`status: ${s}`);
        changes.push({ path: plan.path, text: status.text, summary: status.summary });
      }
      if (gates.kind === "edit") {
        for (const s of gates.summary) note(`retro gates: ${s}`);
        changes.push({ path: plan.retroGatesPath, text: gates.text, summary: gates.summary });
      }
      if (changes.length === 0) {
        return await finish(plan, status.kind === "absent" ? `${plan.path} is absent: no status change written` : "no status change");
      }
      return await openAndQueue(changes, { status: status.kind === "edit", retroGates: gates.kind === "edit" });
    };

    return kit.run(steps);
  };
}
