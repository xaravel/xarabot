import { approvalPaths } from "../core/ci/approval.ts";
import { pollDelayMs } from "../core/ci/checks.ts";
import { coordinatorWriteRules } from "../core/lane/write-check.ts";
import { deleteMerged, finishRecurring, park, parkText, release, releaseDisposable, startMerging, supersedesReleased } from "../core/ledger/edits.ts";
import { planningDue, unitBranch } from "../core/next/coordinator.ts";
import { epicContextPath, epicSourceLine } from "../core/next/snapshot.ts";
import { buildPlanningPrompt, type PlanningPromptUnit, type PromptSection } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { addProvider } from "../core/review/reviewer.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import { planningKindOf, type PlanningKind } from "../core/schemas/ledger.ts";
import type { PlanningResult } from "../core/schemas/session-result.ts";
import type { Snapshot } from "../core/schemas/snapshot.ts";
import type { AgentSettings } from "../ports/agent.ts";
import { isBackoffKind, type ForgeError } from "../ports/forge.ts";
import type { SandboxProfile } from "../ports/sandbox.ts";
import type { Committer } from "./committer.ts";
import type { CoordinatorStep, CoordinatorStepInput, SessionStepDeps } from "./coordinator-process.ts";
import { graphDeltaComment, graphRefusalComment, type GraphDelta } from "../core/graph/graph-gate.ts";
import type { DiffPaths } from "./diff-paths.ts";
import { gateGraph } from "./graph-gate.ts";
import type { GraphTrees } from "./graph-trees.ts";
import { laneLayout } from "./lane-store.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep } from "./ledger-cas.ts";
import { ENQUEUE_TRIES, gateComment } from "./merge-step.ts";
import { shown } from "./pr-step.ts";
import { coordinatorChecks } from "./review-gate.ts";
import {
  createSessionRunner,
  describeError,
  End,
  Halt,
  LIMIT_STOP_REASON,
  MarkerStop,
  message,
  sessionAllowance,
  stepKit,
  stepOps,
  unitSubject,
  type PromptOutcome,
  type PrStepOutput,
  type SessionContext,
  type SessionOutcome,
} from "./session.ts";

/**
 * The planning step (Story 2.7, FR2, NFR5, AR14, AR30): one sandboxed
 * session through the shared runner, then the commit, PR, CI and gate, with
 * no CI-fix session and no loopback.
 *
 * - A status unit (`planning:status.<n>`) runs `bmad-sprint-planning`
 *   headless and compiles the due Epic contexts, each with its source line
 *   below the heading (retro item 12); a graph unit
 *   (`planning:graph.<n>`) writes the missing manifests. What is due comes
 *   from `planningDue` on the round's snapshot; nothing due finishes the
 *   unit with no session.
 * - A `blocked` result (readiness findings, or a first compile's open
 *   design questions, Epic 3 retro item 15) parks `blocked` `readiness` for
 *   the Maintainer (`inbox_owner`), the summary in the journal reason and,
 *   redacted, as the park's text for their inbox; `nothing-due`, or `done` with an empty commit, finishes
 *   the unit (`finishRecurring`) and deletes its record (left `merged` for
 *   `reconcile` while an older `released` record of its kind with a count
 *   is on the ledger, so the run resets the attempts count, C4). A missing or invalid
 *   result, a commit conflict, or a push or PR failure is a failed attempt;
 *   a PR the `record` beat fails to record is closed first, since no record
 *   carries it.
 * - The commit goes onto fresh `main` behind the coordinator write check (a
 *   refusal parks `write-check` and pushes nothing). The push leases from
 *   `Forge.branchHead` when the record has no PR. CI failing parks
 *   `verification`, CI timing out parks `ci-timeout`.
 * - After CI the Standing Authority is re-checked on fresh `main`. A graph
 *   PR always parks `awaiting-approval` holding its diff's paths, with a 🤖
 *   comment, after the graph-change gate (Story 2.8) on its merge with fresh
 *   `main`: a refused merge result parks `blocked` `graph-invalid` and
 *   nothing is enqueued; a changed graph parks for the Maintainer
 *   (`inbox_owner`), the comment carrying the delta, then the gated paths,
 *   posted before the park, which records the delta's hash (`graph_posted`)
 *   only once that comment succeeded (retro item 30); a conflicting merge
 *   or a `main` that does not resolve is a failed attempt.
 *   A status PR skips that gate (its diff holds no graph input) and parks
 *   only when policy gates a path, else it is
 *   fenced, written `merging` and enqueued at its head, and is disposable
 *   like `reconcile`'s (a conflicting enqueue closes it, releases the
 *   record and deletes its branch).
 * - After CI and the PR checks on fresh `main` (Story 3.5): the passed gate
 *   at the head; a head no review passed gets one review round (the normal
 *   pass), and a blocking round parks `blocked` `review-findings` for the
 *   Maintainer, with no loopback. A round that passes starts CI and the
 *   checks again on fresh `main`, where the gate passes the head. Then,
 *   before any gate, fresh `main`'s policy must still allow the lane's agent
 *   and a reviewer (`allowanceReason`, else a failed attempt); the enqueue
 *   fence records `enqueued_sha`. Both steps share these checks
 *   (`coordinatorChecks`).
 * - A unit adopted with its open PR runs no session: an empty
 *   `builder_providers` first gets the lane's vendor in a fence (Epic 2 retro
 *   item 29), then its CI is polled at the record's `head_sha`, and the gate
 *   follows.
 *
 * Every push, PR change and enqueue is fenced; the push's fence adds the
 * lane's vendor to the record's `builder_providers` (AD-16). The session
 * runs outside `kit.run`, so a `Halt` reaches the coordinator process: a
 * STOP during a usage-limit sleep releases the unit and ends the run
 * `stop` through `MarkerStop`. Once `input.signal` aborts (the unit or the
 * coordinator claim lost), the session ends the step `failed` and the
 * process abandons the unit. Anything else never throws.
 */

export type PlanningStepDeps = SessionStepDeps & {
  /** `main`'s tree and the PR's merge tree, for the graph-change gate. */
  readonly graphTrees: GraphTrees;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const PROMPT_SECTION = /^\.xarabot\/prompts\/([^/]+\.md)$/;

/**
 * The planning prompt's unit for `kind` on `snapshot`, or why there is none.
 * `files` are `main`'s files the snapshot was built from: each due context's
 * source line hashes its Epic's section of `epics_path` there (retro item 12).
 * A context with no file on `main` is a first compile (Epic 3 retro item 15).
 */
export function planningPromptUnit(
  unit: string,
  kind: PlanningKind,
  snapshot: Snapshot,
  files: Readonly<Record<string, string>>,
): { readonly ok: true; readonly value: PlanningPromptUnit } | { readonly ok: false; readonly reason: string } {
  const { config } = snapshot;
  const due = planningDue(snapshot);
  if (kind === "status") {
    const epicsText = Object.hasOwn(files, config.epics_path) ? files[config.epics_path] : undefined;
    const contexts: { epic: number; output_path: string; source_line: string; first_compile: boolean }[] = [];
    for (const epic of due.status.contexts) {
      const source = epicsText === undefined ? null : epicSourceLine(epicsText, epic);
      if (source === null) return { ok: false, reason: `Epic ${epic} has no section in ${config.epics_path} on main to hash for its context's source line` };
      contexts.push({
        epic,
        output_path: epicContextPath(config.epic_context_path, epic),
        source_line: source,
        first_compile: (snapshot.epic_context[String(epic)] ?? "missing") === "missing",
      });
    }
    return { ok: true, value: { kind: "status", id: unit, epics_path: config.epics_path, contexts } };
  }
  if (config.manifests === undefined) return { ok: false, reason: "graph planning needs manifests.dir in .xarabot/config.yaml" };
  const m = config.manifests;
  const pathKey = m.path_key === undefined ? null : { key: m.path_key, values: Object.keys(m.path_map ?? {}).sort() };
  return { ok: true, value: { kind: "graph", id: unit, epics_path: config.epics_path, manifests_dir: m.dir, path_key: pathKey, headings: due.graph.headings } };
}

/** The commit message, PR title and PR body for a planning unit's `done` result. */
export function planningPrText(
  unit: string,
  kind: PlanningKind,
  result: Pick<PlanningResult, "summary" | "denied_actions">,
  secrets: readonly string[] = [],
): { readonly message: string; readonly title: string; readonly body: string } {
  const summary = sanitizeAgentText(result.summary, { secrets }).replace(/\s+/g, " ").trim();
  const title = capText(`${unit}: ${summary}`, FORGE_TEXT_LIMITS.title);
  const gate =
    kind === "graph"
      ? "It changes the Epic graph inputs, so it waits for the owner's approval of its head before it is queued; when its merge with `main` changes the Epic graph, only the Maintainer's approval counts."
      : "The runner queues this PR once its checks pass, unless policy gates a path it changes.";
  const denied = result.denied_actions.map((a) => sanitizeAgentText(a, { secrets }).replace(/\s+/g, " ").trim()).filter((a) => a !== "");
  const body = [
    `🤖 ${unit}: written by a ${kind} planning session.`,
    "",
    summary,
    "",
    gate,
    "",
    denied.length === 0 ? "Denied actions: none." : ["Denied actions:", ...denied.map((a) => `- ${a}`)].join("\n"),
    "",
  ].join("\n");
  return { message: `${title}\n`, title, body: capText(body, FORGE_TEXT_LIMITS.body) };
}

export function createPlanningStep(deps: PlanningStepDeps): CoordinatorStep {
  const { forge, identity, committer } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const secrets = deps.secrets ?? [];
  const layout = laneLayout(deps.laneDir);
  const settings: AgentSettings = { effort: deps.lane.effort, ...(deps.lane.model !== undefined ? { model: deps.lane.model } : {}) };

  return async (input: CoordinatorStepInput): Promise<PrStepOutput> => {
    const unit = input.unit.unit;
    const snapshot = input.snapshot;
    const config = snapshot.config;
    const kind: PlanningKind = planningKindOf(input.record) ?? "status";
    const branch = unitBranch(config.branches.xarabot, unit);
    const kit = stepKit({
      name: "planning step",
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
    const { generation, reasons, note, end, forgeNow, call, swap, failed, held, beat } = kit;
    const { aborted, parkBlocked, freshMain, poll, closeOrphans, recordPr } = stepOps({
      kit,
      forge,
      identity,
      repo: deps.lane.repo,
      signal: input.signal,
      abortReason: "the unit or the coordinator claim was lost during the planning step",
      clock,
      sleep,
      secrets,
    });

    /**
     * Nothing to commit: `merged` with no PR, then the record deleted at
     * once, unless an older `released` record of its kind with a count is on
     * the ledger: then it is left `merged` for `reconcile`, which deletes
     * that record first, so this run resets the count instead of the older
     * record's carrying over to the next one (C4).
     */
    const finish = async (why: string): Promise<never> => {
      aborted();
      await held("finishRecurring", finishRecurring({ unit, by: identity, now: forgeNow(), generation }));
      reasons.push(why);
      note(`finished with no PR: ${why}`);
      const older = snapshot.ledger.units.filter((r) => supersedesReleased([r], kit.record));
      if (older.length > 0) {
        note(`left merged for reconcile, after ${older.map((r) => r.unit).join(", ")} released`);
        throw end("progress", kit.record.state);
      }
      const r = await swap(deleteMerged({ unit, by: identity, now: forgeNow() }));
      if (r.kind === "ok") note(`deleteMerged ${unit}`);
      else {
        reasons.push(`deleteMerged ${unit}: ${r.message}`);
        note(`deleteMerged ${unit} failed: ${r.message}`);
      }
      throw end("progress", kit.record.state);
    };

    /**
     * A conflicting enqueue of a disposable status PR: the PR closed, the
     * record released with no attempt, then its branch deleted (Epic 2 retro
     * item 21; the next claim leases from `branchHead`, so a missing branch
     * is a fresh push). A failed close is a failed attempt, so a PR left open
     * is never resumed round after round with none counted. A failed delete
     * is noted and leaves the branch for reconcile's `deleteReleased`.
     */
    const dispose = async (pr: number, e: ForgeError): Promise<never> => {
      note(`enqueue conflict: ${e.message}`);
      await beat("fence");
      const closed = await call("closePr", (o) => forge.closePr(pr, o));
      if (!closed.ok) return await failed(`enqueue PR #${pr} ${describeError(e)}; closePr PR #${pr} ${describeError(closed.error)}`);
      reasons.push(`enqueue PR #${pr} ${describeError(e)}: closed, released`);
      await held("releaseDisposable", releaseDisposable({ unit, by: identity, now: forgeNow(), generation }));
      const deleted = await call("deleteBranch", (o) => forge.deleteBranch(branch, o));
      if (deleted.ok) {
        if (deleted.value.deleted) note(`deleted branch ${branch}`);
      } else {
        reasons.push(`deleteBranch ${branch} ${describeError(deleted.error)}; the branch is left`);
        note(`deleteBranch ${branch} failed: ${describeError(deleted.error)}`);
      }
      throw end("progress", kit.record.state);
    };

    /** CI at `head`, fresh `main`, the gate, then `merging` and the enqueue (status) or the approval park (graph). */
    const ciAndGate = async (pr: number, head: string): Promise<never> => {
      // 1-2. CI, fresh main and the PR on it, the passed gate or a review round, and the allowance.
      const { snap, config: repo } = await coordinatorChecks({
        kit,
        ops: { aborted, parkBlocked, freshMain, poll },
        identity,
        agent: deps.lane.agent,
        passed: deps.passed,
        review: deps.review,
        input: { unit: { unit, subject: unitSubject(unit) }, storyId: null, track: input.track, signal: input.signal, log: input.log },
        pr,
        head,
        ciWaitMs: config.ci_max_wait_minutes * MINUTE_MS,
        expectedChecks: snapshot.policy.expected_checks,
        callTimeoutMs,
      });

      // 3. A graph PR's merge result through the graph-change gate.
      let graph: GraphDelta | null = null;
      if (kind === "graph") {
        const g = await gateGraph(deps.graphTrees, {
          headSha: head,
          mainSha: snap.main.sha,
          ledgerFiles: snap.ledger.files,
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
          listPrsByBranch: (b) => call("listPrsByBranch", (o) => forge.listPrsByBranch(b, o)),
        });
        aborted();
        if (g.kind === "conflict") return await failed(`graph gate: the merge with main ${snap.main.sha} conflicts: ${g.paths.map(shown).join(", ")}`);
        if (g.kind === "error") return await failed(`graph gate: ${g.message}`);
        if (g.kind === "refuse") {
          reasons.push(`graph-invalid: ${g.refusals.join("; ")}`);
          note(`parking blocked graph-invalid: ${g.refusals.join("; ")}`);
          await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "graph-invalid" }));
          const commented = await call("comment", (o) => forge.comment(pr, graphRefusalComment(`Unit ${unit}`, g.refusals), o));
          if (!commented.ok) {
            reasons.push(`graph refusal comment on PR #${pr} failed: ${describeError(commented.error)}`);
            note(`graph refusal comment failed: ${describeError(commented.error)}`);
          }
          throw end("progress", kit.record.state);
        }
        if (g.kind === "change") {
          note(`graph gate: changed from ${g.mainHash} to ${g.mergedHash}`);
          graph = g.delta;
        } else note(`graph gate: unchanged (${g.hash})`);
      }

      // 4. The approval gate: a graph PR always waits for approval; a status PR only when policy gates a path.
      let changed: Awaited<ReturnType<DiffPaths>>;
      try {
        changed = await deps.diffPaths({ headSha: head, mainSha: snap.main.sha, signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]) });
      } catch (e) {
        changed = { ok: false, error: { kind: "transient", message: `diff paths threw: ${message(e)}` } };
      }
      aborted();
      if (!changed.ok) return await failed(`diff paths ${changed.error.kind}: ${changed.error.message}`);
      const policy = repo.repo.policy;
      const gated = kind === "graph" ? [...changed.value] : approvalPaths(changed.value, [...policy.owner_approval_paths, ...policy.effective_protected_paths]);
      if (kind === "graph" || gated.length > 0) {
        const maintainer = repo.repo.config.maintainer;
        if (graph !== null) {
          // The delta comment first, behind a fence; the park records its hash only once it is posted (retro item 30).
          aborted();
          await beat("fence");
          const commented = await call("comment", (o) => forge.comment(pr, graphDeltaComment(`Unit ${unit}`, { delta: graph, maintainer, gatedPaths: gated }), o));
          if (!commented.ok) {
            reasons.push(`graph delta comment on PR #${pr} failed: ${describeError(commented.error)}`);
            note(`graph delta comment failed: ${describeError(commented.error)}`);
          }
          await held(
            "park",
            park({
              unit,
              by: identity,
              now: forgeNow(),
              generation,
              kind: "awaiting-approval",
              diffPaths: changed.value,
              inboxOwner: maintainer,
              ...(commented.ok ? { graphPosted: graph.hash } : {}),
            }),
          );
          reasons.push(`awaiting the Maintainer's approval (the graph changes to ${graph.hash}): ${gated.map(shown).join(", ")}`);
          note(`parked awaiting-approval for the Maintainer ${maintainer}: ${gated.map(shown).join(", ")}`);
          throw end("progress", kit.record.state);
        }
        await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: changed.value }));
        reasons.push(`awaiting approval: ${gated.map(shown).join(", ")}`);
        note(`parked awaiting-approval: ${gated.map(shown).join(", ")}`);
        const commented = await call("comment", (o) => forge.comment(pr, gateComment(`Unit ${unit}`, gated), o));
        if (!commented.ok) {
          reasons.push(`approval comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`approval comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", kit.record.state);
      }

      // 5. Fence, merging, enqueue at the head; the queue is not watched.
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
        if (r.error.kind === "conflict") return await dispose(pr, r.error);
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) return await failed(`enqueue ${describeError(r.error)}`);
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
    };

    /** A `done` result: the commit onto fresh `main` behind the write check, the leased push, the PR, then CI and the gate. */
    const publish = async (result: PlanningResult): Promise<never> => {
      // 1. Fresh main: the write check's rules come from it.
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const { snap, config: repo } = fresh.value;
      const onto = snap.main.sha;
      note(`fresh main ${onto}`);
      const rules = coordinatorWriteRules({ config: repo.repo.config, globs: kit.record.globs, graphUnit: kind === "graph" });
      const text = planningPrText(unit, kind, result, secrets);

      // 2. Commit, behind the coordinator write check.
      let committed: Awaited<ReturnType<Committer["commit"]>>;
      try {
        committed = await committer.commit({
          unit,
          ontoSha: onto,
          message: text.message,
          secrets,
          rules,
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        });
      } catch (e) {
        committed = { ok: false, error: { kind: "transient", message: `commit threw: ${message(e)}` } };
      }
      aborted();
      if (!committed.ok) return await failed(`commit ${committed.error.kind}: ${committed.error.message}`);
      const c = committed.value;
      if (c.kind === "conflict") return await failed(`commit conflict onto ${onto}: ${c.paths.map(shown).join(", ")}`);
      if (c.kind === "refused") {
        for (const r of c.refusals) note(`write-check: refused ${shown(r.path)} (${r.class})`);
        return await parkBlocked("write-check", `write-check: refused ${c.refusals.map((r) => `${shown(r.path)} (${r.class})`).join(", ")}`);
      }
      if (c.kind === "empty") return await finish("done with an empty commit onto main");
      const head = c.head_sha;
      note(`committed ${head} onto ${c.base_sha}`);

      // 3. The lease: the branch's real head (a reused n, or a branch an earlier attempt left).
      const leased = await call("branchHead", (o) => forge.branchHead(branch, o));
      if (!leased.ok) return await failed(`branchHead ${describeError(leased.error)}`);
      const expected = leased.value;
      if (expected !== null) note(`${branch} is at ${expected}: the push leases from it`);

      // 4. Fence, adding the lane's vendor to the builders before the branch moves (AD-16), then push with the lease.
      await beat("fence", { builder_providers: addProvider(kit.record.builder_providers, deps.provider) });
      aborted();
      const pushed = await call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: expected, sha: head }, o));
      if (!pushed.ok) return await failed(`pushBranch ${branch} ${describeError(pushed.error)}`);
      note(`pushed ${head} to ${branch}`);

      // 5. Fence, then open the PR and record it.
      await beat("fence");
      aborted();
      const opened = await call("openPr", (o) => forge.openPr({ branch, base: "main", title: text.title, body: text.body }, o));
      if (!opened.ok) {
        // The forge may have opened it anyway: no record carries it, so close any open PR on the branch.
        await closeOrphans(branch);
        return await failed(`openPr ${describeError(opened.error)}`);
      }
      const pr = opened.value.number;
      note(`opened PR #${pr}`);
      await recordPr(pr, { pr, pr_owner: identity.owner, head_sha: head, base_sha: c.base_sha });
      return await ciAndGate(pr, head);
    };

    /** The session's result. */
    const afterSession = async (result: PlanningResult): Promise<never> => {
      aborted();
      note(`result: ${result.outcome}`);
      switch (result.outcome) {
        case "blocked": {
          // Only the Maintainer changes the planning artifacts, so the findings or open questions wait in their inbox.
          const why = `blocked readiness: ${capText(sanitizeAgentText(result.summary, { secrets }).trim(), FORGE_TEXT_LIMITS.body)}`;
          const maintainer = config.maintainer;
          reasons.push(why);
          note(`parking blocked readiness for the Maintainer ${maintainer}: ${why}`);
          const text = parkText(result.summary, secrets);
          await held(
            "park",
            park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "readiness", inboxOwner: maintainer, ...(text !== undefined ? { text } : {}) }),
          );
          throw end("progress", kit.record.state);
        }
        case "nothing-due":
          return await finish(`nothing-due: ${sanitizeAgentText(result.summary, { secrets }).replace(/\s+/g, " ").trim()}`);
        case "done":
          return await publish(result);
      }
    };

    /**
     * An adopted PR's builders (AD-16, Epic 2 retro item 29): an empty
     * `builder_providers` (an adopted PR with no prior record, or a record a
     * runner older than Story 3.3 wrote) gets the lane's vendor in a fence,
     * so the review round's reviewer is cross-vendor relative to this lane; a
     * non-empty set is left as it is.
     */
    const adoptVendor = async (): Promise<void> => {
      if (kit.record.builder_providers.length > 0) return;
      note(`PR #${kit.record.pr ?? "none"} adopted with no builder_providers: adding ${deps.provider}`);
      await beat("fence", { builder_providers: addProvider(kit.record.builder_providers, deps.provider) });
    };

    /** `kit.run` for a body that may throw a `Halt` (from the review round): it reaches the process. */
    const runKit = async (body: () => Promise<PrStepOutput>): Promise<PrStepOutput> => {
      try {
        return await body();
      } catch (e) {
        if (e instanceof End) return e.out;
        if (e instanceof Halt) throw e;
        return kit.run(() => failed(`unexpected error: ${message(e)}`));
      }
    };

    // ------------------------------------------------------------ the unit

    // A unit adopted with its open PR runs no session: its vendor if the set is empty, CI at the record's head, then the gate.
    const adopted = input.record.pr;
    const adoptedHead = input.record.head_sha;
    if (adopted !== null) {
      note(`resuming PR #${adopted} at ${adoptedHead ?? "no head"}: no session`);
      return runKit(async () => {
        if (adoptedHead === null) return await failed(`PR #${adopted} has no head_sha on the record`);
        await adoptVendor();
        return await ciAndGate(adopted, adoptedHead);
      });
    }

    const due = planningDue(snapshot)[kind];
    if (!due.due) return kit.run(() => finish(`nothing-due: ${due.why}`));
    note(`${kind} planning is due: ${due.why}`);

    const promptUnit = planningPromptUnit(unit, kind, snapshot, input.files);
    if (!promptUnit.ok) {
      const why = promptUnit.reason;
      return kit.run(() => failed(why));
    }

    const budget = AbortSignal.timeout(config.unit_budget_hours * HOUR_MS);
    /** Set when a STOP ended a usage-limit sleep and the unit was released. */
    let limitStopped = false;
    const profile: SandboxProfile = {
      clone: layout.clone,
      vendorHome: layout.vendorHome,
      tempDir: layout.tmp,
      runnerGit: layout.runnerGit,
      resultPath: layout.resultPath,
      repoHosts: config.proxy_hosts,
    };
    const ctx: SessionContext = {
      track: input.track,
      branch,
      profile,
      budget,
      overBudget: () => `unit budget of ${config.unit_budget_hours} h passed`,
      signals: () => [input.signal],
      // The process's own check abandons the unit once the step ends.
      checkHeld: async () => aborted(),
      onLimitStop: async () => {
        const r = await swap(release({ unit, by: identity, now: forgeNow(), generation }));
        if (r.kind !== "ok") reasons.push(`release: ${r.message}`);
        input.track.record = kit.record;
        input.track.state = r.kind === "ok" ? kit.record.state : null;
        limitStopped = true;
      },
      // Before each fresh session: fresh main's policy must still allow the lane's agent and a reviewer (Story 3.5).
      allowed: sessionAllowance({ forge, repo: deps.lane.repo, agent: deps.lane.agent, builderProviders: () => kit.record.builder_providers, callTimeoutMs }),
    };
    const runner = createSessionRunner({
      agent: deps.agent,
      sandbox: deps.sandbox,
      store: deps.store,
      workspace: deps.workspace,
      waiter: deps.waiter,
      layout,
      settings,
      ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
      clock,
      note: (text) => note(text),
      log: (text) => {
        try {
          deps.store.appendLog(input.track.logName, text);
        } catch {
          // A log that cannot be written never ends the step.
        }
      },
      reportStore: (r, what) => {
        if (!r.ok && r.error !== undefined) note(`lane store: ${what}: ${r.error.kind}: ${r.error.message}`);
      },
    });

    const sections: PromptSection[] = [];
    for (const path of Object.keys(input.files).sort()) {
      const m = PROMPT_SECTION.exec(path);
      const text = input.files[path];
      if (m !== null && text !== undefined) sections.push({ name: m[1] as string, text });
    }
    const prompt = (): PromptOutcome => {
      const built = buildPlanningPrompt({ template: PACKAGE_TEMPLATE, unit: promptUnit.value, sections, result_path: layout.resultPath });
      return built.ok ? { ok: true, value: built.value } : { ok: false, reason: `prompt ${built.error.kind}: ${built.error.message}` };
    };

    // The session runs outside `kit.run`: a `Halt` reaches the process.
    let ran: SessionOutcome<"planning">;
    try {
      ran = await runner.session(ctx, { at: snapshot.main_sha, kind: "planning", prompt });
    } catch (e) {
      if (e instanceof End) return e.out;
      if (e instanceof Halt) throw e;
      return kit.run(() => failed(`session threw: ${message(e)}`));
    }
    if (limitStopped) {
      note(`stop: ${LIMIT_STOP_REASON}`);
      throw new MarkerStop("stop", LIMIT_STOP_REASON);
    }
    if (!ran.ok) {
      const why = ran.reason;
      return kit.run(() => failed(why));
    }
    const result = ran.result;
    return runKit(() => afterSession(result));
  };
}
