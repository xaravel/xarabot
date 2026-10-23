import { join } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { ENV_NAME } from "../ports/sandbox.ts";

/**
 * The session's environment and the host paths it must never see. Both
 * functions are pure: they take the launching environment as a value.
 */

export type LaunchingEnv = Readonly<Record<string, string | undefined>>;

/** The session's fixed `PATH` after `<tempDir>/bin`. */
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export const PROXY_VARS: readonly string[] = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];

/** Names a spec may not use for its own variables: the ones the sandbox sets or forbids. */
export function isReservedEnvName(name: string): boolean {
  return (
    ["PATH", "HOME", "TMPDIR", "LANG", "TERM", "UV_CACHE_DIR", "SSH_AUTH_SOCK"].includes(name) ||
    PROXY_VARS.includes(name) ||
    name.startsWith("LC_") ||
    name.startsWith("XARABOT_") ||
    name.startsWith("GH_") ||
    name.startsWith("GITHUB_")
  );
}

/** The folders the sandbox rebuilds inside the temp folder each session. */
export function sessionDirs(tempDir: string): { readonly bin: string; readonly home: string; readonly uvCache: string } {
  return { bin: join(tempDir, "bin"), home: join(tempDir, "home"), uvCache: join(tempDir, "uv-cache") };
}

export type SessionEnvParts = {
  readonly tempDir: string;
  readonly vendorHome: string;
  readonly vendorHomeEnv: string;
  readonly resultPath: string;
  readonly proxyUrl?: string;
  /** Env-mode credential: the variable and its trimmed value. */
  readonly credential?: { readonly name: string; readonly value: string };
};

/**
 * The session's whole environment: an allowlist. Only `LANG`, `LC_*` and
 * `TERM` come from the launching env; proxy variables never do.
 */
export function buildSessionEnv(launching: LaunchingEnv, parts: SessionEnvParts): Result<Record<string, string>> {
  const names = [parts.vendorHomeEnv, ...(parts.credential === undefined ? [] : [parts.credential.name])];
  for (const name of names) {
    if (!ENV_NAME.test(name)) return err("invalid", `session env: ${JSON.stringify(name)} is not a valid variable name`);
    if (isReservedEnvName(name)) return err("invalid", `session env: ${name} is reserved`);
  }
  if (parts.credential !== undefined && parts.credential.name === parts.vendorHomeEnv) {
    return err("invalid", `session env: ${parts.vendorHomeEnv} names both the vendor home and the credential`);
  }
  const dirs = sessionDirs(parts.tempDir);
  const env: Record<string, string> = {
    PATH: `${dirs.bin}:${SYSTEM_PATH}`,
    HOME: dirs.home,
    TMPDIR: parts.tempDir,
  };
  for (const [name, value] of Object.entries(launching)) {
    if (value === undefined || !ENV_NAME.test(name)) continue;
    if (name === "LANG" || name === "TERM" || name.startsWith("LC_")) env[name] = value;
  }
  if (parts.credential !== undefined) env[parts.credential.name] = parts.credential.value;
  env[parts.vendorHomeEnv] = parts.vendorHome;
  env["XARABOT_RESULT"] = parts.resultPath;
  env["XARABOT_SANDBOXED"] = "1";
  if (parts.proxyUrl !== undefined) for (const name of PROXY_VARS) env[name] = parts.proxyUrl;
  env["UV_CACHE_DIR"] = dirs.uvCache;
  return ok(env);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** `<config>`: a non-empty `XDG_CONFIG_HOME`, else `<HOME>/.config`; `null` without `HOME`. */
export function configDir(launching: LaunchingEnv): string | null {
  const xdg = nonEmpty(launching["XDG_CONFIG_HOME"]);
  if (xdg !== undefined) return xdg;
  const home = nonEmpty(launching["HOME"]);
  return home === undefined ? null : join(home, ".config");
}

export type DeniedPaths = {
  /** `~/.xarabot`: denied except for the writable roots. */
  readonly xarabotHome: string;
  /** Denied even inside a writable root; `runnerGit` first. */
  readonly always: readonly string[];
};

/** The host paths a session must never read or write, from the launching `HOME` and `XDG_CONFIG_HOME`. */
export function deniedPaths(launching: LaunchingEnv, runnerGit: string): Result<DeniedPaths> {
  const home = nonEmpty(launching["HOME"]);
  const config = configDir(launching);
  if (home === undefined || config === null) return err("invalid", "denied paths: HOME is not set");
  const always = [
    runnerGit,
    join(config, "xarabot"),
    join(home, ".config", "gh"),
    join(config, "gh"),
    join(home, ".ssh"),
    join(home, "Library", "Keychains"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".pi"),
  ];
  return ok({ xarabotHome: join(home, ".xarabot"), always: [...new Set(always)] });
}
