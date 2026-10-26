import { join } from "node:path";
import { storySpecGlob } from "../core/config/story-spec-path.ts";
import { pickSpec, specMatches, type SpecMatch } from "../core/lane/build-check.ts";
import { release } from "../core/ledger/edits.ts";
import { buildReviewPrompt, type ReviewPass } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { isBlocking, reviewComment } from "../core/review/review-comment.ts";
import { followupRecommended } from "../core/review/review-spec.ts";
import { chooseReviewer, type ReviewerChoice, type SessionAdapter } from "../core/review/reviewer.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaneIdentity, UnitRecord } from "../core/schemas/ledger.ts";
import type { ReviewFinding, ReviewResult } from "../core/schemas/session-result.ts";
import type { Agent, AgentSettings } from "../ports/agent.ts";
import type { Forge } from "../ports/forge.ts";
import type { LaneStore } from "../ports/lane-store.ts";
import type { Sandbox, SandboxProfile } from "../ports/sandbox.ts";
import { laneLayout } from "./lane-store.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep, type Sleep } from "./ledger-cas.ts";
import { checkoutFiles, reviewWorkspace, type ReviewCheckout } from "./review-checkout.ts";
import {
  createSessionRunner,
  describeError,
  End,
  Halt,
  LIMIT_STOP_REASON,
  MarkerStop,
  message,
  newTrack,
  readRegular,
  stepKit,
  stepOps,
  type PromptOutcome,
  type SessionContext,
  type SessionLimits,
  type SessionOutcome,
  type StepOutput,
  type StepUnit,
  type UnitTrack,
} from "./session.ts";
import type { Waiter } from "./wait.ts";

/**
 * The review step (Story 3.4, FR8, AR15, AR17, AD-16): one review round on a
 * claimed unit's open PR at its recorded `head_sha`, through the sandbox,
 * with the reviewer `chooseReviewer` picks from fresh `main`'s policy.
 *
 * - Fresh `main` first: the PR must be open at the record's head, else a
 *   failed attempt with no session. A policy that allows neither reviewer,
 *   or a reviewer the caller did not compose, ends the step `stop`.
 * - A reviewer of the lane's own adapter runs with the lane's model and
 *   effort; any other with its adapter's default model and effort `high`.
 *   Each pass is its own session, through its own `SessionRunner`, in
 *   `<lane>/review`: a checkout of the head with `main`'s agent config and
 *   hooks off, written fresh for every pass, never the agent's clone.
 * - A Story's spec is read from the first pass's checkout: exactly one
 *   `done` match of `story_spec_path` (`pickSpec`), else a failed attempt.
 *   `followup_review_recommended: true` adds a follow-up pass. A unit with
 *   no Story id gets the normal pass only.
 * - After each pass's result: a fence recording `reviewed_sha` (the head the
 *   runner checked out, never the agent's own) and clearing `passed_sha`,
 *   then one comment-only review posted at the head. After the last pass,
 *   with no pass blocking, a `record` beat sets `passed_sha` to the head.
 *   A failed post is a failed attempt, with `passed_sha` never set.
 *
 * The step keeps its own `UnitTrack` (the caller's log), so a reviewer from
 * another vendor never changes the builder's journal record. The sessions
 * run outside `kit.run`, so a `Halt` or `MarkerStop` reaches the caller;
 * anything else never throws.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The reviewer agents the caller composed, by adapter. */
export type Reviewers = Partial<Readonly<Record<SessionAdapter, Agent>>>;

export type ReviewStepDeps = {
  readonly forge: Forge;
  readonly sandbox: Sandbox;
  readonly store: LaneStore;
  /** Runs the usage-limit sleeps. */
  readonly waiter: Waiter;
  /** The lane folder (AR37). */
  readonly laneDir: string;
  /** The lane's `host.yaml` settings: repo, agent, model, effort. */
  readonly lane: Lane;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The reviewer agents, by adapter: the one `chooseReviewer` picks must be here. */
  readonly reviewers: Reviewers;
  /** Writes each pass's review checkout. */
  readonly checkout: ReviewCheckout;
  /** The lane's credentials, redacted from the posted reviews; default none. */
  readonly secrets?: readonly string[];
  readonly limits?: SessionLimits;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

export type ReviewStepInput = {
  readonly unit: StepUnit;
  /** The Story's id, whose spec the review reads; `null` for a unit with none (a retro item, a coordinator PR). */
  readonly storyId: string | null;
  /** The claimed record, with its open PR at `head_sha`. */
  readonly record: UnitRecord;
  /** The caller's track: the step logs to its log and keeps a track of its own. */
  readonly track: UnitTrack;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
};

/** What a round found: the reviewed head, whether any pass blocked, the reviewer, the passes run and every finding. */
export type ReviewRound = {
  readonly sha: string;
  readonly blocking: boolean;
  readonly crossVendor: boolean;
  readonly adapter: SessionAdapter;
  readonly passes: number;
  readonly findings: readonly ReviewFinding[];
};

export type ReviewStepOutput = StepOutput & { readonly review?: ReviewRound };

/** Runs one review round. Never throws, except a `Halt` or `MarkerStop` from a session. */
export type ReviewStep = (input: ReviewStepInput) => Promise<ReviewStepOutput>;

/** What the round needs from fresh `main` and the record. */
type Round = {
  readonly pr: number;
  readonly head: string;
  readonly main: string;
  readonly choice: ReviewerChoice;
  readonly agent: Agent;
  readonly specGlob: string;
  readonly budgetHours: number;
  readonly proxyHosts: readonly string[];
};

/** The spec at the head: its path and whether it asks for the follow-up pass, else why not. */
type SpecRead = { readonly ok: true; readonly path: string; readonly followup: boolean } | { readonly ok: false; readonly reason: string };

export function createReviewStep(deps: ReviewStepDeps): ReviewStep {
  const { forge, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const secrets = deps.secrets ?? [];
  const layout = laneLayout(deps.laneDir);

  return async (input: ReviewStepInput): Promise<ReviewStepOutput> => {
    const unit = input.unit.unit;
    const kit = stepKit({
      name: "review step",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    const { generation, reasons, note, end, forgeNow, call, swap, failed, beat } = kit;
    const { aborted, freshMain } = stepOps({
      kit,
      forge,
      identity,
      repo: deps.lane.repo,
      signal: input.signal,
      abortReason: "the unit budget passed or the unit was lost during the review step",
      clock,
      sleep,
    });

    /** Ends the step `stop`, with no session. */
    const stop = (why: string): never => {
      reasons.push(why);
      note(`stop: ${why}`);
      throw end("stop", kit.record.state);
    };

    // 1. The record's PR and head, fresh main, the PR as the forge shows it, then the reviewer.
    const setUp = async (): Promise<Round> => {
      const pr = kit.record.pr;
      const head = kit.record.head_sha;
      if (pr === null) return await failed("the record has no PR to review");
      if (head === null) return await failed(`PR #${pr} has no head_sha on the record`);
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const { snap, config: repo } = fresh.value;
      const state = snap.prs[unit];
      if (state === undefined) return await failed(`PR #${pr} is not known to the forge`);
      if (state.number !== pr) return await failed(`the forge shows PR #${state.number} for ${unit}, not the record's PR #${pr}`);
      if (state.state !== "open") return await failed(`PR #${pr} is ${state.state}`);
      if (state.head_sha !== head) return await failed(`PR #${pr} head is ${state.head_sha}, not the record's ${head}`);
      const choice = chooseReviewer(kit.record.builder_providers, repo.repo.policy.unattended_adapters);
      if (choice === null) return stop("no reviewer: .xarabot/policy.yaml unattended_adapters allows neither claude nor codex");
      const agent = deps.reviewers[choice.adapter];
      if (agent === undefined) return stop(`no reviewer: the ${choice.adapter} reviewer was not composed for this lane`);
      const config = repo.repo.config;
      let specGlob = "";
      if (input.storyId !== null) {
        const glob = storySpecGlob(config.story_spec_path, input.storyId);
        if (!glob.ok) return await failed(`spec: ${glob.error.message}`);
        specGlob = glob.value;
      }
      return { pr, head, main: snap.main.sha, choice, agent, specGlob, budgetHours: config.unit_budget_hours, proxyHosts: config.proxy_hosts };
    };

    let round: Round;
    try {
      round = await setUp();
    } catch (e) {
      if (e instanceof End) return e.out;
      return kit.run(() => failed(`unexpected error: ${message(e)}`));
    }
    const { pr, head, main, choice, agent } = round;

    // 2. The reviewer's settings: the lane's for its own adapter, else the adapter's defaults at effort `high` (AR22).
    const own = choice.adapter === deps.lane.agent;
    const settings: AgentSettings = own ? { effort: deps.lane.effort, ...(deps.lane.model !== undefined ? { model: deps.lane.model } : {}) } : { effort: "high" };
    const model = settings.model ?? agent.defaultModel;
    note(`reviewer ${choice.adapter} (${model}), ${choice.crossVendor ? "cross-vendor" : "same-vendor"}, at ${head} onto main ${main}`);

    // The step's own track: the reviewer's runs never reach the builder's journal record.
    const track = newTrack({ unit, startedMs: clock(), logName: input.track.logName, state: kit.record.state });
    track.record = kit.record;
    const budget = AbortSignal.any([input.signal, AbortSignal.timeout(round.budgetHours * HOUR_MS)]);
    /** Set when a STOP ended a usage-limit sleep and the unit was released. */
    let limitStopped = false;
    const profile: SandboxProfile = {
      clone: layout.review,
      vendorHome: layout.vendorHome,
      tempDir: layout.tmp,
      runnerGit: layout.runnerGit,
      resultPath: layout.resultPath,
      repoHosts: round.proxyHosts,
    };
    const ctx: SessionContext = {
      track,
      branch: "review",
      profile,
      budget,
      overBudget: () => (input.signal.aborted ? "the unit budget passed or the unit was lost during the review" : `review budget of ${round.budgetHours} h passed`),
      signals: () => [input.signal],
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
      agent,
      sandbox: deps.sandbox,
      store: deps.store,
      workspace: reviewWorkspace(deps.checkout, main),
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

    /** The Story's spec in the first pass's checkout: one `done` match (AR11), and its follow-up flag. */
    const readSpec = (): SpecRead => {
      let paths: string[];
      try {
        paths = specMatches(round.specGlob, checkoutFiles(layout.review));
      } catch (e) {
        return { ok: false, reason: `spec: cannot list the review checkout: ${message(e)}` };
      }
      const matches: SpecMatch[] = paths.map((path) => {
        try {
          return { path, text: readRegular(join(layout.review, path)) };
        } catch {
          return { path, text: null };
        }
      });
      const picked = pickSpec("done", matches);
      if (!picked.ok) return { ok: false, reason: `${picked.error.message} (glob ${round.specGlob})` };
      const spec = picked.value.spec as { readonly path: string; readonly text: string };
      return { ok: true, path: spec.path, followup: followupRecommended(spec.text) };
    };

    const passes: ReviewPass[] = ["normal"];
    let specPath: string | null = null;
    let blocking = false;
    const findings: ReviewFinding[] = [];
    /** A pass's posting went through: the round goes on. */
    const GO_ON: StepOutput = { outcome: "progress", state: null };

    /** The fence recording the reviewed head, then the pass's review posted at it. */
    const post = async (pass: ReviewPass, result: ReviewResult): Promise<StepOutput> => {
      aborted();
      if (result.reviewed_sha !== head) note(`the ${pass} result names reviewed_sha ${result.reviewed_sha}, not the checked-out ${head}: ${head} is recorded`);
      await beat("fence", { reviewed_sha: head, passed_sha: null });
      const body = reviewComment({ subject: input.unit.subject, sha: head, crossVendor: choice.crossVendor, adapter: choice.adapter, model, pass, result, secrets });
      const posted = await call("postReview", (o) => forge.postReview(pr, { commit_sha: head, body }, o));
      if (!posted.ok) return await failed(`postReview PR #${pr} ${describeError(posted.error)}`);
      note(`posted the ${pass} review of ${head} on PR #${pr}: ${result.verdict}, ${result.findings.length} finding(s)`);
      return GO_ON;
    };

    for (let i = 0; i < passes.length; i += 1) {
      const pass = passes[i] as ReviewPass;
      /** After `prepare` wrote the checkout: on the first pass of a Story, its spec; then the prompt. */
      const prompt = (): PromptOutcome => {
        if (pass === "normal" && input.storyId !== null) {
          const spec = readSpec();
          if (!spec.ok) return { ok: false, reason: spec.reason };
          specPath = spec.path;
          note(`spec ${spec.path}${spec.followup ? ": follow-up review recommended" : ""}`);
          // A usage limit restarts the session and builds its prompt again: the follow-up pass is added once.
          if (spec.followup && !passes.includes("followup")) passes.push("followup");
        }
        const built = buildReviewPrompt({
          template: PACKAGE_TEMPLATE,
          unit: { id: unit, head_sha: head, main_sha: main, spec_path: specPath },
          pass,
          result_path: layout.resultPath,
        });
        return built.ok ? { ok: true, value: built.value } : { ok: false, reason: `prompt ${built.error.kind}: ${built.error.message}` };
      };

      // The session runs outside `kit.run`: a `Halt` reaches the caller.
      let ran: SessionOutcome<"review">;
      try {
        ran = await runner.session(ctx, { at: head, kind: "review", prompt });
      } catch (e) {
        if (e instanceof End) return e.out;
        if (e instanceof Halt) throw e;
        return kit.run(() => failed(`${pass} review session threw: ${message(e)}`));
      }
      if (limitStopped) {
        note(`stop: ${LIMIT_STOP_REASON}`);
        throw new MarkerStop("stop", LIMIT_STOP_REASON);
      }
      if (!ran.ok) {
        const why = `${pass} review: ${ran.reason}`;
        return kit.run(() => failed(why));
      }
      const result = ran.result;
      const blocks = isBlocking(result);
      note(`${pass} review result: ${result.verdict}, ${result.findings.length} finding(s)${blocks ? ", blocking" : ""}`);
      for (const a of result.denied_actions) note(`${pass} review denied action: ${a.replace(/\s+/g, " ").trim()}`);
      const posted = await kit.run(() => post(pass, result));
      if (posted !== GO_ON) return posted;
      if (blocks) blocking = true;
      findings.push(...result.findings);
    }

    // 3. The round: `passed_sha` only when no pass blocked.
    const review: ReviewRound = { sha: head, blocking, crossVendor: choice.crossVendor, adapter: choice.adapter, passes: passes.length, findings };
    const done = await kit.run(async () => {
      if (blocking) {
        reasons.push(`review of ${head} found blocking findings`);
        note(`blocking: passed_sha stays unset at ${head}`);
      } else {
        await beat("record", { passed_sha: head });
        reasons.push(`review of ${head} passed`);
        note(`passed: passed_sha ${head}`);
      }
      throw end("progress", kit.record.state);
    });
    return done.outcome === "progress" ? { ...done, review } : done;
  };
}
