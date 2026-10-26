import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { ok } from "../../src/core/result.ts";
import { redactSecrets } from "../../src/core/sanitize.ts";
import type { JournalRecord } from "../../src/core/schemas/journal.ts";
import { composeReviewers, credentialSecrets, laneRun, LANE_START_FAILED, type LaneRunDeps } from "../../src/cli/lane-run.ts";
import { PI_DEFERRAL } from "../../src/cli/pi-deferral.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import type { CoordinatorRecord } from "../../src/core/schemas/ledger.ts";
import { runCoordinatorProcess, type CoordinatorDeps } from "../../src/lane/coordinator-process.ts";
import { runLaneProcess, type LaneDeps } from "../../src/lane/lane-process.ts";
import type { ProcessInfo } from "../../src/core/lane/waits.ts";
import type { ProcessTable } from "../../src/lane/processes.ts";
import { forgeErr, type Forge } from "../../src/ports/forge.ts";
import * as planningStep from "../../src/lane/planning-step.ts";
import * as prStep from "../../src/lane/pr-step.ts";
import * as reconcileStep from "../../src/lane/reconcile-step.ts";
import * as retroItemStep from "../../src/lane/retro-item-step.ts";
import * as retroStep from "../../src/lane/retro-step.ts";
import * as mergeStep from "../../src/lane/merge-step.ts";
import * as reviewGate from "../../src/lane/review-gate.ts";
import * as reviewStep from "../../src/lane/review-step.ts";
import type { Agent } from "../../src/ports/agent.ts";
import type { CoordinatorStep } from "../../src/lane/coordinator-process.ts";
import { hostTest } from "../support/sandbox.ts";
import {
  cleanup,
  CODEX_AUTH,
  CODEX_REFRESH,
  fakeConnect,
  HOST_ID,
  mainFiles,
  stubInstaller,
  world,
  writeCodexCredential,
  writeCredential,
  type MainOpts,
  type World,
} from "./lane-fixture.ts";

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

/**
 * Each coordinator step factory `lane run` calls, and the builder's PR step
 * factory, with the deps it was given and the step it returned. The
 * factories are wrapped in place: each wrapper records the call and returns
 * the real factory's step, so every other test runs the real steps.
 */
const built = {
  reconcile: [] as { deps: reconcileStep.ReconcileStepDeps; step: CoordinatorStep }[],
  planning: [] as { deps: planningStep.PlanningStepDeps; step: CoordinatorStep }[],
  retro: [] as { deps: retroStep.RetroStepDeps; step: CoordinatorStep }[],
  retroItem: [] as { deps: retroItemStep.RetroItemStepDeps; step: CoordinatorStep }[],
  pr: [] as { deps: prStep.PrStepDeps; step: ReturnType<typeof prStep.createPrStep> }[],
  review: [] as { deps: reviewStep.ReviewStepDeps; step: reviewStep.ReviewStep }[],
  reviewGate: [] as { deps: reviewGate.ReviewGateDeps; step: reviewGate.ReviewGateStep }[],
  merge: [] as { deps: mergeStep.MergeStepDeps; step: mergeStep.MergeStep }[],
};
const realReconcile = reconcileStep.createReconcileStep;
const realPlanning = planningStep.createPlanningStep;
const realRetro = retroStep.createRetroStep;
const realRetroItem = retroItemStep.createRetroItemStep;
const realPr = prStep.createPrStep;
const realReview = reviewStep.createReviewStep;
const realReviewGate = reviewGate.createReviewGateStep;
const realMerge = mergeStep.createMergeStep;
mock.module("../../src/lane/review-step.ts", () => ({
  ...reviewStep,
  createReviewStep: (deps: reviewStep.ReviewStepDeps) => {
    const step = realReview(deps);
    built.review.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/review-gate.ts", () => ({
  ...reviewGate,
  createReviewGateStep: (deps: reviewGate.ReviewGateDeps) => {
    const step = realReviewGate(deps);
    built.reviewGate.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/merge-step.ts", () => ({
  ...mergeStep,
  createMergeStep: (deps: mergeStep.MergeStepDeps) => {
    const step = realMerge(deps);
    built.merge.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/pr-step.ts", () => ({
  ...prStep,
  createPrStep: (deps: prStep.PrStepDeps) => {
    const step = realPr(deps);
    built.pr.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/reconcile-step.ts", () => ({
  ...reconcileStep,
  createReconcileStep: (deps: reconcileStep.ReconcileStepDeps) => {
    const step = realReconcile(deps);
    built.reconcile.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/planning-step.ts", () => ({
  ...planningStep,
  createPlanningStep: (deps: planningStep.PlanningStepDeps) => {
    const step = realPlanning(deps);
    built.planning.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/retro-step.ts", () => ({
  ...retroStep,
  createRetroStep: (deps: retroStep.RetroStepDeps) => {
    const step = realRetro(deps);
    built.retro.push({ deps, step });
    return step;
  },
}));
mock.module("../../src/lane/retro-item-step.ts", () => ({
  ...retroItemStep,
  createRetroItemStep: (deps: retroItemStep.RetroItemStepDeps) => {
    const step = realRetroItem(deps);
    built.retroItem.push({ deps, step });
    return step;
  },
}));

const REPO = "xaravel/xarabot";

type LaneYaml = { readonly name?: string; readonly repo?: string; readonly role?: string; readonly agent?: string; readonly model?: string; readonly effort?: string };

function hostYaml(o: { hostId?: boolean; lanes?: readonly LaneYaml[] } = {}): string {
  const lines = ["schema_version: 1", ...(o.hostId === false ? [] : [`host_id: ${HOST_ID}`]), "lanes:"];
  for (const l of o.lanes ?? [{}]) {
    lines.push(`  ${l.name ?? "builder-1"}:`, `    repo: ${l.repo ?? REPO}`, `    role: ${l.role ?? "builder"}`, "    owner: alice", `    agent: ${l.agent ?? "claude"}`);
    if (l.model !== undefined) lines.push(`    model: ${l.model}`);
    if (l.effort !== undefined) lines.push(`    effort: ${l.effort}`);
  }
  return `${lines.join("\n")}\n`;
}

type Setup = {
  readonly host?: string;
  readonly runner?: string | null;
  readonly failedStarts?: number;
  readonly main?: MainOpts;
  readonly credential?: boolean;
  /** The codex credential files to write, mode 600; default none. */
  readonly codex?: readonly ("auth.json" | "api-key")[];
  readonly installed?: readonly string[];
  readonly env?: Record<string, string>;
  readonly version?: string;
  readonly installFails?: string;
  readonly connectFail?: string;
  readonly botUserFails?: boolean;
  /** The ledger's files at the start. */
  readonly ledger?: Record<string, string>;
  /** `lane.lock`'s text at the start, or `dir` for a folder in its place. */
  readonly lockText?: string;
  /** The lock's owner and process table; default `LOCK_OWNER` with no process for any PID. */
  readonly lock?: LaneRunDeps["lock"];
};

/** This run's lock owner in the lane-run tests. */
const LOCK_OWNER = { pid: 777, command: "bun", startedMs: Date.parse("2026-10-23T10:00:00.250Z") };
const OWN_LOCK = "777\nbun\n2026-10-23T10:00:00.250Z\n";
/** Another lane process's lock: pid 4242, started at 09:00. */
const OTHER_LOCK = "4242\nbun\n2026-10-23T09:00:00.000Z\n";
const OTHER_START = Date.parse("2026-10-23T09:00:00.000Z");

/** A process table answering `inspect` from `procs`; nothing is ever killed. */
function table(procs: Readonly<Record<number, ProcessInfo>> = {}): ProcessTable {
  return { inspect: (pid) => procs[pid] ?? null, kill: () => false };
}

type Ran = {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly fake: FakeForge;
  readonly starts: LaneDeps[];
  readonly coordinatorStarts: CoordinatorDeps[];
  /** The run lane's folder. */
  readonly laneDir: string;
  readonly installs: { version: string }[];
  readonly record: ReturnType<typeof fakeConnect>["record"];
  readonly w: World;
  failedStarts(): string | null;
  runnerFile(): string | null;
  again(): Promise<number>;
};

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

async function laneRunWith(
  o: Setup = {},
  args: readonly string[] = [REPO, "builder-1"],
  start?: LaneRunDeps["start"],
  startCoordinator?: LaneRunDeps["startCoordinator"],
  /** Runs once the world is written, before `laneRun`. */
  before?: (w: World) => void,
): Promise<Ran> {
  const w = world(dirs, o.env ?? {});
  const laneDir = join(dirname(w.laneDir), args[1] ?? "builder-1");
  mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
  writeFileSync(w.hostYaml, o.host ?? hostYaml());
  mkdirSync(laneDir, { recursive: true });
  const runner = o.runner === undefined ? "v1\n" : o.runner;
  if (runner !== null) writeFileSync(join(laneDir, "runner"), runner);
  if (o.failedStarts !== undefined) writeFileSync(join(laneDir, "failed-starts"), `${o.failedStarts}\n`);
  for (const v of o.installed ?? ["v1"]) mkdirSync(join(w.runnerRoot, v), { recursive: true });
  if (o.credential !== false) writeCredential(w);
  for (const file of o.codex ?? []) writeCodexCredential(w, file);
  if (o.lockText === "dir") mkdirSync(join(laneDir, "lane.lock"));
  else if (o.lockText !== undefined) writeFileSync(join(laneDir, "lane.lock"), o.lockText);
  before?.(w);
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o.main), ...(o.ledger !== undefined ? { ledger: o.ledger } : {}) });
  const conn = fakeConnect(fake, { ...(o.connectFail !== undefined ? { fail: o.connectFail } : {}), ...(o.botUserFails === true ? { botUserFails: true } : {}) });
  const installer = stubInstaller(o.installFails !== undefined ? { fail: o.installFails } : {});
  const starts: LaneDeps[] = [];
  const coordinatorStarts: CoordinatorDeps[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: LaneRunDeps = {
    env: w.env,
    connect: conn.connect,
    installRunner: installer.install,
    cliVersion: async () => ok(o.version ?? "2.1.309 (Claude Code)"),
    start:
      start ??
      (async (d) => {
        starts.push(d);
        return { outcome: "idle" };
      }),
    startCoordinator:
      startCoordinator ??
      (async (d) => {
        coordinatorStarts.push(d);
        return { outcome: "idle" };
      }),
    out: (l) => out.push(l),
    errOut: (l) => err.push(l),
    lock: o.lock ?? { ...LOCK_OWNER, table: table() },
  };
  const code = await laneRun(args, deps);
  return {
    code,
    out,
    err,
    fake,
    starts,
    coordinatorStarts,
    laneDir,
    installs: installer.calls,
    record: conn.record,
    w,
    failedStarts: () => read(join(laneDir, "failed-starts")),
    runnerFile: () => read(join(laneDir, "runner")),
    again: () => laneRun(args, deps),
  };
}

describe("xarabot lane run: the lane and STOP", () => {
  test("a lane STOP: exit 0, no count, no snapshot", async () => {
    const w = world(dirs);
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, hostYaml());
    mkdirSync(w.laneDir, { recursive: true });
    writeFileSync(join(w.laneDir, "STOP"), "stop\n");
    const fake = createFakeForge({ main: mainFiles() });
    const conn = fakeConnect(fake);
    const code = await laneRun([REPO, "builder-1"], { env: w.env, connect: conn.connect, out: () => {}, errOut: () => {} });
    expect(code).toBe(0);
    expect(conn.record.connects).toBe(0);
    expect(fake.control.trace()).toEqual([]);
    expect(existsSync(join(w.laneDir, "failed-starts"))).toBe(false);
  });

  test("a host STOP at a coordinator's start: exit 0, no count, no connect, no claim", async () => {
    const w = world(dirs);
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, hostYaml({ lanes: [{ name: "coordinator", role: "coordinator" }] }));
    mkdirSync(w.xarabot, { recursive: true });
    writeFileSync(join(w.xarabot, "STOP"), "stop\n");
    const fake = createFakeForge({ main: mainFiles() });
    const conn = fakeConnect(fake);
    const out: string[] = [];
    expect(await laneRun([REPO, "coordinator"], { env: w.env, connect: conn.connect, out: (l) => out.push(l), errOut: () => {} })).toBe(0);
    expect(out).toEqual([`${join(w.xarabot, "STOP")} present; not starting lane coordinator`]);
    expect(conn.record.connects).toBe(0);
    expect(fake.control.ledgerLog()).toHaveLength(1);
    const coordDir = join(dirname(w.laneDir), "coordinator");
    expect(existsSync(join(coordDir, "failed-starts"))).toBe(false);
    expect(existsSync(join(coordDir, "lane.lock"))).toBe(false);
  });

  test("a host STOP: exit 0, no count", async () => {
    const w = world(dirs);
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, hostYaml());
    mkdirSync(w.xarabot, { recursive: true });
    writeFileSync(join(w.xarabot, "STOP"), "stop\n");
    const conn = fakeConnect(createFakeForge({ main: mainFiles() }));
    expect(await laneRun([REPO, "builder-1"], { env: w.env, connect: conn.connect, out: () => {}, errOut: () => {} })).toBe(0);
    expect(conn.record.connects).toBe(0);
  });

  test.each([
    ["another repo", { host: hostYaml() }, ["xaravel/xaravel", "builder-1"], "is for xaravel/xarabot"],
    ["no host_id", { host: hostYaml({ hostId: false }) }, [REPO, "builder-1"], "no host_id"],
    ["an unknown lane", {}, [REPO, "builder-9"], "unknown lane"],
    ["no lane", {}, [REPO], "usage"],
  ] as const)("%s is refused, not counted", async (_name, o, args, why) => {
    const r = await laneRunWith(o, args);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(why);
    expect(r.record.connects).toBe(0);
    expect(r.failedStarts()).toBeNull();
  });
});

describe("xarabot lane run: lane.lock", () => {
  const lockPath = (r: Ran) => join(r.laneDir, "lane.lock");

  test("a live lock: exit 0 naming the PID, no connect, failed-starts untouched, nothing claimed, the lock left as it was", async () => {
    const r = await laneRunWith({
      lockText: OTHER_LOCK,
      failedStarts: 2,
      lock: { ...LOCK_OWNER, table: table({ 4242: { startMs: OTHER_START + 999, args: "/opt/homebrew/bin/bun /h/.xarabot/runner/v1/src/cli/main.ts lane run xaravel/xarabot builder-1" } }) },
    });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["lane builder-1 is already running (pid 4242, lane.lock); exiting without a claim"]);
    expect(r.err).toEqual([]);
    expect(r.record.connects).toBe(0);
    expect(r.fake.control.trace()).toEqual([]);
    expect(r.failedStarts()).toBe("2\n");
    expect(r.starts).toEqual([]);
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
    expect(readFileSync(lockPath(r), "utf8")).toBe(OTHER_LOCK);
  });

  test.each([
    ["a dead PID", {}, "no process has its PID"],
    ["a reused PID", { 4242: { startMs: OTHER_START + 2000, args: "bun main.ts lane run" } }, "its PID's process started after the lock was taken (a reused PID)"],
    ["another command", { 4242: { startMs: OTHER_START, args: "sleep 60" } }, "its PID runs another command"],
  ] as const)("%s: taken over, the run proceeds, the lock removed at exit", async (_name, procs, why) => {
    let during: string | null = null;
    const r = await laneRunWith({ lockText: OTHER_LOCK, lock: { ...LOCK_OWNER, table: table(procs) } }, [REPO, "builder-1"], async (d) => {
      during = read(join(d.laneDir, "lane.lock"));
      return { outcome: "idle" };
    });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`took over a stale lane.lock (pid 4242): ${why}`);
    expect(during as string | null).toBe(OWN_LOCK);
    expect(existsSync(lockPath(r))).toBe(false);
    expect(r.failedStarts()).toBe("0\n");
  });

  test("a malformed lock: taken over, the run proceeds", async () => {
    const r = await laneRunWith({ lockText: "garbage" });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("took over a stale lane.lock (pid unknown): its text does not parse");
    expect(r.starts).toHaveLength(1);
    expect(existsSync(lockPath(r))).toBe(false);
  });

  test("held during the run with this process's PID and start, and removed after a run that throws", async () => {
    let during: string | null = null;
    let laneDir = "";
    const run = laneRunWith({}, [REPO, "builder-1"], async (d) => {
      laneDir = d.laneDir;
      during = read(join(d.laneDir, "lane.lock"));
      throw new Error("boom");
    });
    await expect(run).rejects.toThrow("boom");
    expect(during as string | null).toBe(OWN_LOCK);
    expect(existsSync(join(laneDir, "lane.lock"))).toBe(false);
  });

  test("released after a refused start and after a version switch", async () => {
    const refused = await laneRunWith({ main: { unattended: [] } });
    expect(refused.code).toBe(1);
    expect(existsSync(lockPath(refused))).toBe(false);
    const switched = await laneRunWith({ main: { runnerVersion: "v2" } });
    expect(switched.code).toBe(0);
    expect(existsSync(lockPath(switched))).toBe(false);
  });

  test("a lock held by another run is not removed at this run's exit", async () => {
    const r = await laneRunWith({}, [REPO, "builder-1"], async (d) => {
      // Another process replaced the lock mid-run (it judged this one stale).
      writeFileSync(join(d.laneDir, "lane.lock"), OTHER_LOCK);
      return { outcome: "idle" };
    });
    expect(r.code).toBe(0);
    expect(readFileSync(lockPath(r), "utf8")).toBe(OTHER_LOCK);
  });

  test("an I/O error on the lock is a failed start", async () => {
    const r = await laneRunWith({ lockText: "dir" });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("start refused: the lane lock: ");
    expect(r.failedStarts()).toBe("1\n");
    expect(r.record.connects).toBe(0);
    expect(r.starts).toEqual([]);
  });

  test("a coordinator lane takes its own lane.lock too: a live one exits 0 with no claim of coordinator.json", async () => {
    const host = hostYaml({ lanes: [{ name: "coordinator", role: "coordinator" }] });
    const r = await laneRunWith(
      { host, lockText: OTHER_LOCK, lock: { ...LOCK_OWNER, table: table({ 4242: { startMs: OTHER_START, args: "bun main.ts lane run" } }) } },
      [REPO, "coordinator"],
    );
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["lane coordinator is already running (pid 4242, lane.lock); exiting without a claim"]);
    expect(r.record.connects).toBe(0);
    expect(r.coordinatorStarts).toEqual([]);
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
  });

  hostTest("by default the lock records this process (its PID, runtime and start, checked through ps), and a second start meanwhile exits 0", async () => {
    let during: string | null = null;
    let second: number | null = null;
    const secondOut: string[] = [];
    const r = await laneRunWith({ lock: {} }, [REPO, "builder-1"], async (d) => {
      during = read(join(d.laneDir, "lane.lock"));
      // The lane folder is <HOME>/.xarabot/repos/<owner>__<name>/lanes/<lane>; host.yaml is under <root>/config.
      const home = resolve(d.laneDir, "../../../../..");
      const env = { HOME: home, XDG_CONFIG_HOME: join(dirname(home), "config"), PATH: "/usr/bin:/bin" };
      second = await laneRun([REPO, "builder-1"], { env, out: (l) => secondOut.push(l), errOut: (l) => secondOut.push(l), connect: async () => ({ ok: false, message: "never" }) });
      return { outcome: "idle" };
    });
    expect(r.code).toBe(0);
    expect(during as string | null).toBe(`${process.pid}\n${basename(process.execPath)}\n${new Date(Math.floor(performance.timeOrigin)).toISOString()}\n`);
    expect(second as number | null).toBe(0);
    expect(secondOut).toEqual([`lane builder-1 is already running (pid ${process.pid}, lane.lock); exiting without a claim`]);
    expect(existsSync(join(r.laneDir, "lane.lock"))).toBe(false);
  });
});

describe("xarabot lane run: the runner version", () => {
  test("main pins another version: it is installed, runner rewritten, no claim, no ledger write", async () => {
    const r = await laneRunWith({ main: { runnerVersion: "v2", done: false }, failedStarts: 1 });
    expect(r.code).toBe(0);
    expect(r.installs.map((i) => i.version)).toEqual(["v2"]);
    expect(r.runnerFile()).toBe("v2\n");
    expect(r.starts).toEqual([]);
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
    expect(r.failedStarts()).toBe("1\n");
  });

  test("pin back to an installed version: no fetch, runner rewritten", async () => {
    const r = await laneRunWith({ runner: "v2\n", installed: ["v1", "v2"], main: { runnerVersion: "v1" } });
    expect(r.code).toBe(0);
    expect(r.installs).toEqual([]);
    expect(r.record.tokens).toBe(0);
    expect(r.runnerFile()).toBe("v1\n");
    expect(r.starts).toEqual([]);
  });

  test("a missing runner file is a switch to the pinned version", async () => {
    const r = await laneRunWith({ runner: null });
    expect(r.code).toBe(0);
    expect(r.runnerFile()).toBe("v1\n");
    expect(r.starts).toEqual([]);
  });

  test("the install fails: a failed start", async () => {
    const r = await laneRunWith({ main: { runnerVersion: "v2" }, installFails: "no tag v2" });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("no tag v2");
    expect(r.runnerFile()).toBe("v1\n");
    expect(r.failedStarts()).toBe("1\n");
  });

  test("an unsafe pinned version: a failed start, nothing installed", async () => {
    const r = await laneRunWith({ main: { runnerVersion: "../x" } });
    expect(r.code).toBe(1);
    expect(r.installs).toEqual([]);
    expect(r.failedStarts()).toBe("1\n");
  });
});

describe("xarabot lane run: refusals", () => {
  const other = { name: "builder-2", repo: "xaravel/xaravel" };
  test.each([
    ["agent not allowed", { main: { unattended: ["codex"] } }, "agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)"],
    ["a pi lane, policy [pi]", { host: hostYaml({ lanes: [{ agent: "pi" }] }), main: { unattended: ["pi"] } }, `agent pi: ${PI_DEFERRAL}`],
    ["a pi lane, policy [claude]", { host: hostYaml({ lanes: [{ agent: "pi" }] }), main: { unattended: ["claude"] } }, `agent pi: ${PI_DEFERRAL}`],
    ["a pi-only policy", { main: { unattended: ["pi"] } }, `allows neither claude nor codex (allowed: pi), so the only reviewer would be pi: ${PI_DEFERRAL}`],
    ["an empty policy", { main: { unattended: [] } }, `allows neither claude nor codex (allowed: none), so the only reviewer would be pi: ${PI_DEFERRAL}`],
    ["effort refused", { host: hostYaml({ lanes: [{ model: "claude-opus-4-6", effort: "xhigh" }] }) }, "does not offer effort xhigh"],
    ["CLI too old", { version: "2.0.0 (Claude Code)" }, "is older than"],
    ["no credential", { credential: false }, "missing"],
    ["builders over the limit", { host: hostYaml({ lanes: [{}, other] }) }, "more than XARABOT_MAX_BUILDERS=1"],
    ["an invalid XARABOT_MAX_BUILDERS", { env: { XARABOT_MAX_BUILDERS: "many" } }, "is not a positive integer"],
    ["no App credentials", { connectFail: "credentials auth: missing" }, "credentials auth: missing"],
  ] as const)("%s: refused, reason named, failed-starts + 1", async (_name, o, why) => {
    const r = await laneRunWith(o as Setup);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(why);
    expect(r.failedStarts()).toBe("1\n");
    expect(r.starts).toEqual([]);
    expect(existsSync(join(r.w.laneDir, "STOP"))).toBe(false);
  });

  test("two builders are fine under XARABOT_MAX_BUILDERS=2", async () => {
    const r = await laneRunWith({ host: hostYaml({ lanes: [{}, other] }), env: { XARABOT_MAX_BUILDERS: "2" } });
    expect(r.code).toBe(0);
    expect(r.starts).toHaveLength(1);
  });

  test("uninstalled: the App installation does not cover the repo", async () => {
    const w = world(dirs);
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, hostYaml());
    mkdirSync(w.laneDir, { recursive: true });
    writeFileSync(join(w.laneDir, "runner"), "v1\n");
    const fake = createFakeForge({ main: mainFiles() });
    fake.control.injectError("snapshot", { kind: "uninstalled", message: "not installed" });
    const err: string[] = [];
    const code = await laneRun([REPO, "builder-1"], { env: w.env, connect: fakeConnect(fake).connect, out: () => {}, errOut: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(`the App installation does not cover ${REPO}`);
    expect(readFileSync(join(w.laneDir, "failed-starts"), "utf8")).toBe("1\n");
  });

  test("the third failed start in a row writes STOP and posts one alert", async () => {
    const r = await laneRunWith({ failedStarts: 2, main: { unattended: [] } });
    expect(r.code).toBe(1);
    expect(r.failedStarts()).toBe("0\n");
    expect(readFileSync(join(r.w.laneDir, "STOP"), "utf8")).toBe("stop\n");
    const alerts = r.fake.control.alerts();
    expect(alerts.map((a) => a.condition)).toEqual([LANE_START_FAILED]);
    const snap = await r.fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    const mainSha = snap.ok ? snap.value.main.sha : "";
    expect(alerts[0]?.main_sha).toBe(mainSha);
    expect(alerts[0]?.main_sha).not.toBe("0".repeat(40));
    expect(r.record.forgeOpts).toContainEqual({ maintainer: "edanisko" });
    // The next start sees STOP: exit 0, no count, no second alert.
    expect(await r.again()).toBe(0);
    expect(r.failedStarts()).toBe("0\n");
    expect(r.fake.control.alerts()).toHaveLength(1);
  });

  test("after the Maintainer removes STOP, one more failure counts 1 and writes no STOP", async () => {
    const r = await laneRunWith({ failedStarts: 2, main: { unattended: [] } });
    expect(existsSync(join(r.w.laneDir, "STOP"))).toBe(true);
    rmSync(join(r.w.laneDir, "STOP"));
    expect(await r.again()).toBe(1);
    expect(r.failedStarts()).toBe("1\n");
    expect(existsSync(join(r.w.laneDir, "STOP"))).toBe(false);
    expect(r.fake.control.alerts()).toHaveLength(1);
  });

  test("the third failed start with no forge known writes STOP and says it cannot alert", async () => {
    const r = await laneRunWith({ failedStarts: 2, connectFail: "credentials auth: missing" });
    expect(r.code).toBe(1);
    expect(existsSync(join(r.w.laneDir, "STOP"))).toBe(true);
    expect(r.err.join("\n")).toContain(`cannot post the ${LANE_START_FAILED} alert`);
  });
});

describe("xarabot lane run: a failure after the refusal table", () => {
  test("a bot user id lookup that keeps failing still counts up to STOP", async () => {
    const r = await laneRunWith({ failedStarts: 1, botUserFails: true });
    expect(r.code).toBe(1);
    expect(r.failedStarts()).toBe("2\n");
    expect(await r.again()).toBe(1);
    // The third writes STOP and resets the count.
    expect(r.failedStarts()).toBe("0\n");
    expect(existsSync(join(r.w.laneDir, "STOP"))).toBe(true);
    expect(r.starts).toHaveLength(0);
  });
});

describe("xarabot lane run: a passing start", () => {
  test("failed-starts goes to 0 after a run with no lane stop, and the composed lane runs", async () => {
    const r = await laneRunWith({ failedStarts: 2 });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.failedStarts()).toBe("0\n");
    expect(r.starts).toHaveLength(1);
    const d = r.starts[0] as LaneDeps;
    expect(d.identity).toEqual({ owner: "alice", host: HOST_ID, lane: "builder-1" });
    expect(d.laneDir).toBe(r.w.laneDir);
    expect(d.lane).toEqual({ repo: REPO, role: "builder", owner: "alice", agent: "claude", effort: "high" });
    expect(d.agent.vendor).toBe("claude");
    expect(d.ciStep).toBeDefined();
    expect(d.mergeStep).toBeDefined();
    const runnerGit = join(r.w.laneDir, "runner.git");
    expect(existsSync(join(runnerGit, "HEAD"))).toBe(true);
    expect(r.record.forgeOpts).toContainEqual({ runnerGit, maintainer: "edanisko" });
    expect(r.record.fetchDirs).toEqual([runnerGit]);
  });

  test("with the real dependencies and no eligible Story, runLaneProcess ends idle and journals an idle span", async () => {
    const r = await laneRunWith({}, [REPO, "builder-1"], (d) => runLaneProcess({ ...d, waiter: { wait: async () => ({ end: "elapsed" }) } }));
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe("lane builder-1: idle");
    const journal = (read(join(r.w.laneDir, "journal.jsonl")) ?? "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as JournalRecord);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ schema_version: 1, type: "span", span: "idle" });
    expect(read(join(r.w.laneDir, "outcome"))).toBe("idle\n");
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
  });
});

describe("xarabot lane run: a codex lane", () => {
  const CODEX_HOST = hostYaml({ lanes: [{ agent: "codex" }] });
  const CODEX = { host: CODEX_HOST, main: { unattended: ["codex"] }, credential: false, version: "codex-cli 0.163.0" } as const;

  test("auth.json and codex-cli 0.163.0: the codex adapter is composed and every start check passes", async () => {
    const r = await laneRunWith({ ...CODEX, codex: ["auth.json"] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.starts).toHaveLength(1);
    const d = r.starts[0] as LaneDeps;
    expect(d.agent.vendor).toBe("codex");
    expect(d.agent.defaultModel).toBe("gpt-6.1-sol");
    const spec = d.agent.launchSpec({ kind: "fresh", prompt: "p" }, { effort: "high" }, "/r/result.json");
    expect(spec.ok && spec.value.credential).toEqual({ file: "auth.json", homeFile: "auth.json" });
    expect(spec.ok && spec.value.apiHosts).toEqual(["chatgpt.com", "ab.chatgpt.com", "auth.openai.com"]);
    expect(spec.ok && spec.value.argv[0]).toBe("codex");
  });

  test("a policy allowing claude and codex: the codex lane starts, with its reviewer claude's credential", async () => {
    const r = await laneRunWith({ ...CODEX, main: { unattended: ["claude", "codex"] }, credential: true, codex: ["auth.json"] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.starts).toHaveLength(1);
  });

  test("only api-key: the API-key spec, with api.openai.com", async () => {
    const r = await laneRunWith({ ...CODEX, codex: ["api-key"] });
    expect(r.code).toBe(0);
    const d = r.starts[0] as LaneDeps;
    const spec = d.agent.launchSpec({ kind: "fresh", prompt: "p" }, { effort: "high" }, "/r/result.json");
    expect(spec.ok && spec.value.credential).toEqual({ file: "api-key", env: "CODEX_API_KEY" });
    expect(spec.ok && spec.value.apiHosts).toContain("api.openai.com");
  });

  test("a bare X.Y.Z version is read too", async () => {
    const r = await laneRunWith({ ...CODEX, codex: ["auth.json"], version: "0.164.2\n" });
    expect(r.code).toBe(0);
  });

  test.each([
    ["both credential files", { codex: ["auth.json", "api-key"] }, "both auth.json and api-key exist"],
    ["no credential file", { codex: [] }, "codex: credential missing: neither auth.json nor api-key"],
    ["an older CLI", { codex: ["auth.json"], version: "codex-cli 0.162.9" }, "codex: CLI 0.162.9 is older than 0.163.0"],
    ["an unreadable version", { codex: ["auth.json"], version: "garbage" }, "codex: cannot read the CLI version"],
    ["an unknown model", { codex: ["auth.json"], host: hostYaml({ lanes: [{ agent: "codex", model: "gpt-9-nope" }] }) }, "does not offer effort high (offered: none)"],
    ["a claude model on a codex lane", { codex: ["auth.json"], host: hostYaml({ lanes: [{ agent: "codex", model: "claude-opus-5-5" }] }) }, "codex: model claude-opus-5-5 does not offer effort high"],
  ] as const)("%s: a failed start, reason named", async (_name, o, why) => {
    const r = await laneRunWith({ ...CODEX, ...o } as Setup);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(why);
    expect(r.failedStarts()).toBe("1\n");
    expect(r.starts).toEqual([]);
  });

  test("a mode-644 auth.json: a failed start naming the file", async () => {
    const r = await laneRunWith({ ...CODEX, codex: ["auth.json"] }, [REPO, "builder-1"], undefined, undefined, (w) =>
      chmodSync(join(w.xdg, "xarabot", "vendors", "codex", "auth.json"), 0o644),
    );
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("auth.json: mode 644, must be 600");
  });

  test("a coordinator's session steps get the auth.json text and each token in it as secrets", async () => {
    for (const list of Object.values(built)) list.length = 0;
    const r = await laneRunWith({ ...CODEX, host: hostYaml({ lanes: [{ name: "coordinator", role: "coordinator", agent: "codex" }] }), codex: ["auth.json"] }, [REPO, "coordinator"]);
    expect(r.code).toBe(0);
    const planning = built.planning[0] as (typeof built.planning)[number];
    expect(planning.deps.secrets).toContain(CODEX_AUTH);
    expect(planning.deps.secrets).toContain(CODEX_REFRESH);
    expect(redactSecrets(`leaked ${CODEX_REFRESH}`, planning.deps.secrets)).toBe("leaked [REDACTED]");
  });
});

describe("credentialSecrets", () => {
  test("a plain token is its own text; a JSON file adds every string of 16+ characters", () => {
    expect(credentialSecrets("sk-ant-oat-fake\n")).toEqual(["sk-ant-oat-fake\n"]);
    expect(credentialSecrets('{"a":"short","b":{"c":["0123456789abcdef"]},"n":12345678901234567890}')).toEqual([
      '{"a":"short","b":{"c":["0123456789abcdef"]},"n":12345678901234567890}',
      "0123456789abcdef",
    ]);
  });
});

describe("xarabot lane run: the reviewer and the session vendor (Story 3.3)", () => {
  const CLAUDE_CREDENTIAL = "sk-ant-oat-fake\n";
  const CODEX_LANE = { host: hostYaml({ lanes: [{ agent: "codex" }] }), credential: false, version: "codex-cli 0.163.0" } as const;
  const BOTH = { unattended: ["claude", "codex"] } as const;
  /** The deps of the one PR step this run built. */
  const prDeps = (): prStep.PrStepDeps => {
    expect(built.pr).toHaveLength(1);
    return (built.pr[0] as (typeof built.pr)[number]).deps;
  };

  test("a claude lane, policy [claude, codex], no codex credential: refused naming the reviewer codex, failed-starts + 1", async () => {
    built.pr.length = 0;
    const r = await laneRunWith({ main: BOTH });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("start refused: reviewer codex: codex: credential missing: neither auth.json nor api-key");
    expect(r.failedStarts()).toBe("1\n");
    expect(r.starts).toEqual([]);
    expect(built.pr).toEqual([]);
  });

  test("a codex lane, policy [claude, codex], no claude credential: refused naming the reviewer claude, failed-starts + 1", async () => {
    const r = await laneRunWith({ ...CODEX_LANE, main: BOTH, codex: ["auth.json"] });
    expect(r.code).toBe(1);
    const said = r.err.join("\n");
    expect(said).toContain("start refused: reviewer claude: credential ");
    expect(said).toContain("vendors/claude/oauth-token: missing");
    expect(r.failedStarts()).toBe("1\n");
    expect(r.starts).toEqual([]);
  });

  test("an unreadable reviewer credential (mode 644) is a failed start too", async () => {
    const r = await laneRunWith({ main: BOTH, codex: ["auth.json"] }, [REPO, "builder-1"], undefined, undefined, (w) =>
      chmodSync(join(w.xdg, "xarabot", "vendors", "codex", "auth.json"), 0o644),
    );
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("start refused: reviewer codex: credential ");
    expect(r.err.join("\n")).toContain("auth.json: mode 644, must be 600");
    expect(r.failedStarts()).toBe("1\n");
  });

  test("a claude lane, policy [claude]: starts with its own credential only, vendor anthropic", async () => {
    built.pr.length = 0;
    const r = await laneRunWith({ main: { unattended: ["claude"] } });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.starts).toHaveLength(1);
    expect(prDeps().provider).toBe("anthropic");
    expect(prDeps().secrets).toEqual([CLAUDE_CREDENTIAL]);
  });

  test("a codex lane, policy [codex]: starts with its own credential only, vendor openai", async () => {
    built.pr.length = 0;
    const r = await laneRunWith({ ...CODEX_LANE, main: { unattended: ["codex"] }, codex: ["auth.json"] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(prDeps().provider).toBe("openai");
    expect(prDeps().secrets).toEqual(credentialSecrets(CODEX_AUTH));
    expect(prDeps().secrets).not.toContain(CLAUDE_CREDENTIAL);
  });

  test("a claude lane, policy [claude, codex], both credentials: starts, both credentials in secrets", async () => {
    built.pr.length = 0;
    const r = await laneRunWith({ main: BOTH, codex: ["auth.json"] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.failedStarts()).toBe("0\n");
    expect(prDeps().provider).toBe("anthropic");
    expect(prDeps().secrets).toEqual([CLAUDE_CREDENTIAL, ...credentialSecrets(CODEX_AUTH)]);
    expect(redactSecrets(`leaked ${CODEX_REFRESH}`, prDeps().secrets)).toBe("leaked [REDACTED]");
  });

  test("a codex lane, policy [claude, codex], both credentials: starts, both credentials in secrets", async () => {
    built.pr.length = 0;
    const r = await laneRunWith({ ...CODEX_LANE, main: BOTH, credential: true, codex: ["api-key"] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(prDeps().provider).toBe("openai");
    expect(prDeps().secrets).toEqual(["sk-proj-fake-codex-key\n", CLAUDE_CREDENTIAL]);
  });

  test("a codex coordinator, policy [claude, codex], both credentials: its session steps get vendor openai and both credentials", async () => {
    for (const list of Object.values(built)) list.length = 0;
    const r = await laneRunWith(
      { ...CODEX_LANE, host: hostYaml({ lanes: [{ name: "coordinator", role: "coordinator", agent: "codex" }] }), main: BOTH, credential: true, codex: ["auth.json"] },
      [REPO, "coordinator"],
    );
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    for (const s of [built.planning[0]?.deps, built.retro[0]?.deps, built.retroItem[0]?.deps]) {
      expect(s?.provider).toBe("openai");
      expect(s?.secrets).toEqual([...credentialSecrets(CODEX_AUTH), CLAUDE_CREDENTIAL]);
    }
  });
});

describe("xarabot lane run: the reviewers and the review gate (Story 3.5)", () => {
  const BOTH = { unattended: ["claude", "codex"] } as const;
  const reset = () => {
    for (const list of Object.values(built)) list.length = 0;
  };

  test("reviewers composed: policy [claude, codex], a claude lane, the codex credential present: both reviewers, codex's secrets redacted", async () => {
    reset();
    const r = await laneRunWith({ main: BOTH, codex: ["auth.json"] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const d = r.starts[0] as LaneDeps;
    expect(built.review).toHaveLength(1);
    const review = (built.review[0] as (typeof built.review)[number]).deps;
    expect(Object.keys(review.reviewers)).toEqual(["claude", "codex"]);
    expect(review.reviewers.claude).toBe(d.agent);
    expect(review.reviewers.codex?.vendor).toBe("codex");
    expect(review.secrets).toContain(CODEX_REFRESH);
    expect(redactSecrets(`leaked ${CODEX_REFRESH}`, review.secrets)).toBe("leaked [REDACTED]");
    // One review step and one passed gate: the builder's review gate and merge step share them.
    const gate = (built.reviewGate[0] as (typeof built.reviewGate)[number]).deps;
    expect(gate.review).toBe((built.review[0] as (typeof built.review)[number]).step);
    // The gate's findings file is redacted with every composed credential, the reviewer's too.
    expect(gate.secrets).toContain(CODEX_REFRESH);
    expect(gate.secrets).toContain("sk-ant-oat-fake\n");
    expect(d.reviewGate).toBe((built.reviewGate[0] as (typeof built.reviewGate)[number]).step);
    const merge = (built.merge[0] as (typeof built.merge)[number]).deps;
    expect(merge.agent).toBe("claude");
    expect(merge.passed).toBe(gate.passed);
    expect(d.mergeStep).toBe((built.merge[0] as (typeof built.merge)[number]).step);
  });

  test("policy [claude]: only the lane's own agent reviews", async () => {
    reset();
    const r = await laneRunWith({ main: { unattended: ["claude"] } });
    expect(r.code).toBe(0);
    const review = (built.review[0] as (typeof built.review)[number]).deps;
    expect(Object.keys(review.reviewers)).toEqual(["claude"]);
    expect(review.reviewers.claude).toBe((r.starts[0] as LaneDeps).agent);
  });

  test("a coordinator: its session steps get the one review step and passed gate, and reconcile the agent and the gate", async () => {
    reset();
    const r = await laneRunWith({ host: hostYaml({ lanes: [{ name: "coordinator", role: "coordinator" }] }), main: BOTH, codex: ["auth.json"] }, [REPO, "coordinator"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const review = built.review[0] as (typeof built.review)[number];
    expect(Object.keys(review.deps.reviewers)).toEqual(["claude", "codex"]);
    const reconcile = (built.reconcile[0] as (typeof built.reconcile)[number]).deps;
    expect(reconcile.agent).toBe("claude");
    for (const s of [built.planning[0]?.deps, built.retro[0]?.deps, built.retroItem[0]?.deps]) {
      expect(s?.review).toBe(review.step);
      expect(s?.passed).toBe(reconcile.passed);
      expect(s?.secrets).toContain(CODEX_REFRESH);
    }
  });
});

describe("composeReviewers (Story 3.5)", () => {
  const AGENT = { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent;

  test("a failing reviewer that is not the start check's choice is left out, with a line; the others are composed", () => {
    const w = world(dirs);
    const said: string[] = [];
    // No codex credential on this host: codex is not the choice here, so it is left out.
    const r = composeReviewers({ allowed: ["claude", "codex"], sessionAgent: "claude", agent: AGENT, choice: "claude", choiceCredential: null, env: w.env, resultPath: "/r/result.json", say: (t) => said.push(t) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.reviewers)).toEqual(["claude"]);
    expect(r.value.credentials).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith("reviewer codex left out: codex: credential missing: neither auth.json nor api-key");
  });

  test("the start check's choice failing refuses", () => {
    const w = world(dirs);
    const r = composeReviewers({ allowed: ["claude", "codex"], sessionAgent: "claude", agent: AGENT, choice: "codex", choiceCredential: null, env: w.env, resultPath: "/r/result.json", say: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("reviewer codex: codex: credential missing");
  });

  test("another lane's adapter with its credential read joins, its text kept for the secrets", () => {
    const w = world(dirs);
    writeCodexCredential(w, "auth.json");
    const r = composeReviewers({ allowed: ["claude", "codex"], sessionAgent: "claude", agent: AGENT, choice: "claude", choiceCredential: null, env: w.env, resultPath: "/r/result.json", say: () => {} });
    expect(r.ok && Object.keys(r.value.reviewers)).toEqual(["claude", "codex"]);
    expect(r.ok && r.value.credentials).toEqual([CODEX_AUTH]);
  });

  test("an adapter the policy does not allow is never composed; pi is never a reviewer", () => {
    const w = world(dirs);
    writeCodexCredential(w, "auth.json");
    const r = composeReviewers({ allowed: ["claude", "pi"], sessionAgent: "claude", agent: AGENT, choice: "claude", choiceCredential: null, env: w.env, resultPath: "/r/result.json", say: () => {} });
    expect(r.ok && Object.keys(r.value.reviewers)).toEqual(["claude"]);
  });
});

describe("xarabot lane run: a coordinator lane", () => {
  const COORD_HOST = hostYaml({ lanes: [{ name: "coordinator", role: "coordinator" }] });
  const ARGS = [REPO, "coordinator"] as const;
  const IDENTITY = { owner: "alice", host: HOST_ID, lane: "coordinator" };
  const other = (over: Partial<CoordinatorRecord> = {}): CoordinatorRecord => ({
    schema_version: 2,
    owner: "dave",
    host: "44444444-4444-4444-8444-444444444444",
    lane: "coordinator",
    generation: 1,
    heartbeat_at: "2026-10-23T09:45:00Z",
    digest_posted_at: null,
    rulings_cursor: null,
    ...over,
  });
  const seed = (c: CoordinatorRecord) => ({ [COORDINATOR_PATH]: serializeCoordinator(c) });
  const coordinatorOf = async (r: Ran) => {
    const s = await r.fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.coordinator;
  };

  test("no coordinator.json: claimed at generation 1, failed-starts reset, the coordinator process starts with the reconcile, planning, retro and retro-item steps", async () => {
    const r = await laneRunWith({ host: COORD_HOST, failedStarts: 2 }, ARGS);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.failedStarts()).toBe("0\n");
    expect(r.starts).toEqual([]);
    expect(r.coordinatorStarts).toHaveLength(1);
    const d = r.coordinatorStarts[0] as CoordinatorDeps;
    expect(d.identity).toEqual(IDENTITY);
    expect(Object.keys(d.steps)).toEqual(["reconcile", "planning", "retro", "retro-item"]);
    expect(typeof d.steps.reconcile).toBe("function");
    expect(typeof d.steps.planning).toBe("function");
    expect(typeof d.steps.retro).toBe("function");
    expect(typeof d.steps["retro-item"]).toBe("function");
    expect(d.laneDir).toBe(r.laneDir);
    expect(d.claim).toMatchObject({ ...IDENTITY, generation: 1, heartbeat_at: "2026-10-23T10:00:00Z" });
    expect(await coordinatorOf(r)).toEqual(d.claim);
    expect(r.out.at(-1)).toBe("lane coordinator: idle");
  });

  test("the steps' wiring: each session step gets the coordinator's forge, agent, store, waiter, lane and identity, one shared sandbox, workspace, committer and diff paths, and the vendor credential as its secret", async () => {
    for (const list of Object.values(built)) list.length = 0;
    const r = await laneRunWith({ host: COORD_HOST }, ARGS);
    const CREDENTIAL = readFileSync(join(r.w.xdg, "xarabot", "vendors", "claude", "oauth-token"), "utf8");
    expect(r.code).toBe(0);
    const d = r.coordinatorStarts[0] as CoordinatorDeps;
    expect([built.reconcile.length, built.planning.length, built.retro.length, built.retroItem.length]).toEqual([1, 1, 1, 1]);
    const reconcile = built.reconcile[0] as (typeof built.reconcile)[number];
    const planning = built.planning[0] as (typeof built.planning)[number];
    const retro = built.retro[0] as (typeof built.retro)[number];
    const retroItem = built.retroItem[0] as (typeof built.retroItem)[number];

    // The steps the process runs are the ones these factories built.
    expect(d.steps.reconcile).toBe(reconcile.step);
    expect(d.steps.planning).toBe(planning.step);
    expect(d.steps.retro).toBe(retro.step);
    expect(d.steps["retro-item"]).toBe(retroItem.step);

    // reconcile: the coordinator's forge and identity, this repo, and no session.
    expect(reconcile.deps.forge).toBe(d.forge);
    expect(reconcile.deps.identity).toEqual(IDENTITY);
    expect(reconcile.deps.repo).toBe(REPO);
    expect(typeof reconcile.deps.committer.commit).toBe("function");
    expect(reconcile.deps.committer).not.toBe(planning.deps.committer);

    const sessions = [planning.deps, retro.deps, retroItem.deps];
    for (const s of sessions) {
      expect(s.forge).toBe(d.forge);
      expect(s.agent).toBe(d.agent);
      expect(s.store).toBe(d.store);
      expect(s.waiter).toBe(d.waiter);
      expect(s.laneDir).toBe(r.laneDir);
      expect(s.lane).toBe(d.lane);
      expect(s.identity).toEqual(IDENTITY);
      // The lane's session vendor, added to builder_providers at each agent-commit push fence.
      expect(s.provider).toBe("anthropic");
      // The vendor credential read at start, redacted from every text a step sends to the forge.
      expect(s.secrets).toEqual([CREDENTIAL]);
      expect(redactSecrets(`token ${CREDENTIAL.trim()} here`, s.secrets)).toBe("token [REDACTED] here");
      expect(s.sandbox).toBe(planning.deps.sandbox);
      expect(s.workspace).toBe(planning.deps.workspace);
      expect(s.committer).toBe(planning.deps.committer);
      expect(s.diffPaths).toBe(planning.deps.diffPaths);
    }
    expect(typeof planning.deps.sandbox.run).toBe("function");
    expect(typeof planning.deps.workspace.prepare).toBe("function");
    expect(typeof planning.deps.committer.commit).toBe("function");

    // Each step's own extra: the graph-change gate's trees, the retro's tree reads, the retro item's merger.
    expect(planning.deps.graphTrees).toBe(reconcile.deps.graphTrees);
    expect(retroItem.deps.graphTrees).toBe(reconcile.deps.graphTrees);
    expect(typeof retro.deps.treeFiles).toBe("function");
    expect(typeof retroItem.deps.merger.merge).toBe("function");
  });

  test("the same identity re-claims at the same generation", async () => {
    const r = await laneRunWith({ host: COORD_HOST, ledger: seed(other({ owner: "alice", host: HOST_ID, generation: 3, rulings_cursor: "r-9" })) }, ARGS);
    expect(r.code).toBe(0);
    expect(r.coordinatorStarts[0]?.claim).toMatchObject({ generation: 3, rulings_cursor: "r-9", heartbeat_at: "2026-10-23T10:00:00Z" });
  });

  test("another identity's stale claim is taken over at generation + 1", async () => {
    const r = await laneRunWith({ host: COORD_HOST, ledger: seed(other({ heartbeat_at: "2026-10-23T09:30:00Z", generation: 4 })) }, ARGS);
    expect(r.code).toBe(0);
    expect(r.coordinatorStarts[0]?.claim).toMatchObject({ ...IDENTITY, generation: 5 });
  });

  test("another identity's live claim: a failed start naming the holder, no ledger write, no process", async () => {
    const r = await laneRunWith({ host: COORD_HOST, ledger: seed(other()) }, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("dave/44444444-4444-4444-8444-444444444444/coordinator");
    expect(r.failedStarts()).toBe("1\n");
    expect(r.coordinatorStarts).toEqual([]);
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
    expect(await coordinatorOf(r)).toEqual(other());
  });

  test("the third such start in a row writes STOP and posts lane-start-failed", async () => {
    const r = await laneRunWith({ host: COORD_HOST, ledger: seed(other()), failedStarts: 2 }, ARGS);
    expect(r.code).toBe(1);
    expect(existsSync(join(r.laneDir, "STOP"))).toBe(true);
    expect(r.fake.control.alerts().map((a) => a.condition)).toEqual([LANE_START_FAILED]);
  });

  test.each([
    ["a builder lane named coordinator", hostYaml({ lanes: [{ name: "coordinator" }] }), "coordinator", "lane coordinator has role builder"],
    ["a coordinator lane under another name", hostYaml({ lanes: [{ name: "builder-1", role: "coordinator" }] }), "builder-1", "lane builder-1 has role coordinator"],
  ] as const)("%s: exit 1 before the forge connect, not counted as a failed start: no STOP, no alert, nothing claimed", async (_name, host, lane, why) => {
    // Two failed starts before: a counted third would write STOP and post the alert.
    const r = await laneRunWith({ host, failedStarts: 2 }, [REPO, lane]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(why);
    expect(r.err.join("\n")).toContain("a coordinator lane must be named coordinator");
    expect(r.err.join("\n")).not.toContain("start refused");
    expect(r.failedStarts()).toBe("2\n");
    expect(existsSync(join(r.laneDir, "STOP"))).toBe(false);
    expect(r.fake.control.alerts()).toEqual([]);
    expect(r.record.connects).toBe(0);
    expect(r.starts).toEqual([]);
    expect(r.coordinatorStarts).toEqual([]);
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
  });

  test("a coordinator is not counted against XARABOT_MAX_BUILDERS", async () => {
    const host = hostYaml({ lanes: [{}, { name: "coordinator", role: "coordinator" }] });
    const r = await laneRunWith({ host }, ARGS);
    expect(r.code).toBe(0);
    expect(r.coordinatorStarts).toHaveLength(1);
  });

  test("the other start checks still apply", async () => {
    const r = await laneRunWith({ host: COORD_HOST, main: { unattended: [] } }, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("unattended_adapters");
    expect(r.fake.control.ledgerLog()).toHaveLength(1);
  });

  test("with the real process: the wired reconcile step runs reconcile:1, which finds no work and ends merged with no PR", async () => {
    const r = await laneRunWith({ host: COORD_HOST }, ARGS, undefined, (d) => runCoordinatorProcess({ ...d, waiter: { wait: async () => ({ end: "elapsed" }) } }));
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe("lane coordinator: progress");
    const journal = (read(join(r.laneDir, "journal.jsonl")) ?? "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as JournalRecord);
    expect(journal).toEqual([expect.objectContaining({ type: "unit", unit: "reconcile:1", outcome: "progress", state: "merged", sessions: 0 })]);
    expect(await coordinatorOf(r)).toMatchObject({ ...IDENTITY, generation: 1 });
    expect(r.fake.control.ledgerLog().map((c) => c.message)).toEqual([
      "root",
      "ledger: claimCoordinator coordinator [skip ci]",
      "ledger: claim reconcile:1 [skip ci]",
      "ledger: finishRecurring reconcile:1 [skip ci]",
    ]);
  });
});

describe("xarabot lane run: lane stops count as failed starts", () => {
  const ELAPSED = { wait: async () => ({ end: "elapsed" as const }) };
  /** The run's forge, with every snapshot refused `auth`. */
  const authFailing = (forge: Forge): Forge => ({ ...forge, snapshot: async () => forgeErr("auth", "bad token") });
  const COORD_HOST = hostYaml({ lanes: [{ name: "coordinator", role: "coordinator" }] });

  test("the count is reset after the run, not at the passing start", async () => {
    let during: string | null = null;
    const r = await laneRunWith({ failedStarts: 2 }, [REPO, "builder-1"], async (d) => {
      during = read(join(d.laneDir, "failed-starts"));
      return { outcome: "progress" };
    });
    expect(during as string | null).toBe("2\n");
    expect(r.code).toBe(0);
    expect(r.failedStarts()).toBe("0\n");
  });

  test("three starts whose runs each end in a forge-auth lane stop: exit 1, counts 1 then 2, then STOP and one lane-start-failed; a 4th start exits 0 on STOP", async () => {
    const r = await laneRunWith({}, [REPO, "builder-1"], (d) => runLaneProcess({ ...d, forge: authFailing(d.forge), waiter: ELAPSED }));
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toBe("lane builder-1: stop");
    expect(r.err.join("\n")).toContain("run ended in a lane stop: forge-auth");
    expect(r.failedStarts()).toBe("1\n");
    expect(read(join(r.laneDir, "outcome"))).toBe("stop\n");
    expect(await r.again()).toBe(1);
    expect(r.failedStarts()).toBe("2\n");
    expect(existsSync(join(r.laneDir, "STOP"))).toBe(false);
    expect(await r.again()).toBe(1);
    expect(r.failedStarts()).toBe("0\n");
    expect(readFileSync(join(r.laneDir, "STOP"), "utf8")).toBe("stop\n");
    expect(r.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-auth", LANE_START_FAILED]);
    expect(await r.again()).toBe(0);
    expect(r.failedStarts()).toBe("0\n");
    expect(r.fake.control.alerts().filter((a) => a.condition === LANE_START_FAILED)).toHaveLength(1);
  });

  test("heals: lane stop, lane stop, then an idle run counts 1, 2, then 0", async () => {
    let runs = 0;
    const r = await laneRunWith({}, [REPO, "builder-1"], (d) => {
      runs += 1;
      return runLaneProcess({ ...d, forge: runs <= 2 ? authFailing(d.forge) : d.forge, waiter: ELAPSED });
    });
    expect(r.code).toBe(1);
    expect(r.failedStarts()).toBe("1\n");
    expect(await r.again()).toBe(1);
    expect(r.failedStarts()).toBe("2\n");
    expect(await r.again()).toBe(0);
    expect(r.out.at(-1)).toBe("lane builder-1: idle");
    expect(r.failedStarts()).toBe("0\n");
    expect(existsSync(join(r.laneDir, "STOP"))).toBe(false);
    expect(r.fake.control.alerts().map((a) => a.condition)).not.toContain(LANE_START_FAILED);
  });

  test("a run that ends stop on the lane STOP marker: exit 0, the count reset", async () => {
    const r = await laneRunWith({ failedStarts: 2 }, [REPO, "builder-1"], (d) => {
      // The STOP appears after the start checks, before the run's own check.
      writeFileSync(join(d.laneDir, "STOP"), "stop\n");
      return runLaneProcess({ ...d, waiter: ELAPSED });
    });
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe("lane builder-1: stop");
    expect(r.err).toEqual([]);
    expect(r.failedStarts()).toBe("0\n");
    expect(r.fake.control.alerts()).toEqual([]);
  });

  test("a coordinator run that ends in a lane stop is counted too; the 3rd writes STOP and posts lane-start-failed", async () => {
    const r = await laneRunWith({ host: COORD_HOST, failedStarts: 1 }, [REPO, "coordinator"], undefined, (d) =>
      runCoordinatorProcess({ ...d, forge: authFailing(d.forge), waiter: ELAPSED }),
    );
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toBe("lane coordinator: stop");
    expect(r.failedStarts()).toBe("2\n");
    expect(await r.again()).toBe(1);
    expect(r.failedStarts()).toBe("0\n");
    expect(existsSync(join(r.laneDir, "STOP"))).toBe(true);
    expect(r.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-auth", LANE_START_FAILED]);
  });
});
