import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { checkHumanLiveStep } from "../core/lane/build-check.ts";
import { coordinatorWriteRules } from "../core/lane/write-check.ts";
import { release } from "../core/ledger/edits.ts";
import { unitBranch } from "../core/next/coordinator.ts";
import { buildRetroItemPrompt, type PromptSection, type RetroItemPromptMode } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { err, ok } from "../core/result.ts";
import { addProvider } from "../core/review/reviewer.ts";
import { FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import type { HumanLiveStep } from "../core/schemas/human-live-steps.ts";
import type { UnitRecord } from "../core/schemas/ledger.ts";
import { RETRO_ITEM_ID_PATTERN, type RetroItem } from "../core/schemas/retro-gates.ts";
import type { BuildResult } from "../core/schemas/session-result.ts";
import type { Snapshot } from "../core/schemas/snapshot.ts";
import type { AgentSettings } from "../ports/agent.ts";
import type { SandboxProfile } from "../ports/sandbox.ts";
import { createCiStep, type CiSession, type CiUnit, type PushFix } from "./ci-step.ts";
import type { CommitOutcome } from "./commit.ts";
import type { Committer } from "./committer.ts";
import type { CoordinatorStep, CoordinatorStepInput, SessionStepDeps } from "./coordinator-process.ts";
import type { GraphTrees } from "./graph-trees.ts";
import { laneLayout } from "./lane-store.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep } from "./ledger-cas.ts";
import { createMergeStep } from "./merge-step.ts";
import type { Merger } from "./merger.ts";
import { shown, statusComment } from "./pr-step.ts";
import { createRegenerate } from "./regenerate.ts";
import { createReviewGateStep, type LoopbackSession } from "./review-gate.ts";
import {
  CI_FIX_LOG,
  createSessionRunner,
  describeError,
  End,
  Halt,
  LIMIT_STOP_REASON,
  MarkerStop,
  message,
  REVIEW_FINDINGS,
  sessionAllowance,
  stepKit,
  stepOps,
  unitSubject,
  type PromptOutcome,
  type PrStepOutput,
  type SessionContext,
  type StepUnit,
} from "./session.ts";

/**
 * The retro-item step (Story 2.10, FR10, AR10, AR14): one open retro action
 * item routed to a lane, `retro-item:<id>` on `<branches.xarabot>retro-item-<id>`,
 * worked by one no-skill `build` session at `main` through the shared runner,
 * whose PR then follows a Story's path.
 *
 * - The item is read from the step's snapshot `retro_gates`; a missing item,
 *   or one not `open`, is a failed attempt. The step never writes
 *   `retro-gates.yaml`: the claimed item stays `open`, and `reconcile` sets
 *   it `done` once the PR merges.
 * - The session's prompt (`buildRetroItemPrompt`) names the unit and the
 *   item, with the Human Live Steps and the repo sections. Its `build`
 *   result has no spec cross-check; a `human-live-step` result must name an
 *   offered step. `blocked` parks `blocked` with `blocked.kind`, `no-op`
 *   parks `no-op`.
 * - A `done` result's push, and each CI fix's, mirrors the PR step: fresh
 *   `main` and its config (a bad one ends the step `stop`), the commit onto it
 *   under `coordinatorWriteRules` with the record's globs and every builder
 *   refusal (a refusal parks `write-check`, an empty commit `no-op`; a
 *   conflict with that `main` commits onto the session's start instead, as a
 *   Story's PR step does, so the CI step's merge of `main` takes the conflict
 *   to a conflict session counted in `ci_fixes`, never an attempt), the lease
 *   (`branchHead` for a new PR, else the record's `head_sha`), a fence that
 *   adds the lane's vendor to the record's `builder_providers` (AD-16) and
 *   the push; a build opens the PR (closing orphans on the branch when
 *   `openPr` fails), a fix keeps it; then the `record` beat (a new PR it
 *   fails to record is closed, since no record carries it) and the 🤖 status
 *   comment.
 * - CI is the CI step's (`createCiStep`): fix and conflict sessions in
 *   `ci-fix` mode up to `CI_FIX_CAP`, lockfile regeneration, no spec file.
 * - Then the review gate (Story 3.5, `createReviewGateStep`, no Story id
 *   and no spec): a head no review passed gets a review round; a blocking
 *   one a `loopback` session (`retro_item_loopback`, the findings in
 *   `tmp/review-findings.md`) up to `LOOPBACK_CAP`, its fix pushed as a CI
 *   fix is and taken through CI again.
 * - Before each session, fresh `main`'s policy must still allow the lane's
 *   agent and a reviewer (`sessionAllowance`), else a failed attempt.
 * - The merge step runs with `watch: false`: the graph-change gate, then the
 *   approval gate (parks `awaiting-approval`), else the fence, `merging` and
 *   the enqueue at the head; the step then ends `progress` `merging`, the
 *   coordinator process stops the unit's keeper (AD-6) and `reconcile` checks
 *   the queue (Story 2.6).
 * - A unit adopted with its open PR runs no session: an empty
 *   `builder_providers` first gets the lane's vendor in a fence (Epic 2 retro
 *   item 29), then CI, the review gate and the merge step.
 *
 * Like the retro step, the sessions run outside `kit.run`, so a `Halt`
 * reaches the coordinator process; anything else never throws.
 */

/** A session's mode, with the text its prompt's file holds: the CI log, or the review findings. */
type SessionMode = { readonly mode: "build" } | { readonly mode: "ci-fix"; readonly text: string } | { readonly mode: "loopback"; readonly text: string };

export type RetroItemStepDeps = SessionStepDeps & {
  /** Merges `main` into the PR in the CI step. */
  readonly merger: Merger;
  /** `main`'s tree and the PR's merge tree, for the graph-change gate. */
  readonly graphTrees: GraphTrees;
};

const HOUR_MS = 60 * 60 * 1000;
const PROMPT_SECTION = /^\.xarabot\/prompts\/([^/]+\.md)$/;

/** The item id of a `retro-item:<id>` unit. */
export function retroItemId(unit: string): string {
  return unit.slice(unit.indexOf(":") + 1);
}

/** The item `retro-gates.yaml` lists for `retro-item:<id>` on `snapshot`, with its Epic, or `null`. */
export function findRetroItem(snapshot: Snapshot, unit: string): { readonly epic: number; readonly item: RetroItem } | null {
  const id = retroItemId(unit);
  const epic = RETRO_ITEM_ID_PATTERN.exec(id)?.[1];
  if (epic === undefined) return null;
  const item = snapshot.retro_gates.epics[epic]?.items?.find((i) => i.id === id);
  return item === undefined ? null : { epic: Number(epic), item };
}

/**
 * The commit message, PR title and PR body for a retro item's `done`
 * result: the message and title `<unit>: <summary>`; the body the summary,
 * the result's body and the item's action text. The title and body are
 * sanitized, with `secrets` redacted, and capped at the forge's limits; the
 * committer sanitizes the message.
 */
export function retroItemPrText(
  unit: string,
  item: Pick<RetroItem, "id" | "text">,
  result: Pick<BuildResult, "summary" | "body">,
  secrets: readonly string[] = [],
): { readonly message: string; readonly title: string; readonly body: string } {
  const message = `${unit}: ${result.summary}`;
  const parts = [result.summary];
  if (result.body.trim() !== "") parts.push(result.body);
  parts.push(`Retro action item \`${item.id}\`: ${item.text.replace(/\s+/g, " ").trim()}`);
  return {
    message,
    title: sanitizeAgentText(message, { secrets, max: FORGE_TEXT_LIMITS.title }),
    body: sanitizeAgentText(parts.join("\n\n"), { secrets, max: FORGE_TEXT_LIMITS.body }),
  };
}

export function createRetroItemStep(deps: RetroItemStepDeps): CoordinatorStep {
  const { forge, identity, committer } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const secrets = deps.secrets ?? [];
  const layout = laneLayout(deps.laneDir);
  const settings: AgentSettings = { effort: deps.lane.effort, ...(deps.lane.model !== undefined ? { model: deps.lane.model } : {}) };
  const timing = { now: clock, callTimeoutMs, sleep, ...(deps.random !== undefined ? { random: deps.random } : {}) };
  const ciStep = createCiStep({ forge, merger: deps.merger, identity, repo: deps.lane.repo, secrets, ...timing });
  const mergeStep = createMergeStep({ forge, diffPaths: deps.diffPaths, graphTrees: deps.graphTrees, identity, repo: deps.lane.repo, agent: deps.lane.agent, passed: deps.passed, ...timing });
  const reviewGate = createReviewGateStep({ forge, identity, repo: deps.lane.repo, review: deps.review, passed: deps.passed, secrets, ...timing });

  return async (input: CoordinatorStepInput): Promise<PrStepOutput> => {
    const unit = input.unit.unit;
    const snapshot = input.snapshot;
    const config = snapshot.config;
    const branch = unitBranch(config.branches.xarabot, unit);
    const kitParams = {
      forge,
      identity,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    };
    const kit = stepKit({ ...kitParams, name: "retro-item step", record: input.record, seen: snapshot.now, mainSha: snapshot.main_sha });
    const { generation, reasons, note, end, forgeNow, failed } = kit;
    const budget = AbortSignal.timeout(config.unit_budget_hours * HOUR_MS);
    const overBudget = () => `unit budget of ${config.unit_budget_hours} h passed`;
    /** The unit or the coordinator claim lost, or the unit budget passed. */
    const signal = AbortSignal.any([input.signal, budget]);
    const opsParams = { forge, identity, repo: deps.lane.repo, signal: input.signal, clock, sleep, secrets };
    const { aborted, parkBlocked } = stepOps({ ...opsParams, kit, abortReason: "the unit or the coordinator claim was lost during the retro-item step" });

    // ------------------------------------------------------------ the item

    const found = findRetroItem(snapshot, unit);
    if (found === null) return kit.run(() => failed(`${config.retro_gates_path} lists no item ${retroItemId(unit)}`));
    if (found.item.status !== "open") return kit.run(() => failed(`item ${found.item.id} is ${found.item.status}, not open`));
    const { epic, item } = found;
    const stepUnit: StepUnit = { unit, subject: unitSubject(unit) };
    const ciUnit: CiUnit = { ...stepUnit, branch: (c) => unitBranch(c.branches.xarabot, unit), needsSpec: false };

    // ------------------------------------------------------------ the push

    /**
     * A `done` result's commit onto fresh `main` behind the write check, the
     * leased push, then for a build the PR opened, for a fix the PR kept; the
     * `record` beat and the status comment. Never throws.
     */
    const publish = async (record: UnitRecord, result: BuildResult, kind: "build" | "fix"): Promise<PrStepOutput> => {
      const k = stepKit({ ...kitParams, name: "retro-item PR step", record });
      const ops = stepOps({ ...opsParams, kit: k, abortReason: "the unit or the coordinator claim was lost before the push" });
      const guard = async (): Promise<void> => {
        ops.aborted();
        if (budget.aborted) await k.failed(`${overBudget()} before the push`);
      };

      return k.run(async () => {
        await guard();
        // 1. Fresh main and its config: the write check's rules come from it.
        const fresh = await ops.freshMain();
        if (!fresh.ok) return await k.failed(`snapshot ${describeError(fresh.error)}`);
        const { snap, config: loaded } = fresh.value;
        const onto = snap.main.sha;
        k.note(`fresh main ${onto}`);
        const repoConfig = loaded.repo.config;

        // 2. Commit, behind the coordinator rules of the record's globs and every builder refusal.
        const rules = coordinatorWriteRules({
          config: repoConfig,
          globs: k.record.globs,
          graphUnit: false,
          builderRefusals: { config: repoConfig, policy: loaded.repo.policy },
        });
        const text = retroItemPrText(unit, item, result, secrets);
        const commitOnto = async (ontoSha: string): Promise<CommitOutcome> => {
          let committed: Awaited<ReturnType<Committer["commit"]>>;
          try {
            committed = await committer.commit({ unit, ontoSha, message: text.message, secrets, rules, signal: AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]) });
          } catch (e) {
            committed = { ok: false, error: { kind: "transient", message: `commit threw: ${message(e)}` } };
          }
          await guard();
          if (!committed.ok) return await k.failed(`commit ${committed.error.kind}: ${committed.error.message}`);
          return committed.value;
        };
        let c = await commitOnto(onto);
        if (c.kind === "conflict") {
          // As a Story's PR step does: committed onto the session's start, the PR's head conflicts with main
          // exactly as this commit did, and the CI step's merge of main runs a conflict session.
          const first = c;
          k.note(`commit conflict onto ${onto}: ${first.paths.map(shown).join(", ")}; committing onto the session's start ${first.start} for the CI step's merge of main`);
          c = await commitOnto(first.start);
          if (c.kind === "conflict") {
            return await k.failed(`commit conflict onto ${onto} (${first.paths.map(shown).join(", ")}), and again onto the session's start ${first.start}: ${c.paths.map(shown).join(", ")}`);
          }
        }
        if (c.kind === "refused") {
          for (const r of c.refusals) k.note(`write-check: refused ${shown(r.path)} (${r.class})`);
          return await ops.parkBlocked("write-check", `write-check: refused ${c.refusals.map((r) => `${shown(r.path)} (${r.class})`).join(", ")}`);
        }
        if (c.kind === "empty") return await ops.parkBlocked("no-op", "no-op: the commit onto main is empty");
        const head = c.head_sha;
        k.note(`committed ${head} onto ${c.base_sha}`);

        // 3. The lease: a new PR's branch head (a branch an earlier attempt left), else the record's head.
        let expected = k.record.head_sha;
        if (k.record.pr === null) {
          const leased = await k.call("branchHead", (o) => forge.branchHead(branch, o));
          if (!leased.ok) return await k.failed(`branchHead ${describeError(leased.error)}`);
          expected = leased.value;
          if (expected !== null) k.note(`${branch} is at ${expected}: the push leases from it`);
        }

        // 4. Fence, adding the lane's vendor to the builders before the branch moves (AD-16), then push with the lease.
        await k.beat("fence", { builder_providers: addProvider(k.record.builder_providers, deps.provider) });
        await guard();
        const pushed = await k.call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: expected, sha: head }, o));
        if (!pushed.ok) return await k.failed(`pushBranch ${branch} ${describeError(pushed.error)}`);
        k.note(`pushed ${head} to ${branch}`);

        // 5. A build opens the PR; a fix keeps it, its title and body as they are.
        let pr: number;
        const kept = k.record.pr;
        if (kept !== null) {
          pr = kept;
          k.note(`${kind === "fix" ? "fix pushed to" : "pushed to the open"} PR #${pr}`);
        } else {
          await k.beat("fence");
          await guard();
          const opened = await k.call("openPr", (o) => forge.openPr({ branch, base: "main", title: text.title, body: text.body }, o));
          if (!opened.ok) {
            // The forge may have opened it anyway: no record carries it, so close any open PR on the branch.
            await ops.closeOrphans(branch);
            return await k.failed(`openPr ${describeError(opened.error)}`);
          }
          pr = opened.value.number;
          k.note(`opened PR #${pr}`);
        }

        // 6. Record the PR and SHAs, then the status comment.
        const set = { pr, pr_owner: identity.owner, head_sha: head, base_sha: c.base_sha };
        if (kept !== null) await k.beat("record", set);
        else await ops.recordPr(pr, set);
        const body = statusComment({ subject: stepUnit.subject, headSha: head, lane: identity.lane, deniedActions: result.denied_actions, secrets });
        const commented = await k.call("comment", (o) => forge.comment(pr, body, o));
        if (!commented.ok) {
          k.reasons.push(`status comment on PR #${pr} failed: ${describeError(commented.error)}`);
          k.note(`status comment failed: ${describeError(commented.error)}`);
        }
        throw k.end("progress", k.record.state);
      });
    };

    /**
     * An adopted PR's builders (AD-16, Epic 2 retro item 29): an empty
     * `builder_providers` (an adopted PR with no prior record, or a record a
     * runner older than Story 3.3 wrote) gets the lane's vendor in a fence,
     * so the review gate's reviewer is cross-vendor relative to this lane; a
     * non-empty set is left as it is.
     */
    const adoptVendor = async (): Promise<void> => {
      if (kit.record.builder_providers.length > 0) return;
      note(`PR #${kit.record.pr ?? "none"} adopted with no builder_providers: adding ${deps.provider}`);
      await kit.beat("fence", { builder_providers: addProvider(kit.record.builder_providers, deps.provider) });
    };

    // ------------------------------------------------------------ sessions

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
      overBudget,
      signals: () => [input.signal],
      // The process's own check abandons the unit once the step ends.
      checkHeld: async () => aborted(),
      onLimitStop: async () => {
        const r = await kit.swap(release({ unit, by: identity, now: forgeNow(), generation }));
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

    /** The human-live step ids the last prompt offered: a `human-live-step` result must name one. */
    let promptedStepIds: readonly string[] = [];

    /**
     * The prompt, after `prepare`: in `ci-fix` mode its log written to
     * `tmp/ci-fix-log.md`; in `loopback` mode the review findings written to
     * `tmp/review-findings.md`.
     */
    const prompt = (session: SessionMode): PromptOutcome => {
      promptedStepIds = [];
      let mode: RetroItemPromptMode = { mode: "build" };
      if (session.mode !== "build") {
        const path = join(layout.tmp, session.mode === "ci-fix" ? CI_FIX_LOG : REVIEW_FINDINGS);
        try {
          writeFileSync(path, session.text);
        } catch (e) {
          return { ok: false, reason: `${session.mode === "ci-fix" ? "ci-fix log" : "review findings"}: cannot write ${path}: ${message(e)}` };
        }
        mode = session.mode === "ci-fix" ? { mode: "ci-fix", log_path: path } : { mode: "loopback", findings_path: path };
      }
      const repo = loadRepoConfig({ repo: deps.lane.repo, now: snapshot.now, tree: Object.keys(input.files), files: { ...input.files } });
      if (!repo.ok) return { ok: false, reason: `config: ${repo.error.message}` };
      const steps: readonly HumanLiveStep[] = repo.value.repo.humanLiveSteps.steps;
      const built = buildRetroItemPrompt({
        template: PACKAGE_TEMPLATE,
        // The record's globs, which the commit is checked against: an adopted PR keeps its claim's.
        unit: { kind: "retro-item", id: unit, item: { id: item.id, epic, text: item.text, globs: input.record.globs } },
        mode,
        sections,
        human_live_steps: steps,
        result_path: layout.resultPath,
      });
      if (!built.ok) return { ok: false, reason: `prompt ${built.error.kind}: ${built.error.message}` };
      promptedStepIds = steps.map((s) => s.id);
      return { ok: true, value: built.value };
    };

    type Ran = { readonly ok: true; readonly result: BuildResult } | { readonly ok: false; readonly reason: string };

    /** One `build` session at `at`, in `mode`. A `human-live-step` result must name an offered step. */
    const sessionAt = async (at: string, mode: SessionMode): Promise<Ran> => {
      const ran = await runner.session(ctx, { at, kind: "build", prompt: () => prompt(mode) });
      if (!ran.ok) return ran;
      const result = ran.result;
      note(`result: ${result.outcome}`);
      const step = checkHumanLiveStep(result, promptedStepIds);
      if (!step.ok) return { ok: false, reason: `result ${step.error.kind}: ${step.error.message}` };
      return { ok: true, result };
    };

    /** The CI step's fix and conflict sessions: `ci-fix` mode, no spec file. */
    const ciSession: CiSession = async ({ start, logText }) => {
      let ran: Ran;
      try {
        ran = await sessionAt(start, { mode: "ci-fix", text: logText });
      } catch (e) {
        return err("session", e instanceof End ? (e.out.reason ?? "the session ended early") : `session threw: ${message(e)}`);
      }
      if (!ran.ok) return err("session", ran.reason);
      return ok({ result: ran.result, specPath: null, superseded: [] });
    };
    /** The review gate's loopback sessions: `loopback` mode, no spec file. A `Halt` reaches the gate's caller. */
    const loopbackSession: LoopbackSession = async ({ start, findingsText }) => {
      const ran = await sessionAt(start, { mode: "loopback", text: findingsText });
      if (!ran.ok) return err("session", ran.reason);
      return ok({ result: ran.result, specPath: null, superseded: [] });
    };
    const pushFix: PushFix = (fix) => publish(fix.record, fix.result, "fix");
    const regenerate = createRegenerate({ runner, ctx, agent: deps.agent, settings, layout, note });

    // ------------------------------------------------------------ CI and the merge step

    /** A step's output adopted; a budget passed while the unit is still claimed is a failed attempt. */
    const settle = async (out: PrStepOutput, what: string): Promise<void> => {
      if (out.record !== undefined) kit.record = out.record;
      if (out.reason !== undefined) reasons.push(out.reason);
      note(`${what}: ${out.outcome} (${out.state ?? "unknown"})`);
      if (budget.aborted && !input.signal.aborted && out.outcome !== "stop" && out.state === "claimed") await failed(overBudget());
    };

    /** CI on the PR, the review gate, then the merge step, until none has more to do. */
    const ciAndMerge = async (): Promise<PrStepOutput> => {
      for (;;) {
        const withPr = kit.record;
        if (withPr.pr === null || withPr.head_sha === null) return await failed("the record has no PR or head_sha to take through CI");
        const ci = await ciStep({
          unit: ciUnit,
          record: withPr,
          clone: layout.clone,
          signal,
          log: input.log,
          scratchDir: join(layout.laneDir, "scratch"),
          pushFix,
          session: ciSession,
          regenerate,
        });
        if (limitStopped) {
          note(`stop: ${LIMIT_STOP_REASON}`);
          throw new MarkerStop("stop", LIMIT_STOP_REASON);
        }
        await settle(ci, "CI step");
        if (ci.outcome !== "progress" || ci.state !== "claimed") throw end(ci.outcome, ci.state);
        const gated = await reviewGate({ unit: stepUnit, storyId: null, record: kit.record, track: input.track, signal, log: input.log, needsSpec: false, session: loopbackSession, pushFix });
        if (limitStopped) {
          note(`stop: ${LIMIT_STOP_REASON}`);
          throw new MarkerStop("stop", LIMIT_STOP_REASON);
        }
        await settle(gated, "review gate");
        if (gated.outcome !== "progress" || gated.state !== "claimed") throw end(gated.outcome, gated.state);
        if (gated.pushed === true) {
          note("loopback fix pushed: CI again on the new head");
          continue;
        }
        const merged = await mergeStep({ unit: stepUnit, record: kit.record, signal, log: input.log, watch: false });
        await settle(merged, "merge step");
        // With no queue watch, the merge step never reports an ejection; were it to, CI runs again.
        if (merged.ejected !== true) throw end(merged.outcome, merged.state);
      }
    };

    /** `kit.run` for a body that may throw a `Halt` (a STOP during a CI session's usage-limit sleep): it reaches the process. */
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

    // A unit adopted with its open PR runs no session: its vendor if the set is empty, CI, then the merge step.
    const adopted = input.record.pr;
    if (adopted !== null) {
      note(`resuming PR #${adopted} at ${input.record.head_sha ?? "no head"}: no session`);
      return runKit(async () => {
        if (input.record.head_sha === null) return await failed(`PR #${adopted} has no head_sha on the record`);
        await adoptVendor();
        return await ciAndMerge();
      });
    }

    // The session runs outside `kit.run`: a `Halt` reaches the process.
    let ran: Ran;
    try {
      ran = await sessionAt(snapshot.main_sha, { mode: "build" });
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
    if (result.outcome === "blocked") {
      const b = result.blocked;
      return kit.run(() => parkBlocked(b.kind, `blocked ${b.kind}: ${b.text}`, b.text));
    }
    if (result.outcome === "no-op") return kit.run(() => parkBlocked("no-op", "no-op"));

    return runKit(async () => {
      const out = await publish(kit.record, result, "build");
      if (out.record !== undefined) kit.record = out.record;
      if (out.reason !== undefined) reasons.push(out.reason);
      note(`PR step: ${out.outcome} (${out.state ?? "unknown"})`);
      if (out.outcome !== "progress" || out.state !== "claimed" || kit.record.pr === null) throw end(out.outcome, out.state);
      return await ciAndMerge();
    });
  };
}
