import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ProcessInfo } from "../../src/core/lane/waits.ts";
import { acquireLaneLock, type AcquireLaneLockParams, type LaneLockAcquired } from "../../src/lane/lane-lock.ts";
import { createPsProcessTable, type ProcessTable } from "../../src/lane/processes.ts";
import { hostTest } from "../support/sandbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function laneDir(): string {
  const root = mkdtempSync(join(tmpdir(), "xarabot-lock-"));
  dirs.push(root);
  return join(root, "lanes", "builder-1");
}

const ME = { pid: 777, command: "bun", startedMs: Date.parse("2026-10-23T10:00:00.250Z") };
const OWN = "777\nbun\n2026-10-23T10:00:00.250Z\n";
const OTHER = "4242\nbun\n2026-10-23T09:00:00.000Z\n";
const OTHER_START = Date.parse("2026-10-23T09:00:00.000Z");
const BUN_ARGS = "/opt/homebrew/bin/bun /h/.xarabot/runner/v1/src/cli/main.ts lane run xaravel/xarabot builder-1";

/** A process table answering `inspect` from `procs` (and running `onInspect` first); nothing is killed. */
function table(procs: Readonly<Record<number, ProcessInfo>> = {}, onInspect?: (pid: number) => void): ProcessTable & { inspected: number[] } {
  const inspected: number[] = [];
  return {
    inspected,
    inspect: (pid) => {
      inspected.push(pid);
      onInspect?.(pid);
      return procs[pid] ?? null;
    },
    kill: () => false,
  };
}

function acquire(dir: string, over: Partial<AcquireLaneLockParams> = {}) {
  return acquireLaneLock({ laneDir: dir, ...ME, table: table(), ...over });
}

function acquired(r: ReturnType<typeof acquire>): LaneLockAcquired {
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.kind !== "acquired") throw new Error(`held by ${r.value.pid}`);
  return r.value;
}

const lockOf = (dir: string) => join(dir, "lane.lock");
/** Everything in the lane folder but the lock: no temp or set-aside file is left. */
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f !== "lane.lock");

function seed(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockOf(dir), text);
}

describe("acquireLaneLock", () => {
  test("no lock: created whole with this process's text, mode 600, the lane folder made; release removes it", () => {
    const dir = laneDir();
    const lock = acquired(acquire(dir));
    expect(lock.tookOver).toBeNull();
    expect(readFileSync(lockOf(dir), "utf8")).toBe(OWN);
    expect(statSync(lockOf(dir)).mode & 0o777).toBe(0o600);
    expect(leftovers(dir)).toEqual([]);
    expect(lock.release()).toEqual({ ok: true, value: undefined });
    expect(existsSync(lockOf(dir))).toBe(false);
    // Releasing again is fine.
    expect(lock.release()).toEqual({ ok: true, value: undefined });
  });

  test("a live lock: held with its PID, the lock untouched", () => {
    const dir = laneDir();
    seed(dir, OTHER);
    const t = table({ 4242: { startMs: OTHER_START, args: BUN_ARGS } });
    expect(acquire(dir, { table: t })).toEqual({ ok: true, value: { kind: "held", pid: 4242 } });
    expect(t.inspected).toEqual([4242]);
    expect(readFileSync(lockOf(dir), "utf8")).toBe(OTHER);
    expect(leftovers(dir)).toEqual([]);
  });

  test("a second acquire by another process while held: held with the first one's PID", () => {
    const dir = laneDir();
    const first = acquired(acquire(dir));
    const t = table({ 777: { startMs: ME.startedMs, args: BUN_ARGS } });
    expect(acquire(dir, { pid: 778, table: t })).toEqual({ ok: true, value: { kind: "held", pid: 777 } });
    first.release();
    expect(acquired(acquire(dir, { pid: 778, table: t })).tookOver).toBeNull();
  });

  test.each([
    ["a dead PID", {}, { pid: 4242, reason: "gone" }],
    ["a reused PID", { 4242: { startMs: OTHER_START + 1001, args: BUN_ARGS } }, { pid: 4242, reason: "started-later" }],
    ["another command", { 4242: { startMs: OTHER_START, args: "/bin/sleep 60" } }, { pid: 4242, reason: "command" }],
  ] as const)("%s: taken over, the lock now this process's, nothing left aside", (_name, procs, tookOver) => {
    const dir = laneDir();
    seed(dir, OTHER);
    const lock = acquired(acquire(dir, { table: table(procs) }));
    expect(lock.tookOver).toEqual(tookOver);
    expect(readFileSync(lockOf(dir), "utf8")).toBe(OWN);
    expect(leftovers(dir)).toEqual([]);
  });

  test.each(["", "garbage", "4242\nbun\n", "4242\n/bin/bun\n2026-10-23T09:00:00.000Z\n"])("malformed %j: taken over with no PID and no process check", (text) => {
    const dir = laneDir();
    seed(dir, text);
    const t = table();
    const lock = acquired(acquire(dir, { table: t }));
    expect(lock.tookOver).toEqual({ pid: null, reason: "malformed" });
    expect(t.inspected).toEqual([]);
    expect(readFileSync(lockOf(dir), "utf8")).toBe(OWN);
  });

  test("the takeover race: another process takes the stale lock between the check and the rename; it is put back and reported held", () => {
    const dir = laneDir();
    seed(dir, OTHER);
    const winner = "5555\nbun\n2026-10-23T10:00:00.100Z\n";
    // The check runs between the read and the rename: the winner replaces the stale lock then.
    const t = table({}, () => writeFileSync(lockOf(dir), winner));
    expect(acquire(dir, { table: t })).toEqual({ ok: true, value: { kind: "held", pid: 5555 } });
    expect(readFileSync(lockOf(dir), "utf8")).toBe(winner);
    expect(leftovers(dir)).toEqual([]);
  });

  test("a stale lock removed by another process before the rename: the retry creates the lock", () => {
    const dir = laneDir();
    seed(dir, OTHER);
    const r = acquireLaneLock({
      laneDir: dir,
      ...ME,
      table: {
        inspect: () => {
          rmSync(lockOf(dir));
          return null;
        },
        kill: () => false,
      },
    });
    const lock = acquired(r);
    expect(lock.tookOver).toEqual({ pid: 4242, reason: "gone" });
    expect(readFileSync(lockOf(dir), "utf8")).toBe(OWN);
  });

  test("release leaves a lock that is no longer this process's own", () => {
    const dir = laneDir();
    const lock = acquired(acquire(dir));
    writeFileSync(lockOf(dir), OTHER);
    expect(lock.release()).toEqual({ ok: true, value: undefined });
    expect(readFileSync(lockOf(dir), "utf8")).toBe(OTHER);
  });

  test("an I/O error: a folder where the lock should be", () => {
    const dir = laneDir();
    mkdirSync(lockOf(dir), { recursive: true });
    const r = acquire(dir);
    expect(r.ok ? "ok" : r.error.kind).toBe("io");
    expect(leftovers(dir)).toEqual([]);
  });

  test("an I/O error: the lane folder can't be made", () => {
    const dir = laneDir();
    mkdirSync(join(dir, ".."), { recursive: true });
    writeFileSync(dir, "a file, not a folder\n");
    const r = acquire(dir);
    expect(r.ok ? "ok" : r.error.kind).toBe("io");
  });

  test("an invalid owner is refused before any write", () => {
    const dir = laneDir();
    const r = acquire(dir, { command: "/usr/bin/bun" });
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("acquireLaneLock with the real process table", () => {
  hostTest("this process's own lock (its PID, runtime and start) is live to a second acquire through ps", () => {
    const dir = laneDir();
    const me = { pid: process.pid, command: basename(process.execPath), startedMs: performance.timeOrigin };
    const table = createPsProcessTable();
    const first = acquired(acquireLaneLock({ laneDir: dir, ...me, table }));
    expect(acquireLaneLock({ laneDir: dir, ...me, pid: process.pid + 1, table })).toEqual({ ok: true, value: { kind: "held", pid: process.pid } });
    first.release();
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  hostTest("a lock recording this PID with a start an hour before it is stale through ps: a reused PID", () => {
    const dir = laneDir();
    const table = createPsProcessTable();
    seed(dir, `${process.pid}\n${basename(process.execPath)}\n${new Date(performance.timeOrigin - 3_600_000).toISOString()}\n`);
    const lock = acquired(acquireLaneLock({ laneDir: dir, pid: process.pid, command: basename(process.execPath), startedMs: performance.timeOrigin, table }));
    expect(lock.tookOver).toEqual({ pid: process.pid, reason: "started-later" });
    lock.release();
  });
});
