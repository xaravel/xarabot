import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { storySpecGlob } from "../core/config/story-spec-path.ts";
import { checkBuildSpec, specMatches } from "../core/lane/build-check.ts";
import { claim, failAttempt, markMerged, park, parkNew, type LedgerCommit, type LedgerEdit } from "../core/ledger/edits.ts";
import { next, type NextStory } from "../core/next/next.ts";
import { assembleSnapshot } from "../core/next/snapshot.ts";
import { buildPrompt, type PromptMode, type PromptSection } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { err, ok } from "../core/result.ts";
import type { Config } from "../core/schemas/config.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { JournalCost, JournalTokens, LaneOutcome, UnitJournalRecord } from "../core/schemas/journal.ts";
import { unitPath, UnitRecordSchema, type LaneIdentity, type ParkReason, type UnitRecord, type UnitState } from "../core/schemas/ledger.ts";
import { parseSessionResult, type BuildResult } from "../core/schemas/session-result.ts";
import type { Agent, AgentSettings, AgentUnit } from "../ports/agent.ts";
import { isLaneStopKind, type CallOpts, type Forge, type ForgePr, type ForgeResult, type ForgeSnapshot } from "../ports/forge.ts";
import type { LaneStore } from "../ports/lane-store.ts";
import type { LaunchSpec, Sandbox, SandboxProfile, SandboxResult, SandboxRun } from "../ports/sandbox.ts";
import { emptyDir } from "../sandbox/vendor-home.ts";
import type { CiSession, CiStep, Regenerate } from "./ci-step.ts";
import { swapLedger, type Sleep } from "./ledger-cas.ts";
import { laneLayout, logFileName, type LaneLayout } from "./lane-store.ts";
import type { MergeStep } from "./merge-step.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The lane process (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR15, AR25): one
 * unit from the STOP check and claim, through a sandboxed session, to a
 * validated result. It leaves a ledger state, at most one journal record, a
 * log and the `outcome` file saying what happened. The PR step after a
 * `done` result is injected (Story 1.16a).
 */

export const MAX_CLAIM_ROUNDS = 3;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const ZERO_SHA = "0".repeat(40);
const HOUR_MS = 60 * 60 * 1000;

/** What the PR step gets after a `done` result whose spec checks out. */
export type PrStepInput = {
  readonly unit: NextStory;
  /** The claimed ledger record. */
  readonly record: UnitRecord;
  readonly result: BuildResult;
  /** The spec file's repo-relative path in the clone. */
  readonly specPath: string;
  readonly clone: string;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
  /** `fix`: a CI fix pushed to the open PR, whose title and body stay as they are. Default `build`. */
  readonly kind?: "build" | "fix";
};

export type PrStepOutput = {
  readonly outcome: LaneOutcome;
  readonly state: UnitState | null;
  /** The latest ledger record the step saw or wrote. */
  readonly record?: UnitRecord;
  /** Why the step ended as it did; added to the journal reason. */
  readonly reason?: string;
};

/** Commits, pushes and opens the PR (Story 1.16a). Never throws. */
export type PrStep = (input: PrStepInput) => Promise<PrStepOutput>;

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
   * Takes a PR whose CI passed through the approval gate and the merge queue
   * (Story 1.17a); without it the run ends after the CI step. After an
   * ejection the CI step runs again, then this step.
   */
  readonly mergeStep?: MergeStep;
  /** The lane folder (AR37). */
  readonly laneDir: string;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The lane's `host.yaml` settings: repo, agent, model, effort. */
  readonly lane: Lane;
  /** The PID `lane.pid` records; default `process.pid`. */
  readonly pid?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The ledger swap's back-off sleep and jitter source (tests). */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

export type LaneProcessResult = { readonly outcome: LaneOutcome };

/** Ends the run early with `outcome`. */
class Halt extends Error {
  constructor(
    readonly outcome: LaneOutcome,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** The `main` paths a snapshot reads the contents of. */
export function readsPath(path: string): boolean {
  return path.startsWith(".xarabot/") || /\.(?:md|ya?ml)$/.test(path);
}

const PROMPT_SECTION = /^\.xarabot\/prompts\/([^/]+\.md)$/;
/** The CI-fix session's log file in `tmp`. */
export const CI_FIX_LOG = "ci-fix-log.md";

/** The unit being handled, for its journal record. */
type UnitTrack = {
  readonly story: NextStory;
  readonly startedMs: number;
  readonly logName: string;
  record: UnitRecord | null;
  state: UnitState | null;
  sessions: number;
  tokens: JournalTokens | null;
  cost: JournalCost | null;
  /** A run reported no cost. */
  uncosted: boolean;
  result: BuildResult | null;
  reason: string | null;
};

type Swapped =
  | { readonly kind: "ok"; readonly record: UnitRecord | null }
  | { readonly kind: "lost"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** The record `commit` writes for `unit`, or `null`. */
export function writtenRecord(commit: LedgerCommit | null, unit: string): UnitRecord | null {
  const text = commit?.writes[unitPath(unit)];
  if (text === undefined) return null;
  try {
    const parsed = UnitRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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

/** A regular file's text; a symlink or anything else is refused. */
function readRegular(path: string): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) return null;
  return readFileSync(path, "utf8");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runLaneProcess(deps: LaneDeps): Promise<LaneProcessResult> {
  const { forge, agent, sandbox, store, workspace, identity, lane } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const layout: LaneLayout = laneLayout(deps.laneDir);
  const iso = (ms: number) => new Date(ms).toISOString();
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });

  let mainSha: string | null = null;
  let lastNow: string | null = null;
  /** The host clock when `lastNow` was seen. */
  let lastNowAt = 0;
  const seeNow = (now: string): void => {
    lastNow = now;
    lastNowAt = clock();
  };
  let unit: UnitTrack | null = null;

  const log = (text: string): void => {
    if (unit !== null) store.appendLog(unit.logName, text);
  };
  const note = (text: string): void => log(`== ${iso(clock())} ${text} ==\n`);
  /** A sandboxed run's exit and output, into the unit log. */
  const logRun = (what: string, r: SandboxRun): void =>
    log(
      `== ${iso(clock())} ${what} pid ${r.pid} exit ${r.exitCode ?? "none"} signal ${r.signal ?? "none"} ${r.durationMs} ms ==\n` +
        `--- stdout ---\n${r.stdout}${r.stdout.endsWith("\n") || r.stdout === "" ? "" : "\n"}` +
        `--- stderr ---\n${r.stderr}${r.stderr.endsWith("\n") || r.stderr === "" ? "" : "\n"}`,
    );

  /** A failed store write goes to the unit log (when there is one) and stderr; the outcome stays. */
  const reportStore = (r: { readonly ok: boolean; readonly error?: { readonly kind: string; readonly message: string } }, what: string): void => {
    if (r.ok || r.error === undefined) return;
    const text = `lane store: ${what}: ${r.error.kind}: ${r.error.message}`;
    note(text);
    console.error(text);
  };

  /** Appends `reason` to the unit's reason unless it is already there. */
  const addReason = (t: UnitTrack, reason: string): void => {
    if (t.reason === null) t.reason = reason;
    else if (t.reason !== reason && !t.reason.endsWith(`; ${reason}`)) t.reason = `${t.reason}; ${reason}`;
  };

  /** Posts the alert (its failure ignored) and stops the lane. */
  const laneStop = async (condition: string, reason: string): Promise<never> => {
    try {
      await forge.alert(condition, mainSha ?? ZERO_SHA, deadline());
    } catch {
      // The alert is best effort; the lane stops either way.
    }
    throw new Halt("stop", `${condition}: ${reason}`);
  };

  /** One forge call under its own deadline; a lane-stop kind stops the lane. */
  const call = async <T>(operation: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> => {
    const r = await run(deadline());
    if (!r.ok && isLaneStopKind(r.error.kind)) await laneStop(`forge-${r.error.kind}`, `${operation}: ${r.error.message}`);
    return r;
  };

  /** A host or lane STOP marker (or one that can't be read) ends the run with `stop`. */
  const checkStop = (): void => {
    const s = store.stopMarkers();
    if (!s.ok) throw new Halt("stop", `STOP markers unreadable, stopping: ${s.error.message}`);
    if (s.value.host) throw new Halt("stop", "host STOP marker present");
    if (s.value.lane) throw new Halt("stop", "lane STOP marker present");
  };

  /** The forge's current time for a ledger edit; the last one seen when the read fails. */
  const forgeNow = async (): Promise<string> => {
    const s = await call("snapshot", (o) => forge.snapshot(o));
    if (s.ok) {
      seeNow(s.value.now);
      return s.value.now;
    }
    if (lastNow === null) return iso(clock());
    // The last forge time seen, advanced by the host time since.
    return iso(Date.parse(lastNow) + Math.max(0, clock() - lastNowAt));
  };

  /** One ledger edit through the CAS loop under its own deadline. */
  const swap = async (edit: LedgerEdit, story: string): Promise<Swapped> => {
    const r = await swapLedger({
      forge,
      edit,
      signal: AbortSignal.timeout(callTimeoutMs),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    if (r.ok) return { kind: "ok", record: writtenRecord(r.value.commit, story) };
    const e = r.error;
    if (e.kind === "edit" && e.edit === "stop") await laneStop("ledger-schema-version", e.message);
    if (e.kind === "forge" && isLaneStopKind(e.forge.kind)) await laneStop(`forge-${e.forge.kind}`, e.message);
    if (e.kind === "edit" && e.edit === "precondition") return { kind: "lost", message: e.message };
    return { kind: "failed", message: `ledger ${e.kind}: ${e.message}` };
  };

  /** Applies a held edit to the claimed unit; records the state after. */
  const held = async (t: UnitTrack, make: (now: string, generation: number) => LedgerEdit, what: string): Promise<boolean> => {
    const generation = t.record?.generation;
    if (generation === undefined) {
      t.state = null;
      return false;
    }
    const r = await swap(make(await forgeNow(), generation), t.story.unit);
    if (r.kind === "ok") {
      if (r.record !== null) t.record = r.record;
      t.state = r.record?.state ?? null;
      note(`${what}: ${t.state ?? "unknown"}`);
      return true;
    }
    t.state = null;
    t.reason = t.reason === null ? `${what}: ${r.message}` : `${t.reason}; ${what}: ${r.message}`;
    note(`${what} failed: ${r.message}`);
    return false;
  };

  /** A failed attempt: released, or parked at the attempts cap. */
  const failUnit = async (t: UnitTrack, reason: string): Promise<LaneOutcome> => {
    t.reason = reason;
    note(`failed: ${reason}`);
    await held(t, (now, generation) => failAttempt({ unit: t.story.unit, by: identity, now, generation }), "failAttempt");
    return "failed";
  };

  type JournalEntry = {
    readonly unit: string;
    readonly logName: string;
    readonly startedMs: number;
    readonly record: UnitRecord | null;
    readonly state: UnitState | null;
    readonly outcome: LaneOutcome;
    readonly reason: string | null;
    readonly tokens?: JournalTokens | null;
    readonly cost?: JournalCost | null;
    readonly sessions?: number;
    readonly result?: BuildResult | null;
  };

  /** Appends one unit journal record, after flushing the unit's log. */
  const journalUnit = (e: JournalEntry): void => {
    const endedMs = clock();
    const logged = store.appendLog(e.logName, "");
    const record: UnitJournalRecord = {
      schema_version: 1,
      type: "unit",
      unit: e.unit,
      lane: identity.lane,
      generation: e.record?.generation ?? null,
      started_at: iso(e.startedMs),
      ended_at: iso(endedMs),
      duration_ms: Math.max(0, endedMs - e.startedMs),
      agent: lane.agent,
      model: lane.model ?? agent.defaultModel,
      effort: lane.effort,
      tokens: e.tokens ?? null,
      cost: e.cost ?? null,
      sessions: e.sessions ?? 0,
      outcome: e.outcome,
      result: e.result?.outcome ?? null,
      state: e.state,
      attempts: e.record?.attempts ?? 0,
      loopbacks: e.record?.loopbacks ?? 0,
      ci_fixes: e.record?.ci_fixes ?? 0,
      denied_actions: [...(e.result?.denied_actions ?? [])],
      reason: e.reason,
      log: logged.ok ? logged.value : join(layout.logs, e.logName),
    };
    reportStore(store.appendJournal(record), "journal");
  };

  /**
   * Before `next`: every parked or merging record whose PR the forge reports
   * merged (the Maintainer approved and queued it by hand, or the queue merged
   * it after its lane ended) is marked `merged`, with one journal record each.
   */
  const sweepMerged = async (units: readonly UnitRecord[], prs: ForgeSnapshot["prs"], now: string): Promise<void> => {
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
      journalUnit({ unit: r.unit, logName, startedMs, record: swapped.record, state: "merged", outcome: "progress", reason });
    }
  };

  const settings: AgentSettings = { effort: lane.effort, ...(lane.model !== undefined ? { model: lane.model } : {}) };

  /** The session and result handling for a claimed unit, under the unit budget. */
  const work = async (t: UnitTrack, snap: ForgeSnapshot, config: Config, start: string): Promise<LaneOutcome> => {
    const story = t.story;
    const budget = AbortSignal.timeout(config.unit_budget_hours * HOUR_MS);
    const overBudget = () => `unit budget of ${config.unit_budget_hours} h passed`;
    const branch = `${config.branches.story}${story.story_id}`;

    const profile: SandboxProfile = {
      clone: layout.clone,
      vendorHome: layout.vendorHome,
      tempDir: layout.tmp,
      runnerGit: layout.runnerGit,
      resultPath: layout.resultPath,
      repoHosts: config.proxy_hosts,
    };

    /** Empties `tmp` and prepares the clone at `at`; the failure's reason, else `null`. */
    const setUp = async (at: string): Promise<string | null> => {
      try {
        emptyDir(layout.tmp);
      } catch (e) {
        return `tmp: cannot empty ${layout.tmp}: ${message(e)}`;
      }
      const generation = t.record?.generation ?? 1;
      let prepared: Awaited<ReturnType<Workspace["prepare"]>>;
      try {
        prepared = await workspace.prepare({ unit: story.unit, branch, start: at, generation, fetch: [at], signal: budget });
      } catch (e) {
        return `prepare: ${message(e)}`;
      }
      if (budget.aborted) return overBudget();
      if (!prepared.ok) return `prepare ${prepared.error.kind}: ${prepared.error.message}`;
      note(`clone at ${prepared.value.sha}${prepared.value.resumed ? " (wip resumed)" : ""}`);
      return null;
    };

    /** One sandboxed run: its session id when it ran, else the failure. */
    const runOnce = async (u: AgentUnit): Promise<{ readonly sessionId: string | null } | { readonly fail: string }> => {
      const spec = agent.launchSpec(u, settings, layout.resultPath);
      if (!spec.ok) return { fail: `launch spec: ${spec.error.message}` };
      const n = t.sessions + 1;
      note(`run ${n} (${u.kind}) starts`);
      let run: SandboxResult<SandboxRun>;
      try {
        run = await sandbox.run(spec.value, profile, budget, { onSpawn: (pid) => reportStore(store.writePid("agent", pid), "agent.pid") });
      } catch (e) {
        run = { ok: false as const, error: { kind: "refused" as const, message: `sandbox threw: ${message(e)}` } };
      } finally {
        reportStore(store.clearPid("agent"), "agent.pid");
      }
      if (!run.ok) return { fail: `sandbox refused: ${run.error.message}` };
      t.sessions = n;
      const r = run.value;
      logRun(`run ${n} (${u.kind})`, r);
      const usage = agent.parseUsage(r.stdout);
      if (usage.tokens !== null) {
        const a = t.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        t.tokens = {
          input: a.input + usage.tokens.input,
          output: a.output + usage.tokens.output,
          cacheRead: a.cacheRead + usage.tokens.cacheRead,
          cacheCreation: a.cacheCreation + usage.tokens.cacheCreation,
        };
      }
      // A run that reported no cost makes the sum an estimate.
      if (usage.cost === null) t.uncosted = true;
      if (usage.cost !== null || t.cost !== null) {
        t.cost = {
          usd: (t.cost?.usd ?? 0) + (usage.cost?.usd ?? 0),
          estimate: (t.cost?.estimate ?? false) || (usage.cost?.estimate ?? true) || t.uncosted,
        };
      }
      return { sessionId: usage.sessionId };
    };

    const resultText = (): string | null => {
      try {
        return readRegular(layout.resultPath);
      } catch {
        return null;
      }
    };

    type Ran =
      | { readonly ok: true; readonly result: BuildResult; readonly specPath: string; readonly specText: string }
      | { readonly ok: false; readonly reason: string };

    /**
     * One builder session at `at`: prepare, prompt, run with the one resume,
     * parse the build result, then the single spec match. With `ciLog` the
     * session runs in `ci-fix` mode, its log in `tmp/ci-fix-log.md`.
     */
    const sessionAt = async (at: string, ciLog: string | null): Promise<Ran> => {
      const fail = (reason: string): Ran => ({ ok: false, reason });
      const setUpFailed = await setUp(at);
      if (setUpFailed !== null) return fail(setUpFailed);

      let mode: PromptMode = { mode: "build" };
      if (ciLog !== null) {
        const logPath = join(layout.tmp, CI_FIX_LOG);
        try {
          writeFileSync(logPath, ciLog);
        } catch (e) {
          return fail(`ci-fix log: cannot write ${logPath}: ${message(e)}`);
        }
        mode = { mode: "ci-fix", log_path: logPath };
      }
      const repo = loadRepoConfig({ repo: lane.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!repo.ok) return fail(`config: ${repo.error.message}`);
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
        human_live_steps: repo.value.repo.humanLiveSteps.steps,
        result_path: layout.resultPath,
      });
      if (!prompt.ok) return fail(`prompt ${prompt.error.kind}: ${prompt.error.message}`);

      const first = await runOnce({ kind: "fresh", prompt: prompt.value });
      if ("fail" in first) return fail(first.fail);
      if (budget.aborted) return fail(overBudget());
      let text = resultText();
      if (text === null && first.sessionId !== null) {
        const second = await runOnce({ kind: "resume", sessionId: first.sessionId });
        if ("fail" in second) return fail(second.fail);
        if (budget.aborted) return fail(overBudget());
        text = resultText();
      }
      if (text === null) return fail(`no result at ${layout.resultPath} after ${t.sessions} run(s)`);
      const parsed = parseSessionResult(layout.resultPath, text, "build");
      if (!parsed.ok) return fail(`result ${parsed.error.kind}: ${parsed.error.message}`);
      const result = parsed.value;
      if (ciLog === null) t.result = result;
      note(`result: ${result.outcome}`);

      const glob = storySpecGlob(config.story_spec_path, story.story_id);
      if (!glob.ok) return fail(`spec: ${glob.error.message}`);
      let matches: string[];
      try {
        matches = specMatches(glob.value, listWorkingTree(layout.clone));
      } catch (e) {
        return fail(`spec: cannot list the clone: ${message(e)}`);
      }
      if (matches.length !== 1) {
        return fail(`spec: ${matches.length} files match ${glob.value}${matches.length > 0 ? ` (${matches.join(", ")})` : ""}, expected exactly one`);
      }
      const specPath = matches[0] as string;
      let specText: string | null;
      try {
        specText = readRegular(join(layout.clone, specPath));
      } catch (e) {
        return fail(`spec: cannot read ${specPath}: ${message(e)}`);
      }
      if (specText === null) return fail(`spec: ${specPath} is not a regular file`);
      return { ok: true, result, specPath, specText };
    };

    /** The CI step's fix and conflict sessions: no spec status cross-check. */
    const ciSession: CiSession = async ({ start: at, logText }) => {
      const ran = await sessionAt(at, logText);
      if (!ran.ok) return err("session", ran.reason);
      return ok({ result: ran.result, specPath: ran.specPath });
    };

    /** The lockfile command under the agent's own launch spec, `argv` replaced and no stdin. */
    const regenerate: Regenerate = async ({ start: at, paths, command }) => {
      const setUpFailed = await setUp(at);
      if (setUpFailed !== null) return err("prepare", setUpFailed);
      const spec = agent.launchSpec({ kind: "fresh", prompt: "Regenerate the lockfiles." }, settings, layout.resultPath);
      if (!spec.ok) return err("launch-spec", spec.error.message);
      const s = spec.value;
      const launch: LaunchSpec = { argv: [...command], vendor: s.vendor, vendorHomeEnv: s.vendorHomeEnv, credential: s.credential, apiHosts: s.apiHosts };
      note(`lockfile command starts: ${command.join(" ")}`);
      let run: SandboxResult<SandboxRun>;
      try {
        run = await sandbox.run(launch, profile, budget, { onSpawn: (pid) => reportStore(store.writePid("agent", pid), "agent.pid") });
      } catch (e) {
        run = { ok: false as const, error: { kind: "refused" as const, message: `sandbox threw: ${message(e)}` } };
      } finally {
        reportStore(store.clearPid("agent"), "agent.pid");
      }
      if (!run.ok) return err("sandbox", `sandbox refused: ${run.error.message}`);
      logRun("lockfile command", run.value);
      if (budget.aborted) return err("budget", overBudget());
      if (run.value.exitCode !== 0) return err("exit", `the lockfile command exited ${run.value.exitCode ?? `on ${run.value.signal ?? "a signal"}`}`);
      const texts: Record<string, string> = {};
      for (const path of paths) {
        if (path === "" || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "." || p === "" || p === ".git")) {
          return err("invalid", `lockfile path ${JSON.stringify(path)} is not a plain repo path`);
        }
        let text: string | null;
        try {
          text = readRegular(join(layout.clone, path));
        } catch (e) {
          return err("read", `cannot read ${path}: ${message(e)}`);
        }
        if (text === null) return err("read", `${path} is not a regular file after the lockfile command`);
        texts[path] = text;
      }
      return ok(texts);
    };

    const ran = await sessionAt(start, null);
    if (!ran.ok) return failUnit(t, ran.reason);
    const { result, specPath } = ran;
    const checked = checkBuildSpec(result.outcome, ran.specText);
    if (!checked.ok) return failUnit(t, `${specPath}: ${checked.error.message}`);

    if (result.outcome !== "done") {
      const reason: ParkReason = result.outcome === "blocked" ? result.blocked.kind : "no-op";
      t.reason = result.outcome === "blocked" ? `blocked ${result.blocked.kind}: ${result.blocked.text}` : "no-op";
      const parked = await held(
        t,
        (now, gen) => park({ unit: story.unit, by: identity, now, generation: gen, kind: "blocked", reason }),
        "park",
      );
      return parked ? "progress" : "failed";
    }

    /** Records a step's output; the budget rule's `failed` when it released the unit, else `null`. */
    const settle = async (out: PrStepOutput, what: string): Promise<LaneOutcome | null> => {
      t.state = out.state;
      if (out.record !== undefined) t.record = out.record;
      if (out.reason !== undefined) addReason(t, out.reason);
      note(`${what}: ${out.outcome} (${out.state ?? "unknown"})`);
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

    const record = t.record;
    if (record === null) return failUnit(t, "no claimed record to hand to the PR step");
    let out: PrStepOutput;
    try {
      out = await deps.prStep({ unit: story, record, result, specPath, clone: layout.clone, signal: budget, log: note, kind: "build" });
    } catch (e) {
      return failUnit(t, `PR step threw: ${message(e)}`);
    }
    const prEnd = await settle(out, "PR step");
    if (prEnd !== null) return prEnd;

    const ciStep = deps.ciStep;
    const mergeStep = deps.mergeStep;
    /** The claimed record with a PR a step may take on, else `null`. */
    const claimedWithPr = (o: PrStepOutput): UnitRecord | null => {
      const r = t.record;
      return o.outcome === "progress" && o.state === "claimed" && r !== null && r.pr !== null ? r : null;
    };
    let last: PrStepOutput = out;
    for (;;) {
      const withPr = claimedWithPr(last);
      if (ciStep === undefined || withPr === null) return last.outcome;
      let ci: PrStepOutput;
      try {
        ci = await ciStep({
          unit: story,
          record: withPr,
          specPath,
          clone: layout.clone,
          signal: budget,
          log: note,
          scratchDir: join(layout.laneDir, "scratch"),
          prStep: deps.prStep,
          session: ciSession,
          regenerate,
        });
      } catch (e) {
        return failUnit(t, `CI step threw: ${message(e)}`);
      }
      const ciEnd = await settle(ci, "CI step");
      if (ciEnd !== null) return ciEnd;
      const passed = claimedWithPr(ci);
      if (mergeStep === undefined || passed === null) return ci.outcome;
      let merged: Awaited<ReturnType<MergeStep>>;
      try {
        merged = await mergeStep({ unit: story, record: passed, signal: budget, log: note });
      } catch (e) {
        return failUnit(t, `merge step threw: ${message(e)}`);
      }
      const mergeEnd = await settle(merged, "merge step");
      if (mergeEnd !== null) return mergeEnd;
      if (merged.ejected !== true) return merged.outcome;
      note("ejected from the merge queue: CI again on fresh main");
      last = merged;
    }
  };

  const body = async (): Promise<LaneOutcome> => {
    const pid = store.writePid("lane", deps.pid ?? process.pid);
    if (!pid.ok) throw new Halt("failed", `lane.pid: ${pid.error.message}`);

    for (let round = 1; round <= MAX_CLAIM_ROUNDS; round += 1) {
      unit = null;
      checkStop();
      const roundStart = clock();
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) throw new Halt("failed", `snapshot ${snapped.error.kind}: ${snapped.error.message}`);
      const snap = snapped.value;
      mainSha = snap.main.sha;
      seeNow(snap.now);
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
      await sweepMerged(assembled.value.ledger.units, snap.prs, snap.now);
      const config = assembled.value.config;
      const picked = next(assembled.value, "builder");
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
      const t: UnitTrack = {
        story,
        startedMs: roundStart,
        logName: logFileName(story.unit, roundStart),
        record: null,
        state: assembled.value.ledger.units.find((r) => r.unit === story.unit)?.state ?? null,
        sessions: 0,
        tokens: null,
        cost: null,
        uncosted: false,
        result: null,
        reason: null,
      };
      unit = t;
      note(`round ${round}: next picked ${story.unit} (${picked.kind}) at main ${snap.main.sha}`);
      checkStop();

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

      const branch = `${config.branches.story}${story.story_id}`;
      const listed = await call("listPrsByBranch", (o) => forge.listPrsByBranch(branch, o));
      if (!listed.ok) throw new Halt("failed", `listPrsByBranch ${listed.error.kind}: ${listed.error.message}`);
      const decided = decidePr(listed.value);
      const claimBase = {
        unit: story.unit,
        by: identity,
        now: snap.now,
        globs: story.globs,
        expectGeneration: story.expect_generation,
        manifestSha: story.infrastructure ? story.manifest_sha : null,
      };
      const edit =
        decided.kind === "open"
          ? claim({
              ...claimBase,
              adoptPr: { pr: decided.pr.number, pr_owner: identity.owner, head_sha: decided.pr.head_sha, base_sha: snap.main.sha },
            })
          : decided.kind === "merged"
            ? claim(claimBase)
            : claim({ ...claimBase, baseSha: snap.main.sha });
      const claimed = await swap(edit, story.unit);
      if (claimed.kind === "lost") {
        note(`claim lost: ${claimed.message}`);
        continue;
      }
      if (claimed.kind === "failed") throw new Halt("failed", `claim: ${claimed.message}`);
      t.record = claimed.record;
      t.state = claimed.record?.state ?? "claimed";
      note(`claimed at generation ${t.record?.generation ?? "unknown"}${decided.kind === "none" ? "" : ` (PR #${decided.pr.number} ${decided.kind})`}`);

      if (decided.kind === "merged") {
        t.reason = `PR #${decided.pr.number} merged`;
        const r = await swap(markMerged({ unit: story.unit, by: identity, now: await forgeNow() }), story.unit);
        if (r.kind !== "ok") throw new Halt("failed", `markMerged: ${r.message}`);
        if (r.record !== null) t.record = r.record;
        t.state = "merged";
        note("marked merged");
        return "progress";
      }
      const start = decided.kind === "open" ? decided.pr.head_sha : snap.main.sha;
      return await work(t, snap, config, start);
    }
    unit = null;
    throw new Halt("failed", `claim lost ${MAX_CLAIM_ROUNDS} rounds in a row`);
  };

  let outcome: LaneOutcome;
  try {
    outcome = await body();
  } catch (e) {
    if (e instanceof Halt) {
      outcome = e.outcome;
      if (unit !== null) addReason(unit as UnitTrack, e.reason);
    } else {
      outcome = "failed";
      const t = unit as UnitTrack | null;
      if (t !== null) {
        t.reason = `unexpected error: ${message(e)}`;
        if (t.state === "claimed") {
          try {
            await failUnit(t, t.reason);
          } catch (inner) {
            t.state = null;
            if (inner instanceof Halt) {
              outcome = inner.outcome;
              addReason(t, inner.reason);
            }
          }
        }
      }
    }
  }

  const t = unit as UnitTrack | null;
  if (t !== null) {
    note(`outcome ${outcome}`);
    journalUnit({
      unit: t.story.unit,
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
    });
  }
  reportStore(store.writeOutcome(outcome), "outcome");
  return { outcome };
}
