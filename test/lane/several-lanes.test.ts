import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { checkWrite, type WriteChange } from "../../src/core/lane/write-check.ts";
import { ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { CoordinatorRecord, LaneIdentity, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Committer } from "../../src/lane/committer.ts";
import { runCoordinatorProcess, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import { runLaneProcess, type LaneProcessResult } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { createPrStep } from "../../src/lane/pr-step.ts";
import type { Workspace } from "../../src/lane/workspace.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";

/**
 * Several lanes on one host (Story 2.11): two builder lanes and a
 * coordinator, each with its own lane folder, run concurrently on one fake
 * forge. The builders use the real PR step behind a committer that runs the
 * real write check over the paths each session changed.
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const B1: LaneIdentity = { owner: "alice", host: HOST, lane: "builder-1" };
const B2: LaneIdentity = { owner: "alice", host: HOST, lane: "builder-2" };
const COORD: LaneIdentity = { owner: "alice", host: HOST, lane: "coordinator" };
const BUILDER: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };
const COORDINATOR: Lane = { ...BUILDER, role: "coordinator" };
const FORGE_NOW = "2026-10-23T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const AUTHORITY = "docs/standing-authority.md";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const STATUS = `${SPEC_DIR}/sprint-status.yaml`;
const RETRO = `${SPEC_DIR}/retro-gates.yaml`;

type Story = { readonly id: string; readonly key: string; readonly glob: string; readonly also?: string };
const STORIES: readonly Story[] = [
  { id: "1.1", key: "1-1-first", glob: "src/s0" },
  { id: "1.2", key: "1-2-second", glob: "src/s1", also: STATUS },
  { id: "1.3", key: "1-3-third", glob: "src/s2", also: RETRO },
];
const storyOf = (unit: string): Story => {
  const s = STORIES.find((x) => `story:${x.id}` === unit);
  if (s === undefined) throw new Error(`no Story for ${unit}`);
  return s;
};

function mainFiles(): Record<string, string> {
  const epics = ["# Epics", "", "## Epic 1: One", ""];
  const status = ["development_status:", "  epic-1: in-progress"];
  for (const s of STORIES) {
    epics.push(`### Story ${s.id}: Story ${s.id}`, "", "Body.", "");
    status.push(`  ${s.key}: backlog`);
  }
  const files: Record<string, string> = {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "0.1.0"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "manifests:", "  dir: stories", ""].join("\n"),
    ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [claude]\n",
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    "_bmad-output/planning-artifacts/epics.md": `${epics.join("\n")}\n`,
    [`${SPEC_DIR}/epic-1-context.md`]: "# Epic 1 Context: One\n\nGoal.\n",
    [STATUS]: `${status.join("\n")}\n`,
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    "README.md": "hello\n",
  };
  for (const s of STORIES) {
    files[`stories/${s.id}.md`] = ["---", `story_id: "${s.id}"`, "epic: 1", `sprint_key: ${s.key}`, `title: Story ${s.id}`, `globs: ["${s.glob}/**"]`, "---", ""].join("\n");
  }
  return files;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeIn(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Every file under `root` but `.git/**`, as repo paths. */
function filesUnder(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (dir === root && name === ".git") continue;
    if (statSync(path).isDirectory()) out.push(...filesUnder(root, path));
    else out.push(relative(root, path));
  }
  return out.sort();
}

const AGENT: Agent = {
  vendor: "claude",
  defaultModel: "claude-opus-5-5",
  minVersion: "2.1.304",
  launchSpec: (_unit, settings, resultPath) =>
    ok({
      argv: ["stub-agent", settings.effort, resultPath],
      stdin: "",
      vendor: "claude",
      vendorHomeEnv: "STUB_HOME",
      credential: { file: "token", env: "STUB_TOKEN" },
      apiHosts: ["api.example.com"],
    } as AgentLaunchSpec),
  parseUsage: () => ({ sessionId: null, model: "claude-opus-5-5", tokens: null, cost: null, usageLimit: null }),
  effortValues: () => ["high"],
  startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
  checkModel,
};

type Session = { readonly lane: string; readonly unit: string };
type Commit = { readonly lane: string; readonly unit: string; readonly paths: readonly string[] };

/** A builder lane: its own folder, clone, sandbox and PR step on the shared forge. */
function builderLane(fake: FakeForge, root: string, identity: LaneIdentity, sessions: Session[], commits: Commit[]) {
  const laneDir = join(root, "repos", "xaravel__xarabot", "lanes", identity.lane);
  const clone = join(laneDir, "clone");
  let prepared: string | null = null;
  const workspace: Workspace = {
    async prepare(p) {
      prepared = p.unit;
      rmSync(clone, { recursive: true, force: true });
      writeIn(clone, ".git/HEAD", `ref: refs/heads/${p.branch}\n`);
      writeIn(clone, "README.md", "hello\n");
      return ok({ sha: p.start, resumed: false });
    },
  };
  const sandbox: Sandbox = {
    async run(_spec, profile) {
      const unit = prepared ?? "none";
      const first = !sessions.some((x) => x.lane === identity.lane);
      sessions.push({ lane: identity.lane, unit });
      // A lane's first session ends only once the other builder has started one, so both builders always work
      // and the other lanes run while this one holds its claim.
      if (first) await until(() => sessions.some((x) => x.lane !== identity.lane));
      const s = storyOf(unit);
      writeIn(profile.clone, `${s.glob}/code.ts`, `// ${s.id}\n`);
      writeIn(profile.clone, `${SPEC_DIR}/spec-${s.key}.md`, "---\ntitle: 'Story'\nstatus: 'done'\n---\n\n# Story\n\n## Auto Run Result\n\nStatus: done\n");
      if (s.also !== undefined) writeIn(profile.clone, s.also, "agent edit\n");
      writeFileSync(profile.resultPath, JSON.stringify({ kind: "build", outcome: "done", summary: "Did it", body: "", verification: ["bun test"], denied_actions: [] }));
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };
  // The real write check over the session's changed paths: everything in the clone but README.md, which main has too.
  const committer: Committer = {
    async commit(r) {
      const changes: WriteChange[] = filesUnder(clone)
        .filter((p) => p !== "README.md")
        .map((path) => ({ path, mode: "100644" }));
      const refusals = checkWrite(r.rules, changes);
      if (refusals.length > 0) return ok({ kind: "refused", refusals, reverted: [] });
      commits.push({ lane: identity.lane, unit: r.unit, paths: changes.map((c) => c.path) });
      return ok({ kind: "committed", base_sha: r.ontoSha, head_sha: fake.control.makeCommit() });
    },
  };
  const prStep = createPrStep({ forge: fake.forge, committer, identity, repo: BUILDER.repo, provider: "anthropic", sleep: async () => {}, random: () => 0 });
  let tick = 0;
  const once = (): Promise<LaneProcessResult> =>
    runLaneProcess({
      forge: fake.forge,
      agent: AGENT,
      sandbox,
      store: createFsLaneStore({ laneDir, hostStop: join(root, "STOP") }),
      workspace,
      prStep,
      laneDir,
      identity,
      lane: BUILDER,
      pid: identity.lane === "builder-1" ? 1001 : 1002,
      now: () => T0 + 1000 * tick++,
      sleep: async () => {
        await Bun.sleep(0);
      },
      random: () => 0,
      waiter: { wait: async () => ({ end: "elapsed" as const }) },
    });
  return { laneDir, once };
}

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the other builder's session");
    await Bun.sleep(1);
  }
}

/** Runs a lane's processes one after another, as its launchd job would, until one ends idle (at most `max`). */
async function untilIdle(once: () => Promise<LaneProcessResult>, max: number): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const r = await once();
    outcomes.push(r.outcome);
    if (r.outcome === "idle" || r.outcome === "stop") break;
  }
  return outcomes;
}

describe("two builder lanes and a coordinator on one host", () => {
  test("race: each Story is claimed and sessioned once in total; no committed change touches a status file; those sessions park write-check; the coordinator claims no Story", async () => {
    const root = mkdtempSync(join(tmpdir(), "xarabot-several-"));
    dirs.push(root);
    const claim: CoordinatorRecord = {
      schema_version: 5,
      owner: COORD.owner,
      host: COORD.host,
      lane: "coordinator",
      generation: 1,
      heartbeat_at: FORGE_NOW,
      digest_posted_at: "2026-10-23T08:00:00Z",
      rulings_cursor: null,
    };
    const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles(), ledger: { [COORDINATOR_PATH]: serializeCoordinator(claim) } });
    const sessions: Session[] = [];
    const commits: Commit[] = [];
    const one = builderLane(fake, root, B1, sessions, commits);
    const two = builderLane(fake, root, B2, sessions, commits);

    const coordinatorDir = join(root, "repos", "xaravel__xarabot", "lanes", "coordinator");
    const coordinatorUnits: string[] = [];
    let coordTick = 0;
    const coordinatorOnce = (): Promise<LaneProcessResult> =>
      runCoordinatorProcess({
        forge: fake.forge,
        agent: AGENT,
        store: createFsLaneStore({ laneDir: coordinatorDir, hostStop: join(root, "STOP") }),
        laneDir: coordinatorDir,
        identity: COORD,
        lane: COORDINATOR,
        claim,
        steps: {
          // A reconcile that finds nothing to do; it records what the coordinator was handed.
          reconcile: async (input: CoordinatorStepInput) => {
            coordinatorUnits.push(input.unit.unit);
            await Bun.sleep(1);
            return { outcome: "progress", state: "claimed" };
          },
        },
        pid: 1003,
        now: () => T0 + 1000 * coordTick++,
        sleep: async () => {
          await Bun.sleep(0);
        },
        random: () => 0,
        waiter: { wait: async () => ({ end: "elapsed" as const }) },
      });

    const [b1, b2, c] = await Promise.all([untilIdle(one.once, 6), untilIdle(two.once, 6), untilIdle(coordinatorOnce, 3)]);
    expect(b1.at(-1)).toBe("idle");
    expect(b2.at(-1)).toBe("idle");
    expect(c.length).toBeGreaterThan(0);

    // Distinct lane folders, each with its own journal.
    expect(one.laneDir).not.toBe(two.laneDir);

    // Each Story claimed once, sessioned once, across both builders.
    const claims = fake.control.ledgerLog().map((x) => x.message);
    for (const s of STORIES) {
      expect(claims.filter((m) => m === `ledger: claim story:${s.id} [skip ci]`)).toHaveLength(1);
      expect(sessions.filter((x) => x.unit === `story:${s.id}`)).toHaveLength(1);
    }
    expect(sessions).toHaveLength(3);
    // Both builders worked: each sessioned (and so claimed) at least one Story.
    for (const lane of ["builder-1", "builder-2"]) expect(sessions.filter((x) => x.lane === lane).length).toBeGreaterThanOrEqual(1);

    // Only Story 1.1's change is committed, and no committed change touches a status file.
    expect(commits.map((x) => x.unit)).toEqual(["story:1.1"]);
    for (const x of commits) {
      expect(x.paths).not.toContain(STATUS);
      expect(x.paths).not.toContain(RETRO);
    }

    const snap = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    if (!snap.ok) throw new Error(snap.error.message);
    const ledger = parseLedger(snap.value.ledger.files);
    if (!ledger.ok) throw new Error(ledger.error.message);
    const units = new Map<string, UnitRecord>(ledger.value.units);
    expect(units.get("story:1.1")).toMatchObject({ state: "claimed", attempts: 0 });
    expect(units.get("story:1.1")?.pr).not.toBeNull();
    for (const id of ["1.2", "1.3"]) {
      expect(units.get(`story:${id}`)).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "write-check" }, pr: null });
    }
    // Every Story is a builder's; the coordinator was handed no Story and holds none.
    for (const s of STORIES) expect(["builder-1", "builder-2"]).toContain(units.get(`story:${s.id}`)?.lane as string);
    expect(coordinatorUnits.every((u) => !u.startsWith("story:"))).toBe(true);
    expect([...units.values()].filter((r) => r.lane === "coordinator").every((r) => !r.unit.startsWith("story:"))).toBe(true);
    // One PR, on Story 1.1's branch.
    expect(Object.keys(snap.value.prs)).toEqual(["story:1.1"]);
  });
});
