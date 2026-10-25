import { err, ok, type Result } from "../core/result.ts";

/**
 * The `Sandbox` port (FR18, NFR8, AR18, AD-17): the only way the runner starts
 * an agent session. An implementation checks everything it needs before the
 * session and refuses it when any check fails; there is never an unsandboxed
 * fallback. `run` never throws: every failure is a `refused` result whose
 * message names its cause.
 */

export const VENDORS = ["claude", "codex", "pi"] as const;
export type Vendor = (typeof VENDORS)[number];

/** The shape every environment variable name a spec names must match. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Where the session's credential comes from: a plain file name under
 * `<config>/xarabot/vendors/<vendor>/`. In `env` mode the trimmed contents go
 * in the variable `env`; in `homeFile` mode the file is copied to
 * `<vendorHome>/<homeFile>` with mode 600.
 */
export type LaunchCredential =
  | { readonly file: string; readonly env: string }
  | { readonly file: string; readonly homeFile: string };

/** What an agent adapter asks the sandbox to run. */
export type LaunchSpec = {
  /** `argv[0]` is a command name resolved on the launching `PATH`. */
  readonly argv: readonly string[];
  /** Written to the session's stdin, which is then closed; default no stdin. */
  readonly stdin?: string;
  readonly vendor: Vendor;
  /** The variable that points the CLI at its vendor home, e.g. `CLAUDE_CONFIG_DIR`. */
  readonly vendorHomeEnv: string;
  /**
   * The session's credential. Absent means a repo command the runner starts
   * (AR19), such as the lockfile regeneration: nothing is seeded into the
   * vendor home and no credential variable is set. Agent sessions always
   * carry one (`AgentLaunchSpec`).
   */
  readonly credential?: LaunchCredential;
  /**
   * The vendor's API hosts, the session's only hosts besides the package
   * hosts and the repo's `proxy_hosts`. Never a GitHub host or an IP literal.
   */
  readonly apiHosts: readonly string[];
  /**
   * A resume of the session that last ran in this vendor home: its contents
   * (the transcript) are kept instead of emptied. A credential, if any, is
   * still re-read and re-checked, and in `homeFile` mode rewritten. Default `false`.
   */
  readonly resume?: boolean;
};

/** Where the session may write, and what it must never see. All absolute paths. */
export type SandboxProfile = {
  readonly clone: string;
  readonly vendorHome: string;
  readonly tempDir: string;
  /** The runner's private `runner.git`: never readable or writable. */
  readonly runnerGit: string;
  /** Where the session writes its result; inside `tempDir`. */
  readonly resultPath: string;
  /** The repo's `proxy_hosts`, added to the proxy allowlist; default `[]`. */
  readonly repoHosts?: readonly string[];
};

/** A finished session. Times are epoch ms from the implementation's clock. */
export type SandboxRun = {
  /** The agent's own PID. */
  readonly pid: number;
  /** `null` when a signal ended the process. */
  readonly exitCode: number | null;
  /** The signal that ended the process, e.g. `SIGTERM`, or `null`. */
  readonly signal: string | null;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type SandboxErrorKind = "refused";
export type SandboxResult<T> = Result<T, SandboxErrorKind>;

export type SandboxHooks = {
  /** Called as soon as the process starts, with its PID. */
  readonly onSpawn?: (pid: number) => void;
};

export type Sandbox = {
  /**
   * Runs one session. When `signal` aborts, the process gets SIGTERM and,
   * 10 s later, SIGKILL, both by its exact PID; the run then resolves with
   * whatever it printed.
   */
  run(spec: LaunchSpec, profile: SandboxProfile, signal: AbortSignal, hooks?: SandboxHooks): Promise<SandboxResult<SandboxRun>>;
};

export function sandboxOk<T>(value: T): { readonly ok: true; readonly value: T } {
  return ok(value);
}

export function refused(message: string): { readonly ok: false; readonly error: { readonly kind: "refused"; readonly message: string } } {
  return err("refused", message);
}

export function isVendor(value: string): value is Vendor {
  return (VENDORS as readonly string[]).includes(value);
}
