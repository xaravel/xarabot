import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import { laneCommand, laneDirFor, type LaneCommandDeps } from "../../src/cli/lane-commands.ts";
import type { ProcessTable } from "../../src/lane/processes.ts";
import { ALICE, rec, tip } from "../core/ledger/fixtures.ts";
import { hostTest } from "../support/sandbox.ts";

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const HOST_ID = ALICE.host;

const dirs: string[] = [];
const children: { kill(): void }[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type World = { home: string; xdg: string; env: Record<string, string>; laneDir: string };

function world(o: { hostId?: boolean; hostYaml?: string | null } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "xarabot-cli-"));
  dirs.push(root);
  const home = join(root, "home");
  const xdg = join(root, "config");
  mkdirSync(home, { recursive: true });
  const hostYaml =
    o.hostYaml !== undefined
      ? o.hostYaml
      : [
          "schema_version: 1",
          ...(o.hostId === false ? [] : [`host_id: ${HOST_ID}`]),
          "lanes:",
          "  builder-1:",
          "    repo: xaravel/xarabot",
          "    role: builder",
          "    owner: alice",
          "    agent: claude",
          "",
        ].join("\n");
  if (hostYaml !== null) {
    mkdirSync(join(xdg, "xarabot"), { recursive: true });
    writeFileSync(join(xdg, "xarabot", "host.yaml"), hostYaml);
  }
  const laneDir = join(home, ".xarabot", "repos", "xaravel__xarabot", "lanes", "builder-1");
  return { home, xdg, env: { HOME: home, XDG_CONFIG_HOME: xdg }, laneDir };
}

async function run(args: string[], deps: Partial<LaneCommandDeps> & { env: Record<string, string> }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await laneCommand(args, { out: (l) => out.push(l), errOut: (l) => err.push(l), ...deps });
  return { code, out, err };
}

function spawnSleep() {
  const p = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(p);
  return p;
}

describe("lane folder", () => {
  test("~/.xarabot/repos/<owner>__<name>/lanes/<lane>", () => {
    expect(laneDirFor("/h/.xarabot", { repo: "a/b", role: "builder", owner: "a", agent: "claude", effort: "high" }, "l1")).toBe(
      "/h/.xarabot/repos/a__b/lanes/l1",
    );
  });
});

describe("xarabot stop", () => {
  test("stop <lane> writes the lane's STOP", async () => {
    const w = world();
    const r = await run(["stop", "builder-1"], { env: w.env });
    expect(r.code).toBe(0);
    expect(readFileSync(join(w.laneDir, "STOP"), "utf8")).toBe("stop\n");
  });

  test("stop --all writes ~/.xarabot/STOP, with no host.yaml needed", async () => {
    const w = world({ hostYaml: null });
    const r = await run(["stop", "--all"], { env: w.env });
    expect(r.code).toBe(0);
    expect(readFileSync(join(w.home, ".xarabot", "STOP"), "utf8")).toBe("stop\n");
  });

  test("host.yaml under HOME/.config when XDG_CONFIG_HOME is unset", async () => {
    const w = world({ hostYaml: null });
    mkdirSync(join(w.home, ".config", "xarabot"), { recursive: true });
    writeFileSync(
      join(w.home, ".config", "xarabot", "host.yaml"),
      "schema_version: 1\nlanes:\n  builder-1:\n    repo: xaravel/xarabot\n    role: builder\n    owner: alice\n    agent: claude\n",
    );
    const r = await run(["stop", "builder-1"], { env: { HOME: w.home } });
    expect(r.code).toBe(0);
    expect(existsSync(join(w.laneDir, "STOP"))).toBe(true);
  });

  test.each([
    ["an unknown lane", {}, ["stop", "nope"], "unknown lane"],
    ["no host.yaml", { hostYaml: null }, ["stop", "builder-1"], "cannot read"],
    ["an invalid host.yaml", { hostYaml: "schema_version: 1\nlanes: 7\n" }, ["wake", "builder-1"], "host.yaml"],
    ["a usage error", {}, ["stop", "--now"], "usage"],
    ["wake with two lanes", {}, ["wake", "a", "b"], "usage"],
  ] as const)("%s exits 1", async (_name, opts, args, message) => {
    const w = world(opts);
    const r = await run([...args], { env: w.env });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(message);
    expect(existsSync(join(w.laneDir, "STOP"))).toBe(false);
  });

  hostTest("stop --now with no host_id: STOP written, kills reported, nothing to release", async () => {
    const w = world({ hostId: false });
    mkdirSync(w.laneDir, { recursive: true });
    const wait = spawnSleep();
    writeFileSync(join(w.laneDir, "wait.pid"), `${wait.pid}\nsleep\n`);
    let forgeAsked = false;
    const r = await run(["stop", "--now", "builder-1"], {
      env: w.env,
      forge: async () => {
        forgeAsked = true;
        return { ok: false, message: "no" };
      },
    });
    expect(r.code).toBe(0);
    expect(forgeAsked).toBe(false);
    expect(readFileSync(join(w.laneDir, "STOP"), "utf8")).toBe("stop\n");
    expect(r.out).toContain(`wait: killed sleep (pid ${wait.pid})`);
    expect(r.out).toContain("lane: skipped: no-pid-file");
    expect(r.out.join("\n")).toContain("nothing to release");
    await wait.exited;
  });

  test("stop --now with a verified process that can't be signalled exits 1", async () => {
    const w = world({ hostId: false });
    mkdirSync(w.laneDir, { recursive: true });
    writeFileSync(join(w.laneDir, "lane.pid"), "4242\nbun\n");
    const table: ProcessTable = { inspect: () => ({ startMs: 0, args: "bun main.ts lane run" }), kill: () => false };
    const r = await run(["stop", "--now", "builder-1"], { env: w.env, table });
    expect(r.code).toBe(1);
    expect(existsSync(join(w.laneDir, "STOP"))).toBe(true);
    expect(r.err.join("\n")).toContain("lane: skipped: kill-failed (pid 4242)");
  });

  test("stop --now releases the lane's held units through the forge", async () => {
    const w = world();
    const fake = createFakeForge({ now: "2026-10-22T10:10:00Z", main: { "README.md": "x\n" } });
    fake.control.writeForeignLedger({ message: "seed [skip ci]", deletes: [], writes: tip([rec({ unit: "story:1.5", attempts: 1 })]) });
    const r = await run(["stop", "--now", "builder-1"], { env: w.env, forge: async () => ({ ok: true, forge: fake.forge }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("released story:1.5");
    const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    expect(l.value.units.get("story:1.5")).toMatchObject({ state: "released", attempts: 1 });
  });

  test("stop --now on a merging unit with a queued PR: a fencing heartbeat commit, then the dequeue, then the release", async () => {
    const w = world();
    const fake = createFakeForge({ now: "2026-10-22T10:10:00Z", main: { "README.md": "x\n" } });
    const opts = { signal: AbortSignal.timeout(5000) };
    const head = fake.control.makeCommit();
    expect((await fake.forge.pushBranch({ branch: "story/1.5", expected_sha: null, sha: head }, opts)).ok).toBe(true);
    const opened = await fake.forge.openPr({ branch: "story/1.5", base: "main", title: "t", body: "b" }, opts);
    if (!opened.ok) throw new Error(opened.error.message);
    const pr = opened.value.number;
    expect((await fake.forge.enqueue(pr, head, opts)).ok).toBe(true);
    expect(fake.control.queue()).toEqual([pr]);
    fake.control.writeForeignLedger({
      message: "seed [skip ci]",
      deletes: [],
      writes: tip([rec({ unit: "story:1.5", state: "merging", pr, pr_owner: "alice", head_sha: head, passed_sha: head })]),
    });
    // The ledger commits already written when the dequeue is asked for.
    let atDequeue: string[] | null = null;
    const forge = {
      ...fake.forge,
      dequeue: (n: number, o: { readonly signal: AbortSignal }) => {
        atDequeue = fake.control.ledgerLog().map((c) => c.message);
        return fake.forge.dequeue(n, o);
      },
    };
    const r = await run(["stop", "--now", "builder-1"], { env: w.env, forge: async () => ({ ok: true, forge }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("released story:1.5");
    expect(atDequeue as string[] | null).toEqual(["root", "seed [skip ci]", "ledger: heartbeat story:1.5 [skip ci]"]);
    expect(fake.control.ledgerLog().map((c) => c.message)).toEqual([
      "root",
      "seed [skip ci]",
      "ledger: heartbeat story:1.5 [skip ci]",
      "ledger: release story:1.5 [skip ci]",
    ]);
    expect(fake.control.queue()).toEqual([]);
    const s = await fake.forge.snapshot(opts);
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    expect(l.value.units.get("story:1.5")).toMatchObject({ state: "released", attempts: 0 });
  });

  test("stop --now with no App credentials: STOP written, the release failure exits 1", async () => {
    const w = world();
    const r = await run(["stop", "--now", "builder-1"], { env: w.env });
    expect(r.code).toBe(1);
    expect(existsSync(join(w.laneDir, "STOP"))).toBe(true);
    expect(r.err.join("\n")).toContain("credentials auth");
  });
});

describe("xarabot wake", () => {
  hostTest("wakes a live recorded sleep: exit 0", async () => {
    const w = world();
    mkdirSync(w.laneDir, { recursive: true });
    const p = spawnSleep();
    writeFileSync(join(w.laneDir, "wait.pid"), `${p.pid}\nsleep\n`);
    const r = await run(["wake", "builder-1"], { env: w.env });
    expect(r.code).toBe(0);
    await p.exited;
    expect(p.signalCode).toBe("SIGTERM");
  });

  test("nothing to wake: exit 1 with the reason", async () => {
    const w = world();
    const r = await run(["wake", "builder-1"], { env: w.env });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("no-pid-file");
  });

  hostTest("through the bin: wake and stop", async () => {
    const w = world();
    mkdirSync(w.laneDir, { recursive: true });
    const p = spawnSleep();
    writeFileSync(join(w.laneDir, "wait.pid"), `${p.pid}\nsleep\n`);
    const env = { ...process.env, ...w.env };
    const wake = Bun.spawnSync([process.execPath, MAIN, "wake", "builder-1"], { env, stdout: "pipe", stderr: "pipe" });
    expect(wake.exitCode).toBe(0);
    await p.exited;
    const again = Bun.spawnSync([process.execPath, MAIN, "wake", "builder-1"], { env, stdout: "pipe", stderr: "pipe" });
    expect(again.exitCode).toBe(1);
    const stop = Bun.spawnSync([process.execPath, MAIN, "stop", "builder-1"], { env, stdout: "pipe", stderr: "pipe" });
    expect(stop.exitCode).toBe(0);
    expect(existsSync(join(w.laneDir, "STOP"))).toBe(true);
  });
});
