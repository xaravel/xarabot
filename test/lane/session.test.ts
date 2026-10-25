import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ZERO_SHA,
  type PromptOutcome,
  type SessionContext,
  type StepKit,
} from "../../src/lane/session.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import type { Forge } from "../../src/ports/forge.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";
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
