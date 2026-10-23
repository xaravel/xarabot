import { accessSync, constants as fsConstants, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isReservedEnvName, buildSessionEnv, deniedPaths, sessionDirs, type LaunchingEnv } from "./environment.ts";
import { renderProfile } from "./profile.ts";
import { resolveTools } from "./tools.ts";
import { isPlainFileName, removeTree, seedVendorHome } from "./vendor-home.ts";
import {
  ENV_NAME,
  isVendor,
  refused,
  sandboxOk,
  type LaunchSpec,
  type Sandbox,
  type SandboxHooks,
  type SandboxProfile,
  type SandboxResult,
  type SandboxRun,
} from "../ports/sandbox.ts";

/**
 * The macOS `Sandbox` (AR18, AD-17): runs the agent through
 * `sandbox-exec -p <profile>` with a generated deny-by-default profile, an
 * allowlisted environment, a fresh `HOME` and a re-seeded vendor home. Every
 * check fails closed and refuses the session; nothing runs unsandboxed and
 * the profile never touches the disk.
 */

export const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** How long after SIGTERM an aborted session gets SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** How long after exit the output pipes may stay open (a lingering grandchild) before the run returns. */
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
  const names = [spec.vendorHomeEnv, ...("env" in spec.credential ? [spec.credential.env] : [])];
  for (const name of names) {
    if (!ENV_NAME.test(name)) return refused(`sandbox: ${JSON.stringify(name)} is not a valid variable name`);
    if (isReservedEnvName(name)) return refused(`sandbox: ${name} is reserved`);
  }
  if ("env" in spec.credential && spec.credential.env === spec.vendorHomeEnv) {
    return refused(`sandbox: ${spec.vendorHomeEnv} names both the vendor home and the credential`);
  }
  if (!isPlainFileName(spec.credential.file)) {
    return refused(`sandbox: credential ${JSON.stringify(spec.credential.file)} is not a plain file name`);
  }
  if ("homeFile" in spec.credential && !isPlainFileName(spec.credential.homeFile)) {
    return refused(`sandbox: home file ${JSON.stringify(spec.credential.homeFile)} is not a plain file name`);
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
  for (const rebuilt of ["bin", "home", "uv-cache"]) {
    if (rel === rebuilt || rel.startsWith(`${rebuilt}/`)) {
      return refused(`sandbox: resultPath ${profile.resultPath} lies inside the rebuilt ${rebuilt} folder`);
    }
  }
  if (profile.proxyUrl !== undefined && /[\0\n]/.test(profile.proxyUrl)) return refused("sandbox: proxyUrl contains a control character");
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

export function createMacSandbox(opts: MacSandboxOpts = {}): Sandbox {
  const sandboxExec = opts.sandboxExec ?? DEFAULT_SANDBOX_EXEC;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => Date.now());

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

    const rendered = renderProfile({
      toolFiles: [tools.value.agent.path, ...tools.value.helpers.map((t) => t.path)],
      toolDirs: tools.value.dirs,
      xarabotHome: realpathLoose(denied.value.xarabotHome),
      writable: [roots.clone, roots.vendorHome, roots.tempDir],
      denied: forbidden().map((f) => f.path),
    });
    if (!rendered.ok) return refused(`sandbox: the profile fails to generate: ${rendered.error.message}`);

    const seeded = seedVendorHome({ launching, vendor: spec.vendor, credential: spec.credential, vendorHome: roots.vendorHome });
    if (!seeded.ok) return seeded;

    const dirs = sessionDirs(roots.tempDir);
    const resultPath = join(roots.tempDir, relative(resolve(profile.tempDir), resolve(profile.resultPath)));
    try {
      removeTree(dirs.bin);
      removeTree(dirs.home);
      removeTree(resultPath);
      if (lstatOrNull(dirs.uvCache)?.isDirectory() === false) removeTree(dirs.uvCache);
      mkdirSync(dirs.bin, { mode: 0o700 });
      mkdirSync(dirs.home, { mode: 0o700 });
      mkdirSync(dirs.uvCache, { recursive: true, mode: 0o700 });
      for (const t of [tools.value.agent, ...tools.value.helpers]) symlinkSync(t.path, join(dirs.bin, t.name));
      writeFileSync(join(dirs.home, ".gitconfig"), SESSION_GITCONFIG, { mode: 0o600 });
    } catch (e) {
      return refused(`sandbox: cannot prepare the temp folder: ${message(e)}`);
    }

    const env = buildSessionEnv(launching, {
      tempDir: roots.tempDir,
      vendorHome: roots.vendorHome,
      vendorHomeEnv: spec.vendorHomeEnv,
      resultPath,
      ...(profile.proxyUrl === undefined ? {} : { proxyUrl: profile.proxyUrl }),
      ...(seeded.value.env === undefined ? {} : { credential: seeded.value.env }),
    });
    if (!env.ok) return refused(`sandbox: ${env.error.message}`);

    if (signal.aborted) return refused("sandbox: aborted before the session started");
    const argv = [sandboxExec, "-p", rendered.value, join(dirs.bin, cmd), ...spec.argv.slice(1)];
    const startedAt = now();
    let child;
    try {
      child = Bun.spawn(argv, {
        cwd: roots.clone,
        env: env.value,
        stdin: spec.stdin === undefined ? "ignore" : new Blob([spec.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return refused(`sandbox: cannot start the session: ${message(e)}`);
    }
    const pid = child.pid;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: "SIGTERM" | "SIGKILL"): void => {
      if (exited) return;
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    };
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
    const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;
    const drained = Promise.all([drain(readers[0], out), drain(readers[1], errOut)]);
    try {
      await child.exited;
    } finally {
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
    }
    const endedAt = now();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([drained, new Promise<void>((r) => (graceTimer = setTimeout(r, DRAIN_GRACE_MS)))]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    // A lingering grandchild may still hold the pipes: stop reading them.
    for (const reader of readers) reader.cancel().catch(() => {});

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

  return { run };
}
