import { err, ok, type Result } from "../core/result.ts";

/**
 * The Seatbelt profile (AR18, AD-17). `renderProfile` is pure: it takes paths
 * the caller has already resolved with `realpath` and returns the profile
 * text. Seatbelt applies the last rule that matches, so the order of the
 * sections below is part of the contract.
 */

/** Read-only system subpaths. Of `/dev`, only `/dev/fd` and the literals below. */
export const SYSTEM_READ_PATHS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/private/etc",
  "/private/var/db/timezone",
  "/dev/fd",
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app/Contents/Developer",
];

/** Read-only system literals: `/` itself and a few devices (no other terminal). */
export const SYSTEM_READ_LITERALS: readonly string[] = [
  "/",
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/dtracehelper",
];

/**
 * The only Mach services a session may look up. No `securityd` or keychain
 * service is listed, so `security` cannot query the keychain.
 */
export const MACH_SERVICES: readonly string[] = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.notification_center",
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.diagnosticd",
];

/** Devices a session may write besides its own pipes. */
const DEVICE_WRITES = '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty")';

export type ProfileInput = {
  /** Real files to read: the agent CLI, `bun`, `uv` and `git`. */
  readonly toolFiles: readonly string[];
  /** Real directories to read: git's exec-path and `share/git-core`, the uv Python directory. */
  readonly toolDirs: readonly string[];
  /** `~/.xarabot`, denied except for the writable roots. */
  readonly xarabotHome: string;
  /** The clone, the vendor home and the temp folder. */
  readonly writable: readonly string[];
  /** Always denied, after the writable roots: `runner.git`, credential and vendor folders. */
  readonly denied: readonly string[];
  /** The session's proxy on `127.0.0.1`: its port is the only network the profile opens. */
  readonly proxyPort?: number;
};

/**
 * A path as a Seatbelt string literal. Refuses a relative path and one
 * containing `"`, `\`, a newline or NUL, which the profile cannot carry.
 */
export function quote(path: string): Result<string> {
  if (!path.startsWith("/")) return err("invalid", `sandbox profile: ${JSON.stringify(path)} is not an absolute path`);
  if (/["\\\n\0]/.test(path)) return err("invalid", `sandbox profile: cannot quote ${JSON.stringify(path)}`);
  return ok(`"${path}"`);
}

function filters(kind: "literal" | "subpath", paths: readonly string[]): Result<string> {
  const out: string[] = [];
  for (const p of paths) {
    const q = quote(p);
    if (!q.ok) return q;
    out.push(`(${kind} ${q.value})`);
  }
  return ok(out.join(" "));
}

export function renderProfile(input: ProfileInput): Result<string> {
  if (input.writable.length === 0) return err("invalid", "sandbox profile: no writable roots");
  const port = input.proxyPort;
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    return err("invalid", `sandbox profile: proxy port ${String(port)} is not an integer from 1 to 65535`);
  }
  const systemLiterals = filters("literal", SYSTEM_READ_LITERALS);
  if (!systemLiterals.ok) return systemLiterals;
  const systemPaths = filters("subpath", SYSTEM_READ_PATHS);
  if (!systemPaths.ok) return systemPaths;
  const system = `${systemLiterals.value} ${systemPaths.value}`;
  const toolFiles = filters("literal", input.toolFiles);
  if (!toolFiles.ok) return toolFiles;
  const toolDirs = filters("subpath", input.toolDirs);
  if (!toolDirs.ok) return toolDirs;
  const xarabot = filters("subpath", [input.xarabotHome]);
  if (!xarabot.ok) return xarabot;
  const writable = filters("subpath", input.writable);
  if (!writable.ok) return writable;
  const denied = filters("subpath", input.denied);
  if (!denied.ok) return denied;

  const mach = MACH_SERVICES.map((name) => `(global-name "${name}")`).join(" ");
  const lines = [
    "(version 1)",
    // 1. Nothing unless allowed below.
    "(deny default)",
    // 2. Fork, signals within the sandbox, sysctl, metadata, a few Mach services.
    // Exec is allowed only where reads are (3, 4, 6): it needs no read access.
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    `(allow mach-lookup ${mach})`,
    // 3. System paths.
    `(allow file-read* process-exec ${system})`,
  ];
  // 4. The tools' real files and directories.
  const tools = [toolFiles.value, toolDirs.value].filter((s) => s !== "").join(" ");
  if (tools !== "") lines.push(`(allow file-read* process-exec ${tools})`);
  lines.push(
    // 5. ~/.xarabot. The global metadata allowance above is a more specific
    // operation than `file-read*`, so it still wins here: getcwd and realpath
    // work below ~/.xarabot, contents stay denied.
    `(deny file-read* file-write* process-exec ${xarabot.value})`,
    // 6. The writable roots.
    `(allow file-read* file-write* process-exec ${writable.value})`,
  );
  // 7. Always denied, even inside a writable root.
  if (denied.value !== "") lines.push(`(deny file-read* file-write* process-exec ${denied.value})`);
  lines.push(
    // 8. Harmless devices.
    `(allow file-write* ${DEVICE_WRITES})`,
    // 9. No network at all, Unix sockets included, and no DNS.
    "(deny network*)",
  );
  // 10. The proxy's port, the profile's last rule and only network allowance.
  if (port !== undefined) lines.push(`(allow network-outbound (remote tcp "localhost:${port}"))`);
  return ok(`${lines.join("\n")}\n`);
}
