import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import { createPsProcessTable, type ProcessTable } from "../../src/lane/processes.ts";
import { releaseHeld, stopNow, wakeLane, writeStop } from "../../src/lane/stop.ts";
import { ALICE, BOB, rec, tip } from "../core/ledger/fixtures.ts";

const dirs: string[] = [];
const children: { kill(): void }[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function laneDir(): string {
  const root = mkdtempSync(join(tmpdir(), "xarabot-stop-"));
  dirs.push(root);
  const dir = join(root, "lanes", "builder-1");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function spawn(cmd: string, ...args: string[]) {
  const p = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  children.push(p);
  return p;
}

const opts = () => ({ signal: AbortSignal.timeout(5000) });

describe("writeStop", () => {
  test("creates the marker and its folder with stop\\n", () => {
    const path = join(laneDir(), "deep", "er", "STOP");
    expect(writeStop(path)).toEqual({ ok: true, value: undefined });
    expect(readFileSync(path, "utf8")).toBe("stop\n");
  });

  test("a path it can't write is an io error", () => {
    const dir = laneDir();
    writeFileSync(join(dir, "file"), "x");
    expect(writeStop(join(dir, "file", "STOP"))).toMatchObject({ ok: false, error: { kind: "io" } });
  });
});

describe("wakeLane", () => {
  test("kills a live recorded sleep", async () => {
    const dir = laneDir();
    const p = spawn("sleep", "30");
    writeFileSync(join(dir, "wait.pid"), `${p.pid}\nsleep\n`);
    expect(wakeLane(createPsProcessTable(), dir)).toEqual({ kind: "killed", pid: p.pid, command: "sleep" });
    await p.exited;
    expect(p.signalCode).toBe("SIGTERM");
  });

  test("a PID file older than the live sleep: skipped started-later", () => {
    const dir = laneDir();
    const p = spawn("sleep", "30");
    const path = join(dir, "wait.pid");
    writeFileSync(path, `${p.pid}\nsleep\n`);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(path, old, old);
    expect(wakeLane(createPsProcessTable(), dir)).toEqual({ kind: "skipped", reason: "started-later", pid: p.pid });
    expect(p.exitCode).toBeNull();
  });

  test("wait.pid naming a live cat: not killed", () => {
    const dir = laneDir();
    const p = spawn("cat");
    writeFileSync(join(dir, "wait.pid"), `${p.pid}\ncat\n`);
    expect(wakeLane(createPsProcessTable(), dir)).toEqual({ kind: "skipped", reason: "command", pid: p.pid });
    writeFileSync(join(dir, "wait.pid"), `${p.pid}\nsleep\n`);
    expect(wakeLane(createPsProcessTable(), dir)).toEqual({ kind: "skipped", reason: "command", pid: p.pid });
    expect(p.exitCode).toBeNull();
  });

  test("no wait.pid: skipped", () => {
    expect(wakeLane(createPsProcessTable(), laneDir())).toEqual({ kind: "skipped", reason: "no-pid-file", pid: null });
  });
});

describe("stopNow", () => {
  test("writes STOP, kills lane, agent and wait in that order, then releases", async () => {
    const dir = laneDir();
    const lane = spawn("sleep", "31");
    const agent = spawn("sleep", "32");
    const wait = spawn("sleep", "33");
    writeFileSync(join(dir, "lane.pid"), `${lane.pid}\nsleep\n`);
    writeFileSync(join(dir, "agent.pid"), `${agent.pid}\nsleep\n`);
    writeFileSync(join(dir, "wait.pid"), `${wait.pid}\nsleep\n`);
    const real = createPsProcessTable();
    const events: string[] = [];
    const table: ProcessTable = {
      inspect: (pid) => real.inspect(pid),
      kill: (pid) => {
        events.push(`kill ${pid === lane.pid ? "lane" : pid === agent.pid ? "agent" : pid === wait.pid ? "wait" : pid}`);
        expect(existsSync(join(dir, "STOP"))).toBe(true);
        return real.kill(pid);
      },
    };
    const report = await stopNow({
      laneDir: dir,
      table,
      release: async () => {
        events.push("release");
        return { released: ["story:1.5"], failed: [] };
      },
    });
    expect(events).toEqual(["kill lane", "kill agent", "kill wait", "release"]);
    expect(readFileSync(join(dir, "STOP"), "utf8")).toBe("stop\n");
    expect(report.stop.ok).toBe(true);
    expect(report.kills.map((k) => [k.name, k.report.kind])).toEqual([
      ["lane", "killed"],
      ["agent", "killed"],
      ["wait", "killed"],
    ]);
    expect(report.release).toEqual({ released: ["story:1.5"], failed: [] });
    await Promise.all([lane.exited, agent.exited, wait.exited]);
  });

  test("nothing running: every kill skipped, release still runs; a throwing release is reported", async () => {
    const dir = laneDir();
    const report = await stopNow({
      laneDir: dir,
      table: createPsProcessTable(),
      release: async () => {
        throw new Error("offline");
      },
    });
    expect(report.kills.map((k) => k.report)).toEqual([
      { kind: "skipped", reason: "no-pid-file", pid: null },
      { kind: "skipped", reason: "no-pid-file", pid: null },
      { kind: "skipped", reason: "no-pid-file", pid: null },
    ]);
    expect(report.release.failed).toEqual([{ unit: null, message: "release threw: offline" }]);
  });
});

describe("releaseHeld", () => {
  async function openQueuedPr(fake: FakeForge, branch: string): Promise<number> {
    const head = fake.control.makeCommit();
    const pushed = await fake.forge.pushBranch({ branch, expected_sha: null, sha: head }, opts());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const opened = await fake.forge.openPr({ branch, base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const q = await fake.forge.enqueue(opened.value.number, head, opts());
    if (!q.ok) throw new Error(q.error.message);
    return opened.value.number;
  }

  async function units(fake: FakeForge): Promise<Map<string, UnitRecord>> {
    const s = await fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return new Map(l.value.units);
  }

  test("releases own claimed and merging records, dequeuing first; leaves the rest", async () => {
    const fake = createFakeForge({ now: "2026-10-22T10:10:00Z", main: { "README.md": "x\n" } });
    const prNumber = await openQueuedPr(fake, "story/1.6");
    fake.control.writeForeignLedger({
      message: "seed [skip ci]",
      deletes: [],
      writes: tip([
        rec({ unit: "story:1.5", state: "claimed", attempts: 1, generation: 2 }),
        rec({ unit: "story:1.6", state: "merging", pr: prNumber, pr_owner: "alice", attempts: 2, globs: ["src/b/**"] }),
        rec({ unit: "story:1.7", state: "released", globs: ["src/c/**"] }),
        rec({ unit: "story:1.8", state: "claimed", owner: BOB.owner, host: BOB.host, lane: BOB.lane, globs: ["src/d/**"] }),
        rec({ unit: "story:1.9", state: "claimed", lane: "builder-9", globs: ["src/e/**"] }),
      ]),
    });
    expect(fake.control.queue()).toEqual([prNumber]);
    const r = await releaseHeld({ forge: fake.forge, identity: ALICE });
    expect([...r.released].sort()).toEqual(["story:1.5", "story:1.6"]);
    expect(r.failed).toEqual([]);
    expect(fake.control.queue()).toEqual([]);
    const after = await units(fake);
    expect(after.get("story:1.5")).toMatchObject({ state: "released", attempts: 1, generation: 2 });
    expect(after.get("story:1.6")).toMatchObject({ state: "released", attempts: 2 });
    expect(after.get("story:1.7")?.state).toBe("released");
    expect(after.get("story:1.8")?.state).toBe("claimed");
    expect(after.get("story:1.9")?.state).toBe("claimed");
  });

  test("a failed dequeue leaves that record and is reported", async () => {
    const fake = createFakeForge({ now: "2026-10-22T10:10:00Z", main: { "README.md": "x\n" } });
    const prNumber = await openQueuedPr(fake, "story/1.6");
    fake.control.writeForeignLedger({
      message: "seed [skip ci]",
      deletes: [],
      writes: tip([rec({ unit: "story:1.6", state: "merging", pr: prNumber, pr_owner: "alice" })]),
    });
    fake.control.injectError("dequeue", { kind: "transient", message: "502" });
    const r = await releaseHeld({ forge: fake.forge, identity: ALICE });
    expect(r.released).toEqual([]);
    expect(r.failed).toEqual([{ unit: "story:1.6", message: `dequeue PR #${prNumber} transient: 502` }]);
    expect((await units(fake)).get("story:1.6")?.state).toBe("merging");
  });

  test("the fence before the dequeue: another lane takes the record at generation + 1 first, so no dequeue and no release", async () => {
    const fake = createFakeForge({ now: "2026-10-22T10:40:00Z", main: { "README.md": "x\n" } });
    const prNumber = await openQueuedPr(fake, "story/1.6");
    const mine = rec({ unit: "story:1.6", state: "merging", pr: prNumber, pr_owner: "alice", passed_sha: "a".repeat(40) });
    fake.control.writeForeignLedger({ message: "seed [skip ci]", deletes: [], writes: tip([mine]) });
    const theirs: UnitRecord = { ...mine, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2, heartbeat_at: "2026-10-22T10:40:00Z" };
    let taken = false;
    fake.control.beforeSwap(() => {
      if (taken) return;
      taken = true;
      fake.control.writeForeignLedger({ message: "ledger: takeOverStale story:1.6 [skip ci]", deletes: [], writes: tip([theirs]) });
    });
    const r = await releaseHeld({ forge: fake.forge, identity: ALICE, callTimeoutMs: 5000 });
    fake.control.beforeSwap(null);
    expect(r.released).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.unit).toBe("story:1.6");
    expect(r.failed[0]?.message).toStartWith("dequeue fence ");
    expect(fake.control.queue()).toEqual([prNumber]);
    expect((await units(fake)).get("story:1.6")).toEqual(theirs);
    expect(fake.control.ledgerLog().map((c) => c.message)).toEqual(["root", "seed [skip ci]", "ledger: takeOverStale story:1.6 [skip ci]"]);
  });

  test("a failed snapshot is reported with no unit", async () => {
    const fake = createFakeForge({ now: "2026-10-22T10:10:00Z", main: { "README.md": "x\n" } });
    fake.control.injectError("snapshot", { kind: "auth", message: "bad key" });
    expect(await releaseHeld({ forge: fake.forge, identity: ALICE })).toEqual({ released: [], failed: [{ unit: null, message: "snapshot auth: bad key" }] });
  });
});
