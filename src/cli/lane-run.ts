import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createClaudeAgent } from "../adapters/agent/claude/claude-agent.ts";
import { codexCredentialKind, createCodexAgent } from "../adapters/agent/codex/codex-agent.ts";
import type { CredentialEnv } from "../adapters/forge/github/credentials.ts";
import { openRunnerGit } from "../adapters/forge/github/runner-git.ts";
import { loadRepoConfig, POLICY_PATH } from "../core/config/load-repo-config.ts";
import { describeStale, LANE_LOCK_FILE } from "../core/lane/lane-lock.ts";
import { afterFailedStart, builderLimit, builderRefusal, parseFailedStarts, parseRunnerFile, runnerFileText, unattendedRefusal } from "../core/lane/runner.ts";
import { botIdentity } from "../core/bot-identity.ts";
import { err, ok, type Result } from "../core/result.ts";
import { chooseReviewer, sessionProvider } from "../core/review/reviewer.ts";
import type { CoordinatorRecord } from "../core/schemas/ledger.ts";
import type { Agent } from "../ports/agent.ts";
import type { Forge, ForgeSnapshot } from "../ports/forge.ts";
import { createCiStep } from "../lane/ci-step.ts";
import { claimCoordinatorRecord, runCoordinatorProcess, type CoordinatorDeps, type SessionStepDeps } from "../lane/coordinator-process.ts";
import { createGitCommitter } from "../lane/committer.ts";
import { createGitDiffPaths } from "../lane/diff-paths.ts";
import { createGitGraphTrees } from "../lane/graph-trees.ts";
import { readsPath, runLaneProcess, type LaneDeps, type LaneProcessResult } from "../lane/lane-process.ts";
import { acquireLaneLock } from "../lane/lane-lock.ts";
import { createFsLaneStore, laneLayout } from "../lane/lane-store.ts";
import { createMergeStep } from "../lane/merge-step.ts";
import { createGitMerger } from "../lane/merger.ts";
import { createPlanningStep } from "../lane/planning-step.ts";
import { createRetroItemStep } from "../lane/retro-item-step.ts";
import { createRetroStep } from "../lane/retro-step.ts";
import { createGitTreeFiles } from "../lane/tree-files.ts";
import { createPrStep } from "../lane/pr-step.ts";
import { createPsProcessTable, type ProcessTable } from "../lane/processes.ts";
import { createGitReconcileCommitter } from "../lane/reconcile-commit.ts";
import { createReconcileStep } from "../lane/reconcile-step.ts";
import { installRunner as defaultInstallRunner, type InstallRunner } from "../lane/runner-install.ts";
import { message } from "../lane/session.ts";
import { writeStop } from "../lane/stop.ts";
import { createSleepWaiter } from "../lane/wait.ts";
import { createGitWorkspace } from "../lane/workspace.ts";
import { createMacSandbox } from "../sandbox/macos.ts";
import { cliVersion as defaultCliVersion } from "../sandbox/tools.ts";
import { credentialPath, readCredential } from "../sandbox/vendor-home.ts";
import { FAILED_STARTS_FILE, findLane, hostPaths, RUNNER_FILE } from "./host-paths.ts";
import { COORDINATOR_LANE, DEFAULT_CALL_TIMEOUT_MS, ensureRunner, INSTALL_TIMEOUT_MS, pinnedConfig, writeFileAtomic } from "./lane-install.ts";
import { githubConnect, type Connect } from "./lane-connection.ts";
import { piAgentRefusal, piReviewerRefusal, type SessionAdapter } from "./pi-deferral.ts";

/**
 * `xarabot lane run <owner>/<name> <lane>` (FR1, NFR15, AR22, AR26, AR34):
 * what the launcher runs, from the pinned runner. It checks STOP and the
 * lane's role and name, then takes the lane's exclusive `lane.lock` (AR3)
 * for the rest of the run, released on every exit: a lock a live process
 * holds means the lane is already running, so this process exits 0 with no
 * connect, no claim and no failed start, and a stale one (its process gone,
 * its PID reused or running another command, or its text unreadable) is
 * taken over. Then it checks that `main` still pins the running version
 * (installing the new one and exiting when not), then the refusal table;
 * only then does it compose the real adapters and run one `runLaneProcess`.
 * A coordinator lane skips the builder limit, and its last start check
 * claims `coordinator.json` (AD-8); it then runs one `runCoordinatorProcess`.
 * After the lane's own credential, the start checks pick the lane's reviewer
 * for a unit only its own vendor built (`chooseReviewer`, AD-16) and, when
 * that is another adapter, read its credential too (AD-17): a missing or
 * unreadable one refuses the start.
 * Every refusal or failure after the STOP check, apart from a version
 * switch, a held lock and the role and lane-name check (a static `host.yaml`
 * error), is a failed start (an I/O error on the lock included), and so is
 * a run that ends in a lane stop (outcome `stop` for any reason but a STOP
 * marker, exit 1): three in a row write the lane's `STOP` and post an alert.
 * The count is reset only after a run that ends without a lane stop, so a
 * start check that heals between lane stops does not reset it. The PR step
 * redacts the vendor credentials read at start (the lane's and its
 * reviewer's) from the text it sends to the forge, and so do the
 * coordinator's planning, retro and retro-item steps (Stories 2.7, 2.9 and
 * 2.10). Each of those steps gets the lane's session vendor, which it adds
 * to a unit's `builder_providers` before pushing an agent-made commit.
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
  /** The lane lock's owner and process table; default this process, its runtime's basename and start, and `ps`. */
  readonly lock?: {
    readonly pid?: number;
    readonly command?: string;
    readonly startedMs?: number;
    readonly table?: ProcessTable;
  };
};

/** True when anything, even a broken symlink, is at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The adapter for a session agent: `claude`, or `codex` with the credential
 * kind its one credential file names (both files, or neither, refuse).
 * `pi` is not a `SessionAdapter`: its adapter is deferred to v1 (Story 3.2).
 */
export function adapterFor(agent: SessionAdapter, env: CredentialEnv): Result<Agent, "refused"> {
  if (agent === "claude") return ok(createClaudeAgent());
  if (agent === "codex") {
    const dir = credentialPath(env, "codex", "auth.json");
    if (!dir.ok) return err("refused", dir.error.message);
    const folder = dirname(dir.value);
    const kind = codexCredentialKind((file) => present(join(folder, file)), folder);
    return kind.ok ? ok(createCodexAgent({ credential: kind.value })) : kind;
  }
  const unknown: never = agent;
  return err("refused", `no adapter for agent ${String(unknown)}`);
}

/**
 * The exact strings the forge-bound text redaction takes for a credential:
 * the file's text and, for a JSON file such as codex's `auth.json`, every
 * string value in it of 16 characters or more (its tokens).
 */
export function credentialSecrets(text: string): string[] {
  const out = [text];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.trim().length >= 16) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v !== null && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(parsed);
  return out;
}

/**
 * A reviewer adapter's credential text (AD-17): the adapter built for it,
 * the credential file its probe launch spec names (default model, effort
 * `high`), then that file read. Any failure refuses.
 */
export function readReviewerCredential(reviewer: SessionAdapter, env: CredentialEnv, resultPath: string): Result<string, "refused"> {
  const adapter = adapterFor(reviewer, env);
  if (!adapter.ok) return adapter;
  const spec = adapter.value.launchSpec({ kind: "fresh", prompt: PROBE_PROMPT }, { effort: "high" }, resultPath);
  if (!spec.ok) return err("refused", spec.error.message);
  const path = credentialPath(env, spec.value.vendor, spec.value.credential.file);
  if (!path.ok) return err("refused", path.error.message);
  const text = readCredential(path.value);
  return text.ok ? ok(text.value) : err("refused", text.error.message);
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

  // The lane's process lock (AR3): a second process of the same lane exits 0 with no claim, and nothing is counted.
  const lockDeps = deps.lock ?? {};
  const locked = acquireLaneLock({
    laneDir,
    pid: lockDeps.pid ?? process.pid,
    command: lockDeps.command ?? basename(process.execPath),
    startedMs: lockDeps.startedMs ?? performance.timeOrigin,
    table: lockDeps.table ?? createPsProcessTable(),
  });
  if (!locked.ok) return failedStart(`the lane lock: ${locked.error.message}`);
  if (locked.value.kind === "held") {
    out(`lane ${name} is already running (pid ${locked.value.pid ?? "unknown"}, ${LANE_LOCK_FILE}); exiting without a claim`);
    return 0;
  }
  const lock = locked.value;
  if (lock.tookOver !== null) {
    out(`took over a stale ${LANE_LOCK_FILE} (pid ${lock.tookOver.pid ?? "unknown"}): ${describeStale(lock.tookOver.reason)}`);
  }

  /** Steps 3 to 6, run while the lock is held. */
  const run = async (): Promise<number> => {
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
    // `pi` first, then a policy with no reviewer but `pi`, then the agent's own allowance (Story 3.2).
    const sessionAgent = piAgentRefusal(lane.agent);
    if (!sessionAgent.ok) return failedStart(sessionAgent.error.message);
    const reviewer = piReviewerRefusal(repoConfig.value.repo.policy);
    if (!reviewer.ok) return failedStart(reviewer.error.message);
    const unattended = unattendedRefusal(repoConfig.value.repo.policy, sessionAgent.value);
    if (!unattended.ok) return failedStart(unattended.error.message);
    const adapter = adapterFor(sessionAgent.value, deps.env);
    if (!adapter.ok) return failedStart(adapter.error.message);
    const agent = adapter.value;
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
    // The lane's reviewer for a unit only its own vendor built (AD-16), and that reviewer's credential (AD-17).
    const provider = sessionProvider({ adapter: sessionAgent.value, model: lane.model ?? agent.defaultModel });
    const choice = chooseReviewer([provider], repoConfig.value.repo.policy.unattended_adapters);
    if (choice === null) return failedStart(`no reviewer: ${POLICY_PATH} unattended_adapters allows neither claude nor codex`);
    const reviewerCredential = choice.adapter === sessionAgent.value ? ok(null) : readReviewerCredential(choice.adapter, deps.env, layout.resultPath);
    if (!reviewerCredential.ok) return failedStart(`reviewer ${choice.adapter}: ${reviewerCredential.error.message}`);
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

    // The adapters both lane roles use, built once.
    const store = createFsLaneStore({ laneDir, hostStop: paths.hostStop });
    const fetch = connection.fetchShas(runnerGit);
    const waiter = createSleepWaiter({ store });
    const sandbox = createMacSandbox({ launchingEnv: deps.env });
    const workspace = createGitWorkspace({ gitDir: runnerGit, clone: layout.clone, fetch });
    const committer = createGitCommitter({ gitDir: runnerGit, clone: layout.clone, bot: bot.value, fetch });
    const merger = createGitMerger({ gitDir: runnerGit, bot: bot.value, fetch });
    const diffPaths = createGitDiffPaths({ gitDir: runnerGit, fetch });
    const graphTrees = createGitGraphTrees({ gitDir: runnerGit, fetch });
    const secrets = [...credentialSecrets(credential.value), ...(reviewerCredential.value === null ? [] : credentialSecrets(reviewerCredential.value))];
    if (claimed !== null) {
      // Story 2.5 wires the reconcile step, Story 2.7 the planning step, Story 2.9 the retro step and Story 2.10 the retro-item step.
      const session: SessionStepDeps = { forge, agent, sandbox, store, workspace, waiter, laneDir, lane, committer, diffPaths, identity, provider, secrets };
      const reconcile = createReconcileStep({ forge, committer: createGitReconcileCommitter({ gitDir: runnerGit, bot: bot.value, fetch }), graphTrees, identity, repo: lane.repo });
      const planning = createPlanningStep({ ...session, graphTrees });
      const retro = createRetroStep({ ...session, treeFiles: createGitTreeFiles({ gitDir: runnerGit, fetch }) });
      const retroItem = createRetroItemStep({ ...session, merger, graphTrees });
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
      sandbox,
      store,
      workspace,
      prStep: createPrStep({ forge, committer, identity, repo: lane.repo, provider, secrets }),
      ciStep: createCiStep({ forge, merger, identity, repo: lane.repo }),
      mergeStep: createMergeStep({ forge, diffPaths, graphTrees, identity, repo: lane.repo }),
      laneDir,
      identity,
      lane,
      waiter,
    };
    return afterRun(await (deps.start ?? runLaneProcess)(laneDeps));
  };

  try {
    return await run();
  } finally {
    const released = lock.release();
    if (!released.ok) say(`${LANE_LOCK_FILE}: ${released.error.message}`);
  }
}
