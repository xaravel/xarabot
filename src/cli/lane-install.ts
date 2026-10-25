import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_COMMAND } from "../adapters/agent/claude/claude-agent.ts";
import { CODEX_COMMAND } from "../adapters/agent/codex/codex-agent.ts";
import type { CredentialEnv } from "../adapters/forge/github/credentials.ts";
import { openRunnerGit } from "../adapters/forge/github/runner-git.ts";
import { CONFIG_PATH } from "../core/config/load-repo-config.ts";
import { laneLabel, plistEnv, renderLauncher, renderPlist, shQuote } from "../core/lane/launchd.ts";
import { builderLimit, builderRefusal, checkRunnerVersion, runnerFileText } from "../core/lane/runner.ts";
import { err, ok, type Result } from "../core/result.ts";
import { describeIssues, parseVersionedYaml } from "../core/schemas/common.ts";
import { ConfigSchema, type Config } from "../core/schemas/config.ts";
import { HostConfigSchema, LaneSchema, type HostConfig, type Lane } from "../core/schemas/host.ts";
import type { AdapterName } from "../core/schemas/policy.ts";
import type { ForgeSnapshot } from "../ports/forge.ts";
import { installRunner as defaultInstallRunner, type InstallRunner } from "../lane/runner-install.ts";
import { hostPaths, laneDirFor, readHostConfig, RUNNER_FILE, type HostPaths } from "./host-paths.ts";
import { githubConnect, RUNNER_REPO_URL, type Connect, type LaneConnection } from "./lane-connection.ts";

/**
 * `xarabot lane install <lane> --repo <o/n> --role <r> --owner <login>
 * --agent <a> [--model <m>] [--effort <e>]` (FR1, NFR15, AR26, AR34, AR35).
 * It checks the lane: a coordinator is named `coordinator`, a builder
 * `builder-<n>` (n >= 1), and the lane's own agent CLI (`claude` or `codex`),
 * `bun`, `git` and `uv` each resolve on the `PATH` the plist will carry. It refuses a name `host.yaml` already
 * holds for another repo (the same name and repo is replaced) and a lane that
 * would take the host over `XARABOT_MAX_BUILDERS`. It then reads
 * `runner_version` from `main` and installs that runner first; only then
 * does it write `host.yaml`, the lane folder, its
 * `runner` file, the fixed launcher and the lane's LaunchDaemon plist. It
 * never runs `sudo` or `launchctl`: it prints the two commands for the
 * Maintainer.
 */

export const LANE_INSTALL_USAGE =
  "xarabot lane install <lane> --repo <owner>/<name> --role <builder|coordinator> --owner <login> --agent <agent> [--model <model>] [--effort <effort>]";

/** A `host.yaml` lane name. */
export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The one name a coordinator lane has, and only it. */
export const COORDINATOR_LANE = "coordinator";

/** A builder lane's name, as the ledger's lane-name rule takes it: `builder-<n>`, n >= 1. */
export const BUILDER_LANE = /^builder-[1-9][0-9]*$/;

/** The tools every lane runs besides its agent CLI. */
export const LANE_HELPER_TOOLS: readonly string[] = ["bun", "git", "uv"];

/** Each agent's CLI command. */
export const AGENT_COMMANDS: Readonly<Record<AdapterName, string>> = { claude: CLAUDE_COMMAND, codex: CODEX_COMMAND, pi: "pi" };

/** The tools a lane of `agent` runs, each of which must resolve on the `PATH` its plist carries: its own agent CLI first. */
export function laneTools(agent: AdapterName): readonly string[] {
  return [AGENT_COMMANDS[agent], ...LANE_HELPER_TOOLS];
}

/**
 * `null` when every one of `tools` (`laneTools`) resolves on `path` (the
 * plist's `PATH`); else the refusal, naming each missing tool and the `PATH`.
 */
export function missingTools(
  path: string | undefined,
  tools: readonly string[],
  which: (tool: string, path: string) => string | null = (t, p) => Bun.which(t, { PATH: p }),
): string | null {
  const list = (names: readonly string[]) => (names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`);
  if (path === undefined || path === "") return `PATH is not set, so the lane's plist gets none: ${list(tools)} must each resolve on it`;
  const missing = tools.filter((t) => which(t, path) === null);
  if (missing.length === 0) return null;
  return `${list(missing)} ${missing.length === 1 ? "does" : "do"} not resolve on the PATH the lane's plist gets: ${path}`;
}

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** The runner install's deadline: a shallow fetch and `bun install`. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type LaneInstallDeps = {
  readonly env: CredentialEnv;
  /** Default GitHub with the owner's App credentials. */
  readonly connect?: Connect;
  readonly installRunner?: InstallRunner;
  /** The `bun` the launcher runs; default `process.execPath`. */
  readonly bun?: string;
  /** The user launchd runs the lane as; default the current user. */
  readonly user?: string;
  /** A new `host_id`; default `crypto.randomUUID`. */
  readonly newHostId?: () => string;
  readonly callTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
};

const FLAGS = ["--repo", "--role", "--owner", "--agent", "--model", "--effort"] as const;
type Flag = (typeof FLAGS)[number];
const REQUIRED: readonly Flag[] = ["--repo", "--role", "--owner", "--agent"];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The lane name and its flags; `null` on any usage error. */
export function parseInstallArgs(args: readonly string[]): { readonly name: string; readonly flags: Partial<Record<Flag, string>> } | null {
  let name: string | undefined;
  const flags: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const flag = FLAGS.find((f) => f === a);
      const value = args[i + 1];
      if (flag === undefined || value === undefined || value.startsWith("--") || flags[flag] !== undefined) return null;
      flags[flag] = value;
      i += 1;
    } else {
      if (name !== undefined) return null;
      name = a;
    }
  }
  if (name === undefined || REQUIRED.some((f) => flags[f] === undefined)) return null;
  return { name, flags };
}

/** `main`'s `.xarabot/config.yaml` from a snapshot, parsed, with its `runner_version` checked. */
export function pinnedConfig(snap: ForgeSnapshot): Result<Config> {
  const text = Object.hasOwn(snap.main.files, CONFIG_PATH) ? snap.main.files[CONFIG_PATH] : undefined;
  if (typeof text !== "string") return err("missing", `${CONFIG_PATH}: missing on main`);
  const config = parseVersionedYaml(CONFIG_PATH, text, ConfigSchema);
  if (!config.ok) return config;
  const version = checkRunnerVersion(config.value.runner_version);
  if (!version.ok) return err("invalid", `${CONFIG_PATH}: runner_version: ${version.error.message}`);
  return config;
}

/**
 * Installs runner `version` unless it is already there, minting a token only
 * when it must fetch.
 */
export async function ensureRunner(p: {
  readonly paths: HostPaths;
  readonly version: string;
  readonly connection: LaneConnection;
  readonly install: InstallRunner;
  readonly timeoutMs: number;
  readonly callTimeoutMs: number;
}): Promise<Result<{ readonly installed: boolean }>> {
  if (existsSync(join(p.paths.runnerRoot, p.version))) return ok({ installed: false });
  const token = await p.connection.token(AbortSignal.timeout(p.callTimeoutMs));
  if (!token.ok) return err(token.error.kind, `runner ${p.version}: installation token: ${token.error.message}`);
  try {
    const r = await p.install({
      runnerRoot: p.paths.runnerRoot,
      version: p.version,
      url: RUNNER_REPO_URL,
      credential: { url: RUNNER_REPO_URL, token: token.value },
      signal: AbortSignal.timeout(p.timeoutMs),
    });
    return r.ok ? ok({ installed: r.value.installed }) : r;
  } catch (e) {
    return err("install", `runner ${p.version}: ${message(e)}`);
  }
}

/** Writes `text` to `path` through a temporary file and a rename, with `mode`. */
export function writeFileAtomic(path: string, text: string, mode: number): Result<void, "io"> {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    return ok(undefined);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort.
    }
    return err("io", `${path}: ${message(e)}`);
  }
}

/** `host` with `lane` added or replaced under `name`, keeping its `host_id` or generating one. */
export function withLane(host: HostConfig | null, name: string, lane: Lane, newHostId: () => string): HostConfig {
  const base = host ?? { schema_version: 1 as const, lanes: {} };
  return { schema_version: 1, host_id: base.host_id ?? newHostId(), lanes: { ...base.lanes, [name]: lane } };
}

/** Runs `xarabot lane install`; `args` follow `lane install`. Returns the exit code. */
export async function laneInstall(args: readonly string[], deps: LaneInstallDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const errOut = deps.errOut ?? ((l: string) => console.error(l));
  const fail = (text: string): number => {
    errOut(`xarabot lane install: ${text}`);
    return 1;
  };
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  // 1. The lane.
  const parsed = parseInstallArgs(args);
  if (parsed === null) return fail(`usage: ${LANE_INSTALL_USAGE}`);
  const { name, flags } = parsed;
  if (!LANE_NAME.test(name)) return fail(`lane ${JSON.stringify(name)} is not a lane name ([A-Za-z0-9_-], starting alphanumeric)`);
  const laneParse = LaneSchema.safeParse({
    repo: flags["--repo"],
    role: flags["--role"],
    owner: flags["--owner"],
    agent: flags["--agent"],
    ...(flags["--model"] !== undefined ? { model: flags["--model"] } : {}),
    ...(flags["--effort"] !== undefined ? { effort: flags["--effort"] } : {}),
  });
  if (!laneParse.success) return fail(`lane ${name}: ${describeIssues(laneParse.error)}`);
  const lane = laneParse.data;
  // The coordinator's identity is `<owner>/<host>/coordinator` (AD-8), so the role and the name go together.
  if (lane.role === "coordinator" && name !== COORDINATOR_LANE) return fail(`a coordinator lane must be named ${COORDINATOR_LANE}, not ${JSON.stringify(name)}`);
  if (lane.role !== "coordinator" && name === COORDINATOR_LANE) return fail(`the lane name ${COORDINATOR_LANE} is only for role coordinator, not ${lane.role}`);
  // The ledger takes only `builder-<n>` for a builder: any other name would stop the lane at its first snapshot.
  if (lane.role === "builder" && !BUILDER_LANE.test(name)) return fail(`a builder lane must be named builder-<n> (n >= 1), not ${JSON.stringify(name)}`);

  const paths = hostPaths(deps.env);
  if (paths === null) return fail("HOME is not set");
  // The lane runs on the PATH its plist carries, so the tools it needs must resolve there.
  const tools = missingTools(plistEnv(deps.env)["PATH"], laneTools(lane.agent));
  if (tools !== null) return fail(tools);

  // 2. host.yaml.
  const host = readHostConfig(paths.hostYaml);
  if (!host.ok) return fail(host.error.message);
  // Lane names are unique per host: the same name for another repo would silently replace that lane.
  const existing = host.value !== null && Object.hasOwn(host.value.lanes, name) ? host.value.lanes[name] : undefined;
  if (existing !== undefined && existing.repo !== lane.repo) {
    return fail(`lane ${name} is already installed on this host for ${existing.repo}; choose another name for ${lane.repo}`);
  }
  // The new lane must not take the host over its builder limit, or every builder would refuse at start.
  const planned = withLane(host.value, name, lane, deps.newHostId ?? randomUUID);
  const limit = builderLimit(deps.env["XARABOT_MAX_BUILDERS"]);
  if (!limit.ok) return fail(limit.error.message);
  const builders = builderRefusal(planned, name, limit.value);
  if (!builders.ok) return fail(builders.error.message);

  // 3. The pinned runner version on main.
  const connected = await (deps.connect ?? githubConnect(deps.env))(lane);
  if (!connected.ok) return fail(connected.message);
  const connection = connected.connection;
  const snap = await connection.forge({}).snapshot({ signal: AbortSignal.timeout(callTimeoutMs), read: (p) => p === CONFIG_PATH });
  if (!snap.ok) return fail(`snapshot of ${lane.repo} main: ${snap.error.kind}: ${snap.error.message}`);
  const config = pinnedConfig(snap.value);
  if (!config.ok) return fail(config.error.message);
  const version = config.value.runner_version;

  // 4. The runner.
  const installed = await ensureRunner({
    paths,
    version,
    connection,
    install: deps.installRunner ?? defaultInstallRunner,
    timeoutMs: deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
    callTimeoutMs,
  });
  if (!installed.ok) return fail(installed.error.message);
  out(installed.value.installed ? `installed runner ${version} in ${join(paths.runnerRoot, version)}` : `runner ${version} is already installed`);

  // 5. host.yaml, mode 600.
  const next = HostConfigSchema.safeParse(planned);
  if (!next.success) return fail(`host.yaml: ${describeIssues(next.error)}`);
  const wroteHost = writeFileAtomic(paths.hostYaml, Bun.YAML.stringify(next.data, null, 2), 0o600);
  if (!wroteHost.ok) return fail(wroteHost.error.message);
  out(`wrote lane ${name} to ${paths.hostYaml}`);

  // 6. The lane folder and runner.git.
  const laneDir = laneDirFor(paths.xarabot, lane, name);
  const gitDir = await openRunnerGit(laneDir, { signal: AbortSignal.timeout(callTimeoutMs) });
  if (!gitDir.ok) return fail(gitDir.error.message);

  // 7. runner, the launcher and the plist.
  const label = laneLabel(lane.repo, name);
  const plistPath = join(laneDir, `${label}.plist`);
  const plist = renderPlist({
    label,
    launcher: paths.launcher,
    repo: lane.repo,
    lane: name,
    user: deps.user ?? userInfo().username,
    home: paths.home,
    env: plistEnv(deps.env),
    log: join(laneDir, "launchd.log"),
  });
  for (const [path, text, mode] of [
    [join(laneDir, RUNNER_FILE), runnerFileText(version), 0o600],
    [paths.launcher, renderLauncher({ bun: deps.bun ?? process.execPath }), 0o755],
    [plistPath, plist, 0o644],
  ] as const) {
    if (path === paths.launcher) {
      try {
        mkdirSync(paths.bin, { recursive: true, mode: 0o755 });
      } catch (e) {
        return fail(`${paths.bin}: ${message(e)}`);
      }
    }
    const w = writeFileAtomic(path, text, mode);
    if (!w.ok) return fail(w.error.message);
    out(`wrote ${path}`);
  }

  // 8. The Maintainer's two commands.
  const daemon = `/Library/LaunchDaemons/${label}.plist`;
  out("To start the lane, run as an admin:");
  out(`sudo cp ${shQuote(plistPath)} /Library/LaunchDaemons/`);
  out(`sudo launchctl bootstrap system ${shQuote(daemon)}`);
  return 0;
}
