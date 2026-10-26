import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPsProcessTable, inspectPid, killRecorded, parseLstart, ProcessUnreadable, readPidFile, type ProcessTable } from "../../src/lane/processes.ts";
import { hostTest } from "../support/sandbox.ts";

const dirs: string[] = [];
const children: { kill(): void }[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "xarabot-proc-"));
  dirs.push(d);
  return d;
}

function spawnSleep(seconds = "30", cmd = "sleep") {
  const p = Bun.spawn([cmd, seconds], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(p);
  return p;
}

describe("parseLstart", () => {
  test.each([
    ["Fri Oct 23 10:00:00 2026 sleep 60", new Date(2026, 9, 23, 10, 0, 0).getTime(), "sleep 60"],
    ["Sat Oct  3 09:05:07 2026 /bin/sleep 5", new Date(2026, 9, 3, 9, 5, 7).getTime(), "/bin/sleep 5"],
    ["  Thu Jan  1 00:00:01 2026   bun main.ts lane run  ", new Date(2026, 0, 1, 0, 0, 1).getTime(), "bun main.ts lane run"],
  ])("%j", (line, startMs, args) => {
    expect(parseLstart(line)).toEqual({ startMs, args });
  });

  test.each(["", "garbage", "Fri Foo 23 10:00:00 2026 sleep", "Fri Oct 23 10:00:00 2026"])("unparseable %j is null", (line) => {
    expect(parseLstart(line)).toBeNull();
  });
});

describe("createPsProcessTable", () => {
  hostTest("inspects a live sleep: its start time and args", async () => {
    const before = Date.now();
    const p = spawnSleep();
    // Linux names the new image before it sets its args: mid-exec, `ps` prints `[sleep]`.
    let info = createPsProcessTable().inspect(p.pid);
    for (let i = 0; i < 50 && info?.args.startsWith("["); i++) {
      await Bun.sleep(20);
      info = createPsProcessTable().inspect(p.pid);
    }
    expect(info).not.toBeNull();
    expect(info?.args).toMatch(/^(\S*\/)?sleep 30$/);
    expect(info?.startMs).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 1000);
    expect(info?.startMs).toBeLessThanOrEqual(Date.now());
  });

  test("a PID with no process is null", async () => {
    const p = spawnSleep("0");
    await p.exited;
    expect(createPsProcessTable().inspect(p.pid)).toBeNull();
    expect(createPsProcessTable().inspect(0)).toBeNull();
  });

  // A `ps` that can't run, one that fails, and one whose line doesn't parse.
  test.each(["/nonexistent/ps", "/usr/bin/false", "/bin/echo"])("a live process that %s can't read throws ProcessUnreadable, never null", (ps) => {
    const p = spawnSleep();
    const table = createPsProcessTable({ ps });
    expect(() => table.inspect(p.pid)).toThrow(ProcessUnreadable);
    expect(() => table.inspect(process.pid)).toThrow(ProcessUnreadable);
    expect(inspectPid(table, p.pid)).toBe("unknown");
  });

  test.each(["/nonexistent/ps", "/usr/bin/false"])("a PID with no process is null even when %s fails: signal 0 finds none", async (ps) => {
    const p = spawnSleep("0");
    await p.exited;
    expect(createPsProcessTable({ ps }).inspect(p.pid)).toBeNull();
    expect(inspectPid(createPsProcessTable({ ps }), p.pid)).toBeNull();
  });

  test("kill sends SIGTERM to exactly that PID", async () => {
    const p = spawnSleep();
    expect(createPsProcessTable().kill(p.pid)).toBe(true);
    await p.exited;
    expect(p.signalCode).toBe("SIGTERM");
    expect(createPsProcessTable().kill(p.pid)).toBe(false);
  });
});

describe("inspectPid", () => {
  test("passes the table's answer through, and any throw is unknown", () => {
    const info = { startMs: 0, args: "sleep 5" };
    const table = (inspect: ProcessTable["inspect"]): ProcessTable => ({ inspect, kill: () => false });
    expect(inspectPid(table(() => info), 7)).toEqual(info);
    expect(inspectPid(table(() => null), 7)).toBeNull();
    expect(inspectPid(table(() => { throw new ProcessUnreadable("ps failed"); }), 7)).toBe("unknown");
    expect(inspectPid(table(() => { throw new Error("anything"); }), 7)).toBe("unknown");
  });
});

describe("readPidFile", () => {
  test("reads the PID, command and mtime", () => {
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, "4242\nsleep\n");
    utimesSync(path, 1000, 1000);
    expect(readPidFile(path)).toEqual({ pid: 4242, command: "sleep", writtenMs: 1_000_000 });
  });

  test.each(["", "4242\n", "abc\nsleep\n", "0\nsleep\n", "-1\nsleep\n"])("malformed %j is null", (text) => {
    const path = join(tmp(), "x.pid");
    writeFileSync(path, text);
    expect(readPidFile(path)).toBeNull();
  });

  test("a missing file is null", () => {
    expect(readPidFile(join(tmp(), "none.pid"))).toBeNull();
  });
});

describe("killRecorded", () => {
  hostTest("kills a live recorded sleep", async () => {
    const p = spawnSleep();
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, `${p.pid}\nsleep\n`);
    expect(killRecorded(createPsProcessTable(), path, { first: true })).toEqual({ kind: "killed", pid: p.pid, command: "sleep" });
    await p.exited;
    expect(p.signalCode).toBe("SIGTERM");
  });

  hostTest("a PID file older than the process: skipped started-later, not killed", () => {
    const p = spawnSleep();
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, `${p.pid}\nsleep\n`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    expect(killRecorded(createPsProcessTable(), path, { first: true })).toEqual({ kind: "skipped", reason: "started-later", pid: p.pid });
    expect(p.killed).toBe(false);
    expect(p.exitCode).toBeNull();
  });

  hostTest("another command: skipped command, not killed", () => {
    const p = spawnSleep();
    const path = join(tmp(), "agent.pid");
    writeFileSync(path, `${p.pid}\nclaude\n`);
    expect(killRecorded(createPsProcessTable(), path, { first: false })).toEqual({ kind: "skipped", reason: "command", pid: p.pid });
    expect(p.exitCode).toBeNull();
  });

  test("a gone process and a missing file are skipped", async () => {
    const p = spawnSleep("0");
    await p.exited;
    const dir = tmp();
    const path = join(dir, "lane.pid");
    writeFileSync(path, `${p.pid}\nsleep\n`);
    expect(killRecorded(createPsProcessTable(), path, { first: true })).toEqual({ kind: "skipped", reason: "gone", pid: p.pid });
    expect(killRecorded(createPsProcessTable(), join(dir, "none.pid"), { first: true })).toEqual({ kind: "skipped", reason: "no-pid-file", pid: null });
  });

  test("only an ok check kills; expect refuses another recorded command", () => {
    const killed: number[] = [];
    const table: ProcessTable = { inspect: () => ({ startMs: 0, args: "cat" }), kill: (pid) => (killed.push(pid), true) };
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, "77\ncat\n");
    expect(killRecorded(table, path, { first: true, expect: "sleep" })).toEqual({ kind: "skipped", reason: "command", pid: 77 });
    expect(killed).toEqual([]);
    expect(killRecorded(table, path, { first: true })).toEqual({ kind: "killed", pid: 77, command: "cat" });
    expect(killed).toEqual([77]);
  });

  test("a recorded PID the table can't read: skipped unknown, not killed", () => {
    const killed: number[] = [];
    const table: ProcessTable = {
      inspect: () => {
        throw new ProcessUnreadable("ps failed");
      },
      kill: (pid) => (killed.push(pid), true),
    };
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, "77\nsleep\n");
    expect(killRecorded(table, path, { first: true })).toEqual({ kind: "skipped", reason: "unknown", pid: 77 });
    expect(killed).toEqual([]);
  });

  test("a live recorded sleep that a failing ps can't read: skipped unknown, not killed", () => {
    const p = spawnSleep();
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, `${p.pid}\nsleep\n`);
    expect(killRecorded(createPsProcessTable({ ps: "/usr/bin/false" }), path, { first: true })).toEqual({ kind: "skipped", reason: "unknown", pid: p.pid });
    expect(p.exitCode).toBeNull();
  });

  test("a failed kill is skipped kill-failed", () => {
    const table: ProcessTable = { inspect: () => ({ startMs: 0, args: "sleep 5" }), kill: () => false };
    const path = join(tmp(), "wait.pid");
    writeFileSync(path, "77\nsleep\n");
    expect(killRecorded(table, path, { first: true })).toEqual({ kind: "skipped", reason: "kill-failed", pid: 77 });
  });
});
