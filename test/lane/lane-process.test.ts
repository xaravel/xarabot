import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import { ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import { UnitJournalRecordSchema, type JournalRecord, type UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { LaneIdentity, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent, AgentUnit } from "../../src/ports/agent.ts";
import type { ForgeError } from "../../src/ports/forge.ts";
import type { LaunchSpec, Sandbox, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { runLaneProcess, type LaneDeps, type PrStepInput } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { PrepareParams, Workspace } from "../../src/lane/workspace.ts";
import { BOB, rec, tip } from "../core/ledger/fixtures.ts";

// ------------------------------------------------------------------ world

const IDENTITY: LaneIdentity = { owner: "alice", host: "11111111-1111-4111-8111-111111111111", lane: "builder-1" };
const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };
const AUTHORITY = "docs/standing-authority.md";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const START_LOG = "2026-10-23T10-00-00Z";

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
  readonly seen: { agentPid: string | null; tmpClean: boolean | null };
  run(over?: Partial<LaneDeps>): Promise<{ outcome: string }>;
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
};

function harness(o: HarnessOpts = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "xarabot-lane-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o) });
  const runs: RunCall[] = [];
  const prepares: PrepareParams[] = [];
  const prSteps: PrStepInput[] = [];
  const seen: Harness["seen"] = { agentPid: null, tmpClean: null };
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
      } as LaunchSpec),
    parseUsage: () => ({
      sessionId,
      model: "reported-model",
      tokens: { input: 100, output: 20, cacheRead: 5, cacheCreation: 1 },
      cost: o.costs === undefined ? { usd: 0.5, estimate: true } : (o.costs[usageCalls++] ?? null),
      usageLimit: null,
    }),
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
    expect(readFileSync(join(h.laneDir, "lane.pid"), "utf8")).toBe("12345\n");
    expect(h.fake.control.trace().slice(0, 3)).toEqual(["ledger", "main", "prs"]);
    const log = h.fake.control.ledgerLog();
    expect(log[1]?.message).toBe("ledger: claim story:1.1 [skip ci]");
  });

  test.each(["host", "lane"] as const)("a %s STOP marker: outcome stop, no snapshot, no ledger commit", async (which) => {
    const h = harness();
    const path = which === "host" ? h.hostStop : join(h.laneDir, "STOP");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    expect((await h.run()).outcome).toBe("stop");
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
    expect(h.seen.agentPid).toBe("999\n");
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
    expect(rec.reason).toContain("frontmatter status");
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
    expect(h.unitRecord().reason).toContain("not a regular file");
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
    expect((await h.run()).outcome).toBe("stop");
    expect(h.fake.control.alerts()).toEqual([{ condition: `forge-${kind}`, main_sha: main }]);
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    expect(h.unitRecord()).toMatchObject({ outcome: "stop", state: null });
  });

  test("a forge auth on the first snapshot alerts with 40 zeros for main", async () => {
    const h = harness();
    h.fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    expect((await h.run()).outcome).toBe("stop");
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
    expect((await h.run()).outcome).toBe("stop");
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
      if (n === 1) foreignRecords(h.fake, [rec({ unit: "story:1.1", globs: ["src/s0/**"], owner: BOB.owner, host: BOB.host, lane: BOB.lane })]);
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
      if (n <= 3) foreignRecords(h.fake, [rec({ unit: `story:1.${n}`, globs: [`src/s${n - 1}/**`], owner: BOB.owner, host: BOB.host, lane: BOB.lane })]);
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
