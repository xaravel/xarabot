import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAgent } from "../adapters/agent/claude/claude-agent.ts";
import type { CredentialEnv } from "../adapters/forge/github/credentials.ts";
import { openRunnerGit } from "../adapters/forge/github/runner-git.ts";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { afterFailedStart, builderLimit, builderRefusal, parseFailedStarts, parseRunnerFile, runnerFileText, unattendedRefusal } from "../core/lane/runner.ts";
import { botIdentity } from "../core/bot-identity.ts";
import type { Result } from "../core/result.ts";
import type { CoordinatorRecord } from "../core/schemas/ledger.ts";
import type { Agent } from "../ports/agent.ts";
import type { Forge, ForgeSnapshot } from "../ports/forge.ts";
import { createCiStep } from "../lane/ci-step.ts";
import { claimCoordinatorRecord, runCoordinatorProcess, type CoordinatorDeps } from "../lane/coordinator-process.ts";
import { createGitCommitter } from "../lane/committer.ts";
import { createGitDiffPaths } from "../lane/diff-paths.ts";
import { createGitGraphTrees } from "../lane/graph-trees.ts";
import { readsPath, runLaneProcess, type LaneDeps, type LaneProcessResult } from "../lane/lane-process.ts";
import { createFsLaneStore, laneLayout } from "../lane/lane-store.ts";
import { createMergeStep } from "../lane/merge-step.ts";
import { createGitMerger } from "../lane/merger.ts";
import { createPlanningStep } from "../lane/planning-step.ts";
import { createRetroItemStep } from "../lane/retro-item-step.ts";
import { createRetroStep } from "../lane/retro-step.ts";
import { createGitTreeFiles } from "../lane/tree-files.ts";
import { createPrStep } from "../lane/pr-step.ts";
import { createGitReconcileCommitter } from "../lane/reconcile-commit.ts";
import { createReconcileStep } from "../lane/reconcile-step.ts";
import { installRunner as defaultInstallRunner, type InstallRunner } from "../lane/runner-install.ts";
import { writeStop } from "../lane/stop.ts";
import { createSleepWaiter } from "../lane/wait.ts";
import { createGitWorkspace } from "../lane/workspace.ts";
import { createMacSandbox } from "../sandbox/macos.ts";
import { cliVersion as defaultCliVersion } from "../sandbox/tools.ts";
import { credentialPath, readCredential } from "../sandbox/vendor-home.ts";
import { FAILED_STARTS_FILE, findLane, hostPaths, RUNNER_FILE } from "./host-paths.ts";
import { COORDINATOR_LANE, DEFAULT_CALL_TIMEOUT_MS, ensureRunner, INSTALL_TIMEOUT_MS, pinnedConfig, writeFileAtomic } from "./lane-install.ts";
import { githubConnect, type Connect } from "./lane-connection.ts";

/**
 * `xarabot lane run <owner>/<name> <lane>` (FR1, NFR15, AR22, AR26, AR34):
 * what the launcher runs, from the pinned runner. It checks STOP, then that
 * `main` still pins the running version (installing the new one and exiting
 * when not), then the refusal table; only then does it compose the real
 * adapters and run one `runLaneProcess`. A coordinator lane skips the
 * builder limit, and its last start check claims `coordinator.json`
 * (AD-8); it then runs one `runCoordinatorProcess`. Every refusal or failure
 * after the STOP check, apart from a version switch and the role and
 * lane-name check (a static `host.yaml` error), is a failed start, and so is
 * a run that ends in a lane stop (outcome `stop` for any reason but a STOP
 * marker, exit 1): three in a row write the lane's `STOP` and post an alert.
 * The count is reset only after a run that ends without a lane stop, so a
 * start check that heals between lane stops does not reset it. The PR step
 * redacts the vendor credential read at start from the text it sends to the
 * forge, and so do the coordinator's planning, retro and retro-item steps
 * (Stories 2.7, 2.9 and 2.10).
 */

export const LANE_RUN_USAGE = "xarabot lane run <owner>/<name> <lane>";

/** The alert three failed starts in a row post. */
export const LANE_START_FAILED = "lane-start-failed";

const ZERO_SHA = "0".repeat(40);

/** A start check's placeholder prompt: the launch spec is read for its credential file, never run. */
const PROBE_PROMPT = "start check";

export type LaneRunDeps = {
  readonly env: CredentialEnv;
  /** Default GitHub with the owner's App credentials. */
  readonly connect?: Connect;
  readonly installRunner?: InstallRunner;
  /** The agent CLI's `--version` probe; default `cliVersion`. */
  readonly cliVersion?: (cmd: string, env: CredentialEnv) => Promise<Result<string, "refused">>;
  /** Runs the composed builder lane; default `runLaneProcess`. */
  readonly start?: (deps: LaneDeps) => Promise<LaneProcessResult>;
  /** Runs the composed coordinator lane; default `runCoordinatorProcess`. */
  readonly startCoordinator?: (deps: CoordinatorDeps) => Promise<LaneProcessResult>;
  readonly callTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
};

/** The adapter for an agent name; only `claude` has one before Epic 6. */
function adapterFor(agent: string): Agent | null {
  return agent === "claude" ? createClaudeAgent() : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Runs `xarabot lane run`; `args` follow `lane run`. Returns the exit code. */
export async function laneRun(args: readonly string[], deps: LaneRunDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const errOut = deps.errOut ?? ((l: string) => console.error(l));
  const say = (text: string): void => errOut(`xarabot lane run: ${text}`);
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const deadline = () => ({ signal: AbortSignal.timeout(callTimeoutMs) });

  // 1. The lane.
  if (args.length !== 2) {
    say(`usage: ${LANE_RUN_USAGE}`);
    return 1;
  }
  const [repo, name] = args as [string, string];
  const paths = hostPaths(deps.env);
  if (paths === null) {
    say("HOME is not set");
    return 1;
  }
  const found = findLane(paths, name);
  if (!found.ok) {
    say(found.message);
    return 1;
  }
  const { lane, laneDir, host } = found;
  if (lane.repo !== repo) {
    say(`lane ${name} is for ${lane.repo}, not ${repo}`);
    return 1;
  }
  const hostId = found.hostId;
  if (hostId === undefined) {
    say(`${paths.hostYaml} has no host_id; run xarabot lane install again`);
    return 1;
  }
  const layout = laneLayout(laneDir);

  // 2. STOP: exit 0, nothing counted.
  if (existsSync(paths.hostStop) || existsSync(layout.stop)) {
    out(`${existsSync(paths.hostStop) ? paths.hostStop : layout.stop} present; not starting lane ${name}`);
    return 0;
  }

  let alertForge: Forge | null = null;
  let mainSha: string | null = null;
  const failedPath = join(laneDir, FAILED_STARTS_FILE);

  /** A run that ended without a lane stop ends the run of failed starts. */
  const resetFailedStarts = (): void => {
    try {
      mkdirSync(laneDir, { recursive: true, mode: 0o700 });
      writeFileSync(failedPath, "0\n");
    } catch (e) {
      say(`${failedPath}: ${message(e)}`);
    }
  };

  /** The run's exit: a lane stop is a failed start (exit 1); any other end resets the count (exit 0). */
  const afterRun = async (result: LaneProcessResult): Promise<number> => {
    out(`lane ${name}: ${result.outcome}`);
    if (result.laneStop !== undefined) return failedStart(result.laneStop, "run ended in a lane stop");
    resetFailedStarts();
    return 0;
  };

  /**
   * One failed start: count it, and at the third in a row write STOP and alert.
   * `what` heads the message: a refused start, or a run that ended in a lane stop.
   */
  const failedStart = async (reason: string, what = "start refused"): Promise<number> => {
    say(`${what}: ${reason}`);
    const count = parseFailedStarts(readText(failedPath) ?? "");
    const next = afterFailedStart(count);
    try {
      mkdirSync(laneDir, { recursive: true, mode: 0o700 });
      writeFileSync(failedPath, `${next.count}\n`);
    } catch (e) {
      say(`${failedPath}: ${message(e)}`);
    }
    if (!next.stop) return 1;
    // STOP takes over; once the Maintainer removes it, counting starts again from 0.
    try {
      writeFileSync(failedPath, "0\n");
    } catch (e) {
      say(`${failedPath}: ${message(e)}`);
    }
    const stop = writeStop(layout.stop);
    if (stop.ok) say(`${next.count} failed starts in a row: wrote ${layout.stop}`);
    else say(`${next.count} failed starts in a row, but STOP: ${stop.error.message}`);
    if (alertForge === null) {
      say(`cannot post the ${LANE_START_FAILED} alert: no forge and maintainer known`);
      return 1;
    }
    try {
      const posted = await alertForge.alert(LANE_START_FAILED, mainSha ?? ZERO_SHA, deadline());
      if (!posted.ok) say(`${LANE_START_FAILED} alert: ${posted.error.kind}: ${posted.error.message}`);
    } catch (e) {
      say(`${LANE_START_FAILED} alert: ${message(e)}`);
    }
    return 1;
  };

  // The coordinator's identity is `<owner>/<host>/coordinator` (AD-8): a host.yaml from before Story 2.4, or edited by hand, may break that.
  // Like the other static host.yaml errors, it is not a failed start: no count, no STOP, no alert.
  if ((lane.role === "coordinator") !== (name === COORDINATOR_LANE)) {
    say(`lane ${name} has role ${lane.role}: a coordinator lane must be named ${COORDINATOR_LANE}, and only a coordinator lane may have that name`);
    return 1;
  }

  // 3. Credentials, the snapshot and config.yaml.
  const connected = await (deps.connect ?? githubConnect(deps.env))(lane);
  if (!connected.ok) return failedStart(connected.message);
  const connection = connected.connection;
  const snapped = await connection.forge({}).snapshot({ ...deadline(), read: readsPath });
  if (!snapped.ok) {
    if (snapped.error.kind === "uninstalled") return failedStart(`the App installation does not cover ${lane.repo}`);
    return failedStart(`snapshot: ${snapped.error.kind}: ${snapped.error.message}`);
  }
  const snap: ForgeSnapshot = snapped.value;
  mainSha = snap.main.sha;
  const config = pinnedConfig(snap);
  if (!config.ok) return failedStart(config.error.message);
  const maintainer = config.value.maintainer;
  alertForge = connection.forge({ maintainer });
  const pinned = config.value.runner_version;

  // 4. The runner version.
  const runnerPath = join(laneDir, RUNNER_FILE);
  const runnerText = readText(runnerPath);
  const running = runnerText === null ? null : parseRunnerFile(runnerText);
  if (running === null || !running.ok || running.value !== pinned) {
    const was = running === null ? "none" : running.ok ? running.value : "unreadable";
    const installed = await ensureRunner({
      paths,
      version: pinned,
      connection,
      install: deps.installRunner ?? defaultInstallRunner,
      timeoutMs: deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      callTimeoutMs,
    });
    if (!installed.ok) return failedStart(installed.error.message);
    const w = writeFileAtomic(runnerPath, runnerFileText(pinned), 0o600);
    if (!w.ok) return failedStart(w.error.message);
    out(`main pins runner ${pinned} (was ${was}): ${installed.value.installed ? "installed it" : "already installed"}, wrote ${runnerPath}; exiting without a claim`);
    return 0;
  }

  // 5. The repo config and the refusals.
  const repoConfig = loadRepoConfig({ repo: lane.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
  if (!repoConfig.ok) return failedStart(`repo config ${repoConfig.error.kind}: ${repoConfig.error.message}`);
  const unattended = unattendedRefusal(repoConfig.value.repo.policy, lane.agent);
  if (!unattended.ok) return failedStart(unattended.error.message);
  const agent = adapterFor(lane.agent);
  if (agent === null) return failedStart(`no adapter for agent ${lane.agent} (only claude has one)`);
  const settings = { ...(lane.model !== undefined ? { model: lane.model } : {}), effort: lane.effort };
  const spec = agent.launchSpec({ kind: "fresh", prompt: PROBE_PROMPT }, settings, layout.resultPath);
  if (!spec.ok) return failedStart(spec.error.message);
  const command = spec.value.argv[0] ?? "";
  const version = await (deps.cliVersion ?? defaultCliVersion)(command, deps.env);
  if (!version.ok) return failedStart(version.error.message);
  const checked = agent.startCheck(settings, version.value);
  if (!checked.ok) return failedStart(checked.error.message);
  const credPath = credentialPath(deps.env, spec.value.vendor, spec.value.credential.file);
  if (!credPath.ok) return failedStart(credPath.error.message);
  const credential = readCredential(credPath.value);
  if (!credential.ok) return failedStart(credential.error.message);
  const limit = builderLimit(deps.env["XARABOT_MAX_BUILDERS"]);
  if (!limit.ok) return failedStart(limit.error.message);
  const coordinator = lane.role === "coordinator";
  if (!coordinator) {
    const builders = builderRefusal(host, name, limit.value);
    if (!builders.ok) return failedStart(builders.error.message);
  }

  // 6. Every check passed: compose the real dependencies and run one unit.
  const gitDir = await openRunnerGit(laneDir, deadline());
  if (!gitDir.ok) return failedStart(`runner.git: ${gitDir.error.message}`);
  const botId = await connection.botUserId(AbortSignal.timeout(callTimeoutMs));
  if (!botId.ok) return failedStart(`bot user id: ${botId.error.kind}: ${botId.error.message}`);
  const bot = botIdentity(lane.owner, botId.value);
  if (!bot.ok) return failedStart(bot.error.message);

  const runnerGit = gitDir.value;
  const forge = connection.forge({ runnerGit, maintainer });
  const identity = { owner: lane.owner, host: hostId, lane: name };

  // A coordinator's last start check: the claim on coordinator.json (AD-8).
  let claimed: CoordinatorRecord | null = null;
  if (coordinator) {
    const c = await claimCoordinatorRecord({ forge, identity, now: snap.now, callTimeoutMs });
    if (!c.ok) return failedStart(c.error.message);
    claimed = c.value;
  }

  const store = createFsLaneStore({ laneDir, hostStop: paths.hostStop });
  const fetch = connection.fetchShas(runnerGit);
  const graphTrees = createGitGraphTrees({ gitDir: runnerGit, fetch });
  if (claimed !== null) {
    // Story 2.5 wires the reconcile step, Story 2.7 the planning step, Story 2.9 the retro step and Story 2.10 the retro-item step.
    const waiter = createSleepWaiter({ store });
    const reconcile = createReconcileStep({ forge, committer: createGitReconcileCommitter({ gitDir: runnerGit, bot: bot.value, fetch }), graphTrees, identity, repo: lane.repo });
    const planning = createPlanningStep({
      forge,
      agent,
      sandbox: createMacSandbox({ launchingEnv: deps.env }),
      store,
      workspace: createGitWorkspace({ gitDir: runnerGit, clone: layout.clone, fetch }),
      waiter,
      laneDir,
      lane,
      committer: createGitCommitter({ gitDir: runnerGit, clone: layout.clone, bot: bot.value, fetch }),
      diffPaths: createGitDiffPaths({ gitDir: runnerGit, fetch }),
      graphTrees,
      identity,
      secrets: [credential.value],
    });
    const retro = createRetroStep({
      forge,
      agent,
      sandbox: createMacSandbox({ launchingEnv: deps.env }),
      store,
      workspace: createGitWorkspace({ gitDir: runnerGit, clone: layout.clone, fetch }),
      waiter,
      laneDir,
      lane,
      committer: createGitCommitter({ gitDir: runnerGit, clone: layout.clone, bot: bot.value, fetch }),
      diffPaths: createGitDiffPaths({ gitDir: runnerGit, fetch }),
      treeFiles: createGitTreeFiles({ gitDir: runnerGit, fetch }),
      identity,
      secrets: [credential.value],
    });
    const retroItem = createRetroItemStep({
      forge,
      agent,
      sandbox: createMacSandbox({ launchingEnv: deps.env }),
      store,
      workspace: createGitWorkspace({ gitDir: runnerGit, clone: layout.clone, fetch }),
      waiter,
      laneDir,
      lane,
      committer: createGitCommitter({ gitDir: runnerGit, clone: layout.clone, bot: bot.value, fetch }),
      merger: createGitMerger({ gitDir: runnerGit, bot: bot.value, fetch }),
      diffPaths: createGitDiffPaths({ gitDir: runnerGit, fetch }),
      graphTrees,
      identity,
      secrets: [credential.value],
    });
    const coordinatorDeps: CoordinatorDeps = {
      forge,
      agent,
      store,
      laneDir,
      identity,
      lane,
      claim: claimed,
      steps: { reconcile, planning, retro, "retro-item": retroItem },
      waiter,
    };
    return afterRun(await (deps.startCoordinator ?? runCoordinatorProcess)(coordinatorDeps));
  }

  const laneDeps: LaneDeps = {
    forge,
    agent,
    sandbox: createMacSandbox({ launchingEnv: deps.env }),
    store,
    workspace: createGitWorkspace({ gitDir: runnerGit, clone: layout.clone, fetch }),
    prStep: createPrStep({
      forge,
      committer: createGitCommitter({ gitDir: runnerGit, clone: layout.clone, bot: bot.value, fetch }),
      identity,
      repo: lane.repo,
      secrets: [credential.value],
    }),
    ciStep: createCiStep({ forge, merger: createGitMerger({ gitDir: runnerGit, bot: bot.value, fetch }), identity, repo: lane.repo }),
    mergeStep: createMergeStep({ forge, diffPaths: createGitDiffPaths({ gitDir: runnerGit, fetch }), graphTrees, identity, repo: lane.repo }),
    laneDir,
    identity,
    lane,
    waiter: createSleepWaiter({ store }),
  };
  return afterRun(await (deps.start ?? runLaneProcess)(laneDeps));
}
