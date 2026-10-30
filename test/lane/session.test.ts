import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createCodexAgent } from "../../src/adapters/agent/codex/codex-agent.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import { keepAlive, park } from "../../src/core/ledger/edits.ts";
import { err, ok, type Result } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import { unitPath, type CoordinatorRecord, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import { runLaneProcess } from "../../src/lane/lane-process.ts";
import { createFsLaneStore, laneLayout } from "../../src/lane/lane-store.ts";
import {
  allowanceReason,
  bestEffortOps,
  callPassedGate,
  createSessionRunner,
  End,
  fenceForge,
  forgeClock,
  forgeOps,
  Halt,
  haveCommits,
  ledgerFenceOf,
  newTrack,
  passedGate,
  sessionAllowance,
  stepKit,
  stepOps,
  ZERO_SHA,
  type PassedGate,
  type PassedGateRequest,
  type PromptOutcome,
  type SessionContext,
  type StepKit,
  type StepOps,
} from "../../src/lane/session.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import { forgeErr, forgeOk, type Forge, type ForgeCheck, type ForgeResult } from "../../src/ports/forge.ts";
import type { Sandbox, SandboxRun } from "../../src/ports/sandbox.ts";
import type { BuildResult } from "../../src/core/schemas/session-result.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { ALICE, BOB, COORD, rec, tip } from "../core/ledger/fixtures.ts";
import { cleanup, commit, rg, setup } from "./git-fixture.ts";

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

  test("a seed seen at an earlier host time counts from then, not from creation (Epic 2 retro item 22)", () => {
    const host = 1_000_000;
    const fc = forgeClock(() => host, FORGE_NOW, host - 90_000);
    expect(fc.seenAt()).toBe(host - 90_000);
    expect(fc.forgeNow()).toBe("2026-10-23T10:01:30.000Z");
    fc.see("2026-10-23T11:00:00Z");
    expect(fc.seenAt()).toBe(host);
  });
});

describe("a fenced forge (Q5)", () => {
  const claim = (over: Partial<CoordinatorRecord> = {}): CoordinatorRecord => ({
    schema_version: 6,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator",
    generation: 2,
    heartbeat_at: FORGE_NOW,
    digest_posted_at: null,
    rulings_cursor: null,
    ...over,
  });
  const seedClaim = (w: KitWorld, c: CoordinatorRecord) =>
    w.fake.control.writeForeignLedger({ message: "claim [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(c) }, deletes: [] });

  test("a plain forge has no fence: the edit as it is", () => {
    const fake = createFakeForge({ now: FORGE_NOW });
    const edit = keepAlive({ unit: UNIT, by: ALICE, now: FORGE_NOW, generation: 1 });
    expect(ledgerFenceOf(fake.forge)(edit)).toBe(edit);
  });

  test("fenceForge keeps every forge call and replaces an earlier fence", () => {
    const fake = createFakeForge({ now: FORGE_NOW });
    const once = fenceForge(fake.forge, { by: COORD, generation: 1 });
    const twice = fenceForge(once, { by: COORD, generation: 2 });
    expect(twice.snapshot).toBe(fake.forge.snapshot);
    expect(twice.ledgerSwap).toBe(fake.forge.ledgerSwap);
    const files = tip([rec({ unit: UNIT })], { [COORDINATOR_PATH]: serializeCoordinator(claim()) });
    const edit = keepAlive({ unit: UNIT, by: ALICE, now: FORGE_NOW, generation: 1 });
    expect(ledgerFenceOf(twice)(edit)(files).ok).toBe(true);
    expect(ledgerFenceOf(once)(edit)(files).ok).toBe(false);
  });

  test("the step kit's held edit through it lands while coordinator.json is held at the generation", async () => {
    const w = await kitWorld();
    seedClaim(w, claim());
    const kit = w.kit({ forge: fenceForge(w.fake.forge, { by: COORD, generation: 2 }) });
    await kit.held("park", park({ unit: UNIT, by: ALICE, now: kit.forgeNow(), generation: kit.generation, kind: "blocked", reason: "no-op" }));
    expect(await w.ledger()).toMatchObject({ state: "parked" });
  });

  test.each([
    ["taken over by another identity", claim({ owner: "dave", host: "44444444-4444-4444-8444-444444444444", generation: 3 })],
    ["at another generation", claim({ generation: 3 })],
  ] as const)("coordinator.json %s: the step kit's held edit is refused as a lost unit, nothing written", async (_name, foreign) => {
    const w = await kitWorld();
    seedClaim(w, foreign);
    const kit = w.kit({ forge: fenceForge(w.fake.forge, { by: COORD, generation: 2 }) });
    const out = await ended(() => kit.held("park", park({ unit: UNIT, by: ALICE, now: kit.forgeNow(), generation: kit.generation, kind: "blocked", reason: "no-op" })));
    expect(out.outcome).toBe("failed");
    expect(out.state).toBeNull();
    expect(out.reason).toContain("park: unit lost: ");
    expect(out.reason).toContain("the coordinator claim is lost");
    expect(await w.ledger()).toEqual(w.record);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("claim [skip ci]");
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

  test.each([
    ["another tempDir", { tempDir: "/elsewhere/tmp", resultPath: "/elsewhere/tmp/result.json" }],
    ["the runner's tempDir, another resultPath", { resultPath: "/elsewhere/result.json" }],
  ] as const)("a profile whose %s is not the runner's (Epic 3 retro item 1): no prepare, no sandbox run", async (_name, patch) => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }));
    const ctx: SessionContext = { ...w.ctx, profile: { ...w.ctx.profile, ...patch } };
    const r = await w.runner.session(ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toStartWith("profile: tempDir ");
    expect(r.reason).toContain("are not the runner's");
    expect(w.prepared).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.track.sessions).toBe(0);
  });

  test("an allowance refusal (Story 3.5): no prepare, no sandbox run, the session fails with the reason", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }));
    let asked = 0;
    const ctx: SessionContext = {
      ...w.ctx,
      allowed: async () => {
        asked += 1;
        return "allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)";
      },
    };
    const r = await w.runner.session(ctx, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(r).toEqual({ ok: false, reason: "allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)" });
    expect(asked).toBe(1);
    expect(w.prepared).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.track.sessions).toBe(0);
  });

  test("allowed runs before each fresh session: again after a usage-limit restart, which a revoked allowance then fails", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }), { runs: [{ usageLimit: { resetAt: null }, result: false }, {}] });
    const answers: (string | null)[] = [null, null];
    let asked = 0;
    const ok2 = await w.runner.session({ ...w.ctx, allowed: async () => answers[asked++] ?? null }, { at: w.at, kind: "planning", prompt: w.prompt });
    expect(ok2).toEqual({ ok: true, result: PLANNING });
    expect(asked).toBe(2);
    expect(w.runs).toHaveLength(2);

    const v = runnerWorld(() => ({ ok: true, value: "Plan." }), { runs: [{ usageLimit: { resetAt: null }, result: false }, {}] });
    const verdicts: (string | null)[] = [null, "allowance: revoked"];
    let n = 0;
    const r = await v.runner.session({ ...v.ctx, allowed: async () => verdicts[n++] ?? null }, { at: v.at, kind: "planning", prompt: v.prompt });
    expect(r).toEqual({ ok: false, reason: "allowance: revoked" });
    expect(n).toBe(2);
    expect(v.waits).toHaveLength(1);
    expect(v.runs).toHaveLength(1);
  });

  test("an allowed check that throws is a refusal, never a throw", async () => {
    const w = runnerWorld(() => ({ ok: true, value: "Plan." }));
    const r = await w.runner.session(
      {
        ...w.ctx,
        allowed: async () => {
          throw new Error("boom");
        },
      },
      { at: w.at, kind: "planning", prompt: w.prompt },
    );
    expect(r).toEqual({ ok: false, reason: "allowance: boom" });
    expect(w.runs).toEqual([]);
  });
});

describe("sessionAllowance (Story 3.5)", () => {
  const policyMain = (policy: string): Record<string, string> => ({
    ".xarabot/config.yaml": "schema_version: 1\nrunner_version: \"0.1.0\"\nmaintainer: edanisko\nstanding_authority_path: docs/sa.md\n",
    ".xarabot/policy.yaml": policy,
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    "docs/sa.md": "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
  });
  const check = (main: Record<string, string>, o: { agent?: string; also?: readonly string[] } = {}) => {
    const fake = createFakeForge({ now: "2026-10-25T10:00:00Z", main });
    return sessionAllowance({ forge: fake.forge, repo: "xaravel/xarabot", agent: o.agent ?? "claude", builderProviders: () => ["anthropic"], also: () => o.also ?? [], callTimeoutMs: 5000 });
  };
  test("an allowed agent with a reviewer: null", async () => {
    expect(await check(policyMain("schema_version: 1\nunattended_adapters: [claude]\n"))()).toBeNull();
  });
  test("an agent fresh main's policy no longer allows: the unattendedRefusal text", async () => {
    expect(await check(policyMain("schema_version: 1\nunattended_adapters: [codex]\n"))()).toBe(
      "allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)",
    );
  });
  test("another adapter the session runs (a reviewer) must be allowed too", async () => {
    expect(await check(policyMain("schema_version: 1\nunattended_adapters: [claude]\n"), { also: ["codex"] })()).toBe(
      "allowance: agent codex is not in .xarabot/policy.yaml unattended_adapters (allowed: claude)",
    );
  });
  test("an invalid config, or a failed snapshot, is a refusal reason", async () => {
    expect(await check(policyMain("schema_version: 9\n"))()).toStartWith("allowance: config ");
    const fake = createFakeForge({ now: "2026-10-25T10:00:00Z", main: policyMain("schema_version: 1\nunattended_adapters: [claude]\n") });
    fake.control.injectError("snapshot", { kind: "transient", message: "down" });
    const r = await sessionAllowance({ forge: fake.forge, repo: "xaravel/xarabot", agent: "claude", builderProviders: () => [], callTimeoutMs: 5000 })();
    expect(r).toBe("allowance: snapshot transient: down");
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

describe("the review plumbing the steps share (Epic 3 retro item 8)", () => {
  afterEach(cleanup);
  const HEAD = "a".repeat(40);
  const MAIN = "b".repeat(40);
  const PASSED = "c".repeat(40);

  describe("allowanceReason", () => {
    test("an allowed agent with a reviewer: null", () => {
      expect(allowanceReason({ unattended_adapters: ["claude", "codex"] }, "claude", ["anthropic"])).toBeNull();
    });
    test("an agent the policy no longer allows, or no reviewer: the reason, prefixed allowance", () => {
      expect(allowanceReason({ unattended_adapters: ["codex"] }, "claude", [])).toBe("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
      expect(allowanceReason({ unattended_adapters: ["pi"] }, "pi", [])).toBe(
        "allowance: no reviewer: .xarabot/policy.yaml unattended_adapters allows neither claude nor codex",
      );
    });
  });

  describe("callPassedGate", () => {
    test("passes the request through, under the call deadline as well as the step's signal", async () => {
      const seen: PassedGateRequest[] = [];
      const passed: PassedGate = async (r) => {
        seen.push(r);
        return ok({ kind: "passed", how: "head" });
      };
      const step = new AbortController();
      expect(await callPassedGate({ passed, headSha: HEAD, passedSha: PASSED, mainSha: MAIN, signal: step.signal, callTimeoutMs: 5000 })).toEqual(ok({ kind: "passed", how: "head" }));
      expect(seen).toMatchObject([{ headSha: HEAD, passedSha: PASSED, mainSha: MAIN }]);
      expect(seen[0]?.signal.aborted).toBe(false);
      step.abort();
      expect(seen[0]?.signal.aborted).toBe(true);
    });

    test("the deadline aborts the gate's signal", async () => {
      const passed: PassedGate = (r) =>
        new Promise((resolve) => r.signal.addEventListener("abort", () => resolve(err("transient", "aborted")), { once: true }));
      expect(await callPassedGate({ passed, headSha: HEAD, passedSha: null, mainSha: MAIN, signal: new AbortController().signal, callTimeoutMs: 1 })).toEqual(err("transient", "aborted"));
    });

    test("a gate that throws is a transient error, never a throw", async () => {
      const passed: PassedGate = async () => {
        throw new Error("boom");
      };
      expect(await callPassedGate({ passed, headSha: HEAD, passedSha: null, mainSha: MAIN, signal: new AbortController().signal, callTimeoutMs: 5000 })).toEqual(
        err("transient", "passed gate threw: boom"),
      );
    });
  });

  describe("passedGate", () => {
    test("the kit's record's passed_sha, then the step's abort check; the outcome returned", async () => {
      const w = await kitWorld();
      const k = w.kit();
      k.record = { ...k.record, passed_sha: PASSED };
      const seen: (string | null)[] = [];
      let afters = 0;
      const passed: PassedGate = async (r) => {
        seen.push(r.passedSha);
        return ok({ kind: "unreviewed", why: "moved" });
      };
      const gate = await passedGate(k, { passed, headSha: HEAD, mainSha: MAIN, signal: new AbortController().signal, callTimeoutMs: 5000, after: () => void (afters += 1) });
      expect(gate).toEqual({ kind: "unreviewed", why: "moved" });
      expect(seen).toEqual([PASSED]);
      expect(afters).toBe(1);
    });

    test("a gate error is a failed attempt, after the abort check", async () => {
      const w = await kitWorld();
      const order: string[] = [];
      const passed: PassedGate = async () => {
        order.push("gate");
        return err("fetch", "offline");
      };
      const out = await ended(() => passedGate(w.kit(), { passed, headSha: HEAD, mainSha: MAIN, signal: new AbortController().signal, callTimeoutMs: 5000, after: () => void order.push("after") }));
      expect(order).toEqual(["gate", "after"]);
      expect(out).toMatchObject({ outcome: "failed", reason: "passed gate fetch: offline" });
    });
  });

  describe("stepOps.pushSessionFix", () => {
    const DONE: BuildResult = { kind: "build", outcome: "done", summary: "Fixed it", body: "", verification: ["bun test"], denied_actions: [] };
    const SPEC = "_bmad-output/implementation-artifacts/spec-1-1-x.md";

    async function fixWorld() {
      const w = await kitWorld();
      const k = w.kit();
      const ops = stepOps({ kit: k, forge: w.fake.forge, identity: ALICE, repo: "xaravel/xarabot", signal: new AbortController().signal, abortReason: "lost", clock: () => w.host, sleep: async () => {} });
      return { w, k, ops };
    }

    test("a done fix is pushed with the kit's record; claimed after it returns, the record adopted", async () => {
      const { w, k, ops } = await fixWorld();
      const pushed: unknown[] = [];
      const after = { ...w.record, head_sha: HEAD };
      await ops.pushSessionFix("CI fix", { result: DONE, specPath: SPEC, superseded: ["old.md"] }, true, async (fix) => {
        pushed.push(fix);
        return { outcome: "progress", state: "claimed", record: after, reason: "pushed the fix" };
      });
      expect(pushed).toEqual([{ record: w.record, result: DONE, specPath: SPEC, superseded: ["old.md"] }]);
      expect(k.record).toEqual(after);
      expect(k.reasons).toEqual(["pushed the fix"]);
      expect(w.logs).toEqual(["test step: CI fix result: done", "test step: PR step (fix): progress (claimed)"]);
    });

    test("any other ending of the push ends the step with it", async () => {
      const { ops } = await fixWorld();
      const out = await ended(() => ops.pushSessionFix("loopback", { result: DONE, specPath: null, superseded: [] }, false, async () => ({ outcome: "failed", state: null })));
      expect(out).toMatchObject({ outcome: "failed", state: null });
    });

    test("blocked and no-op park; a done one with no spec when one is needed, or a push that throws, is a failed attempt", async () => {
      const never = async (): Promise<never> => {
        throw new Error("not pushed");
      };
      const blocked = await fixWorld();
      const b = await ended(() => blocked.ops.pushSessionFix("loopback", { result: { ...DONE, outcome: "blocked", blocked: { kind: "intent-gap", text: "unclear" } } as BuildResult, specPath: null, superseded: [] }, true, never));
      expect(b).toMatchObject({ outcome: "progress", state: "parked", reason: "loopback blocked intent-gap: unclear" });
      expect(await blocked.w.ledger()).toMatchObject({ park: { kind: "blocked", reason: "intent-gap" } });

      const noop = await fixWorld();
      const n = await ended(() => noop.ops.pushSessionFix("CI fix", { result: { ...DONE, outcome: "no-op" } as BuildResult, specPath: null, superseded: [] }, true, never));
      expect(n).toMatchObject({ outcome: "progress", state: "parked", reason: "CI fix: no-op" });

      const noSpec = await fixWorld();
      const s = await ended(() => noSpec.ops.pushSessionFix("CI fix", { result: DONE, specPath: null, superseded: [] }, true, never));
      expect(s).toMatchObject({ outcome: "failed", reason: "CI fix session: a done result with no spec file" });

      const threw = await fixWorld();
      const t = await ended(() => threw.ops.pushSessionFix("CI fix", { result: DONE, specPath: null, superseded: [] }, false, async () => { throw new Error("boom"); }));
      expect(t).toMatchObject({ outcome: "failed", reason: "PR step threw: boom" });
    });
  });

  describe("haveCommits", () => {
    function recordingFetch(impl: FetchShas): { calls: (readonly string[])[]; fetch: FetchShas } {
      const calls: (readonly string[])[] = [];
      return {
        calls,
        fetch: async (shas, signal) => {
          calls.push([...shas]);
          return impl(shas, signal);
        },
      };
    }
    const live = () => AbortSignal.timeout(30_000);

    test("no fetch when every SHA is present", async () => {
      const repo = await setup();
      const a = await commit(repo.gitDir, { a: "a\n" });
      const f = recordingFetch(async () => err("fetch", "offline"));
      expect(await haveCommits(repo.gitDir, f.fetch, "test", [["headSha", a], ["mainSha", a]], live())).toEqual(ok(undefined));
      expect(f.calls).toEqual([]);
    });

    test("the missing SHAs fetched once, each named once; still missing after the fetch is an error", async () => {
      const repo = await setup();
      const a = await commit(repo.gitDir, { a: "a\n" });
      const missing = "e".repeat(40);
      const f = recordingFetch(async (): Promise<Result<void>> => ok(undefined));
      const r = await haveCommits(repo.gitDir, f.fetch, "test", [["headSha", missing], ["passedSha", a], ["mainSha", missing]], live());
      expect(f.calls).toEqual([[missing]]);
      expect(r).toEqual(err("missing-object", `test: after fetch: no commit ${missing} in runner.git`));
    });

    test("a fetch that fails or throws is a fetch error; a bad SHA is invalid with no fetch", async () => {
      const repo = await setup();
      const missing = "e".repeat(40);
      const failed = await haveCommits(repo.gitDir, async () => err("fetch", "offline"), "test", [["mainSha", missing]], live());
      expect(failed).toEqual(err("fetch", `test: fetching ${missing}: offline`));
      const thrown = await haveCommits(repo.gitDir, async () => { throw new Error("boom"); }, "test", [["mainSha", missing]], live());
      expect(thrown).toEqual(err("fetch", `test: fetching ${missing}: boom`));
      const f = recordingFetch(async () => ok(undefined));
      const bad = await haveCommits(repo.gitDir, f.fetch, "test", [["headSha", "nope"]], live());
      expect(bad.ok ? "ok" : bad.error).toEqual({ kind: "invalid", message: 'test: headSha: "nope" is not a full hex SHA' });
      expect(f.calls).toEqual([]);
    });

    test("a fetched SHA is then found", async () => {
      const repo = await setup();
      const other = await setup();
      const main = await commit(other.gitDir, { b: "b\n" });
      await rg(other.gitDir, ["update-ref", "refs/x/main", main]);
      const fetch: FetchShas = async () => {
        const p = Bun.spawnSync(["git", `--git-dir=${repo.gitDir}`, "fetch", "-q", other.gitDir, "refs/x/main:refs/x/main"], {
          env: { PATH: process.env.PATH ?? "", HOME: repo.gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        return p.exitCode === 0 ? ok(undefined) : err("fetch", p.stderr.toString());
      };
      expect(await haveCommits(repo.gitDir, fetch, "test", [["mainSha", main]], live())).toEqual(ok(undefined));
    });
  });
});

describe("bestEffortOps: the inbox and rulings steps' log and forge calls (Epic 4 retro item 5)", () => {
  test("a call that succeeds gives its value and logs nothing", async () => {
    const logs: string[] = [];
    const { call } = bestEffortOps("inbox", { log: (l) => logs.push(l), signal: new AbortController().signal });
    expect(await call("inboxes", async () => forgeOk(7))).toEqual({ ok: true, value: 7 });
    expect(logs).toEqual([]);
  });

  test("a failed call gives its kind and message, logged under the step's name", async () => {
    const logs: string[] = [];
    const { call } = bestEffortOps("rulings", { log: (l) => logs.push(l), signal: new AbortController().signal });
    expect(await call("readRulings", async () => forgeErr("transient", "502"))).toEqual({ ok: false, message: "transient: 502" });
    expect(logs).toEqual(["rulings step: readRulings failed: transient: 502; skipped"]);
  });

  test("a call that throws gives the thrown message, logged; it never throws", async () => {
    const logs: string[] = [];
    const { call } = bestEffortOps("inbox", { log: (l) => logs.push(l), signal: new AbortController().signal });
    expect(await call("openInbox alice", async () => Promise.reject(new Error("boom")))).toEqual({ ok: false, message: "boom" });
    expect(logs).toEqual(["inbox step: openInbox alice threw: boom; skipped"]);
  });

  test("each call gets its own deadline, joined with the step's signal", async () => {
    const outer = new AbortController();
    const { call } = bestEffortOps("inbox", { log: () => {}, signal: outer.signal, callTimeoutMs: 5 });
    const timedOut = await call("inboxes", (o) => new Promise<ForgeResult<boolean>>((resolve) => o.signal.addEventListener("abort", () => resolve(forgeOk(o.signal.aborted)))));
    expect(timedOut).toEqual({ ok: true, value: true });
    outer.abort();
    const aborted = await call("inboxes", async (o) => forgeOk(o.signal.aborted));
    expect(aborted).toEqual({ ok: true, value: true });
  });

  test("a log that throws is swallowed", async () => {
    const { log, call } = bestEffortOps("inbox", {
      log: () => {
        throw new Error("no log");
      },
      signal: new AbortController().signal,
    });
    expect(() => log("x")).not.toThrow();
    expect(await call("inboxes", async () => forgeErr("transient", "502"))).toEqual({ ok: false, message: "transient: 502" });
  });
});
