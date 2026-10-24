import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHubForge } from "../adapters/forge/github/github-forge.ts";
import { loadAppCredentials, type CredentialEnv } from "../adapters/forge/github/credentials.ts";
import { loadHostConfig } from "../core/config/load-host-config.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaneIdentity } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { createPsProcessTable, describeKill, type ProcessTable } from "../lane/processes.ts";
import { releaseHeld, stopNow, wakeLane, writeStop, type ReleaseReport } from "../lane/stop.ts";

/**
 * `xarabot wake <lane>`, `xarabot stop <lane>`, `xarabot stop --all` and
 * `xarabot stop --now <lane>` (FR15, AR3, AR23, AR44). Paths come from
 * `HOME` and `XDG_CONFIG_HOME`; a lane is a key of `host.yaml`'s `lanes`.
 */

export type LaneCommandDeps = {
  readonly env: CredentialEnv;
  /** Default `ps` and SIGTERM. */
  readonly table?: ProcessTable;
  /** The forge `stop --now` releases through; default GitHub with the owner's App credentials. */
  readonly forge?: (lane: Lane) => Promise<{ readonly ok: true; readonly forge: Forge } | { readonly ok: false; readonly message: string }>;
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
};

export const LANE_USAGE = "xarabot wake <lane> | xarabot stop <lane> | xarabot stop --all | xarabot stop --now <lane>";

type Paths = { readonly xarabot: string; readonly hostYaml: string };

function paths(env: CredentialEnv): Paths | null {
  const home = env["HOME"];
  if (home === undefined || home === "") return null;
  const xdg = env["XDG_CONFIG_HOME"];
  const config = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
  return { xarabot: join(home, ".xarabot"), hostYaml: join(config, "xarabot", "host.yaml") };
}

/** A lane's folder: `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`. */
export function laneDirFor(xarabot: string, lane: Lane, name: string): string {
  const [owner, repo] = lane.repo.split("/") as [string, string];
  return join(xarabot, "repos", `${owner}__${repo}`, "lanes", name);
}

type Found = { readonly ok: true; readonly lane: Lane; readonly laneDir: string; readonly hostId: string | undefined } | { readonly ok: false; readonly message: string };

function findLane(p: Paths, name: string): Found {
  let text: string;
  try {
    text = readFileSync(p.hostYaml, "utf8");
  } catch (e) {
    return { ok: false, message: `${p.hostYaml}: cannot read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const host = loadHostConfig(text, p.hostYaml);
  if (!host.ok) return { ok: false, message: host.error.message };
  const lane = Object.hasOwn(host.value.lanes, name) ? host.value.lanes[name] : undefined;
  if (lane === undefined) return { ok: false, message: `unknown lane ${JSON.stringify(name)} (not in ${p.hostYaml})` };
  return { ok: true, lane, laneDir: laneDirFor(p.xarabot, lane, name), hostId: host.value.host_id };
}

async function githubForge(env: CredentialEnv, lane: Lane): Promise<{ readonly ok: true; readonly forge: Forge } | { readonly ok: false; readonly message: string }> {
  const creds = await loadAppCredentials({ login: lane.owner, env });
  if (!creds.ok) return { ok: false, message: `credentials ${creds.error.kind}: ${creds.error.message}` };
  const [owner, name] = lane.repo.split("/") as [string, string];
  return { ok: true, forge: createGitHubForge({ repo: { owner, name }, credentials: creds.value }) };
}

/** Runs a `wake` or `stop` command; returns the exit code. `args` start with the command word. */
export async function laneCommand(args: readonly string[], deps: LaneCommandDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const errOut = deps.errOut ?? ((l: string) => console.error(l));
  const fail = (message: string): number => {
    errOut(`xarabot ${args[0] ?? ""}: ${message}`);
    return 1;
  };
  const p = paths(deps.env);
  if (p === null) return fail("HOME is not set");
  const table = deps.table ?? createPsProcessTable();

  if (args.length === 2 && args[0] === "stop" && args[1] === "--all") {
    const path = join(p.xarabot, "STOP");
    const w = writeStop(path);
    if (!w.ok) return fail(w.error.message);
    out(`wrote ${path}`);
    return 0;
  }

  const name = args.length === 2 && args[1] !== "--now" ? args[1] : args.length === 3 && args[1] === "--now" ? args[2] : undefined;
  if (name === undefined || (args[0] !== "wake" && args[0] !== "stop") || (args[0] === "wake" && args.length !== 2)) {
    return fail(`usage: ${LANE_USAGE}`);
  }
  const found = findLane(p, name);
  if (!found.ok) return fail(found.message);

  if (args[0] === "wake") {
    const r = wakeLane(table, found.laneDir);
    if (r.kind !== "killed") return fail(describeKill("wait", r));
    out(describeKill("wait", r));
    return 0;
  }

  if (args.length === 2) {
    const path = join(found.laneDir, "STOP");
    const w = writeStop(path);
    if (!w.ok) return fail(w.error.message);
    out(`wrote ${path}`);
    return 0;
  }

  // stop --now <lane>
  const lane = found.lane;
  const hostId = found.hostId;
  const release = async (): Promise<ReleaseReport> => {
    if (hostId === undefined) return { released: [], failed: [] };
    const made = await (deps.forge ?? ((l: Lane) => githubForge(deps.env, l)))(lane);
    if (!made.ok) return { released: [], failed: [{ unit: null, message: made.message }] };
    const identity: LaneIdentity = { owner: lane.owner, host: hostId, lane: name };
    return releaseHeld({ forge: made.forge, identity });
  };
  const report = await stopNow({ laneDir: found.laneDir, table, release });
  let code = 0;
  if (report.stop.ok) out(`wrote ${join(found.laneDir, "STOP")}`);
  else {
    errOut(`xarabot stop: STOP: ${report.stop.error.message}`);
    code = 1;
  }
  for (const k of report.kills) {
    if (k.report.kind === "skipped" && k.report.reason === "kill-failed") {
      errOut(`xarabot stop: ${describeKill(k.name, k.report)}`);
      code = 1;
    } else out(describeKill(k.name, k.report));
  }
  if (hostId === undefined) out("release: host.yaml has no host_id, nothing to release");
  for (const u of report.release.released) out(`released ${u}`);
  for (const f of report.release.failed) {
    errOut(`xarabot stop: release${f.unit === null ? "" : ` ${f.unit}`}: ${f.message}`);
    code = 1;
  }
  return code;
}
