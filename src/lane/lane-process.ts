import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { storySpecGlob } from "../core/config/story-spec-path.ts";
import { checkBuildSpec, checkHumanLiveStep, pickSpec, specMatches, type SpecMatch } from "../core/lane/build-check.ts";
import { staleMergingAction } from "../core/lane/takeover.ts";
import { trailingWaitMs } from "../core/lane/waits.ts";
import {
  claim,
  coordinatorClaimState,
  failAttempt,
  heartbeat,
  markMerged,
  park,
  parkText,
  parkNew,
  release,
  releaseStale,
  takeOverStale,
  type AdoptedPr,
  type LedgerEdit,
} from "../core/ledger/edits.ts";
import { next, type NextStory } from "../core/next/next.ts";
import { assembleSnapshot } from "../core/next/snapshot.ts";
import { buildPrompt, type PromptMode, type PromptSection } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { err, ok } from "../core/result.ts";
import { addProvider, sessionProvider, type Provider } from "../core/review/reviewer.ts";
import type { Config } from "../core/schemas/config.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaneOutcome } from "../core/schemas/journal.ts";
import type { CoordinatorRecord, LaneIdentity, ParkReason, UnitRecord, UnitState } from "../core/schemas/ledger.ts";
import type { BuildResult } from "../core/schemas/session-result.ts";
import type { Agent, AgentSettings } from "../ports/agent.ts";
import type { CallOpts, Forge, ForgePr, ForgeSnapshot, QueueState } from "../ports/forge.ts";
import type { LaneStore } from "../ports/lane-store.ts";
import type { Sandbox, SandboxProfile } from "../ports/sandbox.ts";
import type { CiSession, CiStep, CiUnit, PushFix, Regenerate } from "./ci-step.ts";
import { wipRef } from "./clone.ts";
import { startHeartbeat, type Heartbeat } from "./heartbeat.ts";
import { DEFAULT_CALL_TIMEOUT_MS, type Sleep } from "./ledger-cas.ts";
import { laneLayout, logFileName, type LaneLayout } from "./lane-store.ts";
import type { MergeStep } from "./merge-step.ts";
import { createRegenerate } from "./regenerate.ts";
import type { LoopbackSession, ReviewGateStep } from "./review-gate.ts";
import {
  Abandon,
  addReason,
  checkStop,
  CI_FIX_LOG,
  LIMIT_STOP_REASON,
  createSessionRunner,
  forgeClock,
  forgeOps,
  Halt,
  journalUnit,
  MarkerStop,
  MAX_CLAIM_ROUNDS,
  message,
  newTrack,
  readRegular,
  readsPath,
  REVIEW_FINDINGS,
  sessionAllowance,
  storySubject,
  trackOps,
  type JournalEntry,
  type LaneProcessResult,
  type PromptOutcome,
  type PrStep,
  type PrStepOutput,
  type SessionContext,
  type SessionLimits,
  type StoreWrite,
  type UnitTrack,
} from "./session.ts";
import type { Waiter, WaitResult } from "./wait.ts";
import type { Workspace } from "./workspace.ts";

export { CI_FIX_LOG, readsPath, type LaneProcessResult, type PrStep, type PrStepInput, type PrStepOutput, type SessionLimits } from "./session.ts";

/**
 * The lane process (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR15, AR25): one
 * unit from the STOP check and claim, through a sandboxed session, to a
 * validated result. It leaves a ledger state, at most one journal record, a
 * log and the `outcome` file saying what happened. The PR step after a
 * `done` result is injected (Story 1.16a).
 *
 * Every sandboxed run is bounded by the unit budget, the session limit and
 * the result linger; a usage limit sleeps through the `Waiter` and starts
 * the session again. After the outcome the process waits its trailing wait,
 * then clears `lane.pid` (Story 1.18). A failed attempt the ledger did not
 * take is retried first, within that wait (`retryFail`, C4b).
 *
 * From the claim until the process ends, one heartbeat keeper stamps the
 * record every 5 minutes (Story 2.1). When it loses the unit, or releases it
 * (or fails to) before the heartbeat lapses, it aborts the running session and
 * the lane abandons the unit: no further edit.
 *
 * A stale record `next` offers is taken over (Story 2.2), by the snapshot's
 * `now`. A stale `claimed` record gets the claim's PR inspection: a merged PR
 * marks it `merged`; else `takeOverStale` adopts an open PR (or starts from
 * `main`) at `generation` + 1, parking at the attempts cap, and the session
 * runs. A stale `merging` record goes by its PR's queue state: merged is
 * `merged`, still queued is taken over and only watched by the merge step,
 * anything else is `releaseStale`d. The keeper runs only for a unit this lane
 * then holds `claimed` or `merging`.
 *
 * A claim or takeover that leaves the lane holding a record with an open PR
 * and an empty `builder_providers` (an adopted PR with no prior record, or a
 * record a runner older than Story 3.3 wrote) adds the lane's vendor in a
 * fence before anything else runs, so the review gate's reviewer choice is
 * cross-vendor relative to this lane (AD-16, Epic 2 retro item 29). A
 * non-empty set is never changed.
 *
 * After each snapshot, a missing or expired `coordinator.json` posts a
 * best-effort `coordinator-missing` or `coordinator-expired` alert (Story
 * 2.4); the builder goes on either way.
 *
 * The spec file is picked by status (`pickSpec`, Story 2.5a): a re-run's
 * `done` spec supersedes the Story's `blocked` ones, which the PR step drops
 * from the squash. A run that ends parked `blocked` after a session names
 * its wip ref (`refs/wip/<unit-file-id>`, never pushed) in the unit log and
 * the journal's `wip_ref`; if the session changed any file, the ref is
 * written when the lane next rebuilds its clone.
 *
 * The session machinery (prepare, the sandboxed run, the one resume, the
 * usage-limit sleep, the result-linger kill and the result parse), the forge
 * and ledger helpers and the unit track live in `session.ts` (Story 2.6a),
 * shared with the coordinator process and the steps. This module keeps the
 * claim loop, the takeovers, the builder prompt, the spec pick and the PR,
 * CI, review and merge sequence (Story 3.5: the PR step, then CI, the
 * review gate and the merge step in a loop; a pushed loopback fix and an
 * ejection both go back to CI, and every fresh session first re-checks the
 * allowance on fresh `main`); the lockfile regeneration is `regenerate.ts`'s,
 * shared with the retro-item step (Story 2.10).
 */

const HOUR_MS = 60 * 60 * 1000;

export type LaneDeps = {
  readonly forge: Forge;
  readonly agent: Agent;
  readonly sandbox: Sandbox;
  readonly store: LaneStore;
  readonly workspace: Workspace;
  readonly prStep: PrStep;
  /** Takes the open PR through CI (Story 1.17); without it the run ends after the PR step. */
  readonly ciStep?: CiStep;
  /**
   * The review gate after CI passes (Story 3.5): a head no review passed
   * gets a review round, and a blocking one a loopback session whose pushed
   * fix goes through CI again. Without it the run ends after the CI step and
   * never reaches the merge step.
   */
  readonly reviewGate?: ReviewGateStep;
  /**
   * Takes a PR whose CI passed and whose head a review passed through the
   * approval gate and the merge queue (Story 1.17a); without it the run ends
   * after the review gate. After an ejection the CI step runs again, then
   * the review gate and this step.
   */
  readonly mergeStep?: MergeStep;
  /** The lane folder (AR37). */
  readonly laneDir: string;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The lane's `host.yaml` settings: repo, agent, model, effort. */
  readonly lane: Lane;
  /**
   * The lane's session vendor, added to an adopted PR's empty
   * `builder_providers` (AD-16); default the vendor of the lane's agent and
   * model (`sessionProvider`).
   */
  readonly provider?: Provider;
  /** The lane's known secrets, redacted from a blocked build's park text (Story 4.2); default none. */
  readonly secrets?: readonly string[];
  /** The PID `lane.pid` records; default `process.pid`. */
  readonly pid?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The ledger swap's back-off sleep and jitter source (tests). */
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /**
   * The heartbeat keeper's interval (default 5 min), retry wait (default
   * 60 s) and sleep, kept apart from `sleep` (tests).
   */
  readonly heartbeat?: { readonly everyMs?: number; readonly retryMs?: number; readonly sleep?: Sleep };
  /** Runs the trailing wait and usage-limit sleeps (Story 1.18). */
  readonly waiter: Waiter;
  readonly limits?: SessionLimits;
  /** The command `lane.pid` records; default the basename of `process.execPath`. */
  readonly command?: string;
};

const PROMPT_SECTION = /^\.xarabot\/prompts\/([^/]+\.md)$/;

/** A builder session's mode, with the text its prompt's file holds: the CI log, or the review findings. */
type SessionMode = { readonly mode: "build" } | { readonly mode: "ci-fix"; readonly text: string } | { readonly mode: "loopback"; readonly text: string };

/** The Story being built, for its journal record: the shared track plus the Story and its build result. */
type BuilderTrack = UnitTrack & {
  readonly story: NextStory;
  result: BuildResult | null;
};

/** The newest PR in each state decides: merged, then open, then none. */
function decidePr(prs: readonly ForgePr[]): { readonly kind: "merged" | "open"; readonly pr: ForgePr } | { readonly kind: "none" } {
  const newest = (state: ForgePr["state"]) =>
    prs.filter((p) => p.state === state).reduce<ForgePr | null>((a, p) => (a === null || p.number > a.number ? p : a), null);
  const merged = newest("merged");
  if (merged !== null) return { kind: "merged", pr: merged };
  const open = newest("open");
  if (open !== null) return { kind: "open", pr: open };
  return { kind: "none" };
}

/** Every file in the clone's working tree (repo-relative, `/`-separated), skipping the top-level `.git` and never following symlinks. */
function listWorkingTree(clone: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      if (rel === "" && entry === ".git") continue;
      const path = join(dir, entry);
      const relPath = rel === "" ? entry : `${rel}/${entry}`;
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path, relPath);
      else out.push(relPath);
    }
  };
  walk(clone, "");
  return out.sort();
}

export async function runLaneProcess(deps: LaneDeps): Promise<LaneProcessResult> {
  const { forge, agent, sandbox, store, workspace, identity, lane } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const layout: LaneLayout = laneLayout(deps.laneDir);
  const iso = (ms: number) => new Date(ms).toISOString();
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });
  /** The lane's session vendor; `null` for a `pi` lane, which has none in 0.x. */
  const provider: Provider | null = deps.provider ?? (lane.agent === "pi" ? null : sessionProvider({ adapter: lane.agent, model: lane.model ?? agent.defaultModel }));

  let mainSha: string | null = null;
  /** The last forge time seen and the host time it was seen at. */
  const fc = forgeClock(clock);
  let unit: BuilderTrack | null = null;
  /** The run ended on a STOP marker (the host or lane `STOP`, or a STOP during a usage-limit sleep). */
  let markerStop = false;

  const log = (text: string): void => {
    if (unit !== null) store.appendLog(unit.logName, text);
  };
  const note = (text: string): void => log(`== ${iso(clock())} ${text} ==\n`);

  /** A failed store write goes to the unit log (when there is one) and stderr; the outcome stays. */
  const reportStore = (r: StoreWrite, what: string): void => {
    if (r.ok || r.error === undefined) return;
    const text = `lane store: ${what}: ${r.error.kind}: ${r.error.message}`;
    note(text);
    console.error(text);
  };

  /** Forge calls and ledger swaps under their own deadlines; a lane-stop kind posts its alert and stops the lane. */
  const ops = forgeOps({
    forge,
    callTimeoutMs,
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.random !== undefined ? { random: deps.random } : {}),
    clock: fc,
    alertSha: () => mainSha,
    stop: (condition, why) => {
      throw new Halt("stop", `${condition}: ${why}`);
    },
  });
  const { call, swap, laneStop, freshNow } = ops;

  /**
   * A missing or expired coordinator claim (AD-8): one best-effort alert,
   * deduplicated by the forge per (condition, `main` SHA). Its failure is
   * ignored and the builder goes on.
   */
  const alertCoordinatorGone = async (coordinator: CoordinatorRecord | null, now: string, sha: string): Promise<void> => {
    const state = coordinatorClaimState(coordinator, now);
    if (state === "live") return;
    try {
      await forge.alert(`coordinator-${state}`, sha, deadline());
    } catch {
      // Best effort: a builder never stops for this alert.
    }
  };

  /** The claimed unit's heartbeat keeper, from the claim until the process ends. */
  let keeper: Heartbeat | null = null;
  /** The keeper's signal, to join into a run's or a wait's signal. */
  const keeperSignals = (): AbortSignal[] => (keeper === null ? [] : [keeper.signal]);

  const { checkHeld, held, failUnit, retryFail } = trackOps({ ops, identity, note, keeper: () => keeper });

  /**
   * An adopted PR's builders (AD-16, Epic 2 retro item 29): a held record
   * with a PR and an empty `builder_providers` gets the lane's vendor in a
   * fence; a non-empty set, or a record with no PR, is left as it is. The
   * run's outcome when the fence failed, else `null`.
   */
  const adoptVendor = async (t: UnitTrack): Promise<LaneOutcome | null> => {
    const r = t.record;
    if (r === null || r.pr === null || r.builder_providers.length > 0) return null;
    if (provider === null) return failUnit(t, `PR #${r.pr} adopted with no builder_providers, and a ${lane.agent} lane has no session vendor to add`);
    note(`PR #${r.pr} adopted with no builder_providers: adding ${provider}`);
    const set = { builder_providers: addProvider(r.builder_providers, provider) };
    const fenced = await held(t, (now, generation) => heartbeat({ unit: t.unit, by: identity, now, generation, set }), "fence");
    return fenced ? null : "failed";
  };

  /** Appends one unit journal record, after flushing the unit's log. */
  const journal = (e: JournalEntry): void =>
    journalUnit({ store, clock, identity, agent: lane.agent, model: lane.model ?? agent.defaultModel, effort: lane.effort, logsDir: layout.logs, reportStore }, e);

  /**
   * Before `next`: every parked or merging record whose PR the forge reports
   * merged (the Maintainer queued it by hand, the coordinator queued it on its
   * owner's approval, or the queue merged it after its lane ended) is marked
   * `merged`, with one journal record each.
   * Returns the records it wrote, for `next` to see in place of the snapshot's.
   */
  const sweepMerged = async (units: readonly UnitRecord[], prs: ForgeSnapshot["prs"], now: string): Promise<UnitRecord[]> => {
    const written: UnitRecord[] = [];
    for (const r of units) {
      if (r.state !== "parked" && r.state !== "merging") continue;
      const pr = prs[r.unit];
      if (pr?.state !== "merged") continue;
      const startedMs = clock();
      const logName = logFileName(r.unit, startedMs);
      const reason = `PR #${pr.number} merged`;
      store.appendLog(logName, `== ${iso(startedMs)} sweep: ${r.unit} was ${r.state}; ${reason} ==\n`);
      const swapped = await swap(markMerged({ unit: r.unit, by: identity, now }), r.unit);
      if (swapped.kind === "lost") {
        store.appendLog(logName, `== ${iso(clock())} sweep: markMerged lost: ${swapped.message} ==\n`);
        continue;
      }
      if (swapped.kind === "failed") throw new Halt("failed", `sweep markMerged ${r.unit}: ${swapped.message}`);
      // No commit: another lane already marked it merged.
      if (swapped.record === null) continue;
      store.appendLog(logName, `== ${iso(clock())} sweep: marked merged ==\n`);
      journal({ unit: r.unit, logName, startedMs, record: swapped.record, state: "merged", outcome: "progress", reason });
      written.push(swapped.record);
    }
    return written;
  };

  const settings: AgentSettings = { effort: lane.effort, ...(lane.model !== undefined ? { model: lane.model } : {}) };
  const runner = createSessionRunner({
    agent,
    sandbox,
    store,
    workspace,
    waiter: deps.waiter,
    layout,
    settings,
    ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
    clock,
    note,
    log,
    reportStore,
  });

  /**
   * The session and result handling for a claimed unit, under the unit
   * budget, from a session at `start`; with `start` `null` (a stale `merging`
   * takeover) no session runs and the merge step watches the queue. After an
   * ejection the CI step and the merge step run as usual.
   */
  const work = async (t: BuilderTrack, snap: ForgeSnapshot, config: Config, start: string | null): Promise<LaneOutcome> => {
    const story = t.story;
    const budget = AbortSignal.timeout(config.unit_budget_hours * HOUR_MS);
    const overBudget = () => `unit budget of ${config.unit_budget_hours} h passed`;
    /** Set when a STOP ended a usage-limit sleep and the unit was released. */
    let limitStop: { readonly record: UnitRecord | null; readonly state: UnitState | null } | null = null;
    const branch = `${config.branches.story}${story.story_id}`;

    const profile: SandboxProfile = {
      clone: layout.clone,
      vendorHome: layout.vendorHome,
      tempDir: layout.tmp,
      runnerGit: layout.runnerGit,
      resultPath: layout.resultPath,
      repoHosts: config.proxy_hosts,
    };

    const ctx: SessionContext = {
      track: t,
      branch,
      profile,
      budget,
      overBudget,
      signals: keeperSignals,
      checkHeld: () => checkHeld(t),
      // A STOP during a usage-limit sleep releases the unit; the run then ends `stop` (`stopAfterLimit`).
      onLimitStop: async () => {
        await held(t, (now, gen) => release({ unit: story.unit, by: identity, now, generation: gen }), "release");
        limitStop = { record: t.record, state: t.state };
      },
      // Before each fresh session: fresh main's policy must still allow the lane's agent and a reviewer (Story 3.5).
      allowed: sessionAllowance({ forge, repo: lane.repo, agent: lane.agent, builderProviders: () => t.record?.builder_providers ?? [], callTimeoutMs }),
    };

    /** The human-live step ids the last builder prompt offered: a `human-live-step` result must name one. */
    let promptedStepIds: readonly string[] = [];

    /**
     * The builder prompt, after `prepare`: in `ci-fix` mode its log written
     * to `tmp/ci-fix-log.md`; in `loopback` mode the review findings written
     * to `tmp/review-findings.md`.
     */
    const builderPrompt = (session: SessionMode): PromptOutcome => {
      promptedStepIds = [];
      let mode: PromptMode = { mode: "build" };
      if (session.mode !== "build") {
        const path = join(layout.tmp, session.mode === "ci-fix" ? CI_FIX_LOG : REVIEW_FINDINGS);
        try {
          writeFileSync(path, session.text);
        } catch (e) {
          return { ok: false, reason: `${session.mode === "ci-fix" ? "ci-fix log" : "review findings"}: cannot write ${path}: ${message(e)}` };
        }
        mode = session.mode === "ci-fix" ? { mode: "ci-fix", log_path: path } : { mode: "loopback", findings_path: path };
      }
      const repo = loadRepoConfig({ repo: lane.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!repo.ok) return { ok: false, reason: `config: ${repo.error.message}` };
      const steps = repo.value.repo.humanLiveSteps.steps;
      const sections: PromptSection[] = [];
      for (const path of snap.main.tree) {
        const m = PROMPT_SECTION.exec(path);
        const text = snap.main.files[path];
        if (m !== null && text !== undefined) sections.push({ name: m[1] as string, text });
      }
      const prompt = buildPrompt({
        template: PACKAGE_TEMPLATE,
        unit: { kind: "story", id: story.story_id, sprint_key: story.sprint_key },
        mode,
        sections,
        human_live_steps: steps,
        result_path: layout.resultPath,
      });
      if (!prompt.ok) return { ok: false, reason: `prompt ${prompt.error.kind}: ${prompt.error.message}` };
      promptedStepIds = steps.map((s) => s.id);
      return { ok: true, value: prompt.value };
    };

    /** A session's result and its spec pick: `specPath` and `specText` are `null` when no spec is cross-checked. */
    type Ran =
      | {
          readonly ok: true;
          readonly result: BuildResult;
          readonly specPath: string | null;
          readonly specText: string | null;
          readonly superseded: readonly string[];
        }
      | { readonly ok: false; readonly reason: string };

    /**
     * One builder session at `at` through the shared runner, then the spec
     * pick by status (`pickSpec`). In `ci-fix` mode (its log in
     * `tmp/ci-fix-log.md`) and `loopback` mode (the findings in
     * `tmp/review-findings.md`) only a `done` result picks a spec.
     */
    const sessionAt = async (at: string, session: SessionMode): Promise<Ran> => {
      const fail = (reason: string): Ran => ({ ok: false, reason });
      const ran = await runner.session(ctx, { at, kind: "build", prompt: () => builderPrompt(session) });
      if (!ran.ok) return fail(ran.reason);
      const result = ran.result;
      if (session.mode === "build") t.result = result;
      note(`result: ${result.outcome}`);
      // A `human-live-step` must name a step the prompt offered (Story 2.6b).
      const step = checkHumanLiveStep(result, promptedStepIds);
      if (!step.ok) return fail(`result ${step.error.kind}: ${step.error.message}`);

      // A CI or loopback session's `blocked` or `no-op` result parks as it is: only a `done` fix needs a spec file.
      if (session.mode !== "build" && result.outcome !== "done") return { ok: true, result, specPath: null, specText: null, superseded: [] };
      const glob = storySpecGlob(config.story_spec_path, story.story_id);
      if (!glob.ok) return fail(`spec: ${glob.error.message}`);
      let paths: string[];
      try {
        paths = specMatches(glob.value, listWorkingTree(layout.clone));
      } catch (e) {
        return fail(`spec: cannot list the clone: ${message(e)}`);
      }
      const matches: SpecMatch[] = paths.map((path) => {
        try {
          return { path, text: readRegular(join(layout.clone, path)) };
        } catch {
          return { path, text: null };
        }
      });
      const picked = pickSpec(result.outcome, matches);
      if (!picked.ok) return fail(`${picked.error.message} (glob ${glob.value})`);
      const { spec, superseded } = picked.value;
      if (spec === null) note(`spec: ${paths.length} files match ${glob.value}: no cross-check for a blocked result`);
      if (superseded.length > 0) note(`spec: ${spec?.path ?? "none"} supersedes ${superseded.join(", ")}`);
      return { ok: true, result, specPath: spec?.path ?? null, specText: spec?.text ?? null, superseded };
    };

    /** The run ends `stop` with the record the usage-limit STOP released. */
    const stopAfterLimit = (stopped: { readonly record: UnitRecord | null; readonly state: UnitState | null }): LaneOutcome => {
      markerStop = true;
      t.record = stopped.record;
      t.state = stopped.state;
      addReason(t, LIMIT_STOP_REASON);
      note(`stop: ${LIMIT_STOP_REASON}`);
      return "stop";
    };

    /** The CI step's fix and conflict sessions: no spec status cross-check; a `done` fix picks its spec file. */
    const ciSession: CiSession = async ({ start: at, logText }) => {
      const ran = await sessionAt(at, { mode: "ci-fix", text: logText });
      if (!ran.ok) return err("session", ran.reason);
      return ok({ result: ran.result, specPath: ran.specPath, superseded: ran.superseded });
    };

    /** The review gate's loopback session: no spec status cross-check; a `done` fix picks its spec file. */
    const loopbackSession: LoopbackSession = async ({ start: at, findingsText }) => {
      const ran = await sessionAt(at, { mode: "loopback", text: findingsText });
      if (!ran.ok) return err("session", ran.reason);
      return ok({ result: ran.result, specPath: ran.specPath, superseded: ran.superseded });
    };

    /** The lockfile command (`regenerate.ts`), at the merge candidate, under the unit's budget and keeper. */
    const regenerate: Regenerate = createRegenerate({ runner, ctx, agent, settings, layout, note });

    /** Records a step's output; the budget rule's `failed` when it released the unit, else `null`. */
    const settle = async (out: PrStepOutput, what: string): Promise<LaneOutcome | null> => {
      t.state = out.state;
      if (out.record !== undefined) t.record = out.record;
      if (out.reason !== undefined) addReason(t, out.reason);
      note(`${what}: ${out.outcome} (${out.state ?? "unknown"})`);
      await checkHeld(t);
      if (budget.aborted && out.outcome !== "stop" && out.state === "claimed") {
        // The budget passed during the step: release the unit, unless the step already moved it on.
        const before = t.reason;
        const released = await held(t, (now, gen) => failAttempt({ unit: story.unit, by: identity, now, generation: gen }), "failAttempt");
        if (released) {
          t.reason = overBudget();
          return "failed";
        }
        t.reason = before;
        t.state = out.state;
      }
      return null;
    };

    /** The build session at `start` and the PR step: the run's outcome, or the PR step's output for CI. */
    const build = async (at: string): Promise<{ readonly end: LaneOutcome } | { readonly next: PrStepOutput }> => {
      const ran = await sessionAt(at, { mode: "build" });
      if (!ran.ok) {
        const stopped = limitStop as { readonly record: UnitRecord | null; readonly state: UnitState | null } | null;
        if (stopped !== null) return { end: stopAfterLimit(stopped) };
        return { end: await failUnit(t, ran.reason) };
      }
      const { result, specPath, superseded } = ran;
      // A `blocked` result with 0 or 2+ matches has no spec to cross-check, and parks all the same.
      if (specPath !== null && ran.specText !== null) {
        const checked = checkBuildSpec(result.outcome, ran.specText);
        if (!checked.ok) return { end: await failUnit(t, `${specPath}: ${checked.error.message}`) };
      }

      if (result.outcome !== "done") {
        const reason: ParkReason = result.outcome === "blocked" ? result.blocked.kind : "no-op";
        t.reason = result.outcome === "blocked" ? `blocked ${result.blocked.kind}: ${result.blocked.text}` : "no-op";
        // The session's own words land in the owner's inbox (Story 4.2).
        const text = result.outcome === "blocked" ? parkText(result.blocked.text, deps.secrets ?? []) : undefined;
        const parked = await held(
          t,
          (now, gen) => park({ unit: story.unit, by: identity, now, generation: gen, kind: "blocked", reason, ...(text !== undefined ? { text } : {}) }),
          "park",
        );
        return { end: parked ? "progress" : "failed" };
      }

      if (specPath === null) return { end: await failUnit(t, "spec: a done result with no spec file") };
      const record = t.record;
      if (record === null) return { end: await failUnit(t, "no claimed record to hand to the PR step") };
      await checkHeld(t);
      let out: PrStepOutput;
      try {
        out = await deps.prStep({ unit: story, record, result, specPath, superseded, clone: layout.clone, signal: budget, log: note, kind: "build" });
      } catch (e) {
        return { end: await failUnit(t, `PR step threw: ${message(e)}`) };
      }
      const prEnd = await settle(out, "PR step");
      if (prEnd !== null) return { end: prEnd };
      return { next: out };
    };

    const ciStep = deps.ciStep;
    const reviewGate = deps.reviewGate;
    const mergeStep = deps.mergeStep;
    /** The Story as the CI and merge steps name it. */
    const stepUnit = { unit: story.unit, subject: storySubject(story.story_id) };
    const ciUnit: CiUnit = { ...stepUnit, branch: (c) => `${c.branches.story}${story.story_id}`, needsSpec: true };
    /** A CI or loopback fix goes through the Story's PR step, its title and body kept. */
    const pushFix: PushFix = async (fix) => {
      // The CI step and the review gate hand on a `done` fix only with its spec file (`needsSpec`).
      if (fix.specPath === null) return { outcome: "failed", state: fix.record.state, record: fix.record, reason: "a done fix with no spec file" };
      return deps.prStep({ unit: story, record: fix.record, result: fix.result, specPath: fix.specPath, superseded: fix.superseded, clone: layout.clone, signal: budget, log: note, kind: "fix" });
    };
    /** The claimed record with a PR a step may take on, else `null`. */
    const claimedWithPr = (o: PrStepOutput): UnitRecord | null => {
      const r = t.record;
      return o.outcome === "progress" && o.state === "claimed" && r !== null && r.pr !== null ? r : null;
    };

    /** The merge step on `record`: the run's outcome, or the step's output after an ejection (CI runs again). */
    const mergeRound = async (step: MergeStep, record: UnitRecord): Promise<{ readonly end: LaneOutcome } | { readonly next: PrStepOutput }> => {
      let merged: Awaited<ReturnType<MergeStep>>;
      try {
        merged = await step({ unit: stepUnit, record, signal: budget, log: note });
      } catch (e) {
        return { end: await failUnit(t, `merge step threw: ${message(e)}`) };
      }
      const mergeEnd = await settle(merged, "merge step");
      if (mergeEnd !== null) return { end: mergeEnd };
      if (merged.ejected !== true) return { end: merged.outcome };
      note("ejected from the merge queue: CI again on fresh main");
      return { next: merged };
    };

    let first: { readonly end: LaneOutcome } | { readonly next: PrStepOutput };
    if (start === null) {
      // Watch mode: a stale `merging` takeover goes straight to the merge step, which only watches the queue.
      const record = t.record;
      if (record === null) return failUnit(t, "no merging record to watch");
      if (mergeStep === undefined) {
        addReason(t, "no merge step to watch the queue");
        return "progress";
      }
      await checkHeld(t);
      first = await mergeRound(mergeStep, record);
    } else {
      first = await build(start);
    }
    if ("end" in first) return first.end;
    let last: PrStepOutput = first.next;
    for (;;) {
      const withPr = claimedWithPr(last);
      if (ciStep === undefined || withPr === null) return last.outcome;
      let ci: PrStepOutput;
      try {
        ci = await ciStep({
          unit: ciUnit,
          record: withPr,
          clone: layout.clone,
          signal: budget,
          log: note,
          scratchDir: join(layout.laneDir, "scratch"),
          pushFix,
          session: ciSession,
          regenerate,
        });
      } catch (e) {
        const stopped = limitStop as { readonly record: UnitRecord | null; readonly state: UnitState | null } | null;
        if (stopped !== null) return stopAfterLimit(stopped);
        return failUnit(t, `CI step threw: ${message(e)}`);
      }
      {
        // A STOP during a CI session's usage-limit sleep released the unit: the CI step's own ending is moot.
        const stopped = limitStop as { readonly record: UnitRecord | null; readonly state: UnitState | null } | null;
        if (stopped !== null) return stopAfterLimit(stopped);
      }
      const ciEnd = await settle(ci, "CI step");
      if (ciEnd !== null) return ciEnd;
      const ciPassed = claimedWithPr(ci);
      if (reviewGate === undefined || ciPassed === null) return ci.outcome;

      // The review gate: a head no review passed is reviewed; a blocking round's loopback fix goes through CI again.
      let gated: Awaited<ReturnType<ReviewGateStep>>;
      await checkHeld(t);
      try {
        gated = await reviewGate({ unit: stepUnit, storyId: story.story_id, record: ciPassed, track: t, signal: budget, log: note, needsSpec: true, session: loopbackSession, pushFix });
      } catch (e) {
        if (e instanceof Halt) throw e;
        const stopped = limitStop as { readonly record: UnitRecord | null; readonly state: UnitState | null } | null;
        if (stopped !== null) return stopAfterLimit(stopped);
        return failUnit(t, `review gate threw: ${message(e)}`);
      }
      {
        // A STOP during a loopback session's usage-limit sleep released the unit: the gate's own ending is moot.
        const stopped = limitStop as { readonly record: UnitRecord | null; readonly state: UnitState | null } | null;
        if (stopped !== null) return stopAfterLimit(stopped);
      }
      const gateEnd = await settle(gated, "review gate");
      if (gateEnd !== null) return gateEnd;
      if (gated.pushed === true) {
        note("loopback fix pushed: CI again on the new head");
        last = gated;
        continue;
      }
      const reviewed = claimedWithPr(gated);
      if (mergeStep === undefined || reviewed === null) return gated.outcome;
      const merged = await mergeRound(mergeStep, reviewed);
      if ("end" in merged) return merged.end;
      last = merged.next;
    }
  };

  const body = async (): Promise<LaneOutcome> => {
    const pid = store.writePid("lane", deps.pid ?? process.pid, deps.command ?? basename(process.execPath));
    if (!pid.ok) throw new Halt("failed", `lane.pid: ${pid.error.message}`);

    for (let round = 1; round <= MAX_CLAIM_ROUNDS; round += 1) {
      unit = null;
      checkStop(store);
      const roundStart = clock();
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) throw new Halt("failed", `snapshot ${snapped.error.kind}: ${snapped.error.message}`);
      const snap = snapped.value;
      mainSha = snap.main.sha;
      fc.see(snap.now);
      /** The host time the claim's stamp (`snap.now`) was seen: the keeper's first good beat. */
      const claimNowAt = fc.seenAt();
      const assembled = assembleSnapshot({
        repo: lane.repo,
        now: snap.now,
        tree: [...snap.main.tree],
        files: { ...snap.main.files },
        main_sha: snap.main.sha,
        blob_shas: snap.main.blob_shas,
        ledger_tip: snap.ledger.tip,
        ledger_files: snap.ledger.files,
        prs: snap.prs,
        escalations: null,
        lane: identity,
        role: "builder",
      });
      if (!assembled.ok) {
        if (assembled.error.kind === "stop") await laneStop("ledger-schema-version", assembled.error.message);
        throw new Halt("stop", `${assembled.error.kind}: ${assembled.error.message}`);
      }
      await alertCoordinatorGone(assembled.value.ledger.coordinator, snap.now, snap.main.sha);
      const swept = new Map((await sweepMerged(assembled.value.ledger.units, snap.prs, snap.now)).map((r) => [r.unit, r]));
      // `next` sees the records the sweep wrote, so it never takes over a unit the sweep just marked merged.
      const units = assembled.value.ledger.units.map((r) => swept.get(r.unit) ?? r);
      const view = swept.size === 0 ? assembled.value : { ...assembled.value, ledger: { ...assembled.value.ledger, units } };
      const config = assembled.value.config;
      const picked = next(view, "builder");
      if (picked.kind === "stop") throw new Halt("stop", `next: ${picked.reason}`);
      if (picked.kind === "idle") {
        const span = store.appendJournal({
          schema_version: 1,
          type: "span",
          span: "idle",
          reason: picked.reason,
          started_at: iso(roundStart),
          ended_at: iso(clock()),
        });
        reportStore(span, "journal");
        return "idle";
      }

      const story = picked.story;
      const t: BuilderTrack = {
        ...newTrack({
          unit: story.unit,
          startedMs: roundStart,
          logName: logFileName(story.unit, roundStart),
          state: units.find((r) => r.unit === story.unit)?.state ?? null,
        }),
        story,
        result: null,
      };
      unit = t;
      note(`round ${round}: next picked ${story.unit} (${picked.kind}) at main ${snap.main.sha}`);
      checkStop(store);

      if (picked.kind === "park") {
        const r = await swap(parkNew({ unit: story.unit, by: identity, now: snap.now, kind: "needs-approval" }), story.unit);
        if (r.kind === "lost") continue;
        if (r.kind === "failed") throw new Halt("failed", `parkNew: ${r.message}`);
        t.record = r.record;
        t.state = r.record?.state ?? "parked";
        t.reason = "needs-approval";
        note("parked needs-approval");
        return "progress";
      }

      /** The heartbeat keeper, for a unit this lane now holds `claimed` or `merging`. */
      const keep = (): void => {
        const holding = t.record;
        if (holding === null || (holding.state !== "claimed" && holding.state !== "merging")) return;
        keeper = startHeartbeat({
          forge,
          identity,
          unit: story.unit,
          generation: holding.generation,
          clock,
          forgeNow: fc.forgeNow,
          claimedMs: claimNowAt,
          callTimeoutMs,
          ...(deps.heartbeat?.everyMs !== undefined ? { everyMs: deps.heartbeat.everyMs } : {}),
          ...(deps.heartbeat?.retryMs !== undefined ? { retryMs: deps.heartbeat.retryMs } : {}),
          ...(deps.heartbeat?.sleep !== undefined ? { sleep: deps.heartbeat.sleep } : {}),
          ...(deps.random !== undefined ? { random: deps.random } : {}),
          log: note,
        });
      };

      /** `markMerged` (any lane may write it, AD-3), then the run ends `progress`. */
      const markedMerged = async (pr: number, now: string): Promise<LaneOutcome> => {
        t.reason = `PR #${pr} merged`;
        const r = await swap(markMerged({ unit: story.unit, by: identity, now }), story.unit);
        if (r.kind !== "ok") throw new Halt("failed", `markMerged: ${r.message}`);
        if (r.record !== null) t.record = r.record;
        t.state = "merged";
        note("marked merged");
        return "progress";
      };

      /** A takeover's swap; `null` when another lane won it (the next round runs). */
      const takeOver = async (edit: LedgerEdit, what: string): Promise<UnitRecord | null> => {
        const r = await swap(edit, story.unit);
        if (r.kind === "lost") {
          note(`${what} lost: ${r.message}`);
          return null;
        }
        if (r.kind === "failed") throw new Halt("failed", `${what}: ${r.message}`);
        t.record = r.record;
        t.state = r.record?.state ?? null;
        note(`${what}: ${t.state ?? "unknown"} at generation ${t.record?.generation ?? "unknown"}`);
        return r.record;
      };

      if (story.take_over !== null && story.expect_generation === null) {
        throw new Halt("failed", `next: a takeover of ${story.unit} with no generation`);
      }
      const generation = story.expect_generation ?? 0;

      if (story.take_over === "merging") {
        // A stale builder-held `merging` record: its PR's queue state decides (AR10).
        const stale = units.find((r) => r.unit === story.unit);
        const prNumber = stale?.pr ?? null;
        let q: QueueState | "not-found" = "not-found";
        if (prNumber !== null) {
          const r = await call("queueState", (o) => forge.queueState(prNumber, o));
          if (r.ok) q = r.value;
          else if (r.error.kind !== "not-found") throw new Halt("failed", `queueState ${r.error.kind}: ${r.error.message}`);
        }
        const action = staleMergingAction(q);
        const seen = q === "not-found" ? "not found" : `${q.state}${q.queued ? ", queued" : ", not queued"}`;
        note(`stale merging at generation ${generation}: PR #${prNumber ?? "none"} ${seen}: ${action}`);
        if (action === "merged") return await markedMerged(prNumber as number, snap.now);
        if (action === "release") {
          const released = await takeOver(releaseStale({ unit: story.unit, by: identity, now: snap.now, generation }), "releaseStale");
          if (released === null) continue;
          t.reason = `stale merging PR #${prNumber ?? "none"} ${seen}: released`;
          return "progress";
        }
        const queued = q as QueueState;
        const adoptPr: AdoptedPr = {
          pr: prNumber as number,
          pr_owner: stale?.pr_owner ?? identity.owner,
          head_sha: queued.head_sha,
          base_sha: stale?.base_sha ?? snap.main.sha,
        };
        const taken = await takeOver(
          takeOverStale({ unit: story.unit, by: identity, now: snap.now, generation, stillQueued: true, adoptPr }),
          "takeOverStale",
        );
        if (taken === null) continue;
        keep();
        const fenced = await adoptVendor(t);
        if (fenced !== null) return fenced;
        return await work(t, snap, config, null);
      }

      const branch = `${config.branches.story}${story.story_id}`;
      const listed = await call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o));
      if (!listed.ok) throw new Halt("failed", `listPrsByBranch ${listed.error.kind}: ${listed.error.message}`);
      const decided = decidePr(listed.value);
      const adoptPr: AdoptedPr | null =
        decided.kind === "open" ? { pr: decided.pr.number, pr_owner: identity.owner, head_sha: decided.pr.head_sha, base_sha: snap.main.sha } : null;
      const prFields = adoptPr !== null ? { adoptPr } : decided.kind === "none" ? { baseSha: snap.main.sha } : {};
      const prNote = decided.kind === "none" ? "" : ` (PR #${decided.pr.number} ${decided.kind})`;

      if (story.take_over === "claimed") {
        // A stale `claimed` record: a merged PR needs no takeover; else a claim of the record (AD-9).
        if (decided.kind === "merged") return await markedMerged(decided.pr.number, snap.now);
        const taken = await takeOver(
          takeOverStale({ unit: story.unit, by: identity, now: snap.now, generation, globs: story.globs, ...prFields }),
          `takeOverStale${prNote}`,
        );
        if (taken === null) continue;
        if (taken.state === "parked") {
          t.reason = `stale takeover parked blocked attempts-cap after ${taken.attempts} attempts`;
          return "progress";
        }
      } else {
        const edit = claim({
          unit: story.unit,
          by: identity,
          now: snap.now,
          globs: story.globs,
          expectGeneration: story.expect_generation,
          manifestSha: story.infrastructure ? story.manifest_sha : null,
          ...prFields,
        });
        const claimed = await swap(edit, story.unit);
        if (claimed.kind === "lost") {
          note(`claim lost: ${claimed.message}`);
          continue;
        }
        if (claimed.kind === "failed") throw new Halt("failed", `claim: ${claimed.message}`);
        t.record = claimed.record;
        t.state = claimed.record?.state ?? "claimed";
        note(`claimed at generation ${t.record?.generation ?? "unknown"}${prNote}`);
      }
      keep();

      if (decided.kind === "merged") return await markedMerged(decided.pr.number, await freshNow());
      const fenced = await adoptVendor(t);
      if (fenced !== null) return fenced;
      const start = decided.kind === "open" ? decided.pr.head_sha : snap.main.sha;
      return await work(t, snap, config, start);
    }
    unit = null;
    throw new Halt("failed", `claim lost ${MAX_CLAIM_ROUNDS} rounds in a row`);
  };

  let outcome: LaneOutcome;
  /** The reason of the `Halt` that ended the run, if one did. */
  let haltReason: string | null = null;
  try {
    outcome = await body();
  } catch (e) {
    if (e instanceof Halt) {
      outcome = e.outcome;
      haltReason = e.reason;
      if (e instanceof MarkerStop) markerStop = true;
      const t = unit as BuilderTrack | null;
      if (t !== null) addReason(t, e.reason);
      // A failed `Halt` after the claim fails the attempt at once (AD-7's crash row, Story 2.6b).
      if (t !== null && e.outcome === "failed" && !(e instanceof Abandon) && t.state === "claimed" && t.record?.state === "claimed") {
        try {
          await failUnit(t, t.reason ?? e.reason);
        } catch (inner) {
          // An abandoned unit keeps the state the keeper's end gave it.
          if (!(inner instanceof Abandon)) t.state = null;
          if (inner instanceof Halt) {
            outcome = inner.outcome;
            haltReason = inner.reason;
            addReason(t, inner.reason);
          }
        }
      }
    } else {
      outcome = "failed";
      const t = unit as BuilderTrack | null;
      if (t !== null) {
        t.reason = `unexpected error: ${message(e)}`;
        if (t.state === "claimed") {
          try {
            await failUnit(t, t.reason);
          } catch (inner) {
            // An abandoned unit keeps the state the keeper's end gave it.
            if (!(inner instanceof Abandon)) t.state = null;
            if (inner instanceof Halt) {
              outcome = inner.outcome;
              haltReason = inner.reason;
              addReason(t, inner.reason);
            }
          }
        }
      }
    }
  }

  try {
    const t = unit as BuilderTrack | null;
    // A failed attempt the ledger did not take is retried before the journal record and the trailing wait (C4b).
    let waitMs = trailingWaitMs(outcome);
    if (t !== null) {
      try {
        waitMs = await retryFail(t, outcome, { waiter: deps.waiter, waitMs, clock });
      } catch (inner) {
        if (!(inner instanceof Halt)) throw inner;
        outcome = inner.outcome;
        haltReason = inner.reason;
        addReason(t, inner.reason);
        waitMs = trailingWaitMs(outcome);
      }
    }
    if (t !== null) {
      note(`outcome ${outcome}`);
      // A blocked park after a session in the clone (a review session runs elsewhere): the work stays on this host only, saved when the lane next rebuilds its clone.
      const parkedBlocked = t.sessions > t.reviewSessions && t.state === "parked" && t.record?.state === "parked" && t.record.park?.kind === "blocked";
      const wip = parkedBlocked ? wipRef(t.unit) : null;
      if (wip !== null) note(`wip: if the session changed any file, its work is saved as ${wip} in runner.git when the lane next rebuilds its clone; it is never pushed`);
      journal({
        unit: t.unit,
        logName: t.logName,
        startedMs: t.startedMs,
        record: t.record,
        state: t.state,
        outcome,
        reason: t.reason,
        tokens: t.tokens,
        cost: t.cost,
        sessions: t.sessions,
        result: t.result,
        wipRef: wip,
        reportedModel: t.reportedModel,
      });
    }
    reportStore(store.writeOutcome(outcome), "outcome");

    // The keeper goes on through the trailing wait while the record is still claimed or merging.
    if (waitMs !== null && waitMs > 0) {
      let waited: WaitResult;
      try {
        waited = await deps.waiter.wait({ ms: waitMs });
      } catch (e) {
        waited = { end: "failed", message: message(e) };
      }
      if (waited.end === "failed") console.error(`lane wait failed: ${waited.message ?? "no message"}`);
    }
  } finally {
    await (keeper as Heartbeat | null)?.stop();
  }
  reportStore(store.clearPid("lane"), "lane.pid");
  if (outcome !== "stop" || markerStop) return { outcome };
  const t = unit as BuilderTrack | null;
  return { outcome, laneStop: haltReason ?? t?.reason ?? "the run ended stop" };
}
