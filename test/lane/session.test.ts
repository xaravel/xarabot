import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createCodexAgent } from "../../src/adapters/agent/codex/codex-agent.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import { park } from "../../src/core/ledger/edits.ts";
import { ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import { unitPath, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import { runLaneProcess } from "../../src/lane/lane-process.ts";
import { createFsLaneStore, laneLayout } from "../../src/lane/lane-store.ts";
import {
  createSessionRunner,
  End,
  forgeClock,
  forgeOps,
  Halt,
  newTrack,
  stepKit,
  stepOps,
  ZERO_SHA,
  type PromptOutcome,
  type SessionContext,
  type StepKit,
  type StepOps,
} from "../../src/lane/session.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck } from "../../src/ports/forge.ts";
import type { Sandbox, SandboxRun } from "../../src/ports/sandbox.ts";
import { ALICE, BOB, rec, tip } from "../core/ledger/fixtures.ts";

const UNIT = "story:1.1";
const FORGE_NOW = "2026-10-23T10:00:00Z";
const opts = () => ({ signal: AbortSignal.timeout(5000) });

type KitWorld = {
  readonly fake: FakeForge;
  readonly record: UnitRecord;
  readonly logs: string[];
  /** The host clock the kit reads; tests move it. */
  host: number;
  kit(o?: { readonly forge?: Forge; readonly mainSha?: string; readonly callTimeoutMs?: number }): StepKit;
  ledger(): Promise<UnitRecord | undefined>;
};

async function kitWorld(): Promise<KitWorld> {
  const fake = createFakeForge({ now: FORGE_NOW });
  const record = rec({ unit: UNIT, globs: ["src/s0/**"] });
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([record]), deletes: [] });
  const logs: string[] = [];
  const w: KitWorld = {
    fake,
    record,
    logs,
    host: Date.parse("2026-10-23T09:00:00Z"),
    kit: (o = {}) =>
      stepKit({
        name: "test step",
        forge: o.forge ?? fake.forge,
        identity: ALICE,
        record,
        log: (text) => logs.push(text),
        clock: () => w.host,
        callTimeoutMs: o.callTimeoutMs ?? 5000,
        sleep: async () => {},
        random: () => 0,
        ...(o.mainSha !== undefined ? { mainSha: o.mainSha } : {}),
      }),
    async ledger() {
      const s = await fake.forge.snapshot(opts());
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return l.value.units.get(UNIT);
    },
  };
  return w;
}

/** Runs `body`, expecting it to end the step; the step's output. */
async function ended(body: () => Promise<unknown>): Promise<End["out"]> {
  try {
    await body();
  } catch (e) {
    if (e instanceof End) return e.out;
    throw e;
  }
  throw new Error("the step did not end");
}

describe("forgeOps and the step kit: call", () => {
  test("a throwing port method is a transient error, in a step", async () => {
    const w = await kitWorld();
    const r = await w.kit().call("x", async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, error: { kind: "transient", message: "x threw: boom" } });
    expect(w.fake.control.alerts()).toEqual([]);
  });

  test("a throwing port method is a transient error, in a process, and never stops it", async () => {
    const fake = createFakeForge({ now: FORGE_NOW });
    const ops = forgeOps({
      forge: fake.forge,
      callTimeoutMs: 5000,
      clock: forgeClock(() => 0),
      alertSha: () => null,
      stop: (condition, why) => {
        throw new Halt("stop", `${condition}: ${why}`);
      },
    });
    const r = await ops.call("listPrsByBranch", async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, error: { kind: "transient", message: "listPrsByBranch threw: boom" } });
  });

  test("a lane-stop kind alerts at the kit's main SHA, then ends the step stop with the record's state", async () => {
    const w = await kitWorld();
    const main = "b".repeat(40);
    const kit = w.kit({ mainSha: main });
    const out = await ended(() => kit.call("x", async () => ({ ok: false, error: { kind: "auth", message: "bad token" } })));
    expect(out).toEqual({ outcome: "stop", state: "claimed", record: w.record, reason: "forge-auth: x: bad token" });
    expect(w.fake.control.alerts()).toEqual([{ condition: "forge-auth", main_sha: main }]);
    expect(kit.reasons).toEqual(["forge-auth: x: bad token"]);
    expect(w.logs).toContain("test step: stop: forge-auth: x: bad token");
  });

  test("with no main SHA seen, the alert names the zero SHA", async () => {
    const w = await kitWorld();
    await ended(() => w.kit().call("x", async () => ({ ok: false, error: { kind: "forbidden", message: "no" } })));
    expect(w.fake.control.alerts()).toEqual([{ condition: "forge-forbidden", main_sha: ZERO_SHA }]);
  });

  test("a failing alert is ignored: the step still ends stop", async () => {
    const w = await kitWorld();
    const forge: Forge = {
      ...w.fake.forge,
      alert: async () => {
        throw new Error("alert down");
      },
    };
    const out = await ended(() => w.kit({ forge }).call("x", async () => ({ ok: false, error: { kind: "uninstalled", message: "gone" } })));
    expect(out).toMatchObject({ outcome: "stop", state: "claimed", reason: "forge-uninstalled: x: gone" });
  });

  test("any other error is returned as it is", async () => {
    const w = await kitWorld();
    const r = await w.kit().call("x", async () => ({ ok: false, error: { kind: "not-found", message: "nope" } }));
    expect(r).toEqual({ ok: false, error: { kind: "not-found", message: "nope" } });
  });
});

describe("the step kit: held, beat and run", () => {
  test("held on a lost unit: End failed, state null, no further edit", async () => {
    const w = await kitWorld();
    const kit = w.kit();
    const theirs = rec({ unit: UNIT, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2, globs: ["src/s0/**"] });
    w.fake.control.writeForeignLedger({ message: "taken [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(theirs) }, deletes: [] });
    const out = await ended(() => kit.held("park", park({ unit: UNIT, by: ALICE, now: kit.forgeNow(), generation: kit.generation, kind: "blocked", reason: "no-op" })));
    expect(out.outcome).toBe("failed");
    expect(out.state).toBeNull();
    expect(out.reason).toStartWith("park: unit lost: ");
    expect(await w.ledger()).toEqual(theirs);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("taken [skip ci]");
  });

  test("held whose swap passes its deadline: a failed attempt, End failed with the released state", async () => {
    const w = await kitWorld();
    let first = true;
    const forge: Forge = {
      ...w.fake.forge,
      // The first swap's snapshot hangs until its deadline; every later call goes through.
      snapshot: async (o) => {
        if (!first) return w.fake.forge.snapshot(o);
        first = false;
        await new Promise<void>((resolve) => (o.signal.aborted ? resolve() : o.signal.addEventListener("abort", () => resolve(), { once: true })));
        return { ok: false, error: { kind: "transient", message: "slow" } };
      },
    };
    const kit = w.kit({ forge, callTimeoutMs: 50 });
    const out = await ended(() => kit.held("park", park({ unit: UNIT, by: ALICE, now: kit.forgeNow(), generation: kit.generation, kind: "blocked", reason: "no-op" })));
    expect(out.outcome).toBe("failed");
    expect(out.state).toBe("released");
    expect(out.reason).toStartWith("park: ledger deadline: ");
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("beat: a heartbeat at the kit's generation with set; the record is read back and lastBeat advances", async () => {
    const w = await kitWorld();
    const kit = w.kit();
    const passed = "c".repeat(40);
    const before = kit.lastBeat;
    w.host += 60_000;
    kit.see(FORGE_NOW);
    w.host += 5_000;
    await kit.beat("fence", { passed_sha: passed });
    expect(kit.lastBeat).toBe(before + 65_000);
    expect(kit.record).toMatchObject({ generation: 1, passed_sha: passed, heartbeat_at: "2026-10-23T10:00:05.000Z" });
    expect(await w.ledger()).toEqual(kit.record);
  });

  test("an unexpected throw is one failed attempt, and run never throws", async () => {
    const w = await kitWorld();
    const kit = w.kit();
    const out = await kit.run(async () => {
      throw new Error("x");
    });
    expect(out).toEqual({ outcome: "failed", state: "released", record: kit.record, reason: "unexpected error: x" });
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
    expect(w.logs).toEqual(["test step: failed: unexpected error: x", "test step: failAttempt: released"]);
  });

  test("a throw inside the failed attempt: failed, state null", async () => {
    const w = await kitWorld();
    const forge: Forge = {
      ...w.fake.forge,
      snapshot: async () => {
        throw new Error("snapshot blew up");
      },
    };
    const out = await w.kit({ forge }).run(async () => {
      throw new Error("x");
    });
    expect(out).toEqual({ outcome: "failed", state: null, record: w.record, reason: "unexpected error: x; unexpected error: snapshot blew up" });
    expect(await w.ledger()).toEqual(w.record);
  });

  test("an End from the body is the step's output", async () => {
    const w = await kitWorld();
    const kit = w.kit();
    const out = await kit.run(async () => {
      kit.reasons.push("why");
      throw kit.end("progress", "claimed", { ejected: true });
    });
    expect(out).toEqual({ outcome: "progress", state: "claimed", record: w.record, reason: "why", ejected: true });
  });
});

describe("stepOps: what the CI and coordinator steps share", () => {
  const BRANCH = "xarabot/planning-status-1";
  const success = (name: string): ForgeCheck => ({ name, status: "completed", conclusion: "success" });
  const failure = (name: string): ForgeCheck => ({ name, status: "completed", conclusion: "failure" });
  const running = (name: string): ForgeCheck => ({ name, status: "in_progress", conclusion: null });

  type OpsWorld = KitWorld & { readonly k: StepKit; readonly ops: StepOps; readonly abort: AbortController; readonly sleeps: number[] };

  /** `wrap` replaces the fake's forge, for both the kit and the ops. */
  async function opsWorld(wrap?: (fake: FakeForge) => Forge): Promise<OpsWorld> {
    const w = await kitWorld();
    const forge = wrap?.(w.fake) ?? w.fake.forge;
    const k = w.kit({ forge });
    const abort = new AbortController();
    const sleeps: number[] = [];
    const ops = stepOps({
      kit: k,
      forge,
      identity: ALICE,
      repo: "xaravel/xarabot",
      signal: abort.signal,
      abortReason: "the unit was lost during the test step",
      clock: () => w.host,
      sleep: async (ms) => {
        sleeps.push(ms);
        w.host += ms;
      },
    });
    return Object.assign(w, { k, ops, abort, sleeps });
  }

  /** An open PR on `branch`, as an earlier `openPr` left it. */
  async function openPr(w: KitWorld, branch: string): Promise<number> {
    const pushed = await w.fake.forge.pushBranch({ branch, expected_sha: null, sha: w.fake.control.makeCommit() }, opts());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const opened = await w.fake.forge.openPr({ branch, base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    return opened.value.number;
  }

  test("aborted: nothing until the signal aborts, then End failed with the record left as it is", async () => {
    const w = await opsWorld();
    w.ops.aborted();
    w.abort.abort();
    const out = await ended(async () => w.ops.aborted());
    expect(out).toEqual({ outcome: "failed", state: "claimed", record: w.record, reason: "the unit was lost during the test step" });
    expect(await w.ledger()).toEqual(w.record);
    expect(w.logs).toEqual(["test step: aborted: the unit was lost during the test step"]);
  });

  test("parkBlocked: the unit parked blocked for the reason, then End progress", async () => {
    const w = await opsWorld();
    const out = await ended(() => w.ops.parkBlocked("verification", "CI failed"));
    expect(out).toMatchObject({ outcome: "progress", state: "parked", reason: "CI failed" });
    expect(await w.ledger()).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "verification" } });
  });

  test("freshMain: a config that does not load ends the step stop, the record left as it is", async () => {
    const w = await opsWorld();
    const out = await ended(() => w.ops.freshMain());
    expect(out.outcome).toBe("stop");
    expect(out.state).toBe("claimed");
    expect(out.reason).toStartWith("config ");
    expect(await w.ledger()).toEqual(w.record);
  });

  test("freshMain: a failed snapshot is returned to the caller; an aborted signal ends the step first", async () => {
    const w = await opsWorld();
    w.fake.control.injectError("snapshot", { kind: "transient", message: "flaky" });
    expect(await w.ops.freshMain()).toEqual({ ok: false, error: { kind: "transient", message: "flaky" } });
    w.abort.abort();
    expect((await ended(() => w.ops.freshMain())).outcome).toBe("failed");
  });

  test("poll: pending, then passed; the sleeps back off", async () => {
    let polls = 0;
    const w = await opsWorld((fake) => ({
      ...fake.forge,
      checks: async (sha, o) => {
        polls += 1;
        fake.control.setChecks(sha, [polls < 3 ? running("test") : success("test")]);
        return fake.forge.checks(sha, o);
      },
    }));
    expect(await w.ops.poll(w.fake.control.makeCommit(), 60 * 60_000, [])).toBe("passed");
    expect(polls).toBe(3);
    expect(w.sleeps).toEqual([30_000, 60_000]);
  });

  test("poll: failing checks are returned by name", async () => {
    const w = await opsWorld();
    const sha = w.fake.control.makeCommit();
    w.fake.control.setChecks(sha, [failure("lint"), success("test")]);
    expect(await w.ops.poll(sha, 60_000, [])).toEqual(["lint"]);
  });

  test("poll: a transient error counts as pending; still pending past the wait parks ci-timeout", async () => {
    const w = await opsWorld();
    const sha = w.fake.control.makeCommit();
    w.fake.control.setChecks(sha, [running("test")]);
    w.fake.control.injectError("checks", { kind: "transient", message: "flaky" });
    const out = await ended(() => w.ops.poll(sha, 60_000, []));
    expect(out).toMatchObject({ outcome: "progress", state: "parked", reason: `CI on ${sha} still pending after 1 min` });
    expect(await w.ledger()).toMatchObject({ park: { kind: "blocked", reason: "ci-timeout" } });
    expect(w.logs).toContain("test step: checks transient: flaky: counted as pending");
  });

  test("poll: any other error is a failed attempt", async () => {
    const w = await opsWorld();
    const sha = w.fake.control.makeCommit();
    w.fake.control.injectError("checks", { kind: "not-found", message: "no such commit" });
    const out = await ended(() => w.ops.poll(sha, 60_000, []));
    expect(out).toMatchObject({ outcome: "failed", state: "released", reason: "checks not-found: no such commit" });
  });

  test("closeOrphans: each open PR on the branch is closed behind a fence", async () => {
    const w = await opsWorld();
    const pr = await openPr(w, BRANCH);
    await w.ops.closeOrphans(BRANCH);
    expect(w.k.reasons).toEqual([`closed PR #${pr}, which no record carries`]);
    const listed = await w.fake.forge.listPrsByBranch(BRANCH, opts());
    expect(listed.ok && listed.value.map((p) => p.state)).toEqual(["closed"]);
    expect((await w.ledger())?.heartbeat_at).not.toBe(w.record.heartbeat_at);
  });

  test("closeOrphans: a failed list is noted and closes nothing", async () => {
    const w = await opsWorld();
    await openPr(w, BRANCH);
    w.fake.control.injectError("listPrsByBranch", { kind: "transient", message: "flaky" });
    await w.ops.closeOrphans(BRANCH);
    expect(w.k.reasons).toEqual([`listPrsByBranch ${BRANCH} transient: flaky`]);
    expect(w.logs).toEqual([`test step: listPrsByBranch ${BRANCH} failed: transient: flaky`]);
  });

  test("closeOrphans: a fence that fails leaves the PR open and never ends the step", async () => {
    const w = await opsWorld();
    await openPr(w, BRANCH);
    const theirs = rec({ unit: UNIT, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2, globs: ["src/s0/**"] });
    w.fake.control.writeForeignLedger({ message: "taken [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(theirs) }, deletes: [] });
    await w.ops.closeOrphans(BRANCH);
    expect(w.k.reasons).toHaveLength(1);
    expect(w.k.reasons[0]).toMatch(/^fence before closing PR #\d+: .*; it stays open$/);
    const listed = await w.fake.forge.listPrsByBranch(BRANCH, opts());
    expect(listed.ok && listed.value.map((p) => p.state)).toEqual(["open"]);
  });

  test("recordPr: the PR and its SHAs on the record", async () => {
    const w = await opsWorld();
    const pr = await openPr(w, BRANCH);
    const head = "c".repeat(40);
    await w.ops.recordPr(pr, { pr, pr_owner: ALICE.owner, head_sha: head, base_sha: ZERO_SHA });
    expect(await w.ledger()).toMatchObject({ pr, head_sha: head });
    expect(w.k.record).toMatchObject({ pr, head_sha: head });
  });

  test("recordPr on a lost unit: the PR no record carries is closed, then End failed with no further edit", async () => {
    const w = await opsWorld();
    const pr = await openPr(w, BRANCH);
    const theirs = rec({ unit: UNIT, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2, globs: ["src/s0/**"] });
    w.fake.control.writeForeignLedger({ message: "taken [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(theirs) }, deletes: [] });
    const out = await ended(() => w.ops.recordPr(pr, { pr, pr_owner: ALICE.owner, head_sha: "c".repeat(40), base_sha: ZERO_SHA }));
    expect(out.outcome).toBe("failed");
    expect(out.state).toBeNull();
    expect(out.reason).toStartWith(`closed PR #${pr}, which no record carries; record: unit lost: `);
    expect(await w.ledger()).toEqual(theirs);
  });
});

describe("forgeClock", () => {
  test("the host time before any forge time; then the forge time plus the host time since", () => {
    let host = Date.parse("2001-01-01T00:00:00Z");
    const fc = forgeClock(() => host);
    expect(fc.forgeNow()).toBe("2001-01-01T00:00:00.000Z");
    fc.see(FORGE_NOW);
    expect(fc.seenAt()).toBe(host);
    host += 7_000;
    expect(fc.forgeNow()).toBe("2026-10-23T10:00:07.000Z");
  });

  test("a seed counts as seen at creation; a host clock going back never moves the forge time back", () => {
    let host = 1_000_000;
    const fc = forgeClock(() => host, FORGE_NOW);
    expect(fc.seenAt()).toBe(1_000_000);
    host -= 5_000;
    expect(fc.forgeNow()).toBe("2026-10-23T10:00:00.000Z");
  });
});

// ------------------------------------------------------------ the lane process

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AUTHORITY = "docs/standing-authority.md";
const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };

function mainFiles(): Record<string, string> {
  return {
    ".xarabot/config.yaml": [
      "schema_version: 1",
      'runner_version: "0.1.0"',
      "maintainer: edanisko",
      `standing_authority_path: ${AUTHORITY}`,
      "manifests:",
      "  dir: stories",
      "",
    ].join("\n"),
    ".xarabot/policy.yaml": "schema_version: 1\n",
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    "_bmad-output/planning-artifacts/epics.md": "# Epics\n\n## Epic 1: One\n\n### Story 1.1: Story 1.1\n\nBody.\n",
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    "_bmad-output/implementation-artifacts/sprint-status.yaml": "development_status:\n  epic-1: in-progress\n  1-1-first: backlog\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: Story 1.1\nglobs: ["src/s0/**"]\n---\n',
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-09-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
  };
}

describe("runLaneProcess: a forge call that throws", () => {
  test("listPrsByBranch throws: the run fails with a transient error, not an unexpected one", async () => {
    const root = mkdtempSync(join(tmpdir(), "xarabot-session-"));
    dirs.push(root);
    const laneDir = join(root, "lanes", "builder-1");
    const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles() });
    const forge: Forge = {
      ...fake.forge,
      listPrsByBranch: async () => {
        throw new Error("boom");
      },
    };
    const never = (what: string) => () => {
      throw new Error(`${what} must not run`);
    };
    const agent: Agent = {
      vendor: "claude",
      defaultModel: "claude-opus-5-5",
      minVersion: "2.1.304",
      launchSpec: never("launchSpec"),
      parseUsage: never("parseUsage"),
      effortValues: () => ["high"],
      startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
      checkModel,
    };
    const sandbox: Sandbox = { run: never("sandbox") };
    const r = await runLaneProcess({
      forge,
      agent,
      sandbox,
      store: createFsLaneStore({ laneDir, hostStop: join(root, "home", ".xarabot", "STOP") }),
      workspace: { prepare: never("prepare") },
      prStep: never("prStep"),
      laneDir,
      identity: ALICE,
      lane: LANE,
      pid: 12345,
      sleep: async () => {},
      random: () => 0,
      waiter: { wait: async () => ({ end: "elapsed" as const }) },
    });
    expect(r).toEqual({ outcome: "failed" });
    const path = join(laneDir, "journal.jsonl");
    expect(existsSync(path)).toBe(true);
    const units = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as JournalRecord)
      .filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ unit: UNIT, outcome: "failed" });
    expect(units[0]?.reason).toContain("listPrsByBranch transient: listPrsByBranch threw: boom");
    expect(units[0]?.reason).not.toContain("unexpected error");
    // A transient error stops nothing: only the builder's coordinator check alerts.
    expect(fake.control.alerts().map((a) => a.condition)).toEqual(["coordinator-missing"]);
  });
});

// ------------------------------------------------------------ the session runner

describe("createSessionRunner: session()", () => {
  const PLANNING = { kind: "planning", outcome: "done", summary: "Planned it", denied_actions: [] as string[] } as const;

  /** One stub run: the model and usage limit it reports, whether it writes the result (default yes), whether it hangs until killed. */
  type StubRun = { readonly model?: string | null; readonly usageLimit?: { readonly resetAt: number | null } | null; readonly result?: boolean; readonly hang?: boolean };

  /**
   * `reported`: the model each run reports (default the agent's default); `model`: the lane's configured model;
   * `runs`: per-run behaviour, overriding `reported`; `sessionMs`: the session limit.
   */
  function runnerWorld(
    prompt: () => PromptOutcome,
    o: { readonly reported?: string | null; readonly model?: string; readonly runs?: readonly StubRun[]; readonly sessionMs?: number } = {},
  ) {
    let usageCalls = 0;
    const waits: number[] = [];
    const root = mkdtempSync(join(tmpdir(), "xarabot-runner-"));
    dirs.push(root);
    const laneDir = join(root, "lanes", "coordinator");
    const layout = laneLayout(laneDir);
    const store = createFsLaneStore({ laneDir, hostStop: join(root, "home", ".xarabot", "STOP") });
    const runs: string[][] = [];
    const prepared: string[] = [];
    const agent: Agent = {
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
      parseUsage: () => {
        const stub = o.runs?.[usageCalls++];
        const model = stub?.model !== undefined ? stub.model : o.reported === undefined ? "claude-opus-5-5" : o.reported;
        return { sessionId: null, model, tokens: null, cost: null, usageLimit: stub?.usageLimit ?? null };
      },
      effortValues: () => ["high"],
      startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
      checkModel,
    };
    const sandbox: Sandbox = {
      async run(spec, profile, signal) {
        const stub = o.runs?.[runs.length];
        runs.push([...spec.argv]);
        if (stub?.hang === true) {
          await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
          return ok({ pid: 999, exitCode: null, signal: "SIGKILL", startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
        }
        if (stub?.result !== false) writeFileSync(profile.resultPath, JSON.stringify(PLANNING));
        return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
      },
    };
    const runner = createSessionRunner({
      agent,
      sandbox,
      store,
      workspace: {
        async prepare(p) {
          prepared.push(p.start);
          return ok({ sha: p.start, resumed: false });
        },
      },
      waiter: {
        wait: async (p) => {
          waits.push(p.ms);
          return { end: "elapsed" as const };
        },
      },
      layout,
      settings: { effort: "high", ...(o.model !== undefined ? { model: o.model } : {}) },
      ...(o.sessionMs !== undefined ? { limits: { sessionMs: o.sessionMs, resultPollMs: 10 } } : {}),
      clock: Date.now,
      note: () => {},
      log: () => {},
      reportStore: () => {},
    });
    const track = newTrack({ unit: "planning:status.1", startedMs: 0, logName: "planning.log", state: "claimed" });
    const ctx: SessionContext = {
      track,
      branch: "xarabot/planning-status.1",
      profile: {
        clone: layout.clone,
        vendorHome: layout.vendorHome,
        tempDir: layout.tmp,
        runnerGit: layout.runnerGit,
        resultPath: layout.resultPath,
        repoHosts: [],
      },
      budget: new AbortController().signal,
      overBudget: () => "over budget",
      signals: () => [],
      checkHeld: async () => {},
      onLimitStop: async () => {},
    };
    const at = "a".repeat(40);
    return { runner, ctx, track, runs, prepared, at, prompt, waits };
  }

  test("a planning session: the result parsed as planning, one run", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan the sprint." }));
    const r = await w.runner.session(w.ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r).toEqual({ ok: true, result: PLANNING });
    expect(w.track.sessions).toBe(1);
    expect(w.runs).toHaveLength(1);
    expect(w.prepared).toEqual([w.at]);
  });

  test("a run that reports the configured model: the track keeps it as reported", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }), { model: "claude-sonnet-5", reported: "claude-sonnet-5" });
    expect((await w.runner.session(w.ctx, { at: w.at, kind: "planning", prompt: w.prompt })).ok).toBe(true);
    expect(w.track.reportedModel).toBe("claude-sonnet-5");
  });

  test.each([
    ["the lane's model set, the default reported", { model: "claude-sonnet-5" }, "claude-opus-5-5", "ran claude-opus-5-5, not the configured claude-sonnet-5"],
    ["the default configured, another reported", { reported: "claude-sonnet-5-5" }, "claude-sonnet-5-5", "ran claude-sonnet-5-5, not the configured claude-opus-5-5"],
    ["no model reported", { reported: null }, null, "reported no model; configured claude-opus-5-5"],
  ] as const)("model-mismatch: %s", async (_name, o, reported, says) => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }), o);
    const r = await w.runner.session(w.ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toStartWith("model-mismatch: ");
    expect(r.reason).toContain(says);
    // The result file exists, but no resume and no parse follow the mismatch.
    expect(w.runs).toHaveLength(1);
    expect(w.track.reportedModel).toBe(reported);
  });

  test("a run that reported no model and hit a usage limit sleeps, then the session starts again", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }), { runs: [{ model: null, usageLimit: { resetAt: null }, result: false }, {}] });
    const r = await w.runner.session(w.ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r).toEqual({ ok: true, result: PLANNING });
    expect(w.waits).toHaveLength(1);
    expect(w.runs).toHaveLength(2);
  });

  test("a run that reported no model and ran past the session limit fails with the session-limit reason", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }), { runs: [{ model: null, hang: true, result: false }], sessionMs: 50 });
    const r = await w.runner.session(w.ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toStartWith("agent session ran past ");
    expect(w.runs).toHaveLength(1);
  });

  test("a prompt that fails: the session fails with its reason, and no sandbox run happens", async () => {
    const w = runnerWorld(() => ({ ok: false, reason: "no prompt" }));
    const r = await w.runner.session(w.ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r).toEqual({ ok: false, reason: "no prompt" });
    expect(w.runs).toEqual([]);
    expect(w.track.sessions).toBe(0);
  });
});

describe("createSessionRunner: a codex session", () => {
  const PLANNING = { kind: "planning", outcome: "done", summary: "Planned it", denied_actions: [] as string[] } as const;
  const SID = "01a1752b-acea-7ed3-883a-77eb2ba61eae";

  /** `codex exec --json` stdout for one run. */
  const codexStdout = (end: "completed" | "failed" | "none", message = "boom"): string =>
    [
      { type: "thread.started", thread_id: SID },
      { type: "turn.started" },
      ...(end === "completed" ? [{ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 7 } }] : []),
      ...(end === "failed" ? [{ type: "turn.failed", error: { message } }] : []),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n";

  /** The parent session file codex keeps in the vendor home. */
  const rollout = (model: string | null, limits?: { used_percent: number; resets_at: number }): string =>
    [
      { type: "session_meta", payload: { id: SID, source: "exec" } },
      ...(model === null ? [] : [{ type: "turn_context", payload: { model, effort: "high" } }]),
      ...(limits === undefined ? [] : [{ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: limits, secondary: null, rate_limit_reached_type: null } } }]),
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join("");

  /** One stub run: its stdout, the model its session file reports, whether it writes the result, and what the sandbox reports. */
  type CodexRun = {
    readonly end: "completed" | "failed" | "none";
    readonly message?: string;
    readonly model?: string | null;
    readonly limit?: { used_percent: number; resets_at: number };
    readonly result?: boolean;
    readonly credentialRewritten?: boolean;
    readonly proxyRequests?: SandboxRun["proxyRequests"];
  };

  function codexWorld(plan: readonly CodexRun[]) {
    const root = mkdtempSync(join(tmpdir(), "xarabot-codex-runner-"));
    dirs.push(root);
    const laneDir = join(root, "lanes", "builder-1");
    const layout = laneLayout(laneDir);
    const store = createFsLaneStore({ laneDir, hostStop: join(root, "home", ".xarabot", "STOP") });
    const specs: AgentLaunchSpec[] = [];
    const usageCalls: unknown[][] = [];
    const logs: string[] = [];
    const notes: string[] = [];
    const waits: number[] = [];
    const real = createCodexAgent({ credential: "auth-json" });
    const agent: Agent = {
      ...real,
      parseUsage: (...args) => {
        usageCalls.push(args);
        return real.parseUsage(...args);
      },
    };
    const sandbox: Sandbox = {
      async run(spec, profile) {
        const i = specs.length;
        specs.push(spec as AgentLaunchSpec);
        const p = plan[i] ?? { end: "completed" };
        const day = join(profile.vendorHome, "sessions", "2026", "10", "25");
        mkdirSync(day, { recursive: true });
        writeFileSync(join(day, `rollout-2026-10-25T15-26-00-${SID}.jsonl`), rollout(p.model === undefined ? "gpt-6.1-sol" : p.model, p.limit));
        if (p.result === true) writeFileSync(profile.resultPath, JSON.stringify(PLANNING));
        return ok({
          pid: 999,
          exitCode: p.end === "completed" ? 0 : 1,
          signal: null,
          startedAt: 1000 * (i + 1),
          endedAt: 1000 * (i + 1) + 500,
          durationMs: 500,
          stdout: codexStdout(p.end, p.message),
          stderr: "Reading additional input from stdin...\n",
          ...(p.proxyRequests !== undefined ? { proxyRequests: p.proxyRequests } : {}),
          ...(p.credentialRewritten !== undefined ? { credentialRewritten: p.credentialRewritten } : {}),
        });
      },
    };
    const runner = createSessionRunner({
      agent,
      sandbox,
      store,
      workspace: { prepare: async (p) => ok({ sha: p.start, resumed: false }) },
      waiter: {
        wait: async (p) => {
          waits.push(p.ms);
          return { end: "elapsed" as const };
        },
      },
      layout,
      settings: { effort: "high" },
      clock: Date.now,
      note: (t) => notes.push(t),
      log: (t) => logs.push(t),
      reportStore: () => {},
    });
    const track = newTrack({ unit: "story:3.1", startedMs: 0, logName: "story-3.1.log", state: "claimed" });
    const ctx: SessionContext = {
      track,
      branch: "story/3.1",
      profile: { clone: layout.clone, vendorHome: layout.vendorHome, tempDir: layout.tmp, runnerGit: layout.runnerGit, resultPath: layout.resultPath, repoHosts: [] },
      budget: new AbortController().signal,
      overBudget: () => "over budget",
      signals: () => [],
      checkHeld: async () => {},
      onLimitStop: async () => {},
    };
    const journal = (): JournalRecord[] =>
      (existsSync(layout.journal) ? readFileSync(layout.journal, "utf8") : "")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as JournalRecord);
    const session = () => runner.session(ctx, { at: "a".repeat(40), kind: "planning", prompt: () => ({ ok: true, value: "Plan." }) });
    return { session, specs, usageCalls, logs, notes, waits, track, layout, journal };
  }

  test("a run that leaves no result resumes once with codex exec … resume <thread_id> -- <the result prompt>", async () => {
    const w = codexWorld([{ end: "completed" }, { end: "completed", result: true }]);
    expect(await w.session()).toEqual({ ok: true, result: PLANNING });
    expect(w.specs).toHaveLength(2);
    const [fresh, resume] = w.specs as [AgentLaunchSpec, AgentLaunchSpec];
    expect(fresh.argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(fresh.argv.slice(-2)).toEqual(["--", "Plan."]);
    expect(resume.argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(resume.argv.slice(-4, -1)).toEqual(["resume", SID, "--"]);
    expect(resume.argv.at(-1)).toContain(w.layout.resultPath);
    expect(resume.resume).toBe(true);
    // Both runs' tokens are summed: (100 - 40) input, 40 cached, 7 output each.
    expect(w.track.tokens).toEqual({ input: 120, output: 14, cacheRead: 80, cacheCreation: 0 });
    expect(w.track.reportedModel).toBe("gpt-6.1-sol");
  });

  test("parseUsage gets the run's stdout, the lane's vendor home and the run's start", async () => {
    const w = codexWorld([{ end: "completed", result: true }]);
    await w.session();
    expect(w.usageCalls).toEqual([[codexStdout("completed"), w.layout.vendorHome, 1000]]);
  });

  test("a failed turn (not a usage limit) fails the attempt, with no resume", async () => {
    const w = codexWorld([{ end: "failed", message: "Invalid response.create payload (HTTP 400)" }]);
    const r = await w.session();
    expect(r).toEqual({ ok: false, reason: "agent turn failed: Invalid response.create payload (HTTP 400)" });
    expect(w.specs).toHaveLength(1);
    expect(w.waits).toEqual([]);
  });

  test("a failed turn at a usage limit sleeps until the reset, then the session starts again", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const w = codexWorld([{ end: "failed", message: "You've hit your usage limit.", limit: { used_percent: 100, resets_at: reset } }, { end: "completed", result: true }]);
    expect(await w.session()).toEqual({ ok: true, result: PLANNING });
    expect(w.waits).toHaveLength(1);
    expect(w.specs.map((s) => s.resume === true)).toEqual([false, false]);
    expect(w.journal().filter((j) => j.type === "span" && j.span === "usage-limit")).toHaveLength(1);
    expect(w.notes.join("\n")).toContain(`reset ${new Date(reset * 1000).toISOString()}`);
  });

  test.each([
    ["another model", "gpt-6-luna", "ran gpt-6-luna, not the configured gpt-6.1-sol"],
    ["no model", null, "reported no model; configured gpt-6.1-sol"],
  ] as const)("model-mismatch: the session file names %s", async (_name, model, says) => {
    const w = codexWorld([{ end: "completed", model, result: true }]);
    const r = await w.session();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(`model-mismatch: codex: the session ${says}`);
    expect(w.specs).toHaveLength(1);
  });

  test("a rewritten auth.json is journaled as one credential-rewrite span over the run, and noted", async () => {
    const w = codexWorld([{ end: "completed", credentialRewritten: true }, { end: "completed", result: true, credentialRewritten: false }]);
    expect((await w.session()).ok).toBe(true);
    const spans = w.journal().filter((j) => j.type === "span");
    expect(spans).toEqual([
      {
        schema_version: 1,
        type: "span",
        span: "credential-rewrite",
        reason: "run 1 (fresh) rewrote auth.json in the vendor home; not copied back",
        started_at: new Date(1000).toISOString(),
        ended_at: new Date(1500).toISOString(),
      },
    ]);
    expect(w.notes).toContain("run 1 (fresh) rewrote auth.json in the vendor home; the operator's credential is left as it is");
  });

  test("every proxy request goes in the unit log, after stdout and stderr", async () => {
    const w = codexWorld([
      {
        end: "completed",
        result: true,
        proxyRequests: [
          { target: "chatgpt.com:443", allowed: true, reason: null },
          { target: "chatgpt.com:443", allowed: true, reason: null },
          { target: "files.openai.com:443", allowed: false, reason: '"files.openai.com" is not on the allowlist' },
        ],
      },
    ]);
    await w.session();
    const log = w.logs.join("");
    expect(log).toContain('--- proxy ---\nallow chatgpt.com:443\nallow chatgpt.com:443\ndeny files.openai.com:443 ("files.openai.com" is not on the allowlist)\n');
    expect(log.indexOf("--- stderr ---")).toBeLessThan(log.indexOf("--- proxy ---"));
  });

  test("a run with no proxy record logs no proxy section", async () => {
    const w = codexWorld([{ end: "completed", result: true }]);
    await w.session();
    expect(w.logs.join("")).not.toContain("--- proxy ---");
  });
});
