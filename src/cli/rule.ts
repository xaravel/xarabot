import type { CredentialEnv } from "../adapters/forge/github/credentials.ts";
import type { Lane } from "../core/schemas/host.ts";
import { isUnitId, unitKind, type LaneIdentity } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { applyHostRuling, type HostRuling } from "../lane/rule.ts";
import { COORDINATOR_LANE } from "./lane-install.ts";
import { githubForge } from "./lane-commands.ts";
import { hostPaths, readHostConfig } from "./host-paths.ts";

/**
 * `xarabot rule release|rebuild <unit-id> [--repo <owner>/<name>]` (Story
 * 2.5b): the Maintainer's host ruling on a `parked` unit, one fenced ledger
 * edit. The repo is `--repo`, or the only repo among `host.yaml`'s lanes. The
 * edit is written as `<lane owner>/<host_id>/<lane>`: the repo's coordinator
 * lane when the host has one, else its lowest-numbered `builder-<n>`. Other
 * verbs wait for Story 4.6's rulings and are refused before any file or forge
 * access.
 */

export const RULE_USAGE = "xarabot rule release|rebuild <unit-id> [--repo <owner>/<name>]";

const VERBS: readonly HostRuling[] = ["release", "rebuild"];
const BUILDER = /^builder-([1-9][0-9]*)$/;

export type RuleDeps = {
  readonly env: CredentialEnv;
  /** The forge the ruling writes through; default GitHub with the lane owner's App credentials. */
  readonly forge?: (lane: Lane) => Promise<{ readonly ok: true; readonly forge: Forge } | { readonly ok: false; readonly message: string }>;
  /** Each forge call's and the swap's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
};

/** The writer lane for `repo`: its coordinator lane, else its lowest-numbered builder. */
function writerLane(lanes: Readonly<Record<string, Lane>>, repo: string): { readonly name: string; readonly lane: Lane; readonly coordinator: boolean } | null {
  const forRepo = Object.entries(lanes).filter(([, l]) => l.repo === repo);
  const coordinator = forRepo.find(([name, l]) => name === COORDINATOR_LANE && l.role === "coordinator");
  if (coordinator !== undefined) return { name: coordinator[0], lane: coordinator[1], coordinator: true };
  let best: { readonly name: string; readonly lane: Lane; readonly n: number } | null = null;
  for (const [name, l] of forRepo) {
    const m = BUILDER.exec(name);
    if (m === null || l.role !== "builder") continue;
    const n = Number(m[1]);
    if (best === null || n < best.n) best = { name, lane: l, n };
  }
  return best === null ? null : { name: best.name, lane: best.lane, coordinator: false };
}

/** Runs `xarabot rule`; `args` follow `rule`. Returns the exit code. */
export async function ruleCommand(args: readonly string[], deps: RuleDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const errOut = deps.errOut ?? ((l: string) => console.error(l));
  const fail = (message: string): number => {
    errOut(`xarabot rule: ${message}`);
    return 1;
  };

  const [verb, unit, ...rest] = args;
  if (verb === undefined || verb.startsWith("-")) return fail(`usage: ${RULE_USAGE}`);
  // Before any file or forge access: other verbs are Story 4.6's.
  if (!(VERBS as readonly string[]).includes(verb)) return fail(`${verb}: not before Story 4.6`);
  const ruling = verb as HostRuling;
  if (unit === undefined || !isUnitId(unit)) {
    return fail(`${unit === undefined ? "no unit id" : `${JSON.stringify(unit)} is not a unit id`}; usage: ${RULE_USAGE}`);
  }
  let repoArg: string | null = null;
  if (rest.length === 2 && rest[0] === "--repo" && rest[1] !== undefined && rest[1] !== "") repoArg = rest[1];
  else if (rest.length !== 0) return fail(`usage: ${RULE_USAGE}`);

  const paths = hostPaths(deps.env);
  if (paths === null) return fail("HOME is not set");
  const host = readHostConfig(paths.hostYaml);
  if (!host.ok) return fail(host.error.message);
  if (host.value === null) return fail(`${paths.hostYaml} does not exist; run xarabot lane install first`);
  const hostId = host.value.host_id;
  if (hostId === undefined) return fail(`${paths.hostYaml} has no host_id; run xarabot lane install again`);

  const repos = [...new Set(Object.values(host.value.lanes).map((l) => l.repo))].sort();
  let repo: string;
  if (repoArg !== null) {
    if (!repos.includes(repoArg)) return fail(`no lane in ${paths.hostYaml} is for ${repoArg}`);
    repo = repoArg;
  } else if (repos.length === 1) {
    repo = repos[0] as string;
  } else if (repos.length === 0) {
    return fail(`${paths.hostYaml} has no lanes`);
  } else {
    return fail(`the lanes in ${paths.hostYaml} are for several repos (${repos.join(", ")}): name one with --repo`);
  }

  const writer = writerLane(host.value.lanes, repo);
  if (writer === null) return fail(`no coordinator or builder-<n> lane in ${paths.hostYaml} is for ${repo}`);
  const kind = unitKind(unit);
  // `next` counts coordinator PRs only on records whose lane is `coordinator`: a coordinator unit is ruled on as one.
  if (kind !== "story" && !writer.coordinator) {
    return fail(`${unit} is a ${kind ?? "unknown"} unit: a ruling on it is written as the coordinator lane, and ${paths.hostYaml} has none for ${repo}`);
  }
  const identity: LaneIdentity = { owner: writer.lane.owner, host: hostId, lane: writer.name };

  const made = await (deps.forge ?? ((l: Lane) => githubForge(deps.env, l)))(writer.lane);
  if (!made.ok) return fail(made.message);
  const r = await applyHostRuling({
    forge: made.forge,
    identity,
    unit,
    ruling,
    ...(deps.callTimeoutMs !== undefined ? { callTimeoutMs: deps.callTimeoutMs } : {}),
  });
  if (!r.ok) return fail(r.error.message);
  if (r.value.closedPr !== null) out(`closed PR #${r.value.closedPr}`);
  const { park } = r.value;
  out(`released ${unit} (${park.kind}${park.reason === null ? "" : ` ${park.reason}`})`);
  return 0;
}
