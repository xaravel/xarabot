/**
 * The fixed lane launcher and the lane's launchd job (FR1, AR26, AR34),
 * rendered as text. The launcher `~/.xarabot/bin/xarabot-lane <owner>/<name>
 * <lane>` runs `xarabot lane run` from the runner version the lane's
 * `runner` file names, never from a clone or a branch. The job is a
 * LaunchDaemon carrying `UserName`, because the lane user never logs in at
 * the screen and so has no `gui/<uid>` domain. Pure.
 */

/** The launcher's file name in `~/.xarabot/bin/`. */
export const LAUNCHER_NAME = "xarabot-lane";

/** The only variables a lane job's plist carries, each when set at install time. */
export const PLIST_ENV: readonly string[] = ["HOME", "PATH", "LANG", "XDG_CONFIG_HOME", "XARABOT_MAX_BUILDERS"];

/** Seconds launchd waits between starts of a job that exits. */
export const THROTTLE_INTERVAL_S = 60;

/** The launchd label: `com.xarabot.lane.<owner>__<name>.<lane>`. */
export function laneLabel(repo: string, lane: string): string {
  const [owner, name] = repo.split("/") as [string, string];
  return `com.xarabot.lane.${owner}__${name}.${lane}`;
}

/** `value` single-quoted for POSIX `sh`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type LauncherParams = {
  /** The absolute path of the `bun` that runs the runner. */
  readonly bun: string;
};

/** The POSIX `sh` launcher. */
export function renderLauncher(p: LauncherParams): string {
  return `#!/bin/sh
# xarabot-lane: the fixed lane launcher, written by \`xarabot lane install\`.
# Usage: xarabot-lane <owner>/<name> <lane>
# Runs \`xarabot lane run\` from the pinned runner the lane's runner file names.
set -u

fail() {
  echo "xarabot-lane: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "usage: xarabot-lane <owner>/<name> <lane>"
repo=$1
lane=$2

case $repo in
  */*) ;;
  *) fail "repo $repo is not <owner>/<name>" ;;
esac
owner=\${repo%%/*}
name=\${repo#*/}
case $owner in
  '' | -* | *- | *--* | *[!A-Za-z0-9-]*) fail "owner $owner is not a GitHub login" ;;
esac
[ "\${#owner}" -le 39 ] || fail "owner $owner is not a GitHub login"
case $name in
  '' | . | .. | *[!A-Za-z0-9._-]*) fail "repo name $name is not a repo name" ;;
esac
[ "\${#name}" -le 100 ] || fail "repo name $name is not a repo name"
case $lane in
  '' | [!A-Za-z0-9]* | *[!A-Za-z0-9_-]*) fail "lane $lane is not a lane name" ;;
esac

[ -n "\${HOME:-}" ] || fail "HOME is not set"
lane_dir=$HOME/.xarabot/repos/\${owner}__\${name}/lanes/$lane
runner_file=$lane_dir/runner
[ -f "$runner_file" ] || fail "$runner_file: missing"
version=
IFS= read -r version < "$runner_file" || [ -n "$version" ] || fail "$runner_file: cannot read a version"
case $version in
  '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._+-]* | *..*) fail "$runner_file: $version is not a runner version" ;;
esac
[ "\${#version}" -le 100 ] || fail "$runner_file: $version is not a runner version"

main=$HOME/.xarabot/runner/$version/src/cli/main.ts
[ -f "$main" ] || fail "$main: missing (runner $version is not installed)"

unset XARABOT_SANDBOXED
exec ${shQuote(p.bun)} "$main" lane run "$repo" "$lane"
`;
}

/** `text` escaped for XML character data and attribute values. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The `PLIST_ENV` variables of `env` that are set, by name. */
export function plistEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PLIST_ENV) {
    const value = env[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

export type PlistParams = {
  readonly label: string;
  /** The launcher's absolute path. */
  readonly launcher: string;
  readonly repo: string;
  readonly lane: string;
  /** The user launchd runs the job as. */
  readonly user: string;
  /** The user's home: the job's working directory. */
  readonly home: string;
  /** Filtered through `plistEnv`, then sorted by name. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where the job's stdout and stderr go. */
  readonly log: string;
};

/** The lane's LaunchDaemon plist. */
export function renderPlist(p: PlistParams): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const env = plistEnv(p.env);
  const names = Object.keys(env).sort();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${s(p.label)}`,
    "  <key>UserName</key>",
    `  ${s(p.user)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${s(p.launcher)}`,
    `    ${s(p.repo)}`,
    `    ${s(p.lane)}`,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...names.flatMap((name) => [`    <key>${xmlEscape(name)}</key>`, `    ${s(env[name] as string)}`]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  ${s(p.home)}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${THROTTLE_INTERVAL_S}</integer>`,
    "  <key>StandardOutPath</key>",
    `  ${s(p.log)}`,
    "  <key>StandardErrorPath</key>",
    `  ${s(p.log)}`,
    "</dict>",
    "</plist>",
  ];
  return `${lines.join("\n")}\n`;
}
