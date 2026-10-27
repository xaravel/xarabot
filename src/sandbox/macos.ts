import { accessSync, constants as fsConstants, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isReservedEnvName, buildSessionEnv, deniedPaths, SESSION_DIR_NAMES, sessionDirs, type DeniedPaths, type LaunchingEnv } from "./environment.ts";
import { buildAllowlist } from "../core/network/hosts.ts";
import { renderProfile } from "./profile.ts";
import { startProxy, type ConnectDecision, type Proxy, type ProxyOpts } from "./proxy.ts";
import { resolveTools, type ResolvedTools } from "./tools.ts";
import { homeFileChanged, isPlainFileName, removeTree, seedVendorHome } from "./vendor-home.ts";
import {
  ENV_NAME,
  isVendor,
  refused,
  sandboxOk,
  type LaunchSpec,
  type ProxyRequest,
  type Sandbox,
  type SandboxHooks,
  type SandboxProfile,
  type SandboxResult,
  type SandboxRun,
} from "../ports/sandbox.ts";

/**
 * The macOS `Sandbox` (AR18, AD-17): runs the agent through
 * `sandbox-exec -p <profile>` with a generated deny-by-default profile, an
 * allowlisted environment, a fresh `HOME` and a re-seeded vendor home. Its
 * only network is a per-session CONNECT proxy on `127.0.0.1`, which allows
 * the vendor's API hosts, the package hosts and the repo's `proxy_hosts`, and
 * never a GitHub host. Every check fails closed and refuses the session;
 * nothing runs unsandboxed and the profile never touches the disk. The run
 * reports every request the proxy decided on and, for a `homeFile`
 * credential, whether the session rewrote the seeded file. The session leads
 * its own process group (`setsid`); an abort signals that group, and once the
 * session ends the group gets SIGKILL, so no descendant outlives the run. A
 * reaper kills the group should the lane end first, however it ends.
 */

export const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** How long after SIGTERM an aborted session gets SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** How long after exit the output pipes may stay open (a descendant that left the session's group) before the run returns. */
const DRAIN_GRACE_MS = 5_000;

/** The `.gitconfig` of the session's fresh `HOME`: no credential helper. */
export const SESSION_GITCONFIG = "[credential]\n\thelper =\n";

export type MacSandboxOpts = {
  readonly sandboxExec?: string;
  /** The environment the runner launches from; default `process.env`. */
  readonly launchingEnv?: LaunchingEnv;
  /** Default `process.platform`. */
  readonly platform?: string;
  /** Epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** Passed through to `startProxy`; for tests. */
  readonly proxy?: Pick<ProxyOpts, "ports" | "dial">;
  /** Starts and signals the session's processes; default `HOST_PROCESSES`. For tests. */
  readonly processes?: SessionProcesses;
};

type Refused = { readonly ok: false; readonly error: { readonly kind: "refused"; readonly message: string } };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `realpath` of the longest existing prefix, with the rest appended. */
export function realpathLoose(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realpathLoose(parent), basename(abs));
  }
}

/** True when `inner` is `outer` or lies inside it. */
export function within(inner: string, outer: string): boolean {
  if (outer === "/") return true;
  return inner === outer || inner.startsWith(`${outer}/`);
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function validateSpec(spec: LaunchSpec): Refused | null {
  const cmd = spec.argv[0];
  if (cmd === undefined || cmd === "" || cmd.includes("/")) {
    return refused(`sandbox: argv[0] must be a command name, got ${JSON.stringify(cmd ?? "")}`);
  }
  if (spec.argv.some((a) => a.includes("\0"))) return refused("sandbox: an argument contains NUL");
  if (!isVendor(spec.vendor)) return refused(`sandbox: unknown vendor ${JSON.stringify(spec.vendor)}`);
  // No credential: a repo command the runner starts (AR19); only the vendor home variable is checked.
  const credential = spec.credential;
  const names = [spec.vendorHomeEnv, ...(credential !== undefined && "env" in credential ? [credential.env] : [])];
  for (const name of names) {
    if (!ENV_NAME.test(name)) return refused(`sandbox: ${JSON.stringify(name)} is not a valid variable name`);
    if (isReservedEnvName(name)) return refused(`sandbox: ${name} is reserved`);
  }
  if (credential === undefined) return null;
  if ("env" in credential && credential.env === spec.vendorHomeEnv) {
    return refused(`sandbox: ${spec.vendorHomeEnv} names both the vendor home and the credential`);
  }
  if (!isPlainFileName(credential.file)) {
    return refused(`sandbox: credential ${JSON.stringify(credential.file)} is not a plain file name`);
  }
  if ("homeFile" in credential && !isPlainFileName(credential.homeFile)) {
    return refused(`sandbox: home file ${JSON.stringify(credential.homeFile)} is not a plain file name`);
  }
  return null;
}

function validateProfile(profile: SandboxProfile): Refused | null {
  for (const key of ["clone", "vendorHome", "tempDir", "runnerGit", "resultPath"] as const) {
    if (!isAbsolute(profile[key])) return refused(`sandbox: ${key} ${JSON.stringify(profile[key])} is not an absolute path`);
  }
  const rel = relative(resolve(profile.tempDir), resolve(profile.resultPath));
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return refused(`sandbox: resultPath ${profile.resultPath} is not inside tempDir ${profile.tempDir}`);
  }
  for (const rebuilt of SESSION_DIR_NAMES) {
    if (rel === rebuilt || rel.startsWith(`${rebuilt}/`)) {
      return refused(`sandbox: resultPath ${profile.resultPath} lies inside the rebuilt ${rebuilt} folder`);
    }
  }
  return null;
}

type Roots = { readonly clone: string; readonly vendorHome: string; readonly tempDir: string };

type Confinement = {
  readonly forbidden: readonly { readonly what: string; readonly path: string }[];
  /** `~/.xarabot`: no root may equal or contain it. */
  readonly xarabotHome: string;
  /** The lane folder, `dirname(runnerGit)`: every root lies inside it. */
  readonly lane: string;
};

/**
 * Refuses writable roots outside the lane folder, equal to or containing
 * `~/.xarabot`, touching `runner.git` or an always-denied path, or each other.
 */
function checkRoots(roots: Roots, c: Confinement): Refused | null {
  const entries = Object.entries(roots) as [keyof Roots, string][];
  const forbidden = c.forbidden;
  for (const [key, root] of entries) {
    if (within(c.xarabotHome, root)) return refused(`sandbox: ${key} ${root} equals or contains ${c.xarabotHome}`);
    if (root === c.lane || !within(root, c.lane)) return refused(`sandbox: ${key} ${root} is not inside the lane folder ${c.lane}`);
    for (const f of forbidden) {
      if (overlaps(root, f.path)) return refused(`sandbox: ${key} ${root} overlaps ${f.what} ${f.path}`);
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [ka, a] = entries[i] as [keyof Roots, string];
      const [kb, b] = entries[j] as [keyof Roots, string];
      if (overlaps(a, b)) return refused(`sandbox: ${ka} ${a} overlaps ${kb} ${b}`);
    }
  }
  return null;
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!lstatSync(realpathSync(path)).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function drain(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, chunks: Uint8Array[]): Promise<void> {
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done || r.value === undefined) return;
      chunks.push(r.value);
    }
  } catch {
    // The pipe broke; keep what arrived.
  }
}

function signalName(sig: string | number | null): string | null {
  if (sig === null || typeof sig === "string") return sig;
  const found = Object.entries(constants.signals).find(([, n]) => n === sig);
  return found === undefined ? `signal ${sig}` : found[0];
}

function text(chunks: readonly Uint8Array[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

/** The most proxy requests one run records; a session past it gets one marker entry. */
export const MAX_PROXY_REQUESTS = 10_000;
const MAX_TARGET = 200;

/** One proxy decision as the run reports it. */
export function proxyRequest(line: string, decision: ConnectDecision): ProxyRequest {
  const parts = line.split(" ");
  const target = parts[0] === "CONNECT" && parts.length === 3 ? (parts[1] as string) : line;
  return { target: target.slice(0, MAX_TARGET), allowed: decision.allow, reason: decision.allow ? null : decision.reason };
}

/** The entry that ends a run's record once it holds `MAX_PROXY_REQUESTS`. */
export const PROXY_REQUESTS_MARKER: ProxyRequest = { target: "(more requests not recorded)", allowed: false, reason: `over ${MAX_PROXY_REQUESTS} requests` };

/** Adds one decision to `requests`: up to `MAX_PROXY_REQUESTS`, then the marker once, then nothing. */
export function recordProxyRequest(requests: ProxyRequest[], line: string, decision: ConnectDecision): void {
  if (requests.length < MAX_PROXY_REQUESTS) requests.push(proxyRequest(line, decision));
  else if (requests.length === MAX_PROXY_REQUESTS) requests.push(PROXY_REQUESTS_MARKER);
}

/** The signals a session's process group gets. */
export type GroupSignal = "SIGTERM" | "SIGKILL";

/** What `superviseSession` passes to `SessionProcesses.spawn`. */
export type SessionSpawnOptions = {
  /** Always `true`: `setsid()`, so the process leads its own group, whose id is its PID. */
  readonly detached: true;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin: "ignore" | "pipe" | Blob;
  readonly stdout: "ignore" | "pipe";
  readonly stderr: "ignore" | "pipe";
};

/** The parts of a spawned process `superviseSession` uses. */
export type SpawnedProcess = {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  /** The output pipes, when spawned with `"pipe"`. */
  readonly stdout?: ReadableStream<Uint8Array> | number | null;
  readonly stderr?: ReadableStream<Uint8Array> | number | null;
  /** The write end of the input pipe, when spawned with `"pipe"`. */
  readonly stdin?: { end(): unknown } | number | null;
  /** Signals this exact PID. */
  kill(sig: GroupSignal): void;
};

/** How a session's processes are started and signalled; `HOST_PROCESSES` outside tests. */
export type SessionProcesses = {
  readonly spawn: (argv: string[], options: SessionSpawnOptions) => SpawnedProcess;
  /** Signals the process group whose id is `pid`. */
  readonly signalGroup: (pid: number, sig: GroupSignal) => void;
};

export const HOST_PROCESSES: SessionProcesses = {
  spawn: (argv, options) => Bun.spawn(argv, options) as SpawnedProcess,
  /*
   * Signals the session's own process group, by its id: the session's exact
   * PID, so it reaches the session and its descendants and nothing else
   * (Epic 3 retro item 1, the only group kill in `src/` besides the reaper's).
   */
  signalGroup: (pid, sig) => process.kill(-pid, sig),
};

/**
 * The reaper's script, run by `/bin/sh` with the session's PID as `$1`: it
 * waits, with shell builtins only, until its input pipe closes, then SIGKILLs
 * the session's group. Only the lane holds that pipe's write end, and the
 * kernel closes it however the lane ends, so a lane that is stopped, crashes
 * or gets SIGKILL leaves no session process behind. The reaper leads its own
 * group too, so launchd's kill of the lane's group does not take it first.
 */
export const REAPER_SCRIPT = 'while read -r _; do :; done; kill -s KILL -- "-$1" 2>/dev/null; exit 0';

/** What one supervised session printed and how it ended. */
export type SupervisedRun = Omit<SandboxRun, "proxyRequests" | "credentialRewritten">;

/**
 * Starts `argv` as the leader of its own process group and a reaper for that
 * group, and waits for the session. An abort sends the group SIGTERM and,
 * `KILL_GRACE_MS` later, SIGKILL. Once the session exits the group gets
 * SIGKILL, so no descendant outlives the run, and the reaper is killed by its
 * exact PID. Should the lane itself end first, the reaper kills the group.
 */
export async function superviseSession(
  argv: string[],
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly stdin?: string },
  signal: AbortSignal,
  hooks: SandboxHooks | undefined,
  deps: { readonly processes: SessionProcesses; readonly now: () => number },
): Promise<SandboxResult<SupervisedRun>> {
  const { processes, now } = deps;
  const startedAt = now();
  let child: SpawnedProcess;
  try {
    child = processes.spawn(argv, {
      detached: true,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return refused(`sandbox: cannot start the session: ${message(e)}`);
  }
  const pid = child.pid;
  const kill = (sig: GroupSignal): void => {
    try {
      processes.signalGroup(pid, sig);
    } catch {
      // Already gone.
    }
  };
  let reaper: SpawnedProcess;
  try {
    reaper = processes.spawn(["/bin/sh", "-c", REAPER_SCRIPT, "xarabot-reaper", String(pid)], {
      detached: true,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (e) {
    // Fail closed: a session nothing would reap after the lane ends does not run.
    kill("SIGKILL");
    await child.exited;
    return refused(`sandbox: cannot start the session's reaper: ${message(e)}`);
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    hooks?.onSpawn?.(pid);
  } catch {
    // A hook's failure must not orphan the session.
  }
  if (signal.aborted) onAbort();

  const out: Uint8Array[] = [];
  const errOut: Uint8Array[] = [];
  const readerOf = (s: SpawnedProcess["stdout"]) => (s instanceof ReadableStream ? s.getReader() : null);
  const readers = [readerOf(child.stdout), readerOf(child.stderr)] as const;
  const drained = Promise.all([drain(readers[0] ?? EMPTY, out), drain(readers[1] ?? EMPTY, errOut)]);
  try {
    await child.exited;
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    signal.removeEventListener("abort", onAbort);
    // Whatever the session left running dies with it: no descendant outlives the run.
    kill("SIGKILL");
    try {
      reaper.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await reaper.exited;
    try {
      if (typeof reaper.stdin === "object" && reaper.stdin !== null) reaper.stdin.end();
    } catch {
      // The pipe is already closed.
    }
  }
  const endedAt = now();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drained, new Promise<void>((r) => (graceTimer = setTimeout(r, DRAIN_GRACE_MS)))]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  // A descendant that left the group may still hold the pipes: stop reading them.
  for (const reader of readers) reader?.cancel().catch(() => {});

  const sig = child.signalCode;
  return sandboxOk({
    pid,
    exitCode: sig === null ? child.exitCode : null,
    signal: signalName(sig),
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    stdout: text(out),
    stderr: text(errOut),
  });
}

/** A reader with nothing to read. */
const EMPTY = { read: (): Promise<{ done: boolean }> => Promise.resolve({ done: true }) };

export function createMacSandbox(opts: MacSandboxOpts = {}): Sandbox {
  const sandboxExec = opts.sandboxExec ?? DEFAULT_SANDBOX_EXEC;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => Date.now());
  const processes = opts.processes ?? HOST_PROCESSES;

  async function run(spec: LaunchSpec, profile: SandboxProfile, signal: AbortSignal, hooks?: SandboxHooks): Promise<SandboxResult<SandboxRun>> {
    const launching: LaunchingEnv = opts.launchingEnv ?? process.env;
    if (platform !== "darwin") return refused(`sandbox: host is ${platform}, not macOS`);
    if (launching["XARABOT_SANDBOXED"] === "1") return refused("sandbox: already inside a sandbox (XARABOT_SANDBOXED=1)");
    const badSpec = validateSpec(spec) ?? validateProfile(profile);
    if (badSpec !== null) return badSpec;
    if (signal.aborted) return refused("sandbox: aborted before the session started");
    if (!isExecutableFile(sandboxExec)) return refused(`sandbox: ${sandboxExec} not found`);

    const cmd = spec.argv[0] as string;
    const tools = await resolveTools(launching, cmd);
    if (!tools.ok) return tools;

    let gitDir;
    try {
      gitDir = lstatSync(join(profile.clone, ".git"));
    } catch {
      return refused(`sandbox: clone ${profile.clone} has no .git`);
    }
    if (!gitDir.isDirectory()) return refused(`sandbox: clone ${profile.clone}: .git is not a directory (a linked worktree?)`);

    const denied = deniedPaths(launching, profile.runnerGit);
    if (!denied.ok) return refused(`sandbox: ${denied.error.message}`);
    const forbidden = (): { what: string; path: string }[] => [
      { what: "runner.git", path: realpathLoose(profile.runnerGit) },
      ...denied.value.always.slice(1).map((p) => ({ what: "denied path", path: realpathLoose(p) })),
    ];
    const confinement = (): Confinement => ({
      forbidden: forbidden(),
      xarabotHome: realpathLoose(denied.value.xarabotHome),
      lane: realpathLoose(dirname(profile.runnerGit)),
    });
    const looseRoots: Roots = {
      clone: realpathLoose(profile.clone),
      vendorHome: realpathLoose(profile.vendorHome),
      tempDir: realpathLoose(profile.tempDir),
    };
    const badLoose = checkRoots(looseRoots, confinement());
    if (badLoose !== null) return badLoose;
    try {
      mkdirSync(profile.vendorHome, { recursive: true, mode: 0o700 });
      mkdirSync(profile.tempDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      return refused(`sandbox: cannot create the writable roots: ${message(e)}`);
    }
    let roots: Roots;
    try {
      roots = {
        clone: realpathSync(profile.clone),
        vendorHome: realpathSync(profile.vendorHome),
        tempDir: realpathSync(profile.tempDir),
      };
    } catch (e) {
      return refused(`sandbox: cannot resolve the writable roots: ${message(e)}`);
    }
    const bad = checkRoots(roots, confinement());
    if (bad !== null) return bad;

    const allow = buildAllowlist(spec.apiHosts, profile.repoHosts ?? []);
    if (!allow.ok) return refused(`sandbox: ${allow.error.message}`);
    const requests: ProxyRequest[] = [];
    const onRequest = (line: string, decision: ConnectDecision): void => recordProxyRequest(requests, line, decision);
    const proxy = startProxy({ allow: allow.value, ...opts.proxy, onRequest });
    if (!proxy.ok) return refused(`sandbox: the proxy fails to start: ${proxy.error.message}`);
    try {
      return await session(spec, profile, signal, hooks, { tools: tools.value, denied: denied.value, roots, forbidden, proxy: proxy.value, launching, requests });
    } finally {
      proxy.value.stop();
    }
  }

  async function session(
    spec: LaunchSpec,
    profile: SandboxProfile,
    signal: AbortSignal,
    hooks: SandboxHooks | undefined,
    ctx: {
      readonly tools: ResolvedTools;
      readonly denied: DeniedPaths;
      readonly roots: Roots;
      readonly forbidden: () => { what: string; path: string }[];
      readonly proxy: Proxy;
      readonly launching: LaunchingEnv;
      /** Filled by the proxy's hook while the session runs. */
      readonly requests: readonly ProxyRequest[];
    },
  ): Promise<SandboxResult<SandboxRun>> {
    const { tools, denied, roots, forbidden, proxy, launching, requests } = ctx;
    const cmd = spec.argv[0] as string;
    const rendered = renderProfile({
      toolFiles: [tools.agent.path, ...tools.helpers.map((t) => t.path)],
      toolDirs: tools.dirs,
      xarabotHome: realpathLoose(denied.xarabotHome),
      writable: [roots.clone, roots.vendorHome, roots.tempDir],
      denied: forbidden().map((f) => f.path),
      proxyPort: proxy.port,
    });
    if (!rendered.ok) return refused(`sandbox: the profile fails to generate: ${rendered.error.message}`);

    const seeded = seedVendorHome({
      launching,
      vendor: spec.vendor,
      ...(spec.credential === undefined ? {} : { credential: spec.credential }),
      vendorHome: roots.vendorHome,
      keep: spec.resume === true,
    });
    if (!seeded.ok) return seeded;

    const dirs = sessionDirs(roots.tempDir);
    const resultPath = join(roots.tempDir, relative(resolve(profile.tempDir), resolve(profile.resultPath)));
    try {
      removeTree(dirs.bin);
      removeTree(dirs.home);
      removeTree(dirs.cliTmp);
      removeTree(resultPath);
      if (lstatOrNull(dirs.uvCache)?.isDirectory() === false) removeTree(dirs.uvCache);
      mkdirSync(dirs.bin, { mode: 0o700 });
      mkdirSync(dirs.home, { mode: 0o700 });
      mkdirSync(dirs.cliTmp, { mode: 0o700 });
      mkdirSync(dirs.uvCache, { recursive: true, mode: 0o700 });
      for (const t of [tools.agent, ...tools.helpers]) symlinkSync(t.path, join(dirs.bin, t.name));
      writeFileSync(join(dirs.home, ".gitconfig"), SESSION_GITCONFIG, { mode: 0o600 });
      if (tools.uvPython !== null) {
        // uv finds its managed Pythons under the fresh HOME, with no extra variable.
        const link = join(dirs.home, ".local", "share", "uv", "python");
        mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
        symlinkSync(tools.uvPython, link);
      }
    } catch (e) {
      return refused(`sandbox: cannot prepare the temp folder: ${message(e)}`);
    }

    const env = buildSessionEnv(launching, {
      vendor: spec.vendor,
      tempDir: roots.tempDir,
      vendorHome: roots.vendorHome,
      vendorHomeEnv: spec.vendorHomeEnv,
      resultPath,
      proxyUrl: proxy.url,
      ...(seeded.value.env === undefined ? {} : { credential: seeded.value.env }),
    });
    if (!env.ok) return refused(`sandbox: ${env.error.message}`);

    if (signal.aborted) return refused("sandbox: aborted before the session started");
    const argv = [sandboxExec, "-p", rendered.value, join(dirs.bin, cmd), ...spec.argv.slice(1)];
    const supervised = await superviseSession(argv, { cwd: roots.clone, env: env.value, stdin: spec.stdin }, signal, hooks, { processes, now });
    if (!supervised.ok) return supervised;
    const home = seeded.value.homeFile;
    return sandboxOk({
      ...supervised.value,
      proxyRequests: [...requests],
      ...(home === undefined ? {} : { credentialRewritten: homeFileChanged(home) }),
    });
  }

  return { run };
}
