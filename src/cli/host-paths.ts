import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialEnv } from "../adapters/forge/github/credentials.ts";
import { loadHostConfig } from "../core/config/load-host-config.ts";
import { LAUNCHER_NAME } from "../core/lane/launchd.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { HostConfig, Lane } from "../core/schemas/host.ts";

/**
 * The host's paths (AR37), from `HOME` and `XDG_CONFIG_HOME`: `~/.xarabot`
 * with its `bin/`, `runner/` and `STOP`, and `<config>/xarabot/host.yaml`.
 * A lane's folder is `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`.
 */

export type HostPaths = {
  /** `~/.xarabot`. */
  readonly xarabot: string;
  /** `<config>/xarabot/host.yaml`, `<config>` being `XDG_CONFIG_HOME` or `~/.config`. */
  readonly hostYaml: string;
  /** `~/.xarabot/bin`. */
  readonly bin: string;
  /** `~/.xarabot/runner`: one folder per installed runner version. */
  readonly runnerRoot: string;
  /** `~/.xarabot/STOP`. */
  readonly hostStop: string;
  /** `~/.xarabot/bin/xarabot-lane`. */
  readonly launcher: string;
  readonly home: string;
};

/** The lane folder's file naming the runner version (a version and a newline). */
export const RUNNER_FILE = "runner";
/** The lane folder's count of refused starts in a row (a count and a newline). */
export const FAILED_STARTS_FILE = "failed-starts";

/** `null` when `HOME` is not set. */
export function hostPaths(env: CredentialEnv): HostPaths | null {
  const home = env["HOME"];
  if (home === undefined || home === "") return null;
  const xdg = env["XDG_CONFIG_HOME"];
  const config = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
  const xarabot = join(home, ".xarabot");
  const bin = join(xarabot, "bin");
  return {
    xarabot,
    hostYaml: join(config, "xarabot", "host.yaml"),
    bin,
    runnerRoot: join(xarabot, "runner"),
    hostStop: join(xarabot, "STOP"),
    launcher: join(bin, LAUNCHER_NAME),
    home,
  };
}

/** A lane's folder: `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`. */
export function laneDirFor(xarabot: string, lane: Lane, name: string): string {
  const [owner, repo] = lane.repo.split("/") as [string, string];
  return join(xarabot, "repos", `${owner}__${repo}`, "lanes", name);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isMissing(e: unknown): boolean {
  return e !== null && typeof e === "object" && (e as { code?: unknown }).code === "ENOENT";
}

/** `host.yaml`, or `null` when the file does not exist. */
export function readHostConfig(path: string): Result<HostConfig | null> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return ok(null);
    return err("unreadable", `${path}: cannot read: ${message(e)}`);
  }
  const host = loadHostConfig(text, path);
  if (!host.ok) return host;
  return ok(host.value);
}

export type Found =
  | { readonly ok: true; readonly lane: Lane; readonly laneDir: string; readonly hostId: string | undefined; readonly host: HostConfig }
  | { readonly ok: false; readonly message: string };

/** The lane `name` in `host.yaml`; a missing file is an error. */
export function findLane(p: Pick<HostPaths, "xarabot" | "hostYaml">, name: string): Found {
  let text: string;
  try {
    text = readFileSync(p.hostYaml, "utf8");
  } catch (e) {
    return { ok: false, message: `${p.hostYaml}: cannot read: ${message(e)}` };
  }
  const host = loadHostConfig(text, p.hostYaml);
  if (!host.ok) return { ok: false, message: host.error.message };
  const lane = Object.hasOwn(host.value.lanes, name) ? host.value.lanes[name] : undefined;
  if (lane === undefined) return { ok: false, message: `unknown lane ${JSON.stringify(name)} (not in ${p.hostYaml})` };
  return { ok: true, lane, laneDir: laneDirFor(p.xarabot, lane, name), hostId: host.value.host_id, host: host.value };
}
