import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { ATTEMPTS_CAP } from "../../src/core/ledger/edits.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord } from "../../src/core/schemas/journal.ts";
import type { CoordinatorRecord, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent } from "../../src/ports/agent.ts";
import { forgeErr, type Forge } from "../../src/ports/forge.ts";
import { claimCoordinatorRecord, missingStepReason, runCoordinatorProcess, type CoordinatorDeps, type CoordinatorStep, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import { CAS_MAX_TRIES, type Sleep } from "../../src/lane/ledger-cas.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { addReviewUsage, newTrack } from "../../src/lane/session.ts";
import type { WaitParams, WaitResult } from "../../src/lane/wait.ts";
import { mainFiles } from "../cli/lane-fixture.ts";
import { COORD, rec, tip } from "../core/ledger/fixtures.ts";

const FORGE_NOW = "2026-10-23T10:00:00Z";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const MIN = 60_000;
const LANE: Lane = { repo: "xaravel/xarabot", role: "coordinator", owner: COORD.owner, agent: "claude", effort: "high" };
const AGENT = { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent;
const OTHER = { owner: "dave", host: "44444444-4444-4444-8444-444444444444" };

/** The claim `lane run` wrote: generation 1, the digest posted today (so the digest slot is no work). */
function claimRec(over: Partial<CoordinatorRecord> = {}): CoordinatorRecord {
  return {
    schema_version: 6,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator",
    generation: 1,
    heartbeat_at: FORGE_NOW,
    digest_posted_at: "2026-10-23T08:00:00Z",
    rulings_cursor: null,
    ...over,
  };
}

const coordUnit = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: FORGE_NOW, ...over });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

function abortOf(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

type Harness = {
  readonly fake: FakeForge;
  readonly laneDir: string;
  readonly waits: WaitParams[];
  readonly steps: CoordinatorStepInput[];
  /** Lets every keeper sleeping its interval beat once. */
  pulse(): void;
  run(over?: Partial<CoordinatorDeps>): Promise<{ outcome: string; laneStop?: string }>;
  ledger(): Promise<{ units: Map<string, UnitRecord>; coordinator: CoordinatorRecord | null }>;
  journal(): JournalRecord[];
  commits(prefix: string): number;
};

type HarnessOpts = {
  readonly records?: readonly UnitRecord[];
  readonly coordinator?: CoordinatorRecord;
  /** The claim the process is handed; default the seeded `coordinator.json`. */
  readonly claim?: CoordinatorRecord;
  readonly waiter?: (p: WaitParams, h: Harness) => Promise<WaitResult>;
  /** The keepers' wait after a failed beat; default theirs (60 s). */
  readonly retryMs?: number;
};

function harness(o: HarnessOpts = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "xarabot-coord-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "coordinator");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const seeded = o.coordinator ?? claimRec();
  const fake = createFakeForge({
    now: FORGE_NOW,
    main: mainFiles(),
    ledger: tip(o.records ?? [], { [COORDINATOR_PATH]: serializeCoordinator(seeded) }),
  });
  const waits: WaitParams[] = [];
  const steps: CoordinatorStepInput[] = [];

  // The keepers' interval sleeps wait for a pulse; the swaps' short back-off sleeps pass at once.
  const pending: (() => void)[] = [];
  const hbSleep: Sleep = (ms, signal) => {
    if (ms < MIN) return tick();
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => resolve();
      signal.addEventListener("abort", done, { once: true });
      pending.push(done);
    });
  };

  let clock = 0;
  const h: Harness = {
    fake,
    laneDir,
    waits,
    steps,
    pulse() {
      for (const f of pending.splice(0)) f();
    },
    run: (over = {}) =>
      runCoordinatorProcess({
        forge: fake.forge,
        agent: AGENT,
        store: createFsLaneStore({ laneDir, hostStop }),
        laneDir,
        identity: COORD,
        lane: LANE,
        claim: o.claim ?? seeded,
        steps: {},
        pid: 12345,
        now: () => T0 + 1000 * clock++,
        sleep: async () => {},
        random: () => 0,
        heartbeat: { sleep: hbSleep, ...(o.retryMs !== undefined ? { retryMs: o.retryMs } : {}) },
        waiter: {
          async wait(p) {
            waits.push(p);
            return o.waiter === undefined ? { end: "elapsed" } : o.waiter(p, h);
          },
        },
        ...over,
      }),
    async ledger() {
      const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return { units: new Map(l.value.units), coordinator: l.value.coordinator };
    },
    journal() {
      const path = join(laneDir, "journal.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as JournalRecord);
    },
    commits: (prefix) => fake.control.ledgerLog().filter((c) => c.message.startsWith(prefix)).length,
  };
  return h;
}

/** A step that records its input and returns `out`. */
const stepping =
  (h: Harness, out: Awaited<ReturnType<CoordinatorStep>> = { outcome: "progress", state: "claimed" }): CoordinatorStep =>
  async (input) => {
    h.steps.push(input);
    return out;
  };

/** Opens a PR on `branch`; returns its number. */
async function openPr(fake: FakeForge, branch: string): Promise<{ number: number; head: string }> {
  const opts = { signal: AbortSignal.timeout(5000) };
  const head = fake.control.makeCommit();
  const pushed = await fake.forge.pushBranch({ branch, expected_sha: null, sha: head }, opts);
  if (!pushed.ok) throw new Error(pushed.error.message);
  const opened = await fake.forge.openPr({ branch, base: "main", title: "t", body: "b" }, opts);
  if (!opened.ok) throw new Error(opened.error.message);
  return { number: opened.value.number, head };
}

const mainSha = async (fake: FakeForge): Promise<string> => {
  const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
  if (!s.ok) throw new Error(s.error.message);
  return s.value.main.sha;
};

describe("runCoordinatorProcess", () => {
  test("no reconcile step: idle with the 2.5 reason, nothing claimed, no unit record; the claim beats through the trailing wait", async () => {
    const h = harness({
      waiter: async (_p, hh) => {
        // During the trailing wait the coordinator.json keeper still beats.
        hh.pulse();
        await until(() => hh.commits("ledger: keepCoordinator ") >= 1);
        return { end: "elapsed" };
      },
    });
    expect((await h.run()).outcome).toBe("idle");
    expect(missingStepReason("reconcile")).toBe("no reconcile step (Story 2.5)");
    const journal = h.journal();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ type: "span", span: "idle", reason: "no reconcile step (Story 2.5)" });
    expect(h.waits.map((w) => w.ms)).toEqual([MIN]);
    const l = await h.ledger();
    expect(l.units.size).toBe(0);
    expect(h.commits("ledger: claim ")).toBe(0);
    expect(h.commits("ledger: keepCoordinator coordinator [skip ci]")).toBe(1);
    expect(l.coordinator).toMatchObject({ owner: COORD.owner, host: COORD.host, lane: "coordinator", generation: 1 });
    expect(l.coordinator?.heartbeat_at).not.toBe(FORGE_NOW);
    expect(readFileSync(join(h.laneDir, "outcome"), "utf8")).toBe("idle\n");
    expect(existsSync(join(h.laneDir, "lane.pid"))).toBe(false);
  });

  test("with a step: the unit is claimed from main, the step runs, one unit record is journaled", async () => {
    const h = harness();
    const r = await h.run({ steps: { reconcile: stepping(h, { outcome: "progress", state: "claimed", reason: "nothing to do" }) } });
    expect(r.outcome).toBe("progress");
    expect(h.steps).toHaveLength(1);
    const input = h.steps[0] as CoordinatorStepInput;
    expect(input.unit).toMatchObject({ unit: "reconcile:1", kind: "reconcile", globs: [], take_over: null, pr: null });
    expect(input.record).toMatchObject({ unit: "reconcile:1", state: "claimed", owner: COORD.owner, lane: "coordinator", generation: 1, globs: [] });
    expect(input.record.base_sha).toBe(await mainSha(h.fake));
    expect(input.snapshot.role).toBe("coordinator");
    expect(input.signal.aborted).toBe(false);
    expect(h.commits("ledger: claim reconcile:1 [skip ci]")).toBe(1);
    const units = h.journal().filter((j) => j.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      unit: "reconcile:1",
      lane: "coordinator",
      generation: 1,
      outcome: "progress",
      state: "claimed",
      agent: "claude",
      model: "claude-opus-5-5",
      sessions: 0,
      reason: "nothing to do",
    });
    expect(h.waits.map((w) => w.ms)).toEqual([MIN]);
  });

  test("review usage on the step's track reaches the unit record (Epic 3 retro item 5)", async () => {
    const h = harness();
    const line = "normal review of abc by codex gpt-6.1-sol: 2 run(s), tokens 30 in, 4 out, 0 cache read, 0 cache creation, cost $0.5000 (estimate)";
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      // What the review step does through a planning or retro step's review gate.
      const pass = newTrack({ unit: input.unit.unit, startedMs: 0, logName: input.track.logName, state: "claimed" });
      pass.sessions = 2;
      pass.tokens = { input: 30, output: 4, cacheRead: 0, cacheCreation: 0 };
      pass.cost = { usd: 0.5, estimate: true };
      addReviewUsage(input.track, pass);
      return { outcome: "progress", state: "claimed", reason: line };
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("progress");
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({
      unit: "reconcile:1",
      agent: "claude",
      model: "claude-opus-5-5",
      sessions: 2,
      tokens: { input: 30, output: 4, cacheRead: 0, cacheCreation: 0 },
      cost: { usd: 0.5, estimate: true },
      reason: line,
    });
  });

  test("a stale claimed coordinator unit with its PR open is taken over, adopting the PR", async () => {
    const probe = harness();
    const pr = await openPr(probe.fake, "xarabot/planning-status.1");
    const records = [
      coordUnit("reconcile:4", { state: "merged", heartbeat_at: "2026-10-23T09:59:00Z" }),
      coordUnit("planning:status.1", { state: "claimed", ...OTHER, pr: pr.number, heartbeat_at: "2026-10-23T09:30:00Z" }),
    ];
    probe.fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip(records), deletes: [] });
    const r = await probe.run({ steps: { planning: stepping(probe) } });
    expect(r.outcome).toBe("progress");
    expect(probe.commits("ledger: takeOverStale planning:status.1 [skip ci]")).toBe(1);
    const input = probe.steps[0] as CoordinatorStepInput;
    expect(input.unit).toMatchObject({ unit: "planning:status.1", take_over: "claimed", expect_generation: 1, pr: pr.number });
    expect(input.record).toMatchObject({ owner: COORD.owner, host: COORD.host, generation: 2, attempts: 1, pr: pr.number, head_sha: pr.head });
  });

  test("a step for another kind does not cover reconcile", async () => {
    const h = harness();
    expect((await h.run({ steps: { planning: stepping(h) } })).outcome).toBe("idle");
    expect(h.steps).toHaveLength(0);
    expect(h.journal()).toEqual([expect.objectContaining({ span: "idle", reason: "no reconcile step (Story 2.5)" })]);
  });

  test("the claim lost mid-round: the keeper aborts the step's signal, the run ends failed, and the unit is no longer kept", async () => {
    let beatsInWait = null as number | null;
    const h = harness({
      waiter: async (_p, hh) => {
        // The unit keeper was stopped with the claim: a pulse in the trailing wait beats nothing.
        const before = hh.commits("ledger: keepAlive reconcile:1 ");
        hh.pulse();
        await Bun.sleep(20);
        beatsInWait = hh.commits("ledger: keepAlive reconcile:1 ") - before;
        return { end: "elapsed" };
      },
    });
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      const foreign = claimRec({ ...OTHER, generation: 2 });
      h.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(foreign) }, deletes: [] });
      h.pulse();
      await abortOf(input.signal);
      return { outcome: "progress", state: "claimed" };
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("failed");
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed" });
    expect(unit?.type === "unit" ? unit.reason : "").toContain("coordinator claim: coordinator.json lost");
    expect(h.waits.map((w) => w.ms)).toEqual([15 * MIN]);
    expect(h.commits("ledger: keepCoordinator ")).toBe(0);
    expect(beatsInWait).toBe(0);
  });

  test("a failed Halt after the claim (the coordinator claim lost): the fence refuses the failed attempt, the unit is left claimed for the new coordinator (Q5)", async () => {
    const h = harness();
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      const foreign = claimRec({ ...OTHER, generation: 2 });
      h.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(foreign) }, deletes: [] });
      h.pulse();
      await abortOf(input.signal);
      return { outcome: "progress", state: "claimed" };
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "claimed", attempts: 0, owner: COORD.owner, generation: 1 });
    expect(h.commits("ledger: failAttempt ")).toBe(0);
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed", state: null });
    const reason = unit?.type === "unit" ? (unit.reason ?? "") : "";
    expect(reason).toStartWith("coordinator claim: coordinator.json lost");
    expect(reason).toContain("failAttempt: coordinator.json is held by dave/");
  });

  test("a failed Halt after the claim lapsed (coordinator.json still this lane's): the fence lets the failed attempt through, released, attempts + 1", async () => {
    // Every coordinator.json beat fails; with a 40 min retry wait the first failure would lapse.
    const h = harness({ retryMs: 40 * MIN });
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: async (oldSha, commit, o) =>
        commit.message.startsWith("ledger: keepCoordinator ") ? forgeErr("transient", "down") : h.fake.forge.ledgerSwap(oldSha, commit, o),
    };
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      h.pulse();
      await abortOf(input.signal);
      return { outcome: "progress", state: "claimed" };
    };
    expect((await h.run({ forge, steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.commits("ledger: failAttempt reconcile:1 ")).toBe(1);
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit?.type === "unit" ? unit.reason : "").toStartWith("coordinator claim: coordinator.json lapsed");
  });

  test("a failed Halt whose failAttempt fails too: the state is unknown, the record left claimed", async () => {
    const h = harness();
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      const foreign = claimRec({ ...OTHER, generation: 2 });
      h.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(foreign) }, deletes: [] });
      h.pulse();
      await abortOf(input.signal);
      return { outcome: "progress", state: "claimed" };
    };
    const f = h.fake.forge;
    const forge: Forge = {
      ...f,
      ledgerSwap: (old, commit, o) =>
        commit.message.startsWith("ledger: failAttempt reconcile:1 ")
          ? Promise.resolve({ ok: false as const, error: { kind: "not-found" as const, message: "ledgerSwap: gone" } })
          : f.ledgerSwap(old, commit, o),
    };
    expect((await h.run({ forge, steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "claimed", attempts: 0 });
    // The coordinator claim is lost: no retry, the unit is left to go stale for the new coordinator.
    expect(h.waits.map((w) => w.ms)).toEqual([15 * MIN]);
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed", state: null });
    const reason = unit?.type === "unit" ? (unit.reason ?? "") : "";
    expect(reason).toContain("coordinator claim: coordinator.json lost");
    expect(reason).toContain("failAttempt: ");
  });

  test("the coordinator claim lapses mid-step: the unit keeper stops at once, so it beats no more while the step winds down (2.4 F2)", async () => {
    // Every coordinator.json beat fails, and with a 40 min retry wait the first failure lapses the claim.
    // coordinator.json stays this lane's, so the fence alone would still let a unit beat land.
    const h = harness({ retryMs: 40 * MIN });
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: async (oldSha, commit, o) =>
        commit.message.startsWith("ledger: keepCoordinator ") ? forgeErr("transient", "down") : h.fake.forge.ledgerSwap(oldSha, commit, o),
    };
    let beatsAfter = -1;
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      h.pulse();
      await abortOf(input.signal);
      const before = h.commits("ledger: keepAlive reconcile:1 ");
      h.pulse();
      await Bun.sleep(20);
      beatsAfter = h.commits("ledger: keepAlive reconcile:1 ") - before;
      return { outcome: "progress", state: "claimed" };
    };
    expect((await h.run({ forge, steps: { reconcile: step } })).outcome).toBe("failed");
    expect(beatsAfter).toBe(0);
    const logs = readdirSync(join(h.laneDir, "logs")).map((f) => readFileSync(join(h.laneDir, "logs", f), "utf8"));
    expect(logs.join("")).toContain("heartbeat: reconcile:1: the keeper stops (lapsed)");
  });

  test.each([
    ["the start snapshot 20 min before the process start: the first failed beat lapses the claim", T0 - 20 * MIN, true],
    ["no claimSeenMs (the process start): the same failed beat is retried", undefined, false],
  ] as const)("the coordinator keeper's lapse window counts from claimSeenMs: %s (2.4 F1)", async (_name, claimSeenMs, lapses) => {
    // A 9 min retry wait: now + 9 + 1 min reaches 30 min past a claim seen 20 min before the start, not past one seen at the start.
    const h = harness({ retryMs: 9 * MIN });
    let tries = 0;
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: async (oldSha, commit, o) => {
        if (!commit.message.startsWith("ledger: keepCoordinator ")) return h.fake.forge.ledgerSwap(oldSha, commit, o);
        tries += 1;
        return forgeErr("transient", "down");
      },
    };
    let aborted: boolean | null = null;
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      h.pulse();
      await until(() => tries >= CAS_MAX_TRIES);
      await Bun.sleep(20);
      aborted = input.signal.aborted;
      return { outcome: "progress", state: "claimed" };
    };
    const r = await h.run({ forge, steps: { reconcile: step }, ...(claimSeenMs !== undefined ? { claimSeenMs } : {}) });
    expect(aborted as boolean | null).toBe(lapses);
    expect(r.outcome).toBe(lapses ? "failed" : "progress");
    const unit = h.journal().find((j) => j.type === "unit");
    if (lapses) expect(unit?.type === "unit" ? unit.reason : "").toStartWith("coordinator claim: coordinator.json lapsed");
  });

  test("every unit edit is fenced on coordinator.json: a claim after another identity took coordinator.json over is refused, nothing written (Q5)", async () => {
    const h = harness();
    // The snapshot still shows this lane's claim; another identity takes coordinator.json over just before the unit claim's swap.
    const foreign = claimRec({ ...OTHER, generation: 2 });
    let taken = false;
    const forge: Forge = {
      ...h.fake.forge,
      snapshot: async (o) => {
        const snap = await h.fake.forge.snapshot(o);
        if (!taken && o.read === undefined) {
          taken = true;
          h.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(foreign) }, deletes: [] });
          return h.fake.forge.snapshot(o);
        }
        return snap;
      },
    };
    const r = await h.run({ forge, steps: { reconcile: stepping(h) } });
    expect(r.outcome).toBe("failed");
    expect(h.steps).toHaveLength(0);
    expect(h.commits("ledger: claim ")).toBe(0);
    expect((await h.ledger()).units.size).toBe(0);
    expect((await h.ledger()).coordinator).toEqual(foreign);
  });

  test("a released coordinator unit with its PR open is claimed at generation + 1, adopting the PR", async () => {
    const h = harness();
    const pr = await openPr(h.fake, "xarabot/planning-status.1");
    const records = [
      coordUnit("reconcile:4", { state: "merged", heartbeat_at: "2026-10-23T09:59:00Z" }),
      coordUnit("planning:status.1", { state: "released", generation: 3, attempts: 1, pr: pr.number }),
    ];
    h.fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip(records), deletes: [] });
    expect((await h.run({ steps: { planning: stepping(h) } })).outcome).toBe("progress");
    expect(h.commits("ledger: claim planning:status.1 [skip ci]")).toBe(1);
    expect(h.commits("ledger: takeOverStale ")).toBe(0);
    const want = { unit: "planning:status.1", state: "claimed", owner: COORD.owner, generation: 4, attempts: 1, pr: pr.number, head_sha: pr.head };
    expect((await h.ledger()).units.get("planning:status.1")).toMatchObject(want);
    const input = h.steps[0] as CoordinatorStepInput;
    expect(input.unit).toMatchObject({ unit: "planning:status.1", take_over: null, expect_generation: 3, pr: pr.number });
    expect(input.record).toMatchObject(want);
  });

  test("a stale takeover at the attempts cap parks: no step, progress, a parked unit record", async () => {
    const h = harness();
    const pr = await openPr(h.fake, "xarabot/planning-status.1");
    const records = [
      coordUnit("reconcile:4", { state: "merged", heartbeat_at: "2026-10-23T09:59:00Z" }),
      coordUnit("planning:status.1", { state: "claimed", ...OTHER, attempts: ATTEMPTS_CAP - 1, pr: pr.number, heartbeat_at: "2026-10-23T09:30:00Z" }),
    ];
    h.fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip(records), deletes: [] });
    expect((await h.run({ steps: { planning: stepping(h) } })).outcome).toBe("progress");
    expect(h.steps).toHaveLength(0);
    expect(h.commits("ledger: takeOverStale planning:status.1 [skip ci]")).toBe(1);
    const units = h.journal().filter((j) => j.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ unit: "planning:status.1", outcome: "progress", state: "parked", attempts: ATTEMPTS_CAP, generation: 2 });
    expect(units[0]?.type === "unit" ? units[0].reason : "").toContain("attempts-cap");
    expect((await h.ledger()).units.get("planning:status.1")).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "attempts-cap" } });
  });

  test("a coordinator.json of another generation in the snapshot ends the run failed before next", async () => {
    const h = harness({ coordinator: claimRec({ generation: 2 }), claim: claimRec() });
    expect((await h.run({ steps: { reconcile: stepping(h) } })).outcome).toBe("failed");
    expect(h.steps).toHaveLength(0);
    expect(h.journal()).toEqual([]);
    expect(h.commits("ledger: claim ")).toBe(0);
  });

  test.each(["host", "lane"] as const)("a %s STOP: stop, no snapshot, no ledger write", async (which) => {
    const h = harness();
    const path = which === "host" ? join(h.laneDir, "..", "..", "home", ".xarabot", "STOP") : join(h.laneDir, "STOP");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
    const r = await h.run({ steps: { reconcile: stepping(h) } });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toBeUndefined();
    expect(h.fake.control.trace()).toEqual([]);
    expect(h.fake.control.ledgerLog()).toHaveLength(1);
    expect(h.waits).toEqual([]);
  });

  test("a forge auth on the snapshot: forge-auth alert, stop with laneStop set", async () => {
    const h = harness();
    h.fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    const r = await h.run({ steps: { reconcile: stepping(h) } });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toContain("forge-auth");
    expect(h.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-auth"]);
    expect(h.steps).toHaveLength(0);
  });

  test("a keeper beat failing auth mid-step aborts the step's signal: forge-auth alert, stop with laneStop, the record left claimed", async () => {
    const h = harness();
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      // The next swap is a keeper's beat: GitHub refuses its credentials.
      h.fake.control.injectError("ledgerSwap", { kind: "auth", message: "bad token" });
      h.pulse();
      await abortOf(input.signal);
      return { outcome: "failed", state: "claimed", reason: "the step saw its signal abort" };
    };
    const r = await h.run({ steps: { reconcile: step } });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toContain("forge-auth");
    expect(r.laneStop).toContain("heartbeat");
    expect(h.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-auth"]);
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "claimed", attempts: 0 });
  });

  test("only the unit keeper's beat failing auth mid-step: checkUnit stops the lane, forge-auth alert, laneStop, the record left claimed", async () => {
    const h = harness();
    // Only the unit's keepAlive is refused; the coordinator.json keeper's beat lands.
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: async (oldSha, commit, o) =>
        commit.message.startsWith("ledger: keepAlive reconcile:1 ") ? forgeErr("auth", "bad token") : h.fake.forge.ledgerSwap(oldSha, commit, o),
    };
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      h.pulse();
      await abortOf(input.signal);
      return { outcome: "failed", state: "claimed", reason: "the step saw its signal abort" };
    };
    const r = await h.run({ forge, steps: { reconcile: step } });
    expect(r.outcome).toBe("stop");
    expect(r.laneStop).toContain("forge-auth");
    expect(r.laneStop).toContain("heartbeat");
    expect(r.laneStop).toContain("reconcile:1");
    expect(h.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-auth"]);
    expect(h.commits("ledger: keepCoordinator ")).toBeGreaterThanOrEqual(1);
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "claimed", attempts: 0 });
  });

  test.each([
    ["merging: the unit keeper stops, so the record gets no further heartbeat", "merging", 0],
    ["claimed: the unit keeper beats on through the trailing wait", "claimed", 1],
  ] as const)("a step that leaves its unit %s", async (_name, state, beats) => {
    let beatsInWait = -1;
    const h = harness({
      waiter: async (_p, hh) => {
        const before = hh.commits("ledger: keepAlive reconcile:1 ");
        hh.pulse();
        if (beats > 0) await until(() => hh.commits("ledger: keepAlive reconcile:1 ") > before);
        else await Bun.sleep(20);
        beatsInWait = hh.commits("ledger: keepAlive reconcile:1 ") - before;
        return { end: "elapsed" };
      },
    });
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      if (state === "merging") {
        // As startMerging leaves it: still held by this lane at this generation.
        const merging = { ...input.record, state: "merging" as const, pr: 3, passed_sha: "e".repeat(40), head_sha: "e".repeat(40) };
        h.fake.control.writeForeignLedger({ message: "startMerging [skip ci]", writes: tip([merging]), deletes: [] });
      }
      return { outcome: "progress", state };
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("progress");
    expect(beatsInWait).toBe(beats);
    expect(h.waits.map((w) => w.ms)).toEqual([MIN]);
    expect((await h.ledger()).units.get("reconcile:1")?.state).toBe(state);
  });

  test("the step gets main's file texts as the snapshot read them", async () => {
    const h = harness();
    await h.run({ steps: { reconcile: stepping(h) } });
    expect(h.steps[0]?.files["_bmad-output/implementation-artifacts/sprint-status.yaml"]).toBe(mainFiles()["_bmad-output/implementation-artifacts/sprint-status.yaml"]);
  });

  test("a step that throws is a failed attempt: the unit is released", async () => {
    const h = harness();
    const step: CoordinatorStep = async () => {
      throw new Error("boom");
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "released", attempts: 1 });
  });
});

describe("runCoordinatorProcess: the shared track helpers (Story 2.6a)", () => {
  /** A step output whose `reason` getter throws: a non-`Halt` throw from the process body after the claim. */
  const throwingReason = (): Awaited<ReturnType<CoordinatorStep>> => {
    const out = { outcome: "progress" as const, state: "claimed" as const };
    Object.defineProperty(out, "reason", {
      get() {
        throw new Error("reason blew up");
      },
    });
    return out;
  };

  test("a step that throws: failAttempt stamps the forge's fresh now, and the journal names the throw", async () => {
    const h = harness();
    const step: CoordinatorStep = async () => {
      h.fake.control.setNow("2026-10-23T10:07:00Z");
      throw new Error("boom");
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "released", attempts: 1, heartbeat_at: "2026-10-23T10:07:00Z" });
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed", state: "released" });
    expect(unit?.type === "unit" ? unit.reason : "").toContain("reconcile step threw: boom");
  });

  test("a failed attempt the ledger did not take is retried before the trailing wait: released, then what is left of the wait", async () => {
    let down = true;
    let clock = T0;
    const h = harness({
      waiter: async (p) => {
        clock += p.ms;
        down = false;
        return { end: "elapsed" };
      },
    });
    // failAttempt meets an outage that ends during the first retry wait.
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: async (oldSha, commit, o) =>
        down && commit.message.startsWith("ledger: failAttempt reconcile:1 ") ? forgeErr("transient", "ECONNRESET") : h.fake.forge.ledgerSwap(oldSha, commit, o),
    };
    const step: CoordinatorStep = async () => {
      throw new Error("boom");
    };
    expect((await h.run({ forge, now: () => clock, steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "released", attempts: 1 });
    expect(h.commits("ledger: failAttempt reconcile:1 ")).toBe(1);
    expect(h.waits.map((w) => w.ms)).toEqual([MIN, 14 * MIN]);
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed", state: "released", attempts: 1 });
    expect(unit?.type === "unit" ? unit.reason : "").toContain("failAttempt recorded on retry 2");
  });

  test("an unexpected error after the claim: one failed attempt, the journal reason names it", async () => {
    const h = harness();
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      return throwingReason();
    };
    expect((await h.run({ steps: { reconcile: step } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "released", attempts: 1 });
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed", state: "released", attempts: 1 });
    expect(unit?.type === "unit" ? unit.reason : "").toStartWith("unexpected error: reason blew up");
  });

  test("an unexpected error after the unit keeper released the unit: the journal keeps the keeper's state, no attempt counted", async () => {
    const h = harness();
    // Only the unit's keepAlive fails; with a 40 min retry wait its first failed beat would lapse, so the keeper releases.
    const forge: Forge = {
      ...h.fake.forge,
      ledgerSwap: async (oldSha, commit, o) =>
        commit.message.startsWith("ledger: keepAlive reconcile:1 ") ? forgeErr("transient", "down") : h.fake.forge.ledgerSwap(oldSha, commit, o),
    };
    const pending: (() => void)[] = [];
    const sleep: Sleep = (ms, signal) => {
      if (ms < MIN) return tick();
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
        pending.push(() => resolve());
      });
    };
    const step: CoordinatorStep = async (input) => {
      h.steps.push(input);
      for (const f of pending.splice(0)) f();
      await abortOf(input.signal);
      return throwingReason();
    };
    expect((await h.run({ forge, steps: { reconcile: step }, heartbeat: { sleep, retryMs: 40 * MIN } })).outcome).toBe("failed");
    expect((await h.ledger()).units.get("reconcile:1")).toMatchObject({ state: "released", attempts: 0 });
    expect(h.commits("ledger: failAttempt ")).toBe(0);
    const unit = h.journal().find((j) => j.type === "unit");
    expect(unit).toMatchObject({ unit: "reconcile:1", outcome: "failed", state: "released", attempts: 0 });
    expect(unit?.type === "unit" ? unit.reason : "").toContain("unexpected error: reason blew up");
    expect(unit?.type === "unit" ? unit.reason : "").toContain("heartbeat: reconcile:1 released");
  });
});

describe("claimCoordinatorRecord", () => {
  test("no record: generation 1; again: the same generation", async () => {
    const fake = createFakeForge({ now: FORGE_NOW });
    const first = await claimCoordinatorRecord({ forge: fake.forge, identity: COORD, now: FORGE_NOW });
    expect(first.ok && first.value).toEqual({ ...claimRec(), digest_posted_at: null });
    const again = await claimCoordinatorRecord({ forge: fake.forge, identity: COORD, now: "2026-10-23T10:05:00Z" });
    expect(again.ok && again.value).toMatchObject({ generation: 1, heartbeat_at: "2026-10-23T10:05:00Z" });
  });

  test("another identity's live claim: held, named, nothing written", async () => {
    const fake = createFakeForge({ now: FORGE_NOW, ledger: { [COORDINATOR_PATH]: serializeCoordinator(claimRec({ ...OTHER })) } });
    const r = await claimCoordinatorRecord({ forge: fake.forge, identity: COORD, now: FORGE_NOW });
    expect(r.ok ? "ok" : r.error.kind).toBe("held");
    expect(r.ok ? "" : r.error.message).toContain(`${OTHER.owner}/${OTHER.host}/coordinator`);
    expect(fake.control.ledgerLog()).toHaveLength(1);
  });
});
