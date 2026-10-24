import { join } from "node:path";
import { createGitHubForge } from "../adapters/forge/github/github-forge.ts";
import { loadAppCredentials, type CredentialEnv } from "../adapters/forge/github/credentials.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaneIdentity } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { createPsProcessTable, describeKill, type ProcessTable } from "../lane/processes.ts";
import { releaseHeld, stopNow, wakeLane, writeStop, type ReleaseReport } from "../lane/stop.ts";
import { findLane, hostPaths, laneDirFor } from "./host-paths.ts";

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

export { laneDirFor };

/** A GitHub forge for `lane`'s repo with its owner's App credentials. */
export async function githubForge(env: CredentialEnv, lane: Lane): Promise<{ readonly ok: true; readonly forge: Forge } | { readonly ok: false; readonly message: string }> {
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
  const p = hostPaths(deps.env);
  if (p === null) return fail("HOME is not set");
  const table = deps.table ?? createPsProcessTable();

  if (args.length === 2 && args[0] === "stop" && args[1] === "--all") {
    const path = p.hostStop;
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
