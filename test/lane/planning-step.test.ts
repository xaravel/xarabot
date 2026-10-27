import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { checkWrite, type CoordinatorWriteRules, type WriteChange } from "../../src/core/lane/write-check.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { applyRuling } from "../../src/core/ledger/edits.ts";
import { coordinatorGlobs } from "../../src/core/next/coordinator.ts";
import { next } from "../../src/core/next/next.ts";
import { checkGraphChange } from "../../src/core/graph/graph-gate.ts";
import { assembleSnapshot, epicSourceLine } from "../../src/core/next/snapshot.ts";
import { planReconcile } from "../../src/core/reconcile/plan.ts";
import { err, ok, type Result } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { CoordinatorRecord, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Snapshot } from "../../src/core/schemas/snapshot.ts";
import type { Agent, AgentLaunchSpec, AgentUnit } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck } from "../../src/ports/forge.ts";
import type { Sandbox, SandboxProfile } from "../../src/ports/sandbox.ts";
import type { CommitOutcome } from "../../src/lane/commit.ts";
import type { CommitRequest, Committer } from "../../src/lane/committer.ts";
import { runCoordinatorProcess, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import type { DiffPathsRequest } from "../../src/lane/diff-paths.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { createPlanningStep, planningPrText, type PlanningStepDeps } from "../../src/lane/planning-step.ts";
import { createReconcileStep } from "../../src/lane/reconcile-step.ts";
import { MarkerStop, newTrack, readsPath, type PrStepOutput } from "../../src/lane/session.ts";
import type { WaitEnd, WaitParams } from "../../src/lane/wait.ts";
import type { PrepareParams, Workspace, WorkspaceErrorKind } from "../../src/lane/workspace.ts";
import { COORD, rec, tip } from "../core/ledger/fixtures.ts";
import { GRAPH_STATUS, graphFiles, stubGraphTrees, treeOf, unchangedGraph } from "./graph-stub.ts";
import { ledgerProviders, watchPushes } from "./push-providers.ts";
import { headPassedGate } from "../../src/lane/passed-gate.ts";
import { reviewStub, stubReviewStep } from "./review-stub.ts";

// ------------------------------------------------------------------ world

const FORGE_NOW = "2026-10-23T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const MIN = 60_000;
const AUTHORITY = "docs/standing-authority.md";
const EPICS = "_bmad-output/planning-artifacts/epics.md";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
const CONTEXT_2 = "_bmad-output/implementation-artifacts/epic-2-context.md";
const LANE: Lane = { repo: "xaravel/xarabot", role: "coordinator", owner: COORD.owner, agent: "claude", effort: "high" };
const PASS: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "success" }];
const FAIL: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "failure" }];
const opts = () => ({ signal: AbortSignal.timeout(5000) });
const minutesBefore = (m: number) => new Date(T0 - m * MIN).toISOString();

type MainOpts = {
  /** Epic 2's context file is missing: a status unit is due. */
  readonly contextMissing?: boolean;
  /** Epic 2's context file has its heading but no source line: stale, so a status unit is due (retro item 12). */
  readonly contextStale?: boolean;
  /** Story 2.2 has a heading but no manifest: a graph unit is due. */
  readonly graph?: boolean;
  /** Extra `policy.yaml` lines. */
  readonly policy?: readonly string[];
};

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const epic2 = o.graph === true ? "### Story 2.1: Second\n\nBody.\n\n### Story 2.2: Third\n\nBody.\n" : "### Story 2.1: Second\n\nBody.\n";
  const files: Record<string, string> = {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "v1"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "bootstrapped_epics: [1]", "manifests:", "  dir: stories", ""].join("\n"),
    ".xarabot/policy.yaml": ["schema_version: 1", "unattended_adapters: [claude]", ...(o.policy ?? []), ""].join("\n"),
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    ".xarabot/prompts/house.md": "HOUSE RULE: keep it short.\n",
    [EPICS]: `# Epics\n\n## Epic 1: One\n\n### Story 1.1: First\n\nBody.\n\n## Epic 2: Two\n\n${epic2}`,
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    [STATUS]: "development_status:\n  epic-1: done\n  1-1-first: done\n  epic-2: backlog\n  2-1-second: backlog\n",
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: First\nglobs: ["src/a/**"]\n---\n',
    "stories/2.1.md": '---\nstory_id: "2.1"\nepic: 2\nsprint_key: 2-1-second\ntitle: Second\nglobs: ["src/b/**"]\n---\n',
  };
  if (o.contextMissing !== true) files[CONTEXT_2] = `# Epic 2 Context: Two\n${o.contextStale === true ? "" : `${epicSourceLine(files[EPICS] as string, 2)}\n`}\nGoal.\n`;
  return files;
}

const CONFIG = { epics_path: EPICS, sprint_status_path: STATUS, retro_gates_path: RETRO, epic_context_path: "_bmad-output/implementation-artifacts/epic-<N>-context.md", retro_doc_glob: "x-<N>", manifests: { dir: "stories" } };
const STATUS_GLOBS = coordinatorGlobs({ kind: "planning", planning: "status" }, CONFIG);
const GRAPH_GLOBS = coordinatorGlobs({ kind: "planning", planning: "graph" }, CONFIG);

const coord = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: FORGE_NOW, ...over });

function claimRec(): CoordinatorRecord {
  return { schema_version: 2, ...COORD, lane: "coordinator", generation: 1, heartbeat_at: FORGE_NOW, digest_posted_at: "2026-10-23T08:00:00Z", rulings_cursor: null };
}

/** The last `reconcile` ran just now: not due, so `next` reaches planning. */
const RECENT = coord("reconcile:4", { state: "merged", heartbeat_at: FORGE_NOW });

// -------------------------------------------------------------- stubs

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A `planning` result's JSON. */
function planningResult(outcome: "done" | "nothing-due" | "blocked", summary = outcome === "blocked" ? "FAIL: Epic 2 has no acceptance criteria" : "Plan the sprint"): string {
  return JSON.stringify({ kind: "planning", outcome, summary, denied_actions: [] });
}

/** What one stub run does: write the result, or not. */
type Behavior = (ctx: { readonly profile: SandboxProfile; readonly n: number; readonly signal: AbortSignal }) => void | Promise<void>;
const writes =
  (text: string): Behavior =>
  ({ profile }) =>
    writeFileSync(profile.resultPath, text);

type Harness = {
  readonly fake: FakeForge;
  readonly laneDir: string;
  /** The stdin of each run: its prompt. */
  readonly prompts: string[];
  readonly prepares: PrepareParams[];
  readonly commits: CommitRequest[];
  readonly diffs: DiffPathsRequest[];
  readonly waits: WaitParams[];
  readonly logs: string[];
  readonly events: string[];
  readonly head: string;
  input(unit?: string, over?: Partial<CoordinatorStepInput>): Promise<CoordinatorStepInput>;
  run(unit?: string, over?: Partial<CoordinatorStepInput>, deps?: Partial<PlanningStepDeps>): Promise<PrStepOutput>;
  deps(over?: Partial<PlanningStepDeps>): PlanningStepDeps;
  ledger(): Promise<Map<string, UnitRecord>>;
  journal(): JournalRecord[];
};

type HarnessOpts = MainOpts & {
  /** The ledger records besides `coordinator.json`; default this run's own claimed `planning:status.1`. */
  readonly records?: readonly UnitRecord[];
  readonly behaviors?: readonly Behavior[];
  /** The usage limit each run reports; default none. */
  readonly usageLimits?: readonly ({ resetAt: number | null } | null)[];
  readonly waitEnds?: readonly WaitEnd[];
  /** What the stub committer returns; default a commit at `head`. */
  readonly committer?: (r: CommitRequest, h: { head: string }) => Result<CommitOutcome, WorkspaceErrorKind>;
  /** The paths the PR's diff changes; default the status file. */
  readonly diff?: readonly string[];
  /** The checks set on the committed head; default passing, `null` for none. */
  readonly checks?: readonly ForgeCheck[] | null;
};

/** A stale `planning:status.1` claimed record the process takes over, or the step's own record. */
const OWN_STATUS = coord("planning:status.1", { globs: STATUS_GLOBS });
const OWN_GRAPH = coord("planning:graph.1", { globs: GRAPH_GLOBS });

/** The fake forge, recording each call in order; a ledger swap is `ledgerSwap <edit> <unit>`. */
/**
 * `base` with the first ledger swap after a successful `openPr` failing: the
 * forge refuses it (`rejected`), or, with `lose`, another writer bumps
 * `unit`'s generation first, so the unit is lost.
 */
function failRecordAfterOpen(h: { readonly fake: FakeForge; ledger(): Promise<Map<string, UnitRecord>> }, base: Forge, unit: string, lose: boolean): Forge {
  let opened = false;
  return {
    ...base,
    openPr: async (r, o) => {
      const x = await base.openPr(r, o);
      opened = x.ok;
      return x;
    },
    ledgerSwap: async (oldSha, commit, o) => {
      if (!opened) return base.ledgerSwap(oldSha, commit, o);
      opened = false;
      if (!lose) return { ok: false, error: { kind: "rejected", message: "422" } };
      const current = (await h.ledger()).get(unit) as UnitRecord;
      h.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: tip([{ ...current, generation: current.generation + 1 }]), deletes: [] });
      return base.ledgerSwap(oldSha, commit, o);
    },
  };
}

function spied(fake: FakeForge, events: string[]): Forge {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(fake.forge)) {
    out[name] = (...args: unknown[]) => {
      if (name === "ledgerSwap") events.push(`ledgerSwap ${/^ledger: (\S+ \S+)/.exec((args[1] as { message: string }).message)?.[1] ?? ""}`);
      else if (name !== "snapshot") events.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as Forge;
}

function harness(o: HarnessOpts = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "xarabot-planning-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "coordinator");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const fake = createFakeForge({
    now: FORGE_NOW,
    main: mainFiles(o),
    ledger: tip(o.records ?? [OWN_STATUS], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }),
  });
  const events: string[] = [];
  const forge = spied(fake, events);
  const prompts: string[] = [];
  const prepares: PrepareParams[] = [];
  const commits: CommitRequest[] = [];
  const diffs: DiffPathsRequest[] = [];
  const waits: WaitParams[] = [];
  const logs: string[] = [];
  const head = fake.control.makeCommit();
  if (o.checks !== null) fake.control.setChecks(head, o.checks ?? PASS);
  let usageCalls = 0;
  let t = T0;

  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (unit: AgentUnit, settings, resultPath) =>
      ok({
        argv: ["stub-agent", settings.effort, resultPath],
        stdin: unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`,
        vendor: "claude",
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
      } as AgentLaunchSpec),
    parseUsage: () => {
      const i = usageCalls++;
      return { sessionId: null, model: "claude-opus-5-5", tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 0.25, estimate: false }, usageLimit: o.usageLimits?.[i] ?? null };
    },
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
    checkModel,
  };

  const sandbox: Sandbox = {
    async run(spec, profile, signal) {
      prompts.push(spec.stdin ?? "");
      const n = prompts.length;
      await o.behaviors?.[n - 1]?.({ profile, n, signal });
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };

  const workspace: Workspace = {
    async prepare(p) {
      prepares.push(p);
      return ok({ sha: p.start, resumed: false });
    },
  };

  const committer: Committer = {
    async commit(r) {
      commits.push(r);
      return o.committer?.(r, { head }) ?? ok({ kind: "committed", base_sha: r.ontoSha, head_sha: head });
    },
  };

  const deps = (over: Partial<PlanningStepDeps> = {}): PlanningStepDeps => ({
    forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    workspace,
    waiter: {
      async wait(p) {
        const n = waits.length;
        waits.push(p);
        return { end: o.waitEnds?.[n] ?? "elapsed" };
      },
    },
    laneDir,
    lane: LANE,
    committer,
    diffPaths: async (r) => {
      diffs.push(r);
      return ok(o.diff ?? [STATUS]);
    },
    graphTrees: unchangedGraph(),
    identity: COORD,
    provider: "anthropic",
    // A clean review round on the unspied forge: it records passed_sha, and the call log stays the step's own.
    review: stubReviewStep({ forge: fake.forge, identity: COORD }).review,
    passed: headPassedGate,
    secrets: ["sekrit-credential"],
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0,
    ...over,
  });

  const input = async (unit = "planning:status.1", over: Partial<CoordinatorStepInput> = {}): Promise<CoordinatorStepInput> => {
    const s = await fake.forge.snapshot({ ...opts(), read: readsPath });
    if (!s.ok) throw new Error(s.error.message);
    const a = assembleSnapshot({
      repo: LANE.repo,
      now: s.value.now,
      tree: [...s.value.main.tree],
      files: { ...s.value.main.files },
      main_sha: s.value.main.sha,
      blob_shas: s.value.main.blob_shas,
      ledger_tip: s.value.ledger.tip,
      ledger_files: s.value.ledger.files,
      prs: s.value.prs,
      escalations: null,
      lane: COORD,
      role: "coordinator",
    });
    if (!a.ok) throw new Error(a.error.message);
    const record = a.value.ledger.units.find((r) => r.unit === unit) as UnitRecord;
    return {
      unit: { unit, kind: "planning", globs: record.globs, expect_generation: null, take_over: null, pr: record.pr, why: "test" },
      record,
      snapshot: a.value,
      files: s.value.main.files,
      signal: new AbortController().signal,
      log: (text) => logs.push(text),
      track: newTrack({ unit, startedMs: T0, logName: "planning.log", state: "claimed" }),
      ...over,
    };
  };

  const h: Harness = {
    fake,
    laneDir,
    prompts,
    prepares,
    commits,
    diffs,
    waits,
    logs,
    events,
    head,
    input,
    async run(unit, over, d) {
      const i = await input(unit, over);
      events.length = 0;
      return createPlanningStep(deps(d))(i);
    },
    deps,
    async ledger() {
      const s = await fake.forge.snapshot(opts());
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return new Map(l.value.units);
    },
    journal() {
      const path = join(laneDir, "journal.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as JournalRecord);
    },
  };
  return h;
}

const swaps = (events: readonly string[]) => events.filter((e) => e.startsWith("ledgerSwap ")).map((e) => e.slice("ledgerSwap ".length));

/** `branch`'s head on the forge, or `null` once it is deleted. */
async function branchHead(h: Harness, branch: string) {
  const r = await h.fake.forge.branchHead(branch, opts());
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function prOnBranch(h: Harness, branch: string) {
  const r = await h.fake.forge.listPrsByBranch(branch, opts());
  if (!r.ok) throw new Error(r.error.message);
  return r.value.at(-1) ?? null;
}

// ------------------------------------------------------------------ texts

describe("planning PR text", () => {
  test("names the unit and the summary, sanitized and redacted; the gate sentence by kind", () => {
    const t = planningPrText("planning:status.2", "status", { summary: "Plan @someone sekrit", denied_actions: ["git push"] }, ["sekrit"]);
    expect(t.title).toBe("planning:status.2: Plan someone [REDACTED]");
    expect(t.body.startsWith("🤖 planning:status.2: written by a status planning session.")).toBe(true);
    expect(t.body).toContain("unless policy gates a path it changes");
    expect(t.body).toContain("Denied actions:\n- git push");
    expect(planningPrText("planning:graph.1", "graph", { summary: "x", denied_actions: [] }).body).toContain("waits for the owner's approval");
  });
});

// ------------------------------------------------------------------ the session's outcomes

describe("createPlanningStep: the result", () => {
  test("AC: a blocked status result parks blocked readiness with no globs held; the reason carries the findings; nothing committed", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("blocked"))] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    // Story 4.2: the readiness summary is kept as the park's text, for the inbox.
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({
      state: "parked",
      park: { kind: "blocked", reason: "readiness", globs_held: [], text: "FAIL: Epic 2 has no acceptance criteria" },
    });
    expect(out.reason).toBe("blocked readiness: FAIL: Epic 2 has no acceptance criteria");
    expect(h.commits).toEqual([]);
  });

  test("the park's text is redacted with the lane's secrets through parkBlocked (Story 4.2)", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("blocked", "FAIL: the run printed sekrit-credential, ask @bob"))] });
    await h.run();
    const text = (await h.ledger()).get("planning:status.1")?.park?.text ?? "";
    expect(text).toBe("FAIL: the run printed [REDACTED], ask bob");
    expect(text).not.toContain("sekrit-credential");
  });

  test("a blocked graph result parks blocked readiness too", async () => {
    const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("blocked", "cannot tell what 2.2 builds on"))] });
    const out = await h.run("planning:graph.1");
    expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ state: "parked", park: { reason: "readiness" } });
    expect(out.reason).toBe("blocked readiness: cannot tell what 2.2 builds on");
  });

  test("nothing-due: merged with no PR, then the record deleted at once", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("nothing-due", "all in place"))] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect((await h.ledger()).has("planning:status.1")).toBe(false);
    expect(swaps(h.events)).toEqual(["finishRecurring planning:status.1", "deleteMerged planning:status.1"]);
    expect(out.reason).toContain("nothing-due: all in place");
  });

  test("done with an empty commit: merged with no PR, deleted, nothing pushed", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], committer: () => ok({ kind: "empty" }) });
    const out = await h.run();
    expect(out.state).toBe("merged");
    expect((await h.ledger()).has("planning:status.1")).toBe(false);
    expect(h.events).not.toContain("pushBranch");
  });

  test.each([
    ["no result file", [], /no result at/],
    ["invalid JSON", [writes("{")], /result invalid-json/],
    ["a build result", [writes(JSON.stringify({ kind: "build", outcome: "done", summary: "x", body: "", verification: [], denied_actions: [] }))], /result wrong-kind/],
    ["a planning result missing its summary", [writes(JSON.stringify({ kind: "planning", outcome: "done", denied_actions: [] }))], /result invalid/],
  ] as const)("%s: a failed attempt, released", async (_name, behaviors, why) => {
    const h = harness({ contextMissing: true, behaviors });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(out.reason).toMatch(why);
  });

  test("nothing due on the snapshot: no session; merged with no PR and deleted", async () => {
    const h = harness({});
    const out = await h.run();
    expect(h.prompts).toEqual([]);
    expect(out.state).toBe("merged");
    expect((await h.ledger()).has("planning:status.1")).toBe(false);
  });

  test("the session's track counts its runs and cost for the journal", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("blocked"))] });
    const i = await h.input();
    await createPlanningStep(h.deps())(i);
    expect([i.track.sessions, i.track.cost]).toEqual([1, { usd: 0.25, estimate: false }]);
  });

  test("an aborted signal (the unit lost) ends the step failed before any session, with no edit", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const ac = new AbortController();
    ac.abort();
    const out = await h.run("planning:status.1", { signal: ac.signal });
    expect(out.outcome).toBe("failed");
    expect(h.prompts).toEqual([]);
    expect(swaps(h.events)).toEqual([]);
  });
});

describe("createPlanningStep: the prompt and the clone", () => {
  test("status: the clone at main on xarabot/planning-status.1; the prompt runs bmad-sprint-planning and compiles Epic 2's context; the repo sections ride along", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("blocked"))] });
    const i = await h.input();
    await createPlanningStep(h.deps())(i);
    expect(h.prepares.map((p) => [p.unit, p.branch, p.start])).toEqual([["planning:status.1", "xarabot/planning-status.1", i.snapshot.main_sha]]);
    const p = h.prompts[0] ?? "";
    expect(p).toContain("`bmad-sprint-planning`");
    expect(p).toContain(`- Epic 2: output path \`${CONTEXT_2}\`, source line \`${epicSourceLine(mainFiles()[EPICS] as string, 2)}\``);
    expect(p).toContain("directly below its `# Epic <N> Context:` heading");
    expect(p).toContain("HOUSE RULE: keep it short.");
    expect(p).toContain(join(h.laneDir, "tmp"));
  });

  test("status: a stale Epic 2 context (no source line) is due; the prompt gives the source line of Epic 2's section on main", async () => {
    const h = harness({ contextStale: true, behaviors: [writes(planningResult("blocked"))] });
    await h.run();
    const p = h.prompts[0] ?? "";
    const source = epicSourceLine(mainFiles()[EPICS] as string, 2) ?? "";
    expect(source).toMatch(/^<!-- source: sha256:[0-9a-f]{64} -->$/);
    expect(p).toContain(`- Epic 2: output path \`${CONTEXT_2}\`, source line \`${source}\``);
  });

  test("graph: the prompt names Story 2.2's heading and the manifests folder, and runs no skill", async () => {
    const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("blocked"))] });
    await h.run("planning:graph.1");
    const p = h.prompts[0] ?? "";
    expect(p).toMatch(/- Story 2\.2 \(Epic 2\), line [0-9]+/);
    expect(p).toContain("write `stories/<id>.md`");
    expect(p).toContain("Run no skill, and never run `bmad-sprint-planning`.");
    expect(h.prepares[0]?.branch).toBe("xarabot/planning-graph.1");
  });
});

// ------------------------------------------------------------------ commit, push, PR, CI and the gate

describe("createPlanningStep: done", () => {
  test("the push fence writes the lane's vendor to builder_providers before the branch moves; the record keeps it", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], diff: [STATUS, CONTEXT_2] });
    const watched = watchPushes(h.deps().forge, h.fake, "planning:status.1");
    const out = await h.run(undefined, undefined, { forge: watched.forge });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(watched.seen).toEqual([["anthropic"]]);
    expect((await h.ledger()).get("planning:status.1")?.builder_providers).toEqual(["anthropic"]);
  });

  test("a codex coordinator's push onto a record anthropic built: [anthropic, openai]", async () => {
    const h = harness({ records: [{ ...OWN_STATUS, builder_providers: ["anthropic"] }], contextMissing: true, behaviors: [writes(planningResult("done"))], diff: [STATUS, CONTEXT_2] });
    const watched = watchPushes(h.deps().forge, h.fake, "planning:status.1");
    const out = await h.run(undefined, undefined, { forge: watched.forge, provider: "openai" });
    expect(out.outcome).toBe("progress");
    expect(watched.seen).toEqual([["anthropic", "openai"]]);
    expect((await h.ledger()).get("planning:status.1")?.builder_providers).toEqual(["anthropic", "openai"]);
  });

  test("AC: a status done result changing only status and context files, CI passing, policy gating nothing: merging, enqueued at the head", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], diff: [STATUS, CONTEXT_2] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    const pr = await prOnBranch(h, "xarabot/planning-status.1");
    expect(pr).toMatchObject({ state: "open", head_sha: h.head, title: "planning:status.1: Plan the sprint" });
    expect(h.fake.control.queue()).toEqual([pr?.number as number]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "merging", pr: pr?.number, head_sha: h.head, passed_sha: h.head, approved_sha: null });
    // Fenced at each step: the push, the PR, the record, the passed head, merging; the enqueue follows.
    expect(h.events.filter((e) => e !== "checks")).toEqual([
      "branchHead",
      "ledgerSwap heartbeat planning:status.1",
      "pushBranch",
      "ledgerSwap heartbeat planning:status.1",
      "openPr",
      "ledgerSwap heartbeat planning:status.1",
      "ledgerSwap heartbeat planning:status.1",
      "ledgerSwap startMerging planning:status.1",
      "enqueue",
    ]);
    expect(h.diffs[0]?.headSha).toBe(h.head);
  });

  test("the commit goes onto fresh main under the coordinator write rules of the unit's globs", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    await h.run();
    const r = h.commits[0]?.rules as CoordinatorWriteRules;
    expect(r).toMatchObject({ role: "coordinator", graphUnit: false, globs: [...STATUS_GLOBS].sort() });
    expect(h.commits[0]?.message).toBe("planning:status.1: Plan the sprint\n");
    expect(h.commits[0]?.secrets).toEqual(["sekrit-credential"]);
  });

  test("AC: a graph unit whose CI passes parks awaiting-approval holding its diff's paths, with a 🤖 comment; never queued", async () => {
    const diff = [EPICS, "stories/2.2.md"];
    const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("done", "Add the Story 2.2 manifest"))], diff });
    const out = await h.run("planning:graph.1");
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const pr = (await prOnBranch(h, "xarabot/planning-graph.1"))?.number as number;
    expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ state: "parked", pr, head_sha: h.head, park: { kind: "awaiting-approval", reason: null, globs_held: diff } });
    const comments = h.fake.control.comments(pr);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.startsWith("🤖 Unit planning:graph.1: this PR changes paths that need the owner's approval:")).toBe(true);
    expect(h.fake.control.queue()).toEqual([]);
    expect(h.commits[0]?.rules).toMatchObject({ role: "coordinator", graphUnit: true });
  });

  test("a graph PR whose diff against fresh main is empty still parks awaiting-approval; never queued", async () => {
    const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("done", "Add the Story 2.2 manifest"))], diff: [] });
    const out = await h.run("planning:graph.1");
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get("planning:graph.1")?.park).toMatchObject({ kind: "awaiting-approval", globs_held: [] });
    expect(h.fake.control.queue()).toEqual([]);
  });

  describe("the graph-change gate (Story 2.8)", () => {
    const MAIN_GRAPH = graphFiles({ 1: ["1.1"], 2: ["2.1"] });
    const ADDED = graphFiles({ 1: ["1.1"], 2: ["2.1", "2.2"] });
    const graphRun = (answer: Parameters<typeof stubGraphTrees>[0]) => {
      const diff = [EPICS, "stories/2.2.md"];
      const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("done", "Add the Story 2.2 manifest"))], diff });
      const g = stubGraphTrees(answer);
      return { h, g, diff, out: h.run("planning:graph.1", {}, { graphTrees: g.trees }) };
    };

    /** The merge result's graph hash, as the gate computes it. */
    function hashOf(main: Record<string, string>, merged: Record<string, string>): string {
      const c = checkGraphChange({ main: treeOf(main), merged: treeOf(merged), ledgerUnits: [] });
      if (c.kind !== "checked") throw new Error("the graph change does not check");
      return c.mergedHash;
    }
    const HASH = hashOf(MAIN_GRAPH, ADDED);

    test("AC: a changed graph parks awaiting-approval for the Maintainer, the comment carrying the delta, then the gated paths; never queued", async () => {
      const { h, g, diff, out } = graphRun({ main: MAIN_GRAPH, merged: ADDED });
      expect([(await out).outcome, (await out).state]).toEqual(["progress", "parked"]);
      const pr = (await prOnBranch(h, "xarabot/planning-graph.1"))?.number as number;
      expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ state: "parked", park: { kind: "awaiting-approval", inbox_owner: "edanisko", globs_held: diff, graph_posted: HASH } });
      // The delta comment comes first, behind a fence; the park records its hash (retro item 30).
      expect(h.events.slice(-3)).toEqual(["ledgerSwap heartbeat planning:graph.1", "comment", "ledgerSwap park planning:graph.1"]);
      const comments = h.fake.control.comments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toStartWith("🤖 Unit planning:graph.1: this PR's merge with `main` changes the Epic graph");
      expect(comments[0]).toContain("- Stories added: Epic 2: +2.2");
      expect((comments[0] as string).indexOf("merge result's graph hash is")).toBeLessThan((comments[0] as string).indexOf("stories/2.2.md"));
      expect(h.fake.control.queue()).toEqual([]);
      expect(g.calls.map((c) => c.headSha)).toEqual([h.head]);
    });

    test("a failed delta comment still parks for the Maintainer, with none posted", async () => {
      const diff = [EPICS, "stories/2.2.md"];
      const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("done", "Add the Story 2.2 manifest"))], diff });
      h.fake.control.injectError("comment", { kind: "transient", message: "flaky" });
      const out = await h.run("planning:graph.1", {}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: ADDED }).trees });
      expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
      const record = (await h.ledger()).get("planning:graph.1");
      expect(out.reason).toContain(`graph delta comment on PR #${record?.pr} failed`);
      expect(record?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: diff });
      expect(h.fake.control.comments(record?.pr as number)).toEqual([]);
      expect(h.fake.control.queue()).toEqual([]);
    });

    test("reconcile takes the posted park on one later Maintainer approval, with no second comment or re-park", async () => {
      const answer = { main: MAIN_GRAPH, merged: ADDED };
      const { h, out } = graphRun(answer);
      await out;
      const parked = (await h.ledger()).get("planning:graph.1") as UnitRecord;
      expect(parked.park?.graph_posted).toBe(HASH);
      const pr = parked.pr as number;
      expect(h.fake.control.comments(pr)).toHaveLength(1);
      h.fake.control.addReview(pr, { author: "edanisko", state: "approved", commit_sha: h.head, submitted_at: new Date(T0 + 5 * MIN).toISOString() });
      // This lane's next unit: a reconcile run over the parked PR.
      h.fake.control.writeForeignLedger({ message: "seed reconcile [skip ci]", writes: tip([coord("reconcile:5", { state: "claimed" })]), deletes: [] });
      const base = await h.input("reconcile:5");
      const events: string[] = [];
      const taken = await createReconcileStep({
        forge: spied(h.fake, events),
        committer: {
          commit: async () => {
            throw new Error("no reconcile commit expected");
          },
        },
        graphTrees: stubGraphTrees(answer).trees,
        identity: COORD,
        repo: LANE.repo,
        agent: "claude",
        passed: headPassedGate,
        now: () => T0,
        sleep: async () => {},
        random: () => 0,
      })({ ...base, unit: { ...base.unit, kind: "reconcile", globs: [] }, track: newTrack({ unit: "reconcile:5", startedMs: T0, logName: "reconcile.log", state: "claimed" }) });
      expect(taken.outcome).toBe("progress");
      expect(swaps(events)).toContain("takeApproved planning:graph.1");
      expect(swaps(events)).not.toContain("reparkGraph planning:graph.1");
      expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ state: "merging", approved_sha: h.head, approved_graph: HASH, enqueued_sha: h.head });
      expect(h.fake.control.queue()).toEqual([pr]);
      expect(h.fake.control.comments(pr)).toHaveLength(1);
    });

    test("an unchanged graph parks as today, for the writer, with the gate comment", async () => {
      const { h, out } = graphRun({ main: MAIN_GRAPH, merged: MAIN_GRAPH });
      expect((await out).state).toBe("parked");
      const record = (await h.ledger()).get("planning:graph.1");
      expect(record?.park).toMatchObject({ kind: "awaiting-approval", inbox_owner: COORD.owner });
      const pr = record?.pr as number;
      expect(h.fake.control.comments(pr)[0]).toStartWith("🤖 Unit planning:graph.1: this PR changes paths that need the owner's approval:");
    });

    test("AC: a merge result that fails validation parks blocked graph-invalid with a comment naming it; nothing is enqueued", async () => {
      const cycle = { ...ADDED, ".xarabot/epics.yaml": "version: 1\nepics:\n  1: {depends_on: [2]}\n" };
      const { h, out } = graphRun({ main: MAIN_GRAPH, merged: cycle });
      const o = await out;
      expect([o.outcome, o.state]).toEqual(["progress", "parked"]);
      const record = (await h.ledger()).get("planning:graph.1");
      expect(record?.park).toMatchObject({ kind: "blocked", reason: "graph-invalid" });
      const [comment] = h.fake.control.comments(record?.pr as number);
      expect(comment).toContain("graph-invalid");
      expect(comment).toContain("cycle");
      expect(h.fake.control.queue()).toEqual([]);
      expect(h.diffs).toEqual([]);
    });

    test("a used Story dropped parks graph-invalid", async () => {
      const used = { ...MAIN_GRAPH, [GRAPH_STATUS]: "development_status:\n  2-1-s: in-progress\n" };
      const { h, out } = graphRun({ main: used, merged: { ...graphFiles({ 1: ["1.1"], 2: [] }), [GRAPH_STATUS]: used[GRAPH_STATUS] as string } });
      expect((await out).reason).toContain("Story 2.1 is removed, but it is used");
      expect((await h.ledger()).get("planning:graph.1")?.park).toMatchObject({ kind: "blocked", reason: "graph-invalid" });
    });

    test.each([
      ["a conflicting merge", { conflict: [EPICS] }],
      ["main not resolving", { main: { ...MAIN_GRAPH, ".xarabot/config.yaml": "x: [" }, merged: MAIN_GRAPH }],
    ] as const)("%s is a failed attempt", async (_name, answer) => {
      const { h, out } = graphRun(answer);
      expect([(await out).outcome, (await out).state]).toEqual(["failed", "released"]);
      expect((await h.ledger()).get("planning:graph.1")?.attempts).toBe(1);
      expect(h.fake.control.queue()).toEqual([]);
    });

    test("a status unit skips the gate", async () => {
      const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
      const g = stubGraphTrees({ error: "never called" });
      const out = await h.run("planning:status.1", {}, { graphTrees: g.trees });
      expect(out.state).toBe("merging");
      expect(g.calls).toEqual([]);
    });
  });

  test("a status PR policy gates (owner_approval_paths) parks awaiting-approval with the comment", async () => {
    const h = harness({ contextMissing: true, policy: ["owner_approval_paths: ['_bmad-output/**']"], behaviors: [writes(planningResult("done"))] });
    const out = await h.run();
    expect(out.state).toBe("parked");
    expect((await h.ledger()).get("planning:status.1")?.park).toMatchObject({ kind: "awaiting-approval", globs_held: [STATUS] });
    expect(h.fake.control.queue()).toEqual([]);
  });

  test("AC: a diff touching a graph input and a status file is refused by the write check: nothing pushed, parked write-check", async () => {
    const changes: WriteChange[] = [
      { path: STATUS, mode: "100644" },
      { path: EPICS, mode: "100644" },
    ];
    const h = harness({
      graph: true,
      records: [OWN_GRAPH],
      behaviors: [writes(planningResult("done"))],
      committer: (r) => {
        const refusals = checkWrite(r.rules, changes);
        return ok(refusals.length > 0 ? { kind: "refused", refusals, reverted: [] } : { kind: "committed", base_sha: r.ontoSha, head_sha: "f".repeat(40) });
      },
    });
    const out = await h.run("planning:graph.1");
    expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "write-check" } });
    expect(out.reason).toContain("(graph-and-status)");
    expect(h.events).not.toContain("pushBranch");
    expect(h.events).not.toContain("branchHead");
  });

  test.each([
    ["a commit conflict", () => ok({ kind: "conflict", paths: [STATUS], start: "e".repeat(40) } as CommitOutcome), /commit conflict onto/],
    ["a failed commit", () => err("transient", "disk full"), /commit transient: disk full/],
  ] as const)("%s is a failed attempt; nothing pushed", async (_name, committer, why) => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], committer });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(why);
    expect(h.events).not.toContain("pushBranch");
  });

  test("a refused push is a failed attempt", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    h.fake.control.refusePushes("xarabot/planning-status.1");
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(/pushBranch xarabot\/planning-status\.1 rejected/);
  });

  test("a failed openPr is a failed attempt", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    h.fake.control.injectError("openPr", { kind: "transient", message: "502" });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(/openPr transient: 502/);
  });

  test("a reused n: the branch an earlier run left is the push's lease", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const old = h.fake.control.makeCommit();
    expect((await h.fake.forge.pushBranch({ branch: "xarabot/planning-status.1", expected_sha: null, sha: old }, opts())).ok).toBe(true);
    const out = await h.run();
    expect(out.state).toBe("merging");
    expect(h.logs.some((l) => l.includes(`xarabot/planning-status.1 is at ${old}: the push leases from it`))).toBe(true);
  });

  test("CI failing parks blocked verification; no fix session", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], checks: FAIL });
    const out = await h.run();
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "verification" } });
    expect(out.reason).toContain("CI failed on");
    expect(h.prompts).toHaveLength(1);
  });

  test("CI still pending past ci_max_wait_minutes parks blocked ci-timeout", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], checks: null });
    const out = await h.run();
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "ci-timeout" } });
    expect(out.reason).toContain("still pending after 60 min");
  });

  test("an enqueue conflict: the disposable status PR is closed and the record released, no attempt", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    h.fake.control.injectError("enqueue", { kind: "conflict", message: "not mergeable" });
    const out = await h.run();
    expect(out.state).toBe("released");
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 0 });
    expect((await prOnBranch(h, "xarabot/planning-status.1"))?.state).toBe("closed");
    expect(swaps(h.events)).toContain("releaseDisposable planning:status.1");
    // Epic 2 retro item 21: its branch is deleted once the record is released.
    expect(h.events.slice(-2)).toEqual(["ledgerSwap releaseDisposable planning:status.1", "deleteBranch"]);
    expect(await branchHead(h, "xarabot/planning-status.1")).toBeNull();
  });

  test("an enqueue conflict whose branch delete fails: still released with no attempt; the branch is left, the reason naming the delete", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    h.fake.control.injectError("enqueue", { kind: "conflict", message: "not mergeable" });
    h.fake.control.injectError("deleteBranch", { kind: "transient", message: "502" });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "released"]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 0 });
    expect(out.reason).toContain("deleteBranch xarabot/planning-status.1 transient: 502; the branch is left");
    expect(await branchHead(h, "xarabot/planning-status.1")).not.toBeNull();
  });

  test("an enqueue conflict whose closePr fails: a failed attempt, released with attempts 1, the reason naming the close", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    h.fake.control.injectError("enqueue", { kind: "conflict", message: "not mergeable" });
    h.fake.control.injectError("closePr", { kind: "transient", message: "502" });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(out.reason).toContain("closePr PR #");
    expect(out.reason).toContain("transient: 502");
    expect(swaps(h.events)).not.toContain("releaseDisposable planning:status.1");
  });

  test("the record beat fails after openPr: the new PR, which no record carries, is closed, then a failed attempt", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const events: string[] = [];
    const out = await h.run("planning:status.1", {}, { forge: failRecordAfterOpen(h, spied(h.fake, events), "planning:status.1", false) });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 1, pr: null });
    expect((await prOnBranch(h, "xarabot/planning-status.1"))?.state).toBe("closed");
    // The refused record swap never reaches the spy; the close comes before the failed attempt.
    expect(events.slice(events.indexOf("openPr"))).toEqual(["openPr", "closePr", "ledgerSwap failAttempt planning:status.1"]);
    expect(out.reason).toContain("which no record carries");
  });

  test("the unit lost at the record beat after openPr: the new PR is closed, no further edit", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const events: string[] = [];
    const out = await h.run("planning:status.1", {}, { forge: failRecordAfterOpen(h, spied(h.fake, events), "planning:status.1", true) });
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "claimed", pr: null });
    expect((await prOnBranch(h, "xarabot/planning-status.1"))?.state).toBe("closed");
    expect(events).not.toContain("ledgerSwap failAttempt planning:status.1");
  });

  test("openPr fails after the forge opened the PR: the orphan on the branch is closed, fenced, then a failed attempt", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const events: string[] = [];
    const base = spied(h.fake, events);
    const forge: Forge = {
      ...base,
      openPr: async (r, o) => {
        expect((await base.openPr(r, o)).ok).toBe(true);
        return { ok: false, error: { kind: "transient", message: "timeout" } };
      },
    };
    const out = await h.run("planning:status.1", {}, { forge });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 1, pr: null });
    expect((await prOnBranch(h, "xarabot/planning-status.1"))?.state).toBe("closed");
    expect(events.slice(events.indexOf("openPr"))).toEqual(["openPr", "listPrsByBranch", "ledgerSwap heartbeat planning:status.1", "closePr", "ledgerSwap failAttempt planning:status.1"]);
    expect(out.reason).toContain("which no record carries");
  });

  test("a long readiness finding is capped in the journal reason", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("blocked", "x".repeat(70_000)))] });
    const out = await h.run();
    expect(out.state).toBe("parked");
    expect(out.reason?.length).toBeLessThanOrEqual("blocked readiness: ".length + 65_536);
    expect(out.reason?.endsWith("[truncated by xarabot]")).toBe(true);
  });

  test("a Standing Authority that no longer loads on fresh main after CI stops the step; the record left claimed", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const i = await h.input();
    const step = createPlanningStep(h.deps({ sleep: async () => {} }));
    // CI is pending on the first poll; meanwhile main loses its Standing Authority.
    h.fake.control.setChecks(h.head, [{ name: "ci", status: "in_progress", conclusion: null }]);
    const files = mainFiles({ contextMissing: true });
    let polls = 0;
    const out = await step({
      ...i,
      log: (text) => {
        if (text.includes("committed ") && polls === 0) {
          polls += 1;
          delete files[AUTHORITY];
          h.fake.control.setMain(files);
          h.fake.control.setChecks(h.head, PASS);
        }
      },
    });
    expect(out.outcome).toBe("stop");
    expect(out.state).toBe("claimed");
    expect(h.fake.control.queue()).toEqual([]);
  });
});

describe("createPlanningStep: the review before the gate (Story 3.5)", () => {
  const done = () => harness({ contextMissing: true, behaviors: [writes(planningResult("done"))], diff: [STATUS, CONTEXT_2] });

  test("an unreviewed head gets one review round (no Story id, so the normal pass) after CI, before the enqueue; enqueued_sha the head", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const out = await h.run(undefined, undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ storyId: null, unit: { unit: "planning:status.1", subject: "Unit planning:status.1" } });
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "merging", passed_sha: h.head, enqueued_sha: h.head });
  });

  test("a blocking round parks blocked review-findings, with no loopback and no enqueue", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD, blocking: () => true });
    const out = await h.run(undefined, undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(out.reason).toContain("no loopback");
    expect(h.prompts).toHaveLength(1);
    expect(h.fake.control.queue()).toEqual([]);
    expect(h.events).not.toContain("enqueue");
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "parked", loopbacks: 0, passed_sha: null, park: { kind: "blocked", reason: "review-findings", inbox_owner: "edanisko" } });
  });

  test("a round blocked by its verdict alone names the verdict in the park reason", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD, blocking: () => true, findings: () => [] });
    const out = await h.run(undefined, undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(out.reason).toContain("its verdict changes-requested, with no blocking finding of 0");
  });

  test("after a review round every check runs again on fresh main: CI polled again, the diff read against the main the review left", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    let movedTo = "";
    const review: typeof stub.review = async (input) => {
      const out = await stub.review(input);
      movedTo = h.fake.control.setMain({ ...mainFiles({ contextMissing: true }), "README.md": "moved during the review\n" });
      return out;
    };
    const out = await h.run(undefined, undefined, { review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(stub.calls).toHaveLength(1);
    expect(h.events.filter((e) => e === "checks").length).toBeGreaterThanOrEqual(2);
    expect(h.diffs.map((d) => d.mainSha)).toEqual([movedTo]);
  });

  test("the allowance runs before the approval gate: a graph PR whose policy drops the lane's agent is a failed attempt, never parked awaiting approval", async () => {
    const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("done"))], diff: [EPICS, "stories/2.2.md"] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const review: typeof stub.review = async (input) => {
      const out = await stub.review(input);
      h.fake.control.setMain({ ...mainFiles({ graph: true }), ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [codex]\n" });
      return out;
    };
    const out = await h.run("planning:graph.1", undefined, { review });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml");
    expect(h.diffs).toEqual([]);
  });

  test("a graph PR's blocking round parks review-findings before the approval park", async () => {
    const h = harness({ graph: true, records: [OWN_GRAPH], behaviors: [writes(planningResult("done"))], diff: [EPICS, "stories/2.2.md"] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD, blocking: () => true });
    const out = await h.run("planning:graph.1", undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ park: { kind: "blocked", reason: "review-findings" } });
  });

  test("a head the gate passes is not reviewed again", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const out = await h.run(undefined, undefined, { review: stub.review, passed: async () => ok({ kind: "passed", how: "clean-merge" }) });
    expect(stub.calls).toHaveLength(0);
    // No review round recorded a passed_sha, so startMerging refuses: the record must carry a reviewed head.
    expect(out.outcome).toBe("failed");
  });

  test("a passed gate error is a failed attempt with no review", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const out = await h.run(undefined, undefined, { review: stub.review, passed: async () => err("fetch", "offline") });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("passed gate fetch: offline");
    expect(stub.calls).toHaveLength(0);
  });

  test("a Halt from the review reaches the coordinator process", async () => {
    const h = done();
    const review = async (): Promise<never> => {
      throw new MarkerStop("stop", "STOP during a usage-limit sleep");
    };
    await expect(h.run(undefined, undefined, { review })).rejects.toBeInstanceOf(MarkerStop);
  });

  test("the allowance before the enqueue: a policy that drops the lane's agent after the review is a failed attempt, no enqueue", async () => {
    const h = done();
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const review: typeof stub.review = async (input) => {
      const out = await stub.review(input);
      h.fake.control.setMain({ ...mainFiles({ contextMissing: true }), ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [codex]\n" });
      return out;
    };
    const out = await h.run(undefined, undefined, { review });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
    expect(h.events).not.toContain("enqueue");
  });

  test("the allowance before the session: a policy that drops the lane's agent runs no session", async () => {
    const h = harness({ contextMissing: true, behaviors: [writes(planningResult("done"))] });
    const at = await h.input();
    h.fake.control.setMain({ ...mainFiles({ contextMissing: true }), ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [codex]\n" });
    const out = await h.run(undefined, at);
    expect(out.outcome).toBe("failed");
    expect(h.prompts).toEqual([]);
    expect(out.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
  });
});

/** `files` with a policy allowing both reviewers, so the reviewer choice is cross-vendor whichever vendor built the unit. */
const bothReviewers = (files: Record<string, string>): Record<string, string> => ({ ...files, ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [claude, codex]\n" });

/** `forge` with each `checks` call first reading `unit`'s `builder_providers` from the ledger on `fake` into `seen`. */
function watchChecks(forge: Forge, fake: FakeForge, unit: string, seen: (readonly string[] | undefined)[]): Forge {
  return {
    ...forge,
    checks: async (sha, o) => {
      seen.push(await ledgerProviders(fake, unit));
      return forge.checks(sha, o);
    },
  };
}

describe("createPlanningStep: resuming an adopted PR", () => {
  test("no session: CI polled at the record's head, then the gate (status: merging, enqueued)", async () => {
    const h = harness({ contextMissing: true });
    const head = h.fake.control.makeCommit();
    h.fake.control.setChecks(head, PASS);
    expect((await h.fake.forge.pushBranch({ branch: "xarabot/planning-status.1", expected_sha: null, sha: head }, opts())).ok).toBe(true);
    const opened = await h.fake.forge.openPr({ branch: "xarabot/planning-status.1", base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const pr = opened.value.number;
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([coord("planning:status.1", { globs: STATUS_GLOBS, generation: 2, pr, pr_owner: COORD.owner, head_sha: head })]), deletes: [] });
    const out = await h.run();
    expect(h.prompts).toEqual([]);
    expect(h.prepares).toEqual([]);
    expect(h.commits).toEqual([]);
    expect(out.state).toBe("merging");
    expect(h.fake.control.queue()).toEqual([pr]);
    expect(h.diffs[0]?.headSha).toBe(head);
  });

  test("a Halt from the adopted PR's review reaches the process (runKit), with no session", async () => {
    const h = harness({ contextMissing: true });
    const head = h.fake.control.makeCommit();
    h.fake.control.setChecks(head, PASS);
    expect((await h.fake.forge.pushBranch({ branch: "xarabot/planning-status.1", expected_sha: null, sha: head }, opts())).ok).toBe(true);
    const opened = await h.fake.forge.openPr({ branch: "xarabot/planning-status.1", base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([coord("planning:status.1", { globs: STATUS_GLOBS, generation: 2, pr: opened.value.number, pr_owner: COORD.owner, head_sha: head })]), deletes: [] });
    const review = async (): Promise<never> => {
      throw new MarkerStop("stop", "STOP during a usage-limit sleep");
    };
    await expect(h.run(undefined, undefined, { review })).rejects.toBeInstanceOf(MarkerStop);
    expect(h.prompts).toEqual([]);
  });

  test.each([
    ["no builder_providers (an adopted PR with no prior record, or a pre-3.3 record): the lane's vendor fenced in before CI", [], ["anthropic"], "codex"],
    ["builder_providers codex wrote: the set unchanged", ["openai"], ["openai"], "claude"],
  ] as const)("retro item 29: an adopted PR with %s; the review is cross-vendor by the other vendor", async (_name, built, after, reviewer) => {
    const h = harness({ contextMissing: true });
    h.fake.control.setMain(bothReviewers(mainFiles({ contextMissing: true })));
    const head = h.fake.control.makeCommit();
    h.fake.control.setChecks(head, PASS);
    expect((await h.fake.forge.pushBranch({ branch: "xarabot/planning-status.1", expected_sha: null, sha: head }, opts())).ok).toBe(true);
    const opened = await h.fake.forge.openPr({ branch: "xarabot/planning-status.1", base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const pr = opened.value.number;
    const record = coord("planning:status.1", { globs: STATUS_GLOBS, generation: 2, pr, pr_owner: COORD.owner, head_sha: head, builder_providers: [...built] });
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([record]), deletes: [] });
    const seen: (readonly string[] | undefined)[] = [];
    const stub = reviewStub({ forge: h.fake.forge, laneDir: h.laneDir, hostStop: join(h.laneDir, "..", "STOP"), lane: LANE, identity: COORD, results: [] });
    const out = await h.run(undefined, undefined, { forge: watchChecks(h.deps().forge, h.fake, "planning:status.1", seen), review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.prompts).toEqual([]);
    expect(seen[0]).toEqual([...after]);
    // The vendor fence is the only edit before CI, and only for an empty set.
    expect(h.events.slice(0, h.events.indexOf("checks"))).toEqual(built.length === 0 ? ["ledgerSwap heartbeat planning:status.1"] : []);
    expect(stub.prompts).toHaveLength(1);
    expect(h.fake.control.reviewBodies(pr)[0]).toStartWith(`🤖 Unit ${"planning:status.1"}: cross-vendor review by ${reviewer}`);
    expect((await h.ledger()).get("planning:status.1")?.builder_providers).toEqual([...after]);
  });
});

// ------------------------------------------------------------------ through the coordinator process

describe("planning through the coordinator process", () => {
  const runProcess = (h: Harness, waitEnds: readonly WaitEnd[] = []) => {
    let clock = 0;
    let waited = 0;
    return runCoordinatorProcess({
      forge: h.fake.forge,
      agent: { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent,
      store: createFsLaneStore({ laneDir: h.laneDir, hostStop: join(h.laneDir, "..", "STOP") }),
      laneDir: h.laneDir,
      identity: COORD,
      lane: LANE,
      claim: claimRec(),
      steps: { planning: createPlanningStep(h.deps()) },
      pid: 12345,
      now: () => T0 + 1000 * clock++,
      sleep: async () => {},
      random: () => 0,
      heartbeat: { sleep: (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))) },
      waiter: {
        async wait() {
          return { end: waitEnds[waited++] ?? "elapsed" };
        },
      },
    });
  };

  test("AC: a STOP during the session's usage-limit sleep releases the unit and ends the run stop, not a lane stop", async () => {
    // The step's session runner and the process share the stub waiter: its first wait is the usage-limit sleep.
    const h = harness({ contextMissing: true, records: [RECENT], usageLimits: [{ resetAt: null }], waitEnds: ["stopped"] });
    const r = await runProcess(h);
    expect(r).toEqual({ outcome: "stop" });
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "released", attempts: 0 });
    const unit = h.journal().find((x) => x.type === "unit") as UnitJournalRecord;
    expect(unit).toMatchObject({ unit: "planning:status.1", outcome: "stop", state: "released", sessions: 1 });
    expect(unit.reason).toContain("STOP during a usage-limit sleep");
    expect(h.journal().some((x) => x.type === "span" && x.span === "usage-limit")).toBe(true);
  });

  test("next picks planning:status.1, the process claims it and the step parks it blocked readiness; the journal reason carries the findings", async () => {
    const h = harness({ contextMissing: true, records: [RECENT], behaviors: [writes(planningResult("blocked"))] });
    const r = await runProcess(h);
    expect(r.outcome).toBe("progress");
    expect((await h.ledger()).get("planning:status.1")).toMatchObject({ state: "parked", generation: 1, park: { reason: "readiness" } });
    const unit = h.journal().find((x) => x.type === "unit") as UnitJournalRecord;
    expect(unit).toMatchObject({ unit: "planning:status.1", outcome: "progress", state: "parked", sessions: 1 });
    expect(unit.reason).toContain("blocked readiness: FAIL: Epic 2 has no acceptance criteria");
  });

  test("a stale claimed graph record with no PR is taken over at generation + 1 and its session runs", async () => {
    const stale = coord("planning:graph.1", { globs: GRAPH_GLOBS, heartbeat_at: minutesBefore(30) });
    const h = harness({ graph: true, records: [RECENT, stale], behaviors: [writes(planningResult("blocked"))] });
    await runProcess(h);
    expect((await h.ledger()).get("planning:graph.1")).toMatchObject({ state: "parked", generation: 2, attempts: 1 });
    expect(h.prompts).toHaveLength(1);
  });
});

describe("AC: a released readiness park", () => {
  test("xarabot rule release planning:status.2: status.3 may be due; a later reconcile deletes status.2", () => {
    const parked = coord("planning:status.2", { globs: STATUS_GLOBS, state: "parked", park: { kind: "blocked", reason: "readiness", inbox_owner: COORD.owner, globs_held: [] } });
    const files = tip([RECENT, parked], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) });
    const ruled = applyRuling({ unit: "planning:status.2", by: { owner: "edanisko", host: COORD.host, lane: "builder-1" }, now: FORGE_NOW, generation: 1, ruling: "release" })(files);
    if (!ruled.ok || ruled.value === null) throw new Error("expected the ruling to apply");
    const after: Record<string, string> = { ...files, ...ruled.value.writes };
    const main = mainFiles({ contextMissing: true });
    const snap = (ledger: Record<string, string>): Snapshot => {
      const a = assembleSnapshot({
        repo: LANE.repo,
        now: FORGE_NOW,
        tree: Object.keys(main).sort(),
        files: main,
        main_sha: "1".repeat(40),
        blob_shas: Object.fromEntries(Object.keys(main).map((p) => [p, "a".repeat(40)])),
        ledger_tip: "2".repeat(40),
        ledger_files: ledger,
        prs: {},
        escalations: null,
        lane: COORD,
        role: "coordinator",
      });
      if (!a.ok) throw new Error(a.error.message);
      return a.value;
    };
    expect(next(snap(files), "coordinator").kind).toBe("idle");
    const o = next(snap(after), "coordinator");
    expect(o.kind === "coordinator" ? o.unit.unit : o.kind).toBe("planning:status.3");
    const plan = planReconcile(snap(after), "reconcile:5", main[STATUS] as string);
    expect(plan.deleteReleased.map((t) => t.unit)).toEqual(["planning:status.2"]);
  });
});
