import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { ok } from "../../src/core/result.ts";
import type { JournalRecord } from "../../src/core/schemas/journal.ts";
import { laneRun, LANE_START_FAILED, type LaneRunDeps } from "../../src/cli/lane-run.ts";
import { runLaneProcess, type LaneDeps } from "../../src/lane/lane-process.ts";
import { cleanup, fakeConnect, HOST_ID, mainFiles, stubInstaller, world, writeCredential, type MainOpts, type World } from "./lane-fixture.ts";

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

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
  readonly installed?: readonly string[];
  readonly env?: Record<string, string>;
  readonly version?: string;
  readonly installFails?: string;
  readonly connectFail?: string;
  readonly botUserFails?: boolean;
};

type Ran = {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly fake: FakeForge;
  readonly starts: LaneDeps[];
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

async function laneRunWith(o: Setup = {}, args: readonly string[] = [REPO, "builder-1"], start?: LaneRunDeps["start"]): Promise<Ran> {
  const w = world(dirs, o.env ?? {});
  mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
  writeFileSync(w.hostYaml, o.host ?? hostYaml());
  mkdirSync(w.laneDir, { recursive: true });
  const runner = o.runner === undefined ? "v1\n" : o.runner;
  if (runner !== null) writeFileSync(join(w.laneDir, "runner"), runner);
  if (o.failedStarts !== undefined) writeFileSync(join(w.laneDir, "failed-starts"), `${o.failedStarts}\n`);
  for (const v of o.installed ?? ["v1"]) mkdirSync(join(w.runnerRoot, v), { recursive: true });
  if (o.credential !== false) writeCredential(w);
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o.main) });
  const conn = fakeConnect(fake, { ...(o.connectFail !== undefined ? { fail: o.connectFail } : {}), ...(o.botUserFails === true ? { botUserFails: true } : {}) });
  const installer = stubInstaller(o.installFails !== undefined ? { fail: o.installFails } : {});
  const starts: LaneDeps[] = [];
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
    out: (l) => out.push(l),
    errOut: (l) => err.push(l),
  };
  const code = await laneRun(args, deps);
  return {
    code,
    out,
    err,
    fake,
    starts,
    installs: installer.calls,
    record: conn.record,
    w,
    failedStarts: () => read(join(w.laneDir, "failed-starts")),
    runnerFile: () => read(join(w.laneDir, "runner")),
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
    ["agent not allowed", { main: { unattended: [] } }, "is not in .xarabot/policy.yaml unattended_adapters"],
    ["no adapter", { host: hostYaml({ lanes: [{ agent: "codex" }] }), main: { unattended: ["codex"] } }, "no adapter for agent codex"],
    ["effort refused", { host: hostYaml({ lanes: [{ model: "claude-opus-4-6", effort: "xhigh" }] }) }, "does not offer effort xhigh"],
    ["CLI too old", { version: "2.0.0 (Claude Code)" }, "is older than"],
    ["no credential", { credential: false }, "missing"],
    ["builders over the limit", { host: hostYaml({ lanes: [{}, other] }) }, "more than XARABOT_MAX_BUILDERS=1"],
    ["an invalid XARABOT_MAX_BUILDERS", { env: { XARABOT_MAX_BUILDERS: "many" } }, "is not a positive integer"],
    ["coordinator", { host: hostYaml({ lanes: [{ role: "coordinator" }] }) }, "no coordinator process before Epic 2"],
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
  test("failed-starts goes to 0 and the composed lane runs", async () => {
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
