import type { CredentialEnv } from "../adapters/forge/github/credentials.ts";
import type { Lane } from "../core/schemas/host.ts";
import { isUnitId, PENDING_RULING_VERBS, unitKind, type LaneIdentity } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { RULING_VERBS } from "../core/rulings/rulings.ts";
import { applyHostRuling, applyHostVerb, type HostRuling, type HostVerb, type HostVerbReport } from "../lane/rule.ts";
import { COORDINATOR_LANE } from "./lane-install.ts";
import { githubForge } from "./lane-commands.ts";
import { hostPaths, readHostConfig } from "./host-paths.ts";

/**
 * `xarabot rule <verb> <unit-id> [--repo <owner>/<name>]` (Stories 2.5b and
 * 4.6): the Maintainer's host ruling, with the same edit as the comment
 * ruling. `release` and `rebuild` keep Story 2.5b's path: one fenced ledger
 * edit on a `parked` unit. Every other verb is judged as the Maintainer
 * against one assembled snapshot (a refusal exits 1 with the reason) and
 * swaps the same `applyRuling` or `recordRulings` edit, without moving the
 * rulings cursor. The repo is `--repo`, or the only repo among `host.yaml`'s
 * lanes. The edit is written as `<lane owner>/<host_id>/<lane>`: the repo's
 * coordinator lane when the host has one, else its lowest-numbered
 * `builder-<n>`. `go`, `block`, `unblock`, `done`, `defer` and `dismiss`
 * write `coordinator.json`, so they need the repo's coordinator lane on the
 * host. An unknown verb is refused before any file or forge access.
 */

export const RULE_USAGE = `xarabot rule ${RULING_VERBS.join("|")} <unit-id> [--repo <owner>/<name>]`;

const VERBS: readonly string[] = RULING_VERBS;
/** Story 2.5b's verbs, on its own path. */
const HOST_RULINGS: readonly HostRuling[] = ["release", "rebuild"];
/** The verbs that write `coordinator.json`: only its coordinator lane may. */
const COORDINATOR_VERBS: readonly string[] = [...PENDING_RULING_VERBS, "dismiss"];

const BUILDER = /^builder-([1-9][0-9]*)$/;

/** What a host verb did, as one line. */
function reported(r: HostVerbReport): string {
  const e = r.effect;
  switch (e.kind) {
    case "ledger":
      // Only `approve` takes this path: `release` and `rebuild` keep Story 2.5b's.
      switch (e.verb) {
        case "approve":
          return `approved ${r.unit} (manifest ${e.approval?.manifest_sha}): released`;
        case "release":
        case "rebuild":
          return `${e.verb === "release" ? "released" : "rebuilt"} ${r.unit}`;
      }
    case "pending":
      return `recorded ${e.entry.verb} ${r.unit} as pending: the next reconcile PR writes it to retro-gates.yaml`;
    case "dismissal":
      return `dismissed ${r.unit} from the inbox`;
  }
}

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
  // Before any file or forge access.
  if (!VERBS.includes(verb)) return fail(`${verb} is not a verb; usage: ${RULE_USAGE}`);
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
  if (COORDINATOR_VERBS.includes(verb) && !writer.coordinator) {
    return fail(`${verb} writes coordinator.json, so it is written as the repo's coordinator lane, and ${paths.hostYaml} has none for ${repo}`);
  }
  // `next` counts coordinator PRs only on records whose lane is `coordinator`: a coordinator unit is ruled on as one.
  if (kind !== "story" && !writer.coordinator) {
    return fail(`${unit} is a ${kind ?? "unknown"} unit: a ruling on it is written as the coordinator lane, and ${paths.hostYaml} has none for ${repo}`);
  }
  const identity: LaneIdentity = { owner: writer.lane.owner, host: hostId, lane: writer.name };

  const made = await (deps.forge ?? ((l: Lane) => githubForge(deps.env, l)))(writer.lane);
  if (!made.ok) return fail(made.message);
  if (!(HOST_RULINGS as readonly string[]).includes(verb)) {
    const v = await applyHostVerb({
      forge: made.forge,
      identity,
      repo,
      unit,
      verb: verb as HostVerb,
      ...(deps.callTimeoutMs !== undefined ? { callTimeoutMs: deps.callTimeoutMs } : {}),
    });
    if (!v.ok) return fail(v.error.message);
    out(reported(v.value));
    return 0;
  }
  const ruling = verb as HostRuling;
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
