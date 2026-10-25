import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import { UnitJournalRecordSchema, type JournalRecord, type UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { CoordinatorRecord, LaneIdentity, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent, AgentLaunchSpec, AgentUnit } from "../../src/ports/agent.ts";
import type { Forge, ForgeError } from "../../src/ports/forge.ts";
import type { LaunchSpec, Sandbox, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { readsPath, runLaneProcess, type LaneDeps, type PrStepInput } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { createCiStep } from "../../src/lane/ci-step.ts";
import { createMergeStep } from "../../src/lane/merge-step.ts";
import { defaultSleep, type Sleep } from "../../src/lane/ledger-cas.ts";
import { createPsProcessTable, readPidFile } from "../../src/lane/processes.ts";
import { createSleepWaiter, type WaitEnd, type WaitParams } from "../../src/lane/wait.ts";
import type { PrepareParams, Workspace } from "../../src/lane/workspace.ts";
import { BOB, rec, tip } from "../core/ledger/fixtures.ts";
import { hostTest } from "../support/sandbox.ts";

// ------------------------------------------------------------------ world

const IDENTITY: LaneIdentity = { owner: "alice", host: "11111111-1111-4111-8111-111111111111", lane: "builder-1" };
const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };
const AUTHORITY = "docs/standing-authority.md";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const START_LOG = "2026-10-23T10-00-00Z";
/** The fake forge's `now` at the start: a heartbeat stamped then is fresh. */
const FORGE_NOW = "2026-10-23T10:00:00Z";

type Story = { readonly id: string; readonly slug: string; readonly infra?: boolean };
const STORIES: readonly Story[] = [
  { id: "1.1", slug: "first" },
  { id: "1.2", slug: "second" },
  { id: "1.3", slug: "third" },
];
const key = (s: Story) => `${s.id.replace(".", "-")}-${s.slug}`;

type MainOpts = {
  readonly stories?: readonly Story[];
  readonly done?: readonly string[];
  readonly budgetHours?: number;
  readonly noAuthority?: boolean;
};

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const stories = o.stories ?? STORIES;
  const config = [
    "schema_version: 1",
    'runner_version: "0.1.0"',
    "maintainer: edanisko",
    `standing_authority_path: ${AUTHORITY}`,
    "manifests:",
    "  dir: stories",
    "proxy_hosts: [files.pythonhosted.org]",
  ];
  if (o.budgetHours !== undefined) config.push(`unit_budget_hours: ${o.budgetHours}`);
  const epics = ["# Epics", "", "## Epic 1: One", ""];
  for (const s of stories) epics.push(`### Story ${s.id}: Story ${s.id}`, "", "Body.", "");
  const status = ["development_status:", "  epic-1: in-progress"];
  for (const s of stories) status.push(`  ${key(s)}: ${(o.done ?? []).includes(s.id) ? "done" : "backlog"}`);
  const files: Record<string, string> = {
    ".xarabot/config.yaml": `${config.join("\n")}\n`,
    ".xarabot/policy.yaml": "schema_version: 1\n",
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps:\n  - id: rotate-key\n    text: Rotate the deploy key.\n",
    ".xarabot/prompts/house.md": "HOUSE RULE: run bun test.\n",
    "_bmad-output/planning-artifacts/epics.md": `${epics.join("\n")}\n`,
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    [STATUS]: `${status.join("\n")}\n`,
    "README.md": "hello\n",
  };
  if (o.noAuthority !== true) {
    files[AUTHORITY] = "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n";
  }
  stories.forEach((s, i) => {
    const lines = ["---", `story_id: "${s.id}"`, "epic: 1", `sprint_key: ${key(s)}`, `title: Story ${s.id}`, `globs: ["src/s${i}/**"]`];
    if (s.infra === true) lines.push("infrastructure: true");
    lines.push("---", "");
    files[`stories/${s.id}.md`] = lines.join("\n");
  });
  return files;
}

// -------------------------------------------------------------- stubs

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SESSION_ID = "0b6f0b1e-1111-4222-8333-444455556666";

type RunCall = { readonly spec: LaunchSpec; readonly profile: SandboxProfile; readonly unit: AgentUnit };
/** What one stub run does: write files in the clone or tmp, or wait for the abort. */
type Behavior = (ctx: { readonly profile: SandboxProfile; readonly n: number; readonly signal: AbortSignal; readonly unit: AgentUnit }) => Promise<Partial<SandboxRun> | void> | Partial<SandboxRun> | void;

function buildResult(outcome: "done" | "no-op" | "blocked", extra: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = { kind: "build", outcome, summary: "Did it", body: "", verification: ["bun test"], denied_actions: ["git push"] };
  if (outcome === "blocked") base["blocked"] = { kind: "intent-gap", text: "the spec does not say" };
  return JSON.stringify({ ...base, ...extra });
}

function specText(status: string, section = status): string {
  return `---\ntitle: 'Story'\nstatus: '${status}'\n---\n\n# Story\n\n## Auto Run Result\n\nStatus: ${section}\n`;
}

function writeIn(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A run that writes the spec file (`status`) and the result (`outcome`). */
const finishes =
  (outcome: "done" | "no-op" | "blocked", status = outcome === "blocked" ? "blocked" : "done", slug = "first", id = "1-1"): Behavior =>
  ({ profile }) => {
    writeIn(profile.clone, `${SPEC_DIR}/spec-${id}-${slug}.md`, specText(status));
    writeFileSync(profile.resultPath, buildResult(outcome));
  };

type Harness = {
  readonly fake: FakeForge;
  readonly laneDir: string;
  readonly hostStop: string;
  readonly runs: RunCall[];
  readonly prepares: PrepareParams[];
  readonly prSteps: PrStepInput[];
  readonly seen: { agentPid: string | null; tmpClean: boolean | null; lanePid: string | null };
  /** Every wait the stub waiter was asked for, in order. */
  readonly waits: WaitParams[];
  run(over?: Partial<LaneDeps>): Promise<{ outcome: string; laneStop?: string }>;
  ledger(): Promise<Map<string, UnitRecord>>;
  journal(): JournalRecord[];
  unitRecord(): UnitJournalRecord;
  outcomeFile(): string;
};

type HarnessOpts = MainOpts & {
  readonly behaviors?: readonly Behavior[];
  /** The session id `parseUsage` reports; default one, `null` for none. */
  readonly sessionId?: string | null;
  /** The cost `parseUsage` reports per run; default 0.5, an estimate. */
  readonly costs?: readonly ({ usd: number; estimate: boolean } | null)[];
  readonly prOutcome?: { outcome: "progress" | "failed" | "stop" | "idle"; state: UnitRecord["state"] | null };
  /** The usage limit `parseUsage` reports per run; default none. */
  readonly usageLimits?: readonly ({ resetAt: number | null } | null)[];
  /** How each stub wait ends, in order; default `elapsed`. */
  readonly waitEnds?: readonly WaitEnd[];
  /** The ledger's `coordinator.json`; default a live claim, `null` for none. */
  readonly coordinator?: CoordinatorRecord | null;
};

/** A `coordinator.json` claim stamped at `heartbeatAt` (default the forge's `now`, so live). */
function liveCoordinator(heartbeatAt = FORGE_NOW): CoordinatorRecord {
  return {
    schema_version: 1,
    owner: "carol",
    host: "33333333-3333-4333-8333-333333333333",
    lane: "coordinator",
    generation: 1,
    heartbeat_at: heartbeatAt,
    digest_posted_at: null,
    rulings_cursor: null,
  };
}

function harness(o: HarnessOpts = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "xarabot-lane-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const coordinator = o.coordinator === undefined ? liveCoordinator() : o.coordinator;
  const ledger: Record<string, string> = coordinator === null ? {} : { [COORDINATOR_PATH]: serializeCoordinator(coordinator) };
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o), ledger });
  const runs: RunCall[] = [];
  const prepares: PrepareParams[] = [];
  const prSteps: PrStepInput[] = [];
  const seen: Harness["seen"] = { agentPid: null, tmpClean: null, lanePid: null };
  const waits: WaitParams[] = [];
  const sessionId = o.sessionId === undefined ? SESSION_ID : o.sessionId;
  let usageCalls = 0;

  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (unit, settings, resultPath) =>
      ok({
        argv: ["stub-agent", settings.effort, resultPath],
        stdin: unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`,
        vendor: "claude",
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
        ...(unit.kind === "resume" ? { resume: true } : {}),
        // The unit rides along for the assertions.
        unit,
      } as AgentLaunchSpec),
    parseUsage: () => {
      const i = usageCalls++;
      return {
        sessionId,
        model: "reported-model",
        tokens: { input: 100, output: 20, cacheRead: 5, cacheCreation: 1 },
        cost: o.costs === undefined ? { usd: 0.5, estimate: true } : (o.costs[i] ?? null),
        usageLimit: o.usageLimits?.[i] ?? null,
      };
    },
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
  };

  const sandbox: Sandbox = {
    async run(spec, profile, signal, hooks) {
      const unit = (spec as LaunchSpec & { unit: AgentUnit }).unit;
      runs.push({ spec, profile, unit });
      const n = runs.length;
      if (n === 1) seen.tmpClean = !existsSync(join(profile.tempDir, "stale.txt")) && !existsSync(profile.resultPath);
      hooks?.onSpawn?.(999);
      const pidFile = join(laneDir, "agent.pid");
      seen.agentPid = existsSync(pidFile) ? readFileSync(pidFile, "utf8") : null;
      const extra = (await o.behaviors?.[n - 1]?.({ profile, n, signal, unit })) ?? {};
      return ok({
        pid: 999,
        exitCode: 0,
        signal: null,
        startedAt: 0,
        endedAt: 1,
        durationMs: 1,
        stdout: `stdout of run ${n}\n`,
        stderr: `stderr of run ${n}\n`,
        ...extra,
      });
    },
  };

  const workspace: Workspace = {
    async prepare(p) {
      prepares.push(p);
      const clone = join(laneDir, "clone");
      rmSync(clone, { recursive: true, force: true });
      writeIn(clone, ".git/HEAD", `ref: refs/heads/${p.branch}\n`);
      // A spec under .git/ never counts.
      writeIn(clone, `.git/${SPEC_DIR}/spec-1-1-git.md`, specText("done"));
      writeIn(clone, "README.md", "hello\n");
      return ok({ sha: p.start, resumed: false });
    },
  };

  let tick = 0;
  const deps = (over: Partial<LaneDeps>): LaneDeps => ({
    forge: fake.forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    workspace,
    prStep: async (input) => {
      prSteps.push(input);
      return o.prOutcome ?? { outcome: "progress", state: "claimed" };
    },
    laneDir,
    identity: IDENTITY,
    lane: LANE,
    pid: 12345,
    now: () => T0 + 1000 * tick++,
    sleep: async () => {},
    random: () => 0,
    waiter: {
      async wait(p) {
        const n = waits.length;
        waits.push(p);
        if (n === 0) {
          const lanePid = join(laneDir, "lane.pid");
          seen.lanePid = existsSync(lanePid) ? readFileSync(lanePid, "utf8") : null;
        }
        return { end: o.waitEnds?.[n] ?? "elapsed" };
      },
    },
    ...over,
  });

  const h: Harness = {
    fake,
    laneDir,
    hostStop,
    runs,
    prepares,
    prSteps,
    seen,
    waits,
    run: (over = {}) => runLaneProcess(deps(over)),
    async ledger() {
      const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
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
    unitRecord() {
      const units = h.journal().filter((r) => r.type === "unit");
      expect(units).toHaveLength(1);
      const parsed = UnitJournalRecordSchema.safeParse(units[0]);
      expect(parsed.success).toBe(true);
      const r = units[0] as UnitJournalRecord;
      // The AC: outcome equals the outcome file, and the log exists under logs/.
      expect(`${r.outcome}\n`).toBe(h.outcomeFile());
      expect(r.log.startsWith(join(laneDir, "logs") + "/")).toBe(true);
      expect(existsSync(r.log)).toBe(true);
      return r;
    },
    outcomeFile: () => readFileSync(join(laneDir, "outcome"), "utf8"),
  };
  return h;
}

/** Puts a PR on `story/<id>` in `state`; returns its number and head. */
async function pr(fake: FakeForge, id: string, state: "open" | "merged" | "closed"): Promise<{ number: number; head: string }> {
  const opts = { signal: AbortSignal.timeout(5000) };
  const branch = `story/${id}`;
  const head = fake.control.makeCommit();
  const listed = await fake.forge.listPrsByBranch(branch, opts);
  const expected = listed.ok ? (listed.value.at(-1)?.head_sha ?? null) : null;
  const pushed = await fake.forge.pushBranch({ branch, expected_sha: expected, sha: head }, opts);
  if (!pushed.ok) throw new Error(pushed.error.message);
  const opened = await fake.forge.openPr({ branch, base: "main", title: "t", body: "b" }, opts);
  if (!opened.ok) throw new Error(opened.error.message);
  const number = opened.value.number;
  if (state === "merged") {
    await fake.forge.enqueue(number, head, opts);
    fake.control.mergeQueueHead();
  }
  if (state === "closed") await fake.forge.closePr(number, opts);
  return { number, head };
}

function foreignRecords(fake: FakeForge, records: readonly UnitRecord[]): void {
  fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: tip(records), deletes: [] });
}

/** The heartbeat keeper's sleep in tests: 5 ms of real time whatever it is asked for. */
const fastBeats: Sleep = (_ms, signal) => defaultSleep(5, signal);

/** The keeper's `keepAlive` commits so far. */
const keepAlives = (fake: FakeForge): number => fake.control.ledgerLog().filter((c) => c.message.startsWith("ledger: keepAlive ")).length;

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

const mainSha = async (fake: FakeForge): Promise<string> => {
  const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
  if (!s.ok) throw new Error(s.error.message);
  return s.value.main.sha;
};

// -------------------------------------------------------------- cases

describe("runLaneProcess", () => {
  test("a lane start records lane.pid and reads ledger, main, prs before the claim commit", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    const r = await h.run();
    expect(r.outcome).toBe("progress");
    expect(h.seen.lanePid).toMatch(/^12345\n[A-Za-z0-9._-]+\n$/);
    expect(existsSync(join(h.laneDir, "lane.pid"))).toBe(false);
    expect(h.fake.control.trace().slice(0, 3)).toEqual(["ledger", "main", "prs"]);
    const log = h.fake.control.ledgerLog();
    expect(log[1]?.message).toBe("ledger: claim story:1.1 [skip ci]");
  });

  test.each(["host", "lane"] as const)("a %s STOP marker: outcome stop, no snapshot, no ledger commit", async (which) => {
    const h = harness();
    const path = which === "host" ? h.hostStop : join(h.laneDir, "STOP");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    const r = await h.run();
    expect(r.outcome).toBe("stop");
    // A STOP marker is the operator's choice, never a lane stop.
    expect(r.laneStop).toBeUndefined();
    expect(h.fake.control.trace()).toEqual([]);
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    expect(h.journal()).toEqual([]);
    expect(h.outcomeFile()).toBe("stop\n");
    expect(h.runs).toHaveLength(0);
  });

  test("a STOP marker that appears after next and before the claim stops with no claim", async () => {
    const h = harness();
    const store = createFsLaneStore({ laneDir: h.laneDir, hostStop: h.hostStop });
    let checks = 0;
    const r = await h.run({
      store: {
        ...store,
        stopMarkers: () => {
          checks += 1;
          return ok({ host: false, lane: checks >= 2 });
        },
      },
    });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toBeUndefined();
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ unit: "story:1.1", outcome: "stop", generation: null, state: null, sessions: 0 });
  });

  test("idle: every Story done gives an idle span with next's reason", async () => {
    const h = harness({ done: ["1.1", "1.2", "1.3"] });
    expect((await h.run()).outcome).toBe("idle");
    expect(h.journal()).toEqual([
      {
        schema_version: 1,
        type: "span",
        span: "idle",
        reason: "no Story left to build",
        started_at: "2026-10-23T10:00:00.000Z",
        ended_at: "2026-10-23T10:00:02.000Z",
      },
    ]);
    expect(h.outcomeFile()).toBe("idle\n");
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
  });

  test("a merged PR: claimed then recorded merged, with no session", async () => {
    const h = harness();
    await pr(h.fake, "1.1", "closed");
    await pr(h.fake, "1.1", "merged");
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")?.state).toBe("merged");
    expect(h.fake.control.ledgerLog().map((c) => c.message)).toEqual([
      "root",
      "ledger: claim story:1.1 [skip ci]",
      "ledger: markMerged story:1.1 [skip ci]",
    ]);
    expect(h.runs).toHaveLength(0);
    expect(h.prepares).toHaveLength(0);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "merged", sessions: 0, result: null, generation: 1 });
  });

  test("an open PR is adopted and the session starts at its head", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    await pr(h.fake, "1.1", "closed");
    const open = await pr(h.fake, "1.1", "open");
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("progress");
    const record = (await h.ledger()).get("story:1.1");
    expect(record).toMatchObject({ state: "claimed", pr: open.number, pr_owner: "alice", head_sha: open.head, base_sha: main });
    expect(h.prepares).toHaveLength(1);
    expect(h.prepares[0]).toMatchObject({ unit: "story:1.1", branch: "story/1.1", start: open.head, generation: 1, fetch: [open.head] });
  });

  test("a closed PR or none: the claim records main as base_sha and the session starts there", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    await pr(h.fake, "1.1", "closed");
    const main = await mainSha(h.fake);
    await h.run();
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "claimed", pr: null, head_sha: null, base_sha: main });
    expect(h.prepares[0]).toMatchObject({ start: main, fetch: [main] });
  });

  test("done: the session gets the prompt, profile and clean tmp, and prStep is called once", async () => {
    const h = harness({ behaviors: [finishes("done")], prOutcome: { outcome: "progress", state: "parked" } });
    mkdirSync(join(h.laneDir, "tmp"), { recursive: true });
    writeFileSync(join(h.laneDir, "tmp", "stale.txt"), "old");
    writeFileSync(join(h.laneDir, "tmp", "result.json"), buildResult("done"));
    const r = await h.run();
    expect(r.outcome).toBe("progress");
    expect(h.seen.tmpClean).toBe(true);
    expect(h.seen.agentPid).toBe("999\nstub-agent\n");
    expect(existsSync(join(h.laneDir, "agent.pid"))).toBe(false);

    expect(h.runs).toHaveLength(1);
    const run = h.runs[0] as RunCall;
    expect(run.unit.kind).toBe("fresh");
    const prompt = run.unit.kind === "fresh" ? run.unit.prompt : "";
    expect(prompt).toContain("Build Story 1.1 (`1-1-first`)");
    expect(prompt).toContain("HOUSE RULE: run bun test.");
    expect(prompt).toContain("`rotate-key`: Rotate the deploy key.");
    expect(prompt).toContain(join(h.laneDir, "tmp", "result.json"));
    expect(run.profile).toEqual({
      clone: join(h.laneDir, "clone"),
      vendorHome: join(h.laneDir, "vendor"),
      tempDir: join(h.laneDir, "tmp"),
      runnerGit: join(h.laneDir, "runner.git"),
      resultPath: join(h.laneDir, "tmp", "result.json"),
      repoHosts: ["files.pythonhosted.org"],
    });

    expect(h.prSteps).toHaveLength(1);
    const step = h.prSteps[0] as PrStepInput;
    expect(step.unit.unit).toBe("story:1.1");
    expect(step.record).toMatchObject({ unit: "story:1.1", state: "claimed", generation: 1 });
    expect(step.result.outcome).toBe("done");
    expect(step.specPath).toBe(`${SPEC_DIR}/spec-1-1-first.md`);
    expect(step.clone).toBe(join(h.laneDir, "clone"));

    const rec = h.unitRecord();
    expect(rec).toMatchObject({
      unit: "story:1.1",
      lane: "builder-1",
      generation: 1,
      agent: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      tokens: { input: 100, output: 20, cacheRead: 5, cacheCreation: 1 },
      cost: { usd: 0.5, estimate: true },
      sessions: 1,
      outcome: "progress",
      result: "done",
      state: "parked",
      denied_actions: ["git push"],
      started_at: "2026-10-23T10:00:00.000Z",
    });
    expect(rec.log).toBe(join(h.laneDir, "logs", `story__1.1-${START_LOG}.log`));
    const log = readFileSync(rec.log, "utf8");
    expect(log).toContain("stdout of run 1");
    expect(log).toContain("stderr of run 1");
  });

  test("missing result: one resume, then released with attempts 1", async () => {
    const h = harness();
    expect((await h.run()).outcome).toBe("failed");
    expect(h.runs.map((r) => r.unit)).toEqual([
      { kind: "fresh", prompt: expect.any(String) },
      { kind: "resume", sessionId: SESSION_ID },
    ]);
    expect(h.runs[1]?.spec.resume).toBe(true);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "failed", state: "released", attempts: 1, sessions: 2, result: null });
    expect(rec.tokens).toEqual({ input: 200, output: 40, cacheRead: 10, cacheCreation: 2 });
    expect(rec.cost).toEqual({ usd: 1, estimate: true });
    expect(rec.reason).toContain("no result");
    const log = readFileSync(rec.log, "utf8");
    expect(log).toContain("stdout of run 1");
    expect(log).toContain("stdout of run 2");
  });

  test("missing result with no session id: no resume", async () => {
    const h = harness({ sessionId: null });
    expect((await h.run()).outcome).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect(h.unitRecord()).toMatchObject({ state: "released", sessions: 1 });
  });

  test("a result written by the resume counts", async () => {
    const h = harness({ behaviors: [() => {}, finishes("done")] });
    expect((await h.run()).outcome).toBe("progress");
    expect(h.runs).toHaveLength(2);
    expect(h.prSteps).toHaveLength(1);
  });

  test("an invalid result is a failed attempt", async () => {
    const h = harness({
      behaviors: [
        ({ profile }) => {
          writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-first.md`, specText("done"));
          writeFileSync(profile.resultPath, JSON.stringify({ kind: "build", outcome: "done" }));
        },
      ],
    });
    expect((await h.run()).outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain("result invalid");
  });

  test("attempts cap: a released record at attempts 2 parks attempts-cap on failure", async () => {
    const h = harness();
    foreignRecords(h.fake, [rec({ unit: "story:1.1", state: "released", attempts: 2, globs: ["src/s0/**"], owner: BOB.owner, host: BOB.host, lane: BOB.lane })]);
    expect((await h.run()).outcome).toBe("failed");
    const record = (await h.ledger()).get("story:1.1");
    expect(record).toMatchObject({ state: "parked", attempts: 3, generation: 2, park: { kind: "blocked", reason: "attempts-cap" } });
    expect(h.unitRecord()).toMatchObject({ outcome: "failed", state: "parked", attempts: 3, generation: 2 });
  });

  test("spec mismatch: done with a spec in-review is released", async () => {
    const h = harness({ behaviors: [finishes("done", "in-review")] });
    expect((await h.run()).outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")?.state).toBe("released");
    expect(h.prSteps).toHaveLength(0);
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "failed", state: "released", result: "done" });
    expect(rec.reason).toContain(`${SPEC_DIR}/spec-1-1-first.md "in-review"`);
  });

  test.each([
    ["zero", []],
    ["two", ["spec-1-1-first.md", "spec-1-1-again.md"]],
  ] as const)("spec ambiguous: %s matching specs is released", async (_n, names) => {
    const h = harness({
      behaviors: [
        ({ profile }) => {
          for (const name of names) writeIn(profile.clone, `${SPEC_DIR}/${name}`, specText("done"));
          // Near misses that never match.
          writeIn(profile.clone, `${SPEC_DIR}/spec-1-10-other.md`, specText("done"));
          writeFileSync(profile.resultPath, buildResult("done"));
        },
      ],
    });
    expect((await h.run()).outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")?.state).toBe("released");
    expect(h.prSteps).toHaveLength(0);
    expect(h.unitRecord().reason).toContain(`${names.length} files match`);
  });

  test("a spec that is a symlink is refused", async () => {
    const h = harness({
      behaviors: [
        ({ profile }) => {
          const real = join(profile.tempDir, "real.md");
          writeFileSync(real, specText("done"));
          mkdirSync(join(profile.clone, SPEC_DIR), { recursive: true });
          Bun.spawnSync(["ln", "-s", real, join(profile.clone, SPEC_DIR, "spec-1-1-first.md")]);
          writeFileSync(profile.resultPath, buildResult("done"));
        },
      ],
    });
    expect((await h.run()).outcome).toBe("failed");
    expect(h.unitRecord().reason).toContain(`${SPEC_DIR}/spec-1-1-first.md (unreadable)`);
  });

  test("blocked: parked blocked with the result's kind and no globs held", async () => {
    const h = harness({ behaviors: [finishes("blocked")] });
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({
      state: "parked",
      park: { kind: "blocked", reason: "intent-gap", inbox_owner: "alice", globs_held: [] },
    });
    expect(h.prSteps).toHaveLength(0);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "parked", result: "blocked" });
  });

  test("no-op: parked blocked no-op, checked against a done spec", async () => {
    const h = harness({ behaviors: [finishes("no-op")] });
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "no-op" } });
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "parked", result: "no-op" });
  });

  test("a re-run's done: the blocked spec beside the new done one is superseded and the PR step gets both", async () => {
    const h = harness({
      behaviors: [
        ({ profile }) => {
          // The first run's blocked spec, as main holds it, and the re-run's new done spec.
          writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-first.md`, specText("blocked"));
          writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-rerun.md`, specText("done"));
          writeFileSync(profile.resultPath, buildResult("done"));
        },
      ],
    });
    expect((await h.run()).outcome).toBe("progress");
    expect(h.prSteps).toHaveLength(1);
    expect(h.prSteps[0]).toMatchObject({ specPath: `${SPEC_DIR}/spec-1-1-rerun.md`, superseded: [`${SPEC_DIR}/spec-1-1-first.md`] });
    expect(readFileSync(h.unitRecord().log, "utf8")).toContain(`spec: ${SPEC_DIR}/spec-1-1-rerun.md supersedes ${SPEC_DIR}/spec-1-1-first.md`);
  });

  test.each([
    ["two done specs", ["done", "done"]],
    ["one blocked spec only", ["blocked"]],
    ["a done spec beside a draft", ["done", "draft"]],
  ] as const)("a done result with %s is a failed attempt", async (_name, statuses) => {
    const h = harness({
      behaviors: [
        ({ profile }) => {
          statuses.forEach((s, i) => writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-v${i}.md`, specText(s)));
          writeFileSync(profile.resultPath, buildResult("done"));
        },
      ],
    });
    expect((await h.run()).outcome).toBe("failed");
    expect(h.prSteps).toHaveLength(0);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain('needs exactly one "done" spec');
  });

  test.each([
    ["zero", []],
    ["two", ["spec-1-1-first.md", "spec-1-1-again.md"]],
  ] as const)("blocked with %s matching specs: parked with its kind, no cross-check", async (_n, names) => {
    const h = harness({
      behaviors: [
        ({ profile }) => {
          for (const name of names) writeIn(profile.clone, `${SPEC_DIR}/${name}`, specText("done"));
          writeFileSync(profile.resultPath, buildResult("blocked"));
        },
      ],
    });
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "intent-gap" }, attempts: 0 });
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "parked", result: "blocked" });
  });

  test("blocked with one spec that says done: the cross-check misses, a failed attempt", async () => {
    const h = harness({ behaviors: [finishes("blocked", "done")] });
    expect((await h.run()).outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain("frontmatter status");
  });

  test("a blocked park after a session: the journal's wip_ref and the log name refs/wip/<unit-file-id>; nothing is pushed", async () => {
    const h = harness({ behaviors: [finishes("blocked")] });
    // Every forge call the run makes, by operation.
    const calls: string[] = [];
    const forge = Object.fromEntries(
      Object.entries(h.fake.forge).map(([name, fn]) => [name, (...args: unknown[]) => (calls.push(name), (fn as (...a: unknown[]) => unknown)(...args))]),
    ) as unknown as Forge;
    expect((await h.run({ forge })).outcome).toBe("progress");
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ state: "parked", wip_ref: "refs/wip/story__1.1" });
    expect(readFileSync(rec.log, "utf8")).toContain("wip: if the session changed any file, its work is saved as refs/wip/story__1.1 in runner.git when the lane next rebuilds its clone");
    expect(calls).toContain("ledgerSwap");
    expect(calls).not.toContain("pushBranch");
    expect(calls).not.toContain("openPr");
  });

  test("no wip_ref without a blocked park after a session: done, a failed attempt, needs-approval", async () => {
    const done = harness({ behaviors: [finishes("done")] });
    await done.run();
    expect(done.unitRecord().wip_ref).toBeUndefined();
    const failed = harness({ behaviors: [finishes("done", "in-review")] });
    await failed.run();
    expect(failed.unitRecord().wip_ref).toBeUndefined();
    const infra = harness({ stories: [{ id: "1.1", slug: "first", infra: true }] });
    await infra.run();
    expect(infra.unitRecord()).toMatchObject({ state: "parked", sessions: 0 });
    expect(infra.unitRecord().wip_ref).toBeUndefined();
  });

  test("the run after a release claims at generation + 1 and prepares the clone fresh at main", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    foreignRecords(h.fake, [rec({ unit: "story:1.1", state: "released", generation: 1, attempts: 0, globs: ["src/s0/**"] })]);
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "claimed", generation: 2 });
    expect(h.prepares).toEqual([expect.objectContaining({ unit: "story:1.1", start: main, generation: 2, fetch: [main] })]);
  });

  test("an unapproved Infrastructure Story parks needs-approval with no session", async () => {
    const h = harness({ stories: [{ id: "1.1", slug: "first", infra: true }] });
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "parked", park: { kind: "needs-approval" } });
    expect(h.runs).toHaveLength(0);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "parked", sessions: 0 });
  });

  test("an unknown ledger schema_version alerts ledger-schema-version and stops", async () => {
    const h = harness();
    const v2 = JSON.stringify({ ...rec({ unit: "story:1.2" }), schema_version: 2 });
    h.fake.control.writeForeignLedger({ message: "future [skip ci]", writes: { "units/story__1.2.json": v2 }, deletes: [] });
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("stop");
    expect(h.fake.control.alerts()).toEqual([{ condition: "ledger-schema-version", main_sha: main }]);
    expect(h.fake.control.ledgerLog()).toHaveLength(2);
    expect(h.journal()).toEqual([]);
  });

  test("an unknown schema_version found by the claim's swap alerts and stops", async () => {
    const h = harness();
    const v2 = JSON.stringify({ ...rec({ unit: "story:1.3", globs: ["src/zz/**"] }), schema_version: 2 });
    h.fake.control.beforeSwap(({ n }) => {
      if (n === 1) h.fake.control.writeForeignLedger({ message: "future [skip ci]", writes: { "units/story__1.3.json": v2 }, deletes: [] });
    });
    expect((await h.run()).outcome).toBe("stop");
    expect(h.fake.control.alerts().map((a) => a.condition)).toEqual(["ledger-schema-version"]);
    expect(h.unitRecord()).toMatchObject({ outcome: "stop", state: null, generation: null });
  });

  test.each(["auth", "forbidden", "uninstalled"] as const)("a forge %s on listPrsByBranch alerts forge-<kind> and stops", async (kind) => {
    const h = harness();
    h.fake.control.injectError("listPrsByBranch", { kind, message: "nope" } as ForgeError);
    const main = await mainSha(h.fake);
    const r = await h.run();
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toContain(`forge-${kind}`);
    expect(h.fake.control.alerts()).toEqual([{ condition: `forge-${kind}`, main_sha: main }]);
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    expect(h.unitRecord()).toMatchObject({ outcome: "stop", state: null });
  });

  test("a forge auth on the first snapshot alerts with 40 zeros for main", async () => {
    const h = harness();
    h.fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    const r = await h.run();
    expect(r.outcome).toBe("stop");
    // A lane stop: `lane run` counts it as a failed start.
    expect(r.laneStop).toContain("forge-auth");
    expect(h.fake.control.alerts()).toEqual([{ condition: "forge-auth", main_sha: "0".repeat(40) }]);
    expect(h.journal()).toEqual([]);
  });

  test("the lane stops even when the alert itself fails", async () => {
    const h = harness();
    h.fake.control.injectError("snapshot", { kind: "forbidden", message: "no" });
    h.fake.control.injectError("alert", { kind: "transient", message: "down" });
    expect((await h.run()).outcome).toBe("stop");
    expect(h.outcomeFile()).toBe("stop\n");
  });

  test("a missing Standing Authority stops the lane with no claim and no alert", async () => {
    const h = harness({ noAuthority: true });
    const r = await h.run();
    expect(r.outcome).toBe("stop");
    // A stop on bad policy from `main` is a lane stop too.
    expect(r.laneStop).toBeDefined();
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    expect(h.fake.control.alerts()).toEqual([]);
    expect(h.journal()).toEqual([]);
  });

  test("budget: a session that outlives the budget is aborted and released", async () => {
    let aborted = false;
    const h = harness({
      budgetHours: 0.00002,
      behaviors: [
        ({ signal }) =>
          new Promise<Partial<SandboxRun>>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ exitCode: null, signal: "SIGTERM" });
            });
          }),
      ],
    });
    expect((await h.run()).outcome).toBe("failed");
    expect(aborted).toBe(true);
    expect(h.runs).toHaveLength(1);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "failed", state: "released", sessions: 1 });
    expect(rec.reason).toContain("budget");
  });

  test("a sandbox refusal is a failed attempt", async () => {
    const h = harness();
    const r = await h.run({
      sandbox: { run: async () => ({ ok: false, error: { kind: "refused", message: "no proxy" } }) },
    });
    expect(r.outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord()).toMatchObject({ sessions: 0, state: "released" });
  });

  test("a failed prepare is a failed attempt with no session", async () => {
    const h = harness();
    const r = await h.run({ workspace: { prepare: async () => ({ ok: false, error: { kind: "fetch", message: "offline" } }) } });
    expect(r.outcome).toBe("failed");
    expect(h.runs).toHaveLength(0);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain("offline");
  });

  test("lost claim: another lane claims first, next runs again and picks the next Story", async () => {
    const h = harness({ behaviors: [finishes("done", "done", "second", "1-2")] });
    h.fake.control.beforeSwap(({ n }) => {
      if (n === 1) foreignRecords(h.fake, [rec({ unit: "story:1.1", globs: ["src/s0/**"], owner: BOB.owner, host: BOB.host, lane: BOB.lane, heartbeat_at: FORGE_NOW })]);
    });
    expect((await h.run()).outcome).toBe("progress");
    const ledger = await h.ledger();
    expect(ledger.get("story:1.1")?.owner).toBe("bob");
    expect(ledger.get("story:1.2")).toMatchObject({ owner: "alice", state: "claimed" });
    expect(h.prSteps.map((s) => s.unit.unit)).toEqual(["story:1.2"]);
    expect(h.unitRecord()).toMatchObject({ unit: "story:1.2", outcome: "progress" });
  });

  test("three lost claims in a row: outcome failed with no record", async () => {
    const h = harness();
    h.fake.control.beforeSwap(({ n }) => {
      if (n <= 3) foreignRecords(h.fake, [rec({ unit: `story:1.${n}`, globs: [`src/s${n - 1}/**`], owner: BOB.owner, host: BOB.host, lane: BOB.lane, heartbeat_at: FORGE_NOW })]);
    });
    expect((await h.run()).outcome).toBe("failed");
    expect(h.journal()).toEqual([]);
    expect(h.outcomeFile()).toBe("failed\n");
    expect(h.runs).toHaveLength(0);
  });

  test("model and effort in the journal are the lane's, never the agent's", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    await h.run({ lane: { ...LANE, model: "claude-sonnet-5", effort: "max" } });
    expect(h.unitRecord()).toMatchObject({ model: "claude-sonnet-5", effort: "max" });
  });

  /** A PR step that waits for the budget to pass, then returns `state`. */
  const waitingPrStep = (state: UnitRecord["state"]) => async (input: PrStepInput) => {
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) return resolve();
      input.signal.addEventListener("abort", () => resolve());
    });
    return { outcome: "progress" as const, state };
  };

  test("budget passing during the PR step releases a still-claimed unit", async () => {
    const h = harness({ budgetHours: 0.00002, behaviors: [finishes("done")] });
    expect((await h.run({ prStep: waitingPrStep("claimed") })).outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "failed", state: "released" });
    expect(rec.reason).toContain("budget");
  });

  test("budget passing during the PR step keeps a unit the step moved on", async () => {
    const h = harness({ budgetHours: 0.00002, behaviors: [finishes("done")] });
    const before = h.fake.control.ledgerLog().length;
    expect((await h.run({ prStep: waitingPrStep("merging") })).outcome).toBe("progress");
    const log = h.fake.control.ledgerLog();
    expect(log.map((c) => c.message).filter((m) => m.includes("failAttempt"))).toEqual([]);
    expect(log.length).toBe(before + 1);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "merging" });
  });

  test.each(["auth", "forbidden", "uninstalled"] as const)("a forge %s on the claim's ledgerSwap alerts forge-<kind> and stops", async (kind) => {
    const h = harness();
    h.fake.control.injectError("ledgerSwap", { kind, message: "nope" } as ForgeError);
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("stop");
    expect(h.fake.control.alerts()).toEqual([{ condition: `forge-${kind}`, main_sha: main }]);
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    expect(h.unitRecord()).toMatchObject({ outcome: "stop", state: null });
  });

  test("a PR step that throws releases the unit", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    const r = await h.run({
      prStep: async () => {
        throw new Error("boom");
      },
    });
    expect(r.outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "failed", state: "released" });
    expect(rec.reason).toContain("PR step threw");
  });

  test.each([
    ["exact then estimate", [{ usd: 1, estimate: false }, { usd: 2, estimate: true }], { usd: 3, estimate: true }],
    ["exact then none", [{ usd: 1, estimate: false }, null], { usd: 1, estimate: true }],
    ["none then exact", [null, { usd: 1, estimate: false }], { usd: 1, estimate: true }],
    ["exact twice", [{ usd: 1, estimate: false }, { usd: 2, estimate: false }], { usd: 3, estimate: false }],
    ["none twice", [null, null], null],
  ] as const)("cost over two runs: %s", async (_name, costs, expected) => {
    const h = harness({ costs: [...costs], behaviors: [() => {}, finishes("done")] });
    await h.run();
    expect(h.runs).toHaveLength(2);
    expect(h.unitRecord().cost).toEqual(expected);
  });
});

// ---------------------------------------------------------- Story 1.18

describe("runLaneProcess waits and limits", () => {
  const MIN = 60_000;

  test.each([
    ["progress", { behaviors: [finishes("done")] }, [MIN]],
    ["idle", { done: ["1.1", "1.2", "1.3"] }, [30 * MIN]],
    ["failed", {}, [15 * MIN]],
    ["stop", { noAuthority: true }, []],
  ] as const)("trailing wait after %s", async (outcome, opts, ms) => {
    const h = harness(opts);
    expect((await h.run()).outcome).toBe(outcome);
    expect(h.waits.map((w) => w.ms)).toEqual([...ms]);
    expect(h.waits.every((w) => w.signal === undefined && w.onTick === undefined)).toBe(true);
    expect(existsSync(join(h.laneDir, "lane.pid"))).toBe(false);
  });

  test("lane.pid records LaneDeps.command", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    await h.run({ command: "xarabot-lane" });
    expect(h.seen.lanePid).toBe("12345\nxarabot-lane\n");
  });

  test("a failed trailing wait is written to stderr, the outcome stays", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const r = await h.run({ waiter: { wait: async () => ({ end: "failed", message: "no sleep" }) } });
      expect(r.outcome).toBe("progress");
    } finally {
      console.error = original;
    }
    expect(lines).toEqual(["lane wait failed: no sleep"]);
  });

  /** A run that waits for its signal, then ends on SIGTERM. */
  const hangs: Behavior = ({ signal }) =>
    new Promise<Partial<SandboxRun>>((resolve) => {
      if (signal.aborted) return resolve({ exitCode: null, signal: "SIGTERM" });
      signal.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM" }));
    });

  test("session limit: a run that never ends is killed and is a failed attempt, no resume", async () => {
    const h = harness({ behaviors: [hangs] });
    const r = await h.run({ limits: { sessionMs: 30 } });
    expect(r.outcome).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain(`agent session ran past ${30 / 3_600_000} h`);
    expect(h.waits.map((w) => w.ms)).toEqual([15 * MIN]);
  });

  test("result linger: a run that stays after its result is killed and the result used", async () => {
    let killed = false;
    const h = harness({
      behaviors: [
        async (ctx) => {
          await finishes("done")(ctx);
          const end = await hangs(ctx);
          killed = true;
          return end;
        },
      ],
    });
    const r = await h.run({ limits: { resultLingerMs: 30, resultPollMs: 5 } });
    expect(killed).toBe(true);
    expect(r.outcome).toBe("progress");
    expect(h.prSteps).toHaveLength(1);
  });

  test("usage limit: sleeps to the reset plus 2 min, journals one span, then runs the session again", async () => {
    const h = harness({ usageLimits: [{ resetAt: T0 + MIN }], behaviors: [() => {}, finishes("done")] });
    const r = await h.run({ now: () => T0 });
    expect(r.outcome).toBe("progress");
    expect(h.waits[0]?.ms).toBe(3 * MIN);
    // The keeper heartbeats the claim through the sleep; the wait itself has no tick.
    expect(h.waits[0]?.tickMs).toBeUndefined();
    expect(h.waits[0]?.onTick).toBeUndefined();
    expect(h.waits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(h.runs.map((x) => x.unit.kind)).toEqual(["fresh", "fresh"]);
    expect(h.prepares).toHaveLength(2);
    expect(h.prepares[1]?.start).toBe(h.prepares[0]?.start as string);
    expect(h.prSteps).toHaveLength(1);
    expect(h.journal().filter((x) => x.type === "span")).toEqual([
      {
        schema_version: 1,
        type: "span",
        span: "usage-limit",
        reason: "usage limit; reset 2026-10-23T10:01:00.000Z",
        started_at: "2026-10-23T10:00:00.000Z",
        ended_at: "2026-10-23T10:00:00.000Z",
      },
    ]);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", sessions: 2 });
  });

  test("the usage-limit span ends at the clock read after the wait", async () => {
    let clockMs = T0;
    let waitStartedMs = 0;
    const h = harness({ usageLimits: [{ resetAt: null }], behaviors: [() => {}, finishes("done")] });
    await h.run({
      now: () => clockMs,
      waiter: {
        async wait(p) {
          // Only the usage-limit sleep carries a signal.
          if (p.signal !== undefined) {
            waitStartedMs = clockMs;
            clockMs += p.ms;
          }
          return { end: "elapsed" };
        },
      },
    });
    const span = h.journal().find((x) => x.type === "span");
    expect(span).toMatchObject({ started_at: new Date(waitStartedMs).toISOString(), ended_at: new Date(waitStartedMs + 15 * MIN).toISOString() });
    expect(Date.parse(span?.ended_at ?? "")).toBeGreaterThan(Date.parse(span?.started_at ?? ""));
  });

  test("usage limit on the resume is treated like the fresh run", async () => {
    const h = harness({ usageLimits: [null, { resetAt: null }], behaviors: [() => {}, () => {}, finishes("done")] });
    expect((await h.run()).outcome).toBe("progress");
    expect(h.runs.map((x) => x.unit.kind)).toEqual(["fresh", "resume", "fresh"]);
    expect(h.waits[0]?.ms).toBe(15 * MIN);
  });

  test.each([
    ["unparsed", null, 15 * MIN],
    ["capped", T0 + 20 * 60 * MIN, 8 * 60 * MIN],
    ["already past", T0 - 10 * MIN, 0],
  ] as const)("usage limit %s", async (_name, resetAt, ms) => {
    const h = harness({ usageLimits: [{ resetAt }], behaviors: [() => {}, finishes("done")] });
    await h.run({ now: () => T0 });
    expect(h.waits[0]?.ms).toBe(ms);
    const span = h.journal().find((x) => x.type === "span");
    expect(span?.reason).toBe(`usage limit; reset ${resetAt === null ? "unknown" : new Date(resetAt).toISOString()}`);
  });

  test("usage limit and a result: the result counts, no sleep", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], behaviors: [finishes("done")] });
    expect((await h.run()).outcome).toBe("progress");
    expect(h.waits.map((w) => w.ms)).toEqual([MIN]);
  });

  test("the keeper heartbeats the claim through a usage-limit sleep", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], behaviors: [() => {}, finishes("done")] });
    let during = 0;
    const r = await h.run({
      heartbeat: { sleep: fastBeats },
      waiter: {
        async wait(p) {
          if (p.signal === undefined) return { end: "elapsed" };
          const before = keepAlives(h.fake);
          await until(() => keepAlives(h.fake) >= before + 2);
          during = keepAlives(h.fake) - before;
          return { end: "elapsed" };
        },
      },
    });
    expect(r.outcome).toBe("progress");
    expect(during).toBeGreaterThanOrEqual(2);
    expect(h.runs).toHaveLength(2);
  });

  test("a unit lost during a usage-limit sleep ends the sleep and the run: no further session, failed, state null", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], behaviors: [() => {}, finishes("done")] });
    const theirs = rec({ unit: "story:1.1", globs: ["src/s0/**"], owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2 });
    const r = await h.run({
      heartbeat: { sleep: fastBeats },
      waiter: {
        async wait(p) {
          const signal = p.signal;
          if (signal === undefined) return { end: "elapsed" };
          foreignRecords(h.fake, [theirs]);
          await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve())));
          return { end: "aborted" };
        },
      },
    });
    expect(r.outcome).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect(h.prSteps).toHaveLength(0);
    expect((await h.ledger()).get("story:1.1")).toEqual(theirs);
    const rec1 = h.unitRecord();
    expect(rec1).toMatchObject({ outcome: "failed", state: null });
    expect(rec1.reason).toContain("lost");
    expect(readFileSync(rec1.log, "utf8")).toContain("abandoning the unit");
  });

  test("a beat failing auth during a usage-limit sleep ends the sleep at once: forge-auth alert, a lane stop, no second session, the record left", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], behaviors: [() => {}, finishes("done")] });
    let before: UnitRecord | undefined;
    let sleptMs: number | null = null;
    const r = await h.run({
      heartbeat: { sleep: fastBeats },
      waiter: {
        async wait(p) {
          const signal = p.signal;
          if (signal === undefined) return { end: "elapsed" };
          before = (await h.ledger()).get("story:1.1");
          // The keeper's next beat is the next swap: GitHub refuses its credentials.
          h.fake.control.injectError("ledgerSwap", { kind: "auth", message: "bad token" });
          const started = Date.now();
          // A 15 min sleep: it ends only because the keeper's stop end aborts its signal.
          await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve())));
          sleptMs = Date.now() - started;
          return { end: "aborted" };
        },
      },
    });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toContain("forge-auth");
    expect(r.laneStop).toContain("heartbeat");
    expect(sleptMs as number | null).toBeLessThan(5000);
    expect(h.runs).toHaveLength(1);
    expect(h.prSteps).toHaveLength(0);
    expect(h.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-auth"]);
    expect(before).toMatchObject({ state: "claimed" });
    expect((await h.ledger()).get("story:1.1")).toEqual(before);
    expect(h.unitRecord()).toMatchObject({ outcome: "stop", state: "claimed" });
    expect(h.outcomeFile()).toBe("stop\n");
  });

  test("usage limit then STOP: released with no attempt, outcome stop", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], waitEnds: ["stopped"] });
    const r = await h.run();
    expect(r.outcome).toBe("stop");
    // A STOP during a usage-limit sleep is a STOP marker, never a lane stop.
    expect(r.laneStop).toBeUndefined();
    expect(h.runs).toHaveLength(1);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 0 });
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "stop", state: "released", attempts: 0 });
    expect(rec.reason).toContain("STOP during a usage-limit sleep");
    expect(h.waits).toHaveLength(1);
  });

  test("usage limit then the budget: a failed attempt", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], waitEnds: ["aborted"] });
    expect((await h.run()).outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain("budget");
  });

  test("usage limit then a failed sleep: a failed attempt naming the waiter's message", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }] });
    let n = 0;
    const r = await h.run({ waiter: { wait: async () => (n++ === 0 ? { end: "failed", message: "spawn sleep ENOENT" } : { end: "elapsed" }) } });
    expect(r.outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.unitRecord().reason).toContain("spawn sleep ENOENT");
  });

  test("usage limit woken: the session starts again", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], waitEnds: ["woken"], behaviors: [() => {}, finishes("done")] });
    expect((await h.run()).outcome).toBe("progress");
    expect(h.runs).toHaveLength(2);
  });

  test("a CI step that throws after a usage-limit STOP in its session: outcome stop, released, no attempt", async () => {
    const h = harness({ usageLimits: [null, { resetAt: null }], waitEnds: ["stopped"], behaviors: [finishes("done")] });
    const r = await h.run({
      prStep: async (input) => ({ outcome: "progress", state: "claimed", record: { ...input.record, pr: 7 } }),
      ciStep: async (input) => {
        await input.session({ start: input.record.base_sha ?? "", logText: "CI failed\n" });
        throw new Error("CI step blew up");
      },
    });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toBeUndefined();
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 0 });
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ outcome: "stop", state: "released", attempts: 0 });
    expect(rec.reason).toContain("STOP during a usage-limit sleep");
  });

  test("a CI-fix session limited, then STOP: released with no attempt, outcome stop", async () => {
    const h = harness({ usageLimits: [null, { resetAt: null }], waitEnds: ["stopped"], behaviors: [finishes("done")] });
    let sessionError = "";
    const r = await h.run({
      prStep: async (input) => ({ outcome: "progress", state: "claimed", record: { ...input.record, pr: 7 } }),
      ciStep: async (input) => {
        const ran = await input.session({ start: input.record.base_sha ?? "", logText: "CI failed\n" });
        if (!ran.ok) sessionError = ran.error.message;
        return { outcome: "failed", state: "claimed", reason: "CI fix session failed" };
      },
    });
    expect(r.outcome).toBe("stop");
    expect(sessionError).toContain("STOP during a usage-limit sleep");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 0 });
    expect(h.unitRecord()).toMatchObject({ outcome: "stop", state: "released", attempts: 0 });
  });

  describe("the CI session's spec pick, through the real CI step", () => {
    const HEAD = "c".repeat(40);
    /** The real CI step: main merges in up to date, CI fails on HEAD, so a CI-fix session runs through `input.session`. */
    const ciStepFor = (h: Harness) =>
      createCiStep({
        forge: h.fake.forge,
        merger: { merge: async () => ok({ kind: "up-to-date" as const }) },
        identity: IDENTITY,
        repo: LANE.repo,
        sleep: async () => {},
        random: () => 0,
      });
    /** The build's PR step records PR #7 at HEAD; a fix's PR step ends the CI step. */
    const prStepFor = (h: Harness): LaneDeps["prStep"] => async (input) => {
      h.prSteps.push(input);
      if (input.kind === "fix") return { outcome: "failed", state: "claimed", reason: "stub: fix recorded" };
      return { outcome: "progress", state: "claimed", record: { ...input.record, pr: 7, head_sha: HEAD } };
    };

    test("a done fix with a blocked spec beside the done one: the PR step gets kind fix and the blocked spec superseded", async () => {
      const h = harness({
        behaviors: [
          finishes("done"),
          ({ profile }) => {
            writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-first.md`, specText("blocked"));
            writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-rerun.md`, specText("done"));
            writeFileSync(profile.resultPath, buildResult("done"));
          },
        ],
      });
      h.fake.control.setChecks(HEAD, [{ name: "test", status: "completed", conclusion: "failure" }]);
      await h.run({ prStep: prStepFor(h), ciStep: ciStepFor(h) });
      expect(h.runs).toHaveLength(2);
      expect(h.prSteps).toHaveLength(2);
      expect(h.prSteps[1]).toMatchObject({ kind: "fix", specPath: `${SPEC_DIR}/spec-1-1-rerun.md`, superseded: [`${SPEC_DIR}/spec-1-1-first.md`] });
    });

    test("a blocked fix with no spec match parks with its kind instead of failing on the spec", async () => {
      const h = harness({
        behaviors: [
          finishes("done"),
          ({ profile }) => {
            writeFileSync(profile.resultPath, buildResult("blocked"));
          },
        ],
      });
      h.fake.control.setChecks(HEAD, [{ name: "test", status: "completed", conclusion: "failure" }]);
      expect((await h.run({ prStep: prStepFor(h), ciStep: ciStepFor(h) })).outcome).toBe("progress");
      expect(h.prSteps).toHaveLength(1);
      expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "intent-gap" }, attempts: 0 });
      const rec = h.unitRecord();
      expect(rec.reason ?? "").not.toContain("spec:");
      expect(rec).toMatchObject({ state: "parked", wip_ref: "refs/wip/story__1.1" });
    });
  });

  test("a write-check park from the PR step after a session: the journal's wip_ref and the log line", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    const r = await h.run({
      prStep: async (input) => ({
        outcome: "progress",
        state: "parked",
        record: { ...input.record, state: "parked", park: { kind: "blocked", reason: "write-check", inbox_owner: "alice", globs_held: [] } },
        reason: "write-check: refused CLAUDE.md (agent-config)",
      }),
    });
    expect(r.outcome).toBe("progress");
    const rec = h.unitRecord();
    expect(rec).toMatchObject({ state: "parked", sessions: 1, wip_ref: "refs/wip/story__1.1" });
    expect(readFileSync(rec.log, "utf8")).toContain("wip: if the session changed any file, its work is saved as refs/wip/story__1.1");
  });

  hostTest("with the sleep waiter, wait.pid names a live sleep during the trailing wait and is gone after", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    const store = createFsLaneStore({ laneDir: h.laneDir, hostStop: h.hostStop });
    const real = createSleepWaiter({ store, pollMs: 20 });
    const table = createPsProcessTable();
    const asked: number[] = [];
    let during: { command: string; args: string | null } = { command: "", args: null };
    const r = await h.run({
      waiter: {
        async wait(p) {
          asked.push(p.ms);
          const pending = real.wait({ ...p, ms: 400 });
          await Bun.sleep(150);
          const file = readPidFile(join(h.laneDir, "wait.pid"));
          if (file !== null) during = { command: file.command, args: table.inspect(file.pid)?.args ?? null };
          return pending;
        },
      },
    });
    expect(r.outcome).toBe("progress");
    expect(asked).toEqual([MIN]);
    expect(during).toEqual({ command: "sleep", args: expect.stringMatching(/^(\S*\/)?sleep 0\.4$/) });
    expect(existsSync(join(h.laneDir, "wait.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------- Story 2.1

describe("runLaneProcess heartbeat keeper", () => {
  /** A run that waits for its signal, then ends on SIGTERM; `onKill` says it was killed. */
  const untilAborted =
    (onKill: () => void = () => {}): Behavior =>
    ({ signal }) =>
      new Promise<Partial<SandboxRun>>((resolve) => {
        const end = () => {
          onKill();
          resolve({ exitCode: null, signal: "SIGTERM" });
        };
        if (signal.aborted) end();
        else signal.addEventListener("abort", end, { once: true });
      });

  test("keepAlive commits stamp the claim during a session that runs until aborted", async () => {
    let before = 0;
    let during = 0;
    const hang = untilAborted(() => {
      during = keepAlives(h.fake) - before;
    });
    const h = harness({
      behaviors: [
        (ctx) => {
          before = keepAlives(h.fake);
          return hang(ctx);
        },
      ],
    });
    const r = await h.run({ limits: { sessionMs: 200 }, heartbeat: { sleep: fastBeats } });
    expect(r.outcome).toBe("failed");
    expect(during).toBeGreaterThanOrEqual(2);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 1, owner: "alice", generation: 1 });
  });

  test.each(["claimed", "merging"] as const)("keepAlive commits go on through the trailing wait while the record is %s, and stop after it", async (state) => {
    const h = harness({ behaviors: [finishes("done")] });
    let during = 0;
    const r = await h.run({
      heartbeat: { sleep: fastBeats },
      prStep: async (input) => {
        if (state === "merging") foreignRecords(h.fake, [{ ...input.record, state: "merging", pr: 7, passed_sha: "a".repeat(40) }]);
        return { outcome: "progress", state };
      },
      waiter: {
        async wait() {
          const before = keepAlives(h.fake);
          await until(() => keepAlives(h.fake) >= before + 2);
          during = keepAlives(h.fake) - before;
          return { end: "elapsed" };
        },
      },
    });
    expect(r.outcome).toBe("progress");
    expect(during).toBeGreaterThanOrEqual(2);
    const after = keepAlives(h.fake);
    await Bun.sleep(40);
    expect(keepAlives(h.fake)).toBe(after);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state, owner: "alice", generation: 1 });
  });

  test("lost during the session: the keeper kills the run, no PR step, nothing more written, journal failed with state null", async () => {
    let killed = false;
    const theirs = rec({ unit: "story:1.1", globs: ["src/s0/**"], owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2 });
    const hang = untilAborted(() => {
      killed = true;
    });
    const h = harness({
      behaviors: [
        (ctx) => {
          foreignRecords(h.fake, [theirs]);
          return hang(ctx);
        },
      ],
    });
    const r = await h.run({ heartbeat: { sleep: fastBeats } });
    expect(r.outcome).toBe("failed");
    expect(killed).toBe(true);
    // No resume after the kill, and no PR step: nothing pushed.
    expect(h.runs).toHaveLength(1);
    expect(h.prSteps).toHaveLength(0);
    expect((await h.ledger()).get("story:1.1")).toEqual(theirs);
    expect(h.fake.control.ledgerLog().at(-1)?.message).toBe("foreign [skip ci]");
    const j = h.unitRecord();
    expect(j).toMatchObject({ outcome: "failed", state: null, sessions: 1 });
    expect(j.reason).toContain("lost");
    expect(h.waits.map((w) => w.ms)).toEqual([15 * 60_000]);
  });

  test.each([
    ["transient", { kind: "transient", message: "502" }],
    ["rate-limited", { kind: "rate-limited", message: "slow down", retry_after: 60 }],
  ] as const)("heartbeats failing %s until the next retry would lapse: released with attempts unchanged, the run failed", async (_name, error) => {
    let clockMs = T0;
    const h = harness({ behaviors: [untilAborted()] });
    const failure: ForgeError = { ...error };
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: (oldSha, commit, opts) =>
        commit.message.startsWith("ledger: keepAlive ") ? Promise.resolve({ ok: false as const, error: failure }) : h.fake.forge.ledgerSwap(oldSha, commit, opts),
    };
    const r = await h.run({
      forge,
      now: () => clockMs,
      heartbeat: {
        sleep: async (ms, signal) => {
          clockMs += ms;
          await defaultSleep(1, signal);
        },
      },
    });
    expect(r.outcome).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect(h.prSteps).toHaveLength(0);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 0, owner: "alice", generation: 1 });
    const j = h.unitRecord();
    expect(j).toMatchObject({ outcome: "failed", state: "released", attempts: 0 });
    expect(j.reason).toContain("released");
    expect(clockMs - T0).toBeGreaterThanOrEqual(25 * 60_000);
    expect(clockMs - T0).toBeLessThan(40 * 60_000);
  });

  test("the lapse counts from the claim's snapshot time, not from the keeper's start after a slow claim swap", async () => {
    let clockMs = T0;
    let slowClaim = true;
    const h = harness({ behaviors: [untilAborted()] });
    const failure: ForgeError = { kind: "transient", message: "502" };
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: (oldSha, commit, opts) => {
        if (commit.message.startsWith("ledger: claim ") && slowClaim) {
          // The claim swap takes 20 min of host time after the snapshot's now was seen.
          slowClaim = false;
          clockMs += 20 * 60_000;
        }
        return commit.message.startsWith("ledger: keepAlive ") ? Promise.resolve({ ok: false as const, error: failure }) : h.fake.forge.ledgerSwap(oldSha, commit, opts);
      },
    };
    const r = await h.run({
      forge,
      now: () => clockMs,
      heartbeat: {
        sleep: async (ms, signal) => {
          clockMs += ms;
          await defaultSleep(1, signal);
        },
      },
    });
    expect(r.outcome).toBe("failed");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", attempts: 0 });
    // Beats fail from T0 + 25 min; the try at T0 + 28 min could land at T0 + 30 min. From the keeper's start it would be T0 + 48 min.
    expect(clockMs - T0).toBe(28 * 60_000);
  });

  test("lapsed: the beats and the release on the lapse fail, so the run fails with state null and the record stays claimed", async () => {
    let clockMs = T0;
    const h = harness({ behaviors: [untilAborted()] });
    const failure: ForgeError = { kind: "transient", message: "502" };
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: (oldSha, commit, opts) =>
        commit.message.startsWith("ledger: keepAlive ") || commit.message.startsWith("ledger: release ")
          ? Promise.resolve({ ok: false as const, error: failure })
          : h.fake.forge.ledgerSwap(oldSha, commit, opts),
    };
    const r = await h.run({
      forge,
      now: () => clockMs,
      heartbeat: {
        sleep: async (ms, signal) => {
          clockMs += ms;
          await defaultSleep(1, signal);
        },
      },
    });
    expect(r.outcome).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect(h.prSteps).toHaveLength(0);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "claimed", attempts: 0, owner: "alice", generation: 1 });
    expect(h.fake.control.ledgerLog().some((c) => c.message.startsWith("ledger: failAttempt "))).toBe(false);
    const j = h.unitRecord();
    expect(j).toMatchObject({ outcome: "failed", state: null, attempts: 0 });
    expect(j.reason).toContain("lapsed");
  });

  test("lost during the CI step: abandoned at the step's end, no merge step, journal failed with state null", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    const logText = (): string => {
      const dir = join(h.laneDir, "logs");
      return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("") : "";
    };
    let mergeSteps = 0;
    const r = await h.run({
      heartbeat: { sleep: fastBeats },
      prStep: async (input) => ({ outcome: "progress", state: "claimed", record: { ...input.record, pr: 7 } }),
      ciStep: async (input) => {
        foreignRecords(h.fake, [{ ...input.record, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2 }]);
        await until(() => logText().includes("heartbeat: story:1.1 lost"));
        return { outcome: "progress", state: "claimed", record: input.record };
      },
      mergeStep: async (input) => {
        mergeSteps += 1;
        return { outcome: "progress", state: "merged", record: input.record };
      },
    });
    expect(r.outcome).toBe("failed");
    expect(mergeSteps).toBe(0);
    expect(h.fake.control.ledgerLog().at(-1)?.message).toBe("foreign [skip ci]");
    const j = h.unitRecord();
    expect(j).toMatchObject({ outcome: "failed", state: null });
    expect(j.reason).toContain("lost");
  });

  test("the keeper stamps forge time: the snapshot's now plus the host time since, far from the host clock", async () => {
    // The host clock is years from the fake forge's `now` (T0); only the keeper's sleeps move it.
    const host0 = Date.parse("2031-01-01T00:00:00.000Z");
    let clockMs = host0;
    const stamps: string[] = [];
    const h = harness({
      behaviors: [
        async (ctx) => {
          await until(() => stamps.length >= 1);
          finishes("done")(ctx);
        },
      ],
    });
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: (oldSha, commit, opts) => {
        if (commit.message.startsWith("ledger: keepAlive ")) {
          for (const text of Object.values(commit.writes)) stamps.push((JSON.parse(text) as UnitRecord).heartbeat_at);
        }
        return h.fake.forge.ledgerSwap(oldSha, commit, opts);
      },
    };
    const r = await h.run({
      forge,
      now: () => clockMs,
      heartbeat: {
        sleep: async (ms, signal) => {
          clockMs += ms;
          await defaultSleep(1, signal);
        },
      },
    });
    expect(r.outcome).toBe("progress");
    // The first beat, 5 min of host time after the snapshot's now was seen.
    expect(stamps[0]).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });
});

describe("runLaneProcess stale takeover", () => {
  /** Exactly 30 min before the fake forge's `now`: stale. */
  const STALE_AT = "2026-10-23T09:30:00Z";
  /** 29:59 before it: not stale. */
  const FRESH_AT = "2026-10-23T09:30:01Z";
  const callOpts = () => ({ signal: AbortSignal.timeout(5000) });
  /** BOB's record for Story 1.1 at generation 3, its heartbeat at `STALE_AT`. */
  const bobs = (over: Partial<UnitRecord> = {}): UnitRecord =>
    rec({ unit: "story:1.1", globs: ["src/s0/**"], owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 3, heartbeat_at: STALE_AT, ...over });
  const messages = (fake: FakeForge): string[] => fake.control.ledgerLog().map((c) => c.message);
  const held = { owner: IDENTITY.owner, host: IDENTITY.host, lane: IDENTITY.lane };

  test("a stale claimed record with no PR: one takeOverStale commit, held at generation + 1 and attempts + 1, and the session runs", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    foreignRecords(h.fake, [bobs({ globs: ["src/old/**"], reviewed_sha: "a".repeat(40), passed_sha: "a".repeat(40) })]);
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("progress");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]", "ledger: takeOverStale story:1.1 [skip ci]"]);
    const record = (await h.ledger()).get("story:1.1");
    expect(record).toMatchObject({ state: "claimed", ...held, generation: 4, attempts: 1, pr: null, base_sha: main, reviewed_sha: null, passed_sha: null, globs: ["src/s0/**"] });
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
    expect(h.prepares[0]).toMatchObject({ unit: "story:1.1", start: main, fetch: [main], generation: 4 });
    expect(h.prSteps.map((s) => [s.unit.unit, s.record.generation])).toEqual([["story:1.1", 4]]);
    expect(h.unitRecord()).toMatchObject({ unit: "story:1.1", outcome: "progress", generation: 4, attempts: 1 });
  });

  test("a claimed record 29:59 old is passed over with a record-state reason", async () => {
    const h = harness({ done: ["1.2", "1.3"] });
    foreignRecords(h.fake, [bobs({ heartbeat_at: FRESH_AT })]);
    expect((await h.run()).outcome).toBe("idle");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]"]);
    expect(h.journal()).toMatchObject([{ type: "span", span: "idle", reason: "story:1.1 is claimed" }]);
    expect(h.runs).toHaveLength(0);
  });

  test("a stale claimed record with an open PR: the PR's head is adopted and prepared, start and fetch, before the first session", async () => {
    const h = harness({ behaviors: [finishes("done")] });
    await pr(h.fake, "1.1", "closed");
    const open = await pr(h.fake, "1.1", "open");
    foreignRecords(h.fake, [bobs({ pr: open.number, pr_owner: "bob", head_sha: "a".repeat(40), reviewed_sha: "a".repeat(40), approved_sha: "a".repeat(40) })]);
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("progress");
    const record = (await h.ledger()).get("story:1.1");
    expect(record).toMatchObject({
      state: "claimed",
      ...held,
      generation: 4,
      attempts: 1,
      pr: open.number,
      pr_owner: "alice",
      head_sha: open.head,
      base_sha: main,
      reviewed_sha: null,
      approved_sha: null,
    });
    expect(h.prepares).toHaveLength(1);
    expect(h.prepares[0]).toMatchObject({ start: open.head, fetch: [open.head], generation: 4 });
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  test("a stale claimed record whose PR merged: marked merged with no takeOverStale commit and no session", async () => {
    const h = harness();
    await pr(h.fake, "1.1", "merged");
    foreignRecords(h.fake, [bobs()]);
    expect((await h.run({ heartbeat: { sleep: fastBeats } })).outcome).toBe("progress");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]", "ledger: markMerged story:1.1 [skip ci]"]);
    expect((await h.ledger()).get("story:1.1")?.state).toBe("merged");
    expect(h.runs).toHaveLength(0);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "merged", sessions: 0 });
  });

  test("the 3rd takeover parks blocked attempts-cap at generation + 1: no session, no keeper", async () => {
    const h = harness();
    foreignRecords(h.fake, [bobs({ attempts: 2 })]);
    expect((await h.run({ heartbeat: { sleep: fastBeats } })).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toMatchObject({
      state: "parked",
      ...held,
      generation: 4,
      attempts: 3,
      park: { kind: "blocked", reason: "attempts-cap", inbox_owner: "alice", globs_held: [] },
    });
    expect(h.runs).toHaveLength(0);
    await Bun.sleep(30);
    expect(keepAlives(h.fake)).toBe(0);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "parked", attempts: 3, generation: 4, sessions: 0 });
  });

  test("another lane wins the takeover swap: the next round picks the next Story", async () => {
    const h = harness({ behaviors: [finishes("done", "done", "second", "1-2")] });
    foreignRecords(h.fake, [bobs()]);
    const carols = bobs({ owner: "carol", host: "33333333-3333-4333-8333-333333333333", lane: "builder-3", generation: 4, attempts: 1, heartbeat_at: FORGE_NOW });
    h.fake.control.beforeSwap(({ n }) => {
      if (n === 1) foreignRecords(h.fake, [carols]);
    });
    expect((await h.run()).outcome).toBe("progress");
    expect((await h.ledger()).get("story:1.1")).toEqual(carols);
    expect(h.prSteps.map((s) => s.unit.unit)).toEqual(["story:1.2"]);
    expect(h.unitRecord()).toMatchObject({ unit: "story:1.2", outcome: "progress" });
  });

  /** An open PR on `story/1.1`, queued (or not), and BOB's stale `merging` record for it. */
  async function staleMerging(h: Harness, queued: boolean): Promise<{ number: number; head: string }> {
    const open = await pr(h.fake, "1.1", "open");
    if (queued) expect((await h.fake.forge.enqueue(open.number, open.head, callOpts())).ok).toBe(true);
    const main = await mainSha(h.fake);
    foreignRecords(h.fake, [bobs({ state: "merging", pr: open.number, pr_owner: "bob", head_sha: open.head, passed_sha: open.head, base_sha: main, attempts: 1 })]);
    return open;
  }

  /** The fake forge with `enqueue` and `dequeue` counted. */
  function counted(fake: FakeForge): { forge: Forge; calls: { enqueue: number; dequeue: number } } {
    const calls = { enqueue: 0, dequeue: 0 };
    const forge: Forge = {
      ...fake.forge,
      enqueue: (...a) => {
        calls.enqueue += 1;
        return fake.forge.enqueue(...a);
      },
      dequeue: (...a) => {
        calls.dequeue += 1;
        return fake.forge.dequeue(...a);
      },
    };
    return { forge, calls };
  }

  /** The real merge step on `forge`; `onSleep` runs at each of its sleeps. */
  const mergeStepOn = (forge: Forge, onSleep: (i: number) => void | Promise<void>) => {
    let i = 0;
    return createMergeStep({
      forge,
      diffPaths: async () => ok(["src/s0/a.ts"]),
      identity: IDENTITY,
      repo: LANE.repo,
      sleep: async () => {
        await onSleep(i);
        i += 1;
      },
      random: () => 0,
    });
  };

  test("a stale merging record still queued: held merging at generation + 1, no session, no enqueue; merged when the queue merges it", async () => {
    const h = harness();
    const open = await staleMerging(h, true);
    const { forge, calls } = counted(h.fake);
    let during: UnitRecord | undefined;
    const mergeStep = mergeStepOn(forge, async (i) => {
      if (i !== 0) return;
      during = (await h.ledger()).get("story:1.1");
      h.fake.control.mergeQueueHead();
    });
    expect((await h.run({ forge, mergeStep })).outcome).toBe("progress");
    expect(during).toMatchObject({ state: "merging", ...held, generation: 4, attempts: 1, pr: open.number, head_sha: open.head, passed_sha: open.head });
    expect(h.runs).toHaveLength(0);
    expect(h.prepares).toHaveLength(0);
    expect(calls.enqueue).toBe(0);
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]", "ledger: takeOverStale story:1.1 [skip ci]", "ledger: markMerged story:1.1 [skip ci]"]);
    expect((await h.ledger()).get("story:1.1")?.state).toBe("merged");
    expect(h.unitRecord()).toMatchObject({ unit: "story:1.1", outcome: "progress", state: "merged", generation: 4, sessions: 0 });
  });

  test("the keeper heartbeats a stale merging takeover while the merge step watches the queue", async () => {
    const h = harness();
    await staleMerging(h, true);
    let during: UnitRecord | undefined;
    let beats = 0;
    const mergeStep = mergeStepOn(h.fake.forge, async (i) => {
      if (i !== 0) return;
      await until(() => keepAlives(h.fake) >= 2);
      beats = keepAlives(h.fake);
      during = (await h.ledger()).get("story:1.1");
      h.fake.control.mergeQueueHead();
    });
    expect((await h.run({ mergeStep, heartbeat: { sleep: fastBeats } })).outcome).toBe("progress");
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(during).toMatchObject({ state: "merging", ...held, generation: 4 });
    expect((await h.ledger()).get("story:1.1")?.state).toBe("merged");
  });

  test("a stale merging takeover adopts the queue's head; a head other than passed_sha then fails in the merge step", async () => {
    const h = harness();
    const open = await pr(h.fake, "1.1", "open");
    expect((await h.fake.forge.enqueue(open.number, open.head, callOpts())).ok).toBe(true);
    const old = "a".repeat(40);
    foreignRecords(h.fake, [bobs({ state: "merging", pr: open.number, pr_owner: "bob", head_sha: old, passed_sha: old, attempts: 1 })]);
    const r = await h.run({ mergeStep: mergeStepOn(h.fake.forge, () => {}) });
    expect(r.outcome).toBe("failed");
    const takeover = h.fake.control.ledgerLog().findIndex((c) => c.message === "ledger: takeOverStale story:1.1 [skip ci]");
    expect(takeover).toBeGreaterThan(0);
    // The takeover wrote the queue's head; the guard then fenced, dequeued and released it.
    const edits = messages(h.fake).slice(takeover).map((m) => /^ledger: (\S+)/.exec(m)?.[1] ?? m);
    expect(edits).toEqual(["takeOverStale", "heartbeat", "failAttempt"]);
    expect(h.fake.control.queue()).toEqual([]);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", ...held, generation: 4, attempts: 2, head_sha: open.head, passed_sha: old });
    const j = h.unitRecord();
    expect(j).toMatchObject({ outcome: "failed", state: "released" });
    expect(j.reason).toContain(old);
  });

  test("ejected after the takeover: fenced and dequeued, claimed with attempts + 1, then the CI step and merge step run as usual", async () => {
    const h = harness();
    const open = await staleMerging(h, true);
    const { forge, calls } = counted(h.fake);
    const mergeStep = mergeStepOn(forge, (i) => {
      if (i === 0) h.fake.control.eject(open.number);
      else h.fake.control.mergeQueueHead();
    });
    const ciInputs: UnitRecord[] = [];
    const r = await h.run({
      forge,
      mergeStep,
      ciStep: async (input) => {
        ciInputs.push(input.record);
        return { outcome: "progress", state: "claimed", record: input.record };
      },
    });
    expect(r.outcome).toBe("progress");
    expect(ciInputs).toHaveLength(1);
    expect(ciInputs[0]).toMatchObject({ state: "claimed", ...held, generation: 4, attempts: 2, pr: open.number });
    expect(calls.dequeue).toBe(1);
    expect(calls.enqueue).toBe(1);
    const edits = messages(h.fake).map((m) => /^ledger: (\S+)/.exec(m)?.[1] ?? m);
    expect(edits).toEqual(["root", "foreign [skip ci]", "takeOverStale", "heartbeat", "ejected", "heartbeat", "startMerging", "markMerged"]);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "merged", attempts: 2 });
    expect(h.runs).toHaveLength(0);
  });

  test.each(["open, not queued", "closed", "not-found"] as const)("a stale merging record whose PR is %s: releaseStale, attempts + 1, the PR kept, no dequeue, no keeper", async (kind) => {
    const h = harness();
    let number = 99;
    if (kind === "open, not queued") number = (await staleMerging(h, false)).number;
    else if (kind === "closed") {
      number = (await pr(h.fake, "1.1", "closed")).number;
      foreignRecords(h.fake, [bobs({ state: "merging", pr: number, pr_owner: "bob", head_sha: "a".repeat(40), passed_sha: "a".repeat(40), attempts: 1 })]);
    } else {
      foreignRecords(h.fake, [bobs({ state: "merging", pr: number, pr_owner: "bob", head_sha: "a".repeat(40), passed_sha: "a".repeat(40), attempts: 1 })]);
    }
    const { forge, calls } = counted(h.fake);
    expect((await h.run({ forge, heartbeat: { sleep: fastBeats } })).outcome).toBe("progress");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]", "ledger: releaseStale story:1.1 [skip ci]"]);
    expect((await h.ledger()).get("story:1.1")).toMatchObject({ state: "released", ...held, generation: 3, attempts: 2, pr: number });
    expect(calls.dequeue).toBe(0);
    expect(h.runs).toHaveLength(0);
    await Bun.sleep(30);
    expect(keepAlives(h.fake)).toBe(0);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "released", attempts: 2 });
  });

  test("a stale merging record whose PR merged after the snapshot: queueState says merged, so it is marked merged with no takeover", async () => {
    const h = harness({ done: ["1.2", "1.3"] });
    const open = await staleMerging(h, true);
    h.fake.control.mergeQueueHead();
    // The snapshot still reports the PR open: the sweep passes it by, and queueState decides.
    const forge: Forge = {
      ...h.fake.forge,
      snapshot: async (o) => {
        const s = await h.fake.forge.snapshot(o);
        if (!s.ok) return s;
        return { ok: true, value: { ...s.value, prs: { ...s.value.prs, "story:1.1": { number: open.number, state: "open", head_sha: open.head } } } };
      },
    };
    expect((await h.run({ forge })).outcome).toBe("progress");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]", "ledger: markMerged story:1.1 [skip ci]"]);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "merged", reason: `PR #${open.number} merged` });
  });

  test("a stale merging record whose PR merged before the snapshot: the sweep marks it merged and next never takes it over", async () => {
    const h = harness({ done: ["1.2", "1.3"] });
    await staleMerging(h, true);
    h.fake.control.mergeQueueHead();
    expect((await h.run()).outcome).toBe("idle");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]", "ledger: markMerged story:1.1 [skip ci]"]);
  });

  test.each([
    ["transient", { kind: "transient", message: "502" }],
    ["rate-limited", { kind: "rate-limited", message: "slow down", retry_after: 5 }],
  ] as const)("queueState %s: the run ends failed with no ledger edit", async (_name, error) => {
    const h = harness();
    await staleMerging(h, true);
    h.fake.control.injectError("queueState", { ...error });
    expect((await h.run()).outcome).toBe("failed");
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]"]);
    expect(h.runs).toHaveLength(0);
    expect(h.unitRecord()).toMatchObject({ unit: "story:1.1", outcome: "failed" });
  });

  test.each(["auth", "forbidden", "uninstalled"] as const)("queueState %s: alerts forge-<kind> and stops, with no ledger edit", async (kind) => {
    const h = harness();
    await staleMerging(h, true);
    h.fake.control.injectError("queueState", { kind, message: "nope" } as ForgeError);
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("stop");
    expect(h.fake.control.alerts()).toEqual([{ condition: `forge-${kind}`, main_sha: main }]);
    expect(messages(h.fake)).toEqual(["root", "foreign [skip ci]"]);
    expect(h.runs).toHaveLength(0);
    expect(h.unitRecord()).toMatchObject({ unit: "story:1.1", outcome: "stop" });
  });
});

describe("readsPath", () => {
  const cases: readonly [string, boolean][] = [
    [".xarabot/config.yaml", true],
    [".xarabot/prompts/build.md", true],
    ["_bmad-output/planning-artifacts/epics.md", true],
    ["_bmad-output/implementation-artifacts/sprint-status.yaml", true],
    ["stories/2.1.md", true],
    ["docs/maintainer/standing-authority.md", true],
    ["src/lane/lane-process.ts", false],
    ["package.json", false],
    [".claude/skills/bmad-build/SKILL.md", false],
    [".agents/skills/bmad-build/SKILL.md", false],
    ["_bmad/config.toml", false],
    ["_bmad/custom/bmad-build.yaml", false],
  ];
  test.each(cases)("%s → %p", (path, expected) => {
    expect(readsPath(path)).toBe(expected);
  });
});

describe("runLaneProcess: the coordinator claim", () => {
  const claimed = (h: Harness) => h.fake.control.ledgerLog().some((c) => c.message === "ledger: claim story:1.1 [skip ci]");

  test.each([
    ["missing", null, "coordinator-missing"],
    ["expired (30 min since its heartbeat)", liveCoordinator("2026-10-23T09:30:00Z"), "coordinator-expired"],
  ] as const)("%s: one alert for this main SHA, and the builder still claims its Story", async (_name, coordinator, condition) => {
    const h = harness({ coordinator, behaviors: [finishes("done"), finishes("done", "done", "second", "1-2")] });
    const main = await mainSha(h.fake);
    expect((await h.run()).outcome).toBe("progress");
    expect(claimed(h)).toBe(true);
    expect(h.fake.control.alerts()).toEqual([{ condition, main_sha: main }]);
    // A second run on the same main posts nothing more.
    await h.run();
    expect(h.fake.control.alerts()).toHaveLength(1);
  });

  test("a live claim (29 min since its heartbeat) posts nothing", async () => {
    const h = harness({ coordinator: liveCoordinator("2026-10-23T09:31:00Z"), behaviors: [finishes("done")] });
    expect((await h.run()).outcome).toBe("progress");
    expect(claimed(h)).toBe(true);
    expect(h.fake.control.alerts()).toEqual([]);
  });

  test("a failed alert is ignored: the builder goes on building", async () => {
    const h = harness({ coordinator: null, behaviors: [finishes("done")] });
    h.fake.control.injectError("alert", { kind: "auth", message: "bad token" });
    expect((await h.run()).outcome).toBe("progress");
    expect(claimed(h)).toBe(true);
    expect(h.fake.control.alerts()).toEqual([]);
    expect(h.unitRecord()).toMatchObject({ outcome: "progress", state: "claimed" });
  });

  test("a throwing alert is ignored too", async () => {
    const h = harness({ coordinator: null, behaviors: [finishes("done")] });
    const forge: Forge = {
      ...h.fake.forge,
      alert: async () => {
        throw new Error("boom");
      },
    };
    expect((await h.run({ forge })).outcome).toBe("progress");
    expect(claimed(h)).toBe(true);
  });
});
