import { approvalPaths } from "../core/ci/approval.ts";
import { classifyChecks, pollDelayMs } from "../core/ci/checks.ts";
import { loadRepoConfig, type RepoConfig } from "../core/config/load-repo-config.ts";
import { coordinatorWriteRules } from "../core/lane/write-check.ts";
import { deleteMerged, finishRecurring, markMerged, park, release, releaseDisposable, startMerging } from "../core/ledger/edits.ts";
import { planningDue, unitBranch } from "../core/next/coordinator.ts";
import { epicContextPath } from "../core/next/snapshot.ts";
import { buildPlanningPrompt, type PlanningPromptUnit, type PromptSection } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import type { Lane } from "../core/schemas/host.ts";
import { planningKindOf, type LaneIdentity, type ParkReason, type PlanningKind } from "../core/schemas/ledger.ts";
import type { PlanningResult } from "../core/schemas/session-result.ts";
import type { Snapshot } from "../core/schemas/snapshot.ts";
import type { Agent, AgentSettings } from "../ports/agent.ts";
import { isBackoffKind, type Forge, type ForgeError, type ForgeResult, type ForgeSnapshot } from "../ports/forge.ts";
import type { LaneStore } from "../ports/lane-store.ts";
import type { Sandbox, SandboxProfile } from "../ports/sandbox.ts";
import type { Committer } from "./committer.ts";
import type { CoordinatorStep, CoordinatorStepInput } from "./coordinator-process.ts";
import { graphDeltaComment, graphRefusalComment, type GraphDelta } from "../core/graph/graph-gate.ts";
import type { DiffPaths } from "./diff-paths.ts";
import { gateGraph } from "./graph-gate.ts";
import type { GraphTrees } from "./graph-trees.ts";
import { laneLayout } from "./lane-store.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep, type Sleep } from "./ledger-cas.ts";
import { ENQUEUE_TRIES, gateComment } from "./merge-step.ts";
import { shown } from "./pr-step.ts";
import {
  createSessionRunner,
  End,
  Halt,
  LIMIT_STOP_REASON,
  MarkerStop,
  message,
  readsPath,
  stepKit,
  type PromptOutcome,
  type PrStepOutput,
  type SessionContext,
  type SessionLimits,
  type SessionOutcome,
} from "./session.ts";
import type { Waiter } from "./wait.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The planning step (Story 2.7, FR2, NFR5, AR14, AR30): one sandboxed
 * session through the shared runner, then the commit, PR, CI and gate, with
 * no CI-fix session and no loopback.
 *
 * - A status unit (`planning:status.<n>`) runs `bmad-sprint-planning`
 *   headless and compiles the due Epic contexts; a graph unit
 *   (`planning:graph.<n>`) writes the missing manifests. What is due comes
 *   from `planningDue` on the round's snapshot; nothing due finishes the
 *   unit with no session.
 * - A `blocked` result parks `blocked` `readiness`, the findings in the
 *   journal reason; `nothing-due`, or `done` with an empty commit, finishes
 *   the unit (`finishRecurring`) and deletes its record. A missing or invalid
 *   result, a commit conflict, or a push or PR failure is a failed attempt.
 * - The commit goes onto fresh `main` behind the coordinator write check (a
 *   refusal parks `write-check` and pushes nothing). The push leases from
 *   `Forge.branchHead` when the record has no PR. CI failing parks
 *   `verification`, CI timing out parks `ci-timeout`.
 * - After CI the Standing Authority is re-checked on fresh `main`. A graph
 *   PR always parks `awaiting-approval` holding its diff's paths, with a 🤖
 *   comment, after the graph-change gate (Story 2.8) on its merge with fresh
 *   `main`: a refused merge result parks `blocked` `graph-invalid` and
 *   nothing is enqueued; a changed graph parks for the Maintainer
 *   (`inbox_owner`), the comment carrying the delta, then the gated paths; a
 *   conflicting merge or a `main` that does not resolve is a failed attempt.
 *   A status PR skips that gate (its diff holds no graph input) and parks
 *   only when policy gates a path, else it is
 *   fenced, written `merging` and enqueued at its head, and is disposable
 *   like `reconcile`'s (a conflicting enqueue closes it and releases the
 *   record).
 * - A unit adopted with its open PR runs no session: its CI is polled at the
 *   record's `head_sha`, and the gate follows.
 *
 * Every push, PR change and enqueue is fenced. The session runs outside
 * `kit.run`, so a `Halt` reaches the coordinator process: a STOP during a
 * usage-limit sleep releases the unit and ends the run `stop` through
 * `MarkerStop`. Once `input.signal` aborts (the unit or the coordinator
 * claim lost), the session ends the step `failed` and the process abandons
 * the unit. Anything else never throws.
 */

export type PlanningStepDeps = {
  readonly forge: Forge;
  readonly agent: Agent;
  readonly sandbox: Sandbox;
  readonly store: LaneStore;
  readonly workspace: Workspace;
  /** Runs the usage-limit sleeps. */
  readonly waiter: Waiter;
  /** The lane folder (AR37). */
  readonly laneDir: string;
  /** The lane's `host.yaml` settings: repo, agent, model, effort. */
  readonly lane: Lane;
  readonly committer: Committer;
  readonly diffPaths: DiffPaths;
  /** `main`'s tree and the PR's merge tree, for the graph-change gate. */
  readonly graphTrees: GraphTrees;
  /** Who writes the ledger records: the coordinator lane. */
  readonly identity: LaneIdentity;
  /** The lane's credentials, redacted from the commit message, the PR text and the comment; default none. */
  readonly secrets?: readonly string[];
  readonly limits?: SessionLimits;
  /** Each forge call's (and the commit's) deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The poll, enqueue retry and ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const PROMPT_SECTION = /^\.xarabot\/prompts\/([^/]+\.md)$/;

function describeError(e: ForgeError): string {
  return `${e.kind}: ${e.message}`;
}

/** The planning prompt's unit for `kind` on `snapshot`, or why there is none. */
export function planningPromptUnit(unit: string, kind: PlanningKind, snapshot: Snapshot): { readonly ok: true; readonly value: PlanningPromptUnit } | { readonly ok: false; readonly reason: string } {
  const { config } = snapshot;
  const due = planningDue(snapshot);
  if (kind === "status") {
    const contexts = due.status.contexts.map((epic) => ({ epic, output_path: epicContextPath(config.epic_context_path, epic) }));
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

    /** The unit or the coordinator claim was lost: end `failed`, the record left for the process to judge. */
    const aborted = (): void => {
      if (!input.signal.aborted) return;
      reasons.push("the unit or the coordinator claim was lost during the planning step");
      note("aborted");
      throw end("failed", kit.record.state);
    };

    const parkBlocked = async (reason: ParkReason, why: string): Promise<never> => {
      reasons.push(why);
      note(`parking blocked ${reason}: ${why}`);
      await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason }));
      throw end("progress", kit.record.state);
    };

    /** Nothing to commit: `merged` with no PR, then the record deleted at once. */
    const finish = async (why: string): Promise<never> => {
      aborted();
      await held("finishRecurring", finishRecurring({ unit, by: identity, now: forgeNow(), generation }));
      reasons.push(why);
      note(`finished with no PR: ${why}`);
      const r = await swap(deleteMerged({ unit, by: identity, now: forgeNow() }));
      if (r.kind === "ok") note(`deleteMerged ${unit}`);
      else {
        reasons.push(`deleteMerged ${unit}: ${r.message}`);
        note(`deleteMerged ${unit} failed: ${r.message}`);
      }
      throw end("progress", kit.record.state);
    };

    /** Fresh `main`: one snapshot, then the config and Standing Authority loaded from it; an invalid one ends the step `stop`. */
    const freshMain = async (): Promise<ForgeResult<{ readonly snap: ForgeSnapshot; readonly config: RepoConfig }>> => {
      aborted();
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) return snapped;
      const snap: ForgeSnapshot = snapped.value;
      kit.see(snap.now);
      kit.mainSha = snap.main.sha;
      const loaded = loadRepoConfig({ repo: deps.lane.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!loaded.ok) {
        reasons.push(`config ${loaded.error.kind}: ${loaded.error.message}`);
        note(`stop: config ${loaded.error.kind}: ${loaded.error.message}`);
        throw end("stop", kit.record.state);
      }
      return { ok: true, value: { snap, config: loaded.value } };
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

    /**
     * A conflicting enqueue of a disposable status PR: the PR closed, the
     * record released with no attempt. A failed close is a failed attempt, so
     * a PR left open is never resumed round after round with none counted.
     */
    const dispose = async (pr: number, e: ForgeError): Promise<never> => {
      note(`enqueue conflict: ${e.message}`);
      await beat("fence");
      const closed = await call("closePr", (o) => forge.closePr(pr, o));
      if (!closed.ok) return await failed(`enqueue PR #${pr} ${describeError(e)}; closePr PR #${pr} ${describeError(closed.error)}`);
      reasons.push(`enqueue PR #${pr} ${describeError(e)}: closed, released`);
      await held("releaseDisposable", releaseDisposable({ unit, by: identity, now: forgeNow(), generation }));
      throw end("progress", kit.record.state);
    };

    /** CI at `head`, fresh `main`, the gate, then `merging` and the enqueue (status) or the approval park (graph). */
    const ciAndGate = async (pr: number, head: string): Promise<never> => {
      // 1. CI, with no fix session.
      const polled = await poll(head, config.ci_max_wait_minutes * MINUTE_MS, snapshot.policy.expected_checks);
      if (polled !== "passed") return await parkBlocked("verification", `CI failed on ${head}: ${polled.join(", ")}`);
      note(`CI passed on ${head}`);

      // 2. Fresh main: the Standing Authority re-check, and the PR as the forge shows it.
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const { snap, config: repo } = fresh.value;
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
        await held(
          "park",
          park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: changed.value, ...(graph !== null ? { inboxOwner: maintainer } : {}) }),
        );
        reasons.push(`awaiting ${graph !== null ? `the Maintainer's approval (the graph changes to ${graph.hash})` : "approval"}: ${gated.map(shown).join(", ")}`);
        note(`parked awaiting-approval${graph !== null ? ` for the Maintainer ${maintainer}` : ""}: ${gated.map(shown).join(", ")}`);
        const body = graph !== null ? graphDeltaComment(`Unit ${unit}`, { delta: graph, maintainer, gatedPaths: gated }) : gateComment(`Unit ${unit}`, gated);
        const commented = await call("comment", (o) => forge.comment(pr, body, o));
        if (!commented.ok) {
          reasons.push(`approval comment on PR #${pr} failed: ${describeError(commented.error)}`);
          note(`approval comment failed: ${describeError(commented.error)}`);
        }
        throw end("progress", kit.record.state);
      }

      // 5. Fence, merging, enqueue at the head; the queue is not watched.
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
          throw end("progress", kit.record.state);
        }
        if (r.error.kind === "conflict") return await dispose(pr, r.error);
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) return await failed(`enqueue ${describeError(r.error)}`);
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
    };

    /** Best effort after a failed `openPr`: each open PR on the branch closed, behind a fence. */
    const closeOrphans = async (): Promise<void> => {
      const listed = await call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o));
      if (!listed.ok) {
        reasons.push(`listPrsByBranch ${branch} ${describeError(listed.error)}`);
        return;
      }
      for (const p of listed.value.filter((x) => x.state === "open")) {
        await beat("fence");
        const closed = await call("closePr", (o) => forge.closePr(p.number, o));
        reasons.push(closed.ok ? `closed PR #${p.number}, which no record carries` : `closePr PR #${p.number} ${describeError(closed.error)}`);
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

      // 4. Fence, then push with the lease.
      await beat("fence");
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
        await closeOrphans();
        return await failed(`openPr ${describeError(opened.error)}`);
      }
      const pr = opened.value.number;
      note(`opened PR #${pr}`);
      await beat("record", { pr, pr_owner: identity.owner, head_sha: head, base_sha: c.base_sha });
      return await ciAndGate(pr, head);
    };

    /** The session's result. */
    const afterSession = async (result: PlanningResult): Promise<never> => {
      aborted();
      note(`result: ${result.outcome}`);
      switch (result.outcome) {
        case "blocked":
          return await parkBlocked("readiness", `blocked readiness: ${capText(sanitizeAgentText(result.summary, { secrets }).trim(), FORGE_TEXT_LIMITS.body)}`);
        case "nothing-due":
          return await finish(`nothing-due: ${sanitizeAgentText(result.summary, { secrets }).replace(/\s+/g, " ").trim()}`);
        case "done":
          return await publish(result);
      }
    };

    // ------------------------------------------------------------ the unit

    // A unit adopted with its open PR runs no session: CI at the record's head, then the gate.
    const adopted = input.record.pr;
    const adoptedHead = input.record.head_sha;
    if (adopted !== null) {
      note(`resuming PR #${adopted} at ${adoptedHead ?? "no head"}: no session`);
      return kit.run(() => (adoptedHead === null ? failed(`PR #${adopted} has no head_sha on the record`) : ciAndGate(adopted, adoptedHead)));
    }

    const due = planningDue(snapshot)[kind];
    if (!due.due) return kit.run(() => finish(`nothing-due: ${due.why}`));
    note(`${kind} planning is due: ${due.why}`);

    const promptUnit = planningPromptUnit(unit, kind, snapshot);
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
    return kit.run(() => afterSession(result));
  };
}
