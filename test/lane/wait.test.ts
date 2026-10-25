import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "../../src/core/result.ts";
import type { LaneStore } from "../../src/ports/lane-store.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { createPsProcessTable, readPidFile } from "../../src/lane/processes.ts";
import { createSleepWaiter, type SpawnSleep } from "../../src/lane/wait.ts";
import { hostTest } from "../support/sandbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "xarabot-wait-"));
  dirs.push(root);
  const laneDir = join(root, "lane");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const store = createFsLaneStore({ laneDir, hostStop });
  return { laneDir, hostStop, store, waitPid: join(laneDir, "wait.pid") };
}

/** Polls until `wait.pid` exists; its contents. */
async function recorded(path: string): Promise<{ pid: number; command: string }> {
  for (let i = 0; i < 200; i += 1) {
    const f = readPidFile(path);
    if (f !== null) return f;
    await Bun.sleep(5);
  }
  throw new Error("wait.pid never appeared");
}

describe("createSleepWaiter", () => {
  hostTest("a short wait elapses; wait.pid named the live sleep during it and is gone after", async () => {
    const { store, waitPid } = setup();
    const pending = createSleepWaiter({ store, pollMs: 20 }).wait({ ms: 300 });
    const f = await recorded(waitPid);
    expect(f.command).toBe("sleep");
    expect(readFileSync(waitPid, "utf8")).toBe(`${f.pid}\nsleep\n`);
    expect(createPsProcessTable().inspect(f.pid)?.args).toMatch(/^(\S*\/)?sleep 0\.3$/);
    expect(await pending).toEqual({ end: "elapsed" });
    expect(existsSync(waitPid)).toBe(false);
  });

  test("a lane STOP written mid-sleep kills it: stopped", async () => {
    const { laneDir, store, waitPid } = setup();
    const pending = createSleepWaiter({ store, pollMs: 20 }).wait({ ms: 30_000 });
    const f = await recorded(waitPid);
    writeFileSync(join(laneDir, "STOP"), "stop\n");
    expect((await pending).end).toBe("stopped");
    expect(existsSync(waitPid)).toBe(false);
    expect(createPsProcessTable().inspect(f.pid)).toBeNull();
  });

  test("a STOP present at the start: stopped, nothing spawned", async () => {
    const { hostStop, store } = setup();
    mkdirSync(join(hostStop, ".."), { recursive: true });
    writeFileSync(hostStop, "stop\n");
    let spawned = false;
    const spawn: SpawnSleep = () => {
      spawned = true;
      throw new Error("no");
    };
    expect(await createSleepWaiter({ store, spawn }).wait({ ms: 1000 })).toEqual({ end: "stopped", message: "host STOP marker present" });
    expect(spawned).toBe(false);
  });

  test("unreadable STOP markers: stopped", async () => {
    const { store } = setup();
    const broken: LaneStore = { ...store, stopMarkers: () => err("io", "EACCES") };
    expect((await createSleepWaiter({ store: broken }).wait({ ms: 1000 })).end).toBe("stopped");
  });

  test("a STOP written, then the sleep woken before the next poll: stopped", async () => {
    const { laneDir, store, waitPid } = setup();
    const pending = createSleepWaiter({ store, pollMs: 60_000 }).wait({ ms: 30_000 });
    const f = await recorded(waitPid);
    writeFileSync(join(laneDir, "STOP"), "stop\n");
    process.kill(f.pid, "SIGTERM");
    expect(await pending).toEqual({ end: "stopped", message: "lane STOP marker present" });
    expect(existsSync(waitPid)).toBe(false);
  });

  test("an external SIGTERM to the recorded PID: woken", async () => {
    const { store, waitPid } = setup();
    const pending = createSleepWaiter({ store, pollMs: 20 }).wait({ ms: 30_000 });
    const f = await recorded(waitPid);
    process.kill(f.pid, "SIGTERM");
    expect((await pending).end).toBe("woken");
    expect(existsSync(waitPid)).toBe(false);
  });

  test("the signal aborting kills the child: aborted", async () => {
    const { store, waitPid } = setup();
    const ac = new AbortController();
    const pending = createSleepWaiter({ store, pollMs: 20 }).wait({ ms: 30_000, signal: ac.signal });
    const f = await recorded(waitPid);
    ac.abort();
    expect((await pending).end).toBe("aborted");
    expect(createPsProcessTable().inspect(f.pid)).toBeNull();
    expect(existsSync(waitPid)).toBe(false);
  });

  test("an already aborted signal: aborted, nothing spawned", async () => {
    const { store } = setup();
    expect((await createSleepWaiter({ store }).wait({ ms: 30_000, signal: AbortSignal.abort() })).end).toBe("aborted");
  });

  test("onTick runs every tickMs during the wait", async () => {
    const { store } = setup();
    let ticks = 0;
    const r = await createSleepWaiter({ store, pollMs: 1000 }).wait({ ms: 350, tickMs: 50, onTick: () => void ticks++ });
    expect(r.end).toBe("elapsed");
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  test("a failing tick never ends the wait", async () => {
    const { store } = setup();
    const r = await createSleepWaiter({ store }).wait({
      ms: 200,
      tickMs: 30,
      onTick: async () => {
        throw new Error("heartbeat down");
      },
    });
    expect(r.end).toBe("elapsed");
  });

  test("a spawn failure: failed, never throws, wait.pid clear", async () => {
    const { store, waitPid } = setup();
    const spawn: SpawnSleep = () => {
      throw new Error("ENOENT sleep");
    };
    expect(await createSleepWaiter({ store, spawn }).wait({ ms: 1000 })).toEqual({ end: "failed", message: "sleep: ENOENT sleep" });
    expect(existsSync(waitPid)).toBe(false);
  });

  test("a sleep that exits non-zero: failed", async () => {
    const { store } = setup();
    const spawn: SpawnSleep = () => ({ pid: 4242, exited: Promise.resolve(1), exitCode: 1, signalCode: null, kill: () => {} });
    expect(await createSleepWaiter({ store, spawn }).wait({ ms: 10 })).toEqual({ end: "failed", message: "sleep exited 1" });
  });

  test("a wait.pid that can't be written kills the child: failed", async () => {
    const { store } = setup();
    let killed = false;
    const spawn: SpawnSleep = () => ({ pid: 4242, exited: Promise.resolve(0), exitCode: null, signalCode: "SIGTERM", kill: () => void (killed = true) });
    const broken: LaneStore = { ...store, writePid: () => err("io", "disk full"), clearPid: () => ok(undefined) };
    const r = await createSleepWaiter({ store: broken, spawn }).wait({ ms: 10 });
    expect(r).toEqual({ end: "failed", message: "wait.pid: disk full" });
    expect(killed).toBe(true);
  });
});
