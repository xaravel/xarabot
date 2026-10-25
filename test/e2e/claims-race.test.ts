import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { LANE_LOCK_FILE, parseLaneLock } from "../../src/core/lane/lane-lock.ts";
import { claim } from "../../src/core/ledger/edits.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import { readsPath } from "../../src/lane/lane-process.ts";
import type { ProcessTable } from "../../src/lane/processes.ts";
import { liveGithubEnabled } from "../support/live-github.ts";
import { isLiveLong } from "../support/live.ts";
import { hostTest, isSandboxed } from "../support/sandbox.ts";
import {
  fakeArea,
  identityOf,
  killChild,
  liveArea,
  RACE_LANE,
  raceHost,
  release,
  runRaceLane,
  sessionTags,
  sessionUnit,
  spawnRaceLane,
  storyFor,
  swapRace,
  waitFor,
  withMain,
  type ChildLane,
  type RaceArea,
  type RaceHost,
  type RaceLaneParams,
  type RaceLaneRun,
  type RaceView,
} from "./race-harness.ts";
import { scratchSeed } from "./scratch-seed.ts";

/**
 * The claims race suite (Story 2.12, FR3). Live (`XARABOT_LIVE=1` with
 * `XARABOT_LIVE_GITHUB_REPO` and `XARABOT_LIVE_GITHUB_LOGIN`, on the host,
 * outside any sandbox): real `laneRun` lanes race on a fresh ledger branch of
 * the scratch repo, with holding stub sessions, and the ledger history is
 * asserted. The 30-minute takeover case also needs `XARABOT_LIVE_LONG=1`.
 * Each live case also runs as a rehearsal on the fake forge in every
 * `bun test`, so the harness is exercised without credentials. Two facts are
 * asserted only live: the kill by PID across processes, followed by the
 * takeover (the takeover rehearsal runs host A in process with no heartbeat),
 * and the one-claim count across two OS processes (each fake-mode child has
 * its own fake forge).
 */

const ROOT = join(import.meta.dir, "..", "..");
const UNIT = "story:1.1";
const claimMessage = (unit: string): string => `ledger: claim ${unit} [skip ci]`;
const IDLE_LINE = `lane ${RACE_LANE}: idle`;
/** How long a lane may take to reach its session: live, the start checks and a few API round trips. */
const startMs = (area: RaceArea): number => (area.kind === "live" ? 3 * 60_000 : 20_000);
/** How long released lanes may take to fail their attempts and exit. */
const endMs = (kind: RaceArea["kind"]): number => (kind === "live" ? 3 * 60_000 : 20_000);
/** A rehearsal's own timeout: above every wait inside it. */
const REHEARSAL_MS = 90_000;
/** A skip-reporting check's timeout: above its nested `bun test`'s 60 s. */
const NESTED_MS = 90_000;
const DAY_MS = 24 * 60 * 60_000;

// ------------------------------------------------------------ the world of one case

type Run = { readonly tag: string; readonly done: Promise<RaceLaneRun>; result: RaceLaneRun | null; settled: boolean };

type World = {
  readonly root: string;
  readonly control: string;
  readonly lines: string[];
  readonly runs: Run[];
  readonly children: { readonly tag: string; readonly child: ChildLane }[];
  readonly hosts: RaceHost[];
  /** Every lane's recorded alerts. */
  readonly alerts: string[];
  readonly kind: RaceArea["kind"];
};

function newWorld(prefix: string, kind: RaceArea["kind"]): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const control = join(root, "control");
  mkdirSync(control, { recursive: true });
  return { root, control, lines: [], runs: [], children: [], hosts: [], alerts: [], kind };
}

function hostIn(w: World, name: string, area: RaceArea): RaceHost {
  const h = raceHost(join(w.root, name), { repo: area.repo, owner: area.owner, runnerVersion: area.runnerVersion });
  w.hosts.push(h);
  return h;
}

/** Starts one in-process lane; its lines go to the world's diagnostics. */
function startLane(w: World, p: Omit<RaceLaneParams, "control" | "out" | "errOut">): Run {
  const run: Run = {
    tag: p.tag,
    result: null,
    settled: false,
    done: runRaceLane({ ...p, control: w.control, out: (l) => w.lines.push(`[${p.tag} out] ${l}`), errOut: (l) => w.lines.push(`[${p.tag} err] ${l}`) }),
  };
  void run.done.then(
    (r) => {
      run.result = r;
      run.settled = true;
    },
    (e: unknown) => {
      run.settled = true;
      w.lines.push(`[${p.tag}] threw: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
  w.runs.push(run);
  return run;
}

/** Starts one child lane process. */
function startChild(w: World, area: RaceArea, host: RaceHost, tag: string, view: RaceView): ChildLane {
  const child = spawnRaceLane({ host, control: w.control, tag, view, area: area.ref }, join(w.root, `${tag}.json`));
  w.children.push({ tag, child });
  void child.exited.then((e) => w.lines.push(`[${tag} exited] code ${e.code ?? "none"} signal ${e.signal ?? "none"}`, `[${tag} stdout] ${e.stdout}`, `[${tag} stderr] ${e.stderr}`));
  return child;
}

/** The lanes' lines, the children's output once they exited, and the tail of every unit log. */
function diagnostics(w: World): () => string {
  return () => {
    const parts = [`--- lanes ---\n${w.lines.join("\n")}`, `--- sessions --- ${sessionTags(w.control).join(", ")}`, `--- alerts ---\n${w.alerts.join("\n")}`];
    for (const h of w.hosts) {
      const logs = join(h.laneDir, "logs");
      if (!existsSync(logs)) continue;
      for (const f of readdirSync(logs).sort()) parts.push(`--- ${h.hostId} ${f} (tail) ---\n${readFileSync(join(logs, f), "utf8").slice(-3000)}`);
    }
    return parts.join("\n");
  };
}

/** Runs one named step; a failure inside it is reported as `step "<name>": ...` with the diagnostics. */
async function step<T>(name: string, run: () => T | Promise<T>, context: () => string): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`step "${name}": ${e instanceof Error ? e.message : String(e)}\n${context()}`, { cause: e });
  }
}

/** Ends a case: every session released, every child killed by PID, every lane awaited (bounded), the folder removed. */
async function endWorld(w: World): Promise<void> {
  for (const tag of [...w.runs.map((r) => r.tag), ...w.children.map((c) => c.tag)]) release(w.control, tag);
  const settled = Promise.allSettled([...w.runs.map((r) => r.done), ...w.children.map((c) => c.child.exited)]);
  const pending = Symbol("pending");
  const r = await Promise.race([settled, Bun.sleep(endMs(w.kind)).then(() => pending)]);
  if (r === pending) console.error("claims race: a lane is still running after its release; killing the children");
  for (const c of w.children) killChild(c.child);
  await Promise.allSettled(w.children.map((c) => c.child.exited));
  rmSync(w.root, { recursive: true, force: true });
}

const count = (messages: readonly string[], m: string): number => messages.filter((x) => x === m).length;

async function recordOf(area: RaceArea, unit: string): Promise<UnitRecord | undefined> {
  return (await area.records()).get(unit);
}

// ------------------------------------------------------------ the cases

/** Two hosts, one unit: exactly one wins, and only its session starts. */
async function oneUnitCase(area: RaceArea): Promise<void> {
  const w = newWorld("xarabot-race-one-", area.kind);
  const diag = diagnostics(w);
  try {
    const hosts = { a: hostIn(w, "a", area), b: hostIn(w, "b", area) };
    expect(hosts.a.hostId).not.toBe(hosts.b.hostId);
    const race = swapRace(["a", "b"], startMs(area));
    const runs = {
      a: startLane(w, { host: hosts.a, connect: area.connect({ view: ["1.1"], alerts: w.alerts, race, tag: "a" }), tag: "a" }),
      b: startLane(w, { host: hosts.b, connect: area.connect({ view: ["1.1"], alerts: w.alerts, race, tag: "b" }), tag: "b" }),
    };

    await step("one session starts and the other lane ends", () => waitFor(() => sessionTags(w.control).length >= 1 && w.runs.some((r) => r.settled), startMs(area), "a session and a finished lane"), diag);

    const winner = await step(
      "both first swaps carry the same old tip: one ok, one conflict",
      () => {
        expect(race.swaps).toHaveLength(2);
        const [first, second] = race.swaps as [(typeof race.swaps)[0], (typeof race.swaps)[0]];
        expect(first.oldTip).toBe(second.oldTip);
        expect(race.swaps.map((s) => s.result).sort()).toEqual(["conflict", "ok"]);
        expect(race.swaps.map((s) => s.released)).toEqual(["barrier", "barrier"]);
        return race.swaps.find((s) => s.result === "ok")?.tag as "a" | "b";
      },
      diag,
    );
    const loser = winner === "a" ? "b" : "a";

    await step(
      "only the winner's session starts; the loser's laneRun exits 0 idle",
      () => {
        expect(sessionTags(w.control)).toEqual([winner]);
        expect(sessionUnit(w.control, winner)).toBe(UNIT);
        const lost = runs[loser].result;
        expect(lost?.code).toBe(0);
        expect(lost?.out).toContain(IDLE_LINE);
      },
      diag,
    );

    await step(
      "the ledger has one claim of story:1.1, held by the winner at generation 1",
      async () => {
        expect(count(await area.history(), claimMessage(UNIT))).toBe(1);
        expect(await recordOf(area, UNIT)).toMatchObject({ state: "claimed", owner: area.owner, host: hosts[winner].hostId, lane: RACE_LANE, generation: 1 });
      },
      diag,
    );

    await step(
      "after the release, the winner exits 0",
      async () => {
        release(w.control, winner);
        expect((await runs[winner].done).code).toBe(0);
      },
      diag,
    );
  } finally {
    await endWorld(w);
  }
}

/** Two hosts with different Story sets, 1.1 and 1.2 overlapping: one of them is claimed, and the loser gets 1.3. */
async function overlapCase(area: RaceArea): Promise<void> {
  const w = newWorld("xarabot-race-overlap-", area.kind);
  const diag = diagnostics(w);
  try {
    const hosts = { x: hostIn(w, "x", area), y: hostIn(w, "y", area) };
    const views: Record<"x" | "y", RaceView> = { x: ["1.1", "1.3"], y: ["1.2", "1.3"] };
    const picks: Record<"x" | "y", string> = { x: "story:1.1", y: "story:1.2" };
    const race = swapRace(["x", "y"], startMs(area));
    const runs = {
      x: startLane(w, { host: hosts.x, connect: area.connect({ view: views.x, alerts: w.alerts, race, tag: "x" }), tag: "x" }),
      y: startLane(w, { host: hosts.y, connect: area.connect({ view: views.y, alerts: w.alerts, race, tag: "y" }), tag: "y" }),
    };

    await step("both sessions start", () => waitFor(() => sessionTags(w.control).length === 2, startMs(area), "two sessions"), diag);

    const winner = await step(
      "both first swaps carry the same old tip: one ok, one conflict",
      () => {
        expect(race.swaps).toHaveLength(2);
        const [first, second] = race.swaps as [(typeof race.swaps)[0], (typeof race.swaps)[0]];
        expect(first.oldTip).toBe(second.oldTip);
        expect(race.swaps.map((s) => s.result).sort()).toEqual(["conflict", "ok"]);
        expect(race.swaps.map((s) => s.released)).toEqual(["barrier", "barrier"]);
        return race.swaps.find((s) => s.result === "ok")?.tag as "x" | "y";
      },
      diag,
    );
    const loser = winner === "x" ? "y" : "x";

    await step(
      "exactly one of 1.1 and 1.2 is claimed, the other has no record, and the loser holds 1.3",
      async () => {
        const records = await area.records();
        expect(records.get(picks[winner])).toMatchObject({ state: "claimed", host: hosts[winner].hostId, generation: 1 });
        expect(records.has(picks[loser])).toBe(false);
        expect(records.get("story:1.3")).toMatchObject({ state: "claimed", host: hosts[loser].hostId, generation: 1 });
        const history = await area.history();
        expect(count(history, claimMessage(picks[winner]))).toBe(1);
        expect(count(history, claimMessage(picks[loser]))).toBe(0);
        expect(count(history, claimMessage("story:1.3"))).toBe(1);
      },
      diag,
    );

    await step(
      "the winner's session is on its Story, the loser's on 1.3",
      () => {
        expect(sessionUnit(w.control, winner)).toBe(picks[winner]);
        expect(sessionUnit(w.control, loser)).toBe("story:1.3");
      },
      diag,
    );

    await step(
      "after the releases, both lanes exit 0",
      async () => {
        release(w.control, "x");
        release(w.control, "y");
        expect((await runs.x.done).code).toBe(0);
        expect((await runs.y.done).code).toBe(0);
      },
      diag,
    );
  } finally {
    await endWorld(w);
  }
}

/** Two OS processes of one lane on one host: one holds `lane.lock` and claims; the other exits 0 without a claim. */
async function twoProcessesCase(area: RaceArea): Promise<void> {
  const w = newWorld("xarabot-race-lock-", area.kind);
  const diag = diagnostics(w);
  try {
    const host = hostIn(w, "h", area);
    const tags = ["p1", "p2"] as const;
    const children = tags.map((tag) => startChild(w, area, host, tag, ["1.1"]));

    await step(
      "one session starts and the other process exits",
      async () => {
        await waitFor(() => sessionTags(w.control).length >= 2 || children.every((c) => c.done()) || (sessionTags(w.control).length === 1 && children.some((c) => c.done())), startMs(area), "a session and an exited process");
        expect(sessionTags(w.control)).toHaveLength(1);
      },
      diag,
    );
    const holderTag = sessionTags(w.control)[0] as string;
    const holder = children[tags.indexOf(holderTag as "p1" | "p2")] as ChildLane;
    const other = children.find((c) => c !== holder) as ChildLane;

    await step(
      "the other process exits 0 with no claim; lane.lock names the holder",
      async () => {
        const ended = await other.exited;
        expect(ended.code).toBe(0);
        expect(ended.stdout).toContain(`lane ${RACE_LANE} is already running (pid ${holder.pid}`);
        expect(ended.stdout).toContain("exiting without a claim");
        const lock = parseLaneLock(readFileSync(join(host.laneDir, LANE_LOCK_FILE), "utf8"));
        expect(lock.ok ? lock.value.pid : lock.error.message).toBe(holder.pid);
        expect(sessionUnit(w.control, holderTag)).toBe(UNIT);
      },
      diag,
    );

    if (area.kind === "live") {
      // Each fake-mode child has its own fake forge, so the one-claim fact is asserted only live.
      await step("the ledger has exactly one claim commit", async () => {
        const claims = (await area.history()).filter((m) => m.startsWith("ledger: claim "));
        expect(claims).toEqual([claimMessage(UNIT)]);
        expect(await recordOf(area, UNIT)).toMatchObject({ state: "claimed", host: host.hostId, generation: 1 });
      }, diag);
    }

    await step(
      "after the release, the holder exits 0 and lane.lock is gone",
      async () => {
        release(w.control, holderTag);
        const ended = await holder.exited;
        expect(ended.code).toBe(0);
        expect(existsSync(join(host.laneDir, LANE_LOCK_FILE))).toBe(false);
      },
      diag,
    );
  } finally {
    await endWorld(w);
  }
}

/**
 * Host A's lane holds story:1.1 and stops beating: killed by PID (`kill`,
 * a child process) or, in the rehearsal, in process with a 24 h heartbeat
 * interval. Before the stale age host B idles; after it B takes over at
 * generation + 1, and A's late push, replayed, is refused by its fence.
 */
async function killedMidUnitCase(area: RaceArea, how: "kill" | "in-process"): Promise<void> {
  const w = newWorld("xarabot-race-takeover-", area.kind);
  const diag = diagnostics(w);
  const view: RaceView = ["1.1"];
  try {
    const a = hostIn(w, "a", area);
    const b = hostIn(w, "b", area);
    const child = how === "kill" ? startChild(w, area, a, "a", view) : null;
    if (child === null) startLane(w, { host: a, connect: area.connect({ view, alerts: w.alerts, tag: "a" }), tag: "a", heartbeatEveryMs: DAY_MS });

    await step("host A's lane holds story:1.1", () => waitFor(() => sessionTags(w.control).includes("a"), startMs(area), "host A's session"), diag);

    if (child !== null) {
      await step("host A's lane, killed by PID, ends by SIGKILL", async () => {
        killChild(child);
        const ended = await child.exited;
        expect(ended.signal).toBe("SIGKILL");
        expect(ended.code).toBeNull();
      }, diag);
    }

    const held = await step(
      "A's record: claimed by host A",
      async () => {
        const r = await recordOf(area, UNIT);
        expect(r).toMatchObject({ state: "claimed", host: a.hostId, lane: RACE_LANE });
        return r as UnitRecord;
      },
      diag,
    );

    await step(
      "before the stale age, host B's run exits 0 idle and the record is unchanged",
      async () => {
        const r = await startLane(w, { host: b, connect: area.connect({ view, alerts: w.alerts, tag: "b1" }), tag: "b1" }).done;
        expect(r.code).toBe(0);
        expect(r.out).toContain(IDLE_LINE);
        expect(sessionTags(w.control)).not.toContain("b1");
        expect(await recordOf(area, UNIT)).toEqual(held);
      },
      diag,
    );

    await step("the record goes stale by the forge's time", () => area.waitStale(held), diag);

    const taker = startLane(w, { host: b, connect: area.connect({ view, alerts: w.alerts, tag: "b2" }), tag: "b2" });
    await step(
      "after the stale age, host B takes over at generation + 1 and its session starts",
      async () => {
        await waitFor(() => sessionTags(w.control).includes("b2"), startMs(area), "host B's session");
        expect(sessionUnit(w.control, "b2")).toBe(UNIT);
        expect(await recordOf(area, UNIT)).toMatchObject({ state: "claimed", host: b.hostId, generation: held.generation + 1, attempts: held.attempts + 1 });
      },
      diag,
    );

    await step(
      "A's late push, replayed from its generation-g record, is refused by its fence",
      async () => {
        const replayed = await area.replay({ identity: identityOf(a), record: held, view });
        w.lines.push(...replayed.notes.map((n) => `[replay] ${n}`));
        expect(replayed.out.outcome).toBe("failed");
        expect(replayed.out.state).toBeNull();
        expect(replayed.out.reason ?? "").toContain("fence: unit lost");
        expect(replayed.head).toBeNull();
        expect(await recordOf(area, UNIT)).toMatchObject({ state: "claimed", host: b.hostId, generation: held.generation + 1 });
      },
      diag,
    );

    await step(
      "after the release, host B exits 0",
      async () => {
        release(w.control, "b2");
        expect((await taker.done).code).toBe(0);
      },
      diag,
    );
  } finally {
    await endWorld(w);
  }
}

/** Runs `body` on a fresh live area, cleaning it up afterwards. */
async function onLiveArea(body: (area: RaceArea) => Promise<void>): Promise<void> {
  const area = await liveArea();
  try {
    await body(area);
  } finally {
    await area.cleanup();
  }
}

// ------------------------------------------------------------ the views

describe("race views", () => {
  const fake = createFakeForge({ now: "2026-10-25T10:00:00Z", main: scratchSeed({ repo: "acme/scratch", login: "alice" }) });
  const identity = { owner: "alice", host: "33333333-3333-4333-8333-333333333333", lane: RACE_LANE };
  const snapOf = async (view: RaceView) => {
    const r = await withMain(fake.forge, view).snapshot({ signal: AbortSignal.timeout(10_000), read: readsPath });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  /** The ledger files after `unit` is claimed on its globs. */
  const claimed = (unit: string, globs: readonly string[], mainSha: string): Record<string, string> => {
    const c = claim({ unit, by: identity, now: "2026-10-25T10:00:00Z", globs, expectGeneration: null, baseSha: mainSha })({});
    if (!c.ok || c.value === null) throw new Error("claim failed");
    return { ...c.value.writes };
  };

  test.each([
    ["one unit", "story:1.1", ["1.1"], ["race/shared/**"]],
    ["view X", "story:1.1", ["1.1", "1.3"], ["race/shared/**"]],
    ["view Y", "story:1.2", ["1.2", "1.3"], ["race/shared/b/**"]],
  ] as const)("%s: next picks %s", async (_name, unit, view, globs) => {
    const snap = await snapOf(view);
    const story = storyFor({ repo: "acme/scratch", snap, identity });
    expect(story.unit).toBe(unit);
    expect(story.globs).toEqual(globs);
    expect(story.take_over).toBeNull();
  });

  test.each([
    ["view X, with 1.2 claimed", ["1.1", "1.3"], "story:1.2", ["race/shared/b/**"]],
    ["view Y, with 1.1 claimed", ["1.2", "1.3"], "story:1.1", ["race/shared/**"]],
  ] as const)("%s: next picks story:1.3, the overlap skipped", async (_name, view, other, globs) => {
    const snap = await snapOf(view);
    const story = storyFor({ repo: "acme/scratch", snap, identity, ledger: claimed(other, globs, snap.main.sha) });
    expect(story.unit).toBe("story:1.3");
  });

  test("the overlay replaces the seed's Story set and keeps the rest of main", async () => {
    const seed = scratchSeed({ repo: "acme/scratch", login: "alice" });
    const snap = await snapOf(["1.2"]);
    expect(snap.main.tree.filter((p) => p.startsWith("stories/"))).toEqual(["stories/1.2.md"]);
    expect(snap.main.files[".xarabot/config.yaml"]).toBe(seed[".xarabot/config.yaml"]);
    expect(snap.main.files["_bmad-output/implementation-artifacts/sprint-status.yaml"]).toContain("1-2-race-shared-b: backlog");
  });
});

// ------------------------------------------------------------ the rehearsals on the fake forge

describe("rehearsals on the fake forge", () => {
  test("one unit, two hosts: one ok and one conflict at one tip, one claim, only the winner's session", () => oneUnitCase(fakeArea()), REHEARSAL_MS);

  test("overlapping globs, asymmetric views: one of 1.1 and 1.2 claimed, the loser on 1.3", () => overlapCase(fakeArea()), REHEARSAL_MS);

  test("same lane, two laneRuns in one process: one holds lane.lock and claims, the other exits 0 without a claim", async () => {
    const area = fakeArea();
    const w = newWorld("xarabot-race-lock-in-", area.kind);
    const diag = diagnostics(w);
    try {
      const host = hostIn(w, "h", area);
      const startedMs = Date.now();
      // Both lock owners are live processes in this table, whichever holds the lock.
      const table: ProcessTable = { inspect: (pid) => (pid === 1001 || pid === 1002 ? { startMs: startedMs, args: "bun test/e2e/race-lane.ts" } : null), kill: () => false };
        const runs = [
        startLane(w, { host, connect: area.connect({ view: ["1.1"], alerts: w.alerts, tag: "p1" }), tag: "p1", lock: { pid: 1001, command: "bun", startedMs, table } }),
        startLane(w, { host, connect: area.connect({ view: ["1.1"], alerts: w.alerts, tag: "p2" }), tag: "p2", lock: { pid: 1002, command: "bun", startedMs, table } }),
      ];
      await step("one session starts and the other run ends", () => waitFor(() => sessionTags(w.control).length === 1 && runs.some((r) => r.settled), startMs(area), "a session and an ended run"), diag);
      const holderTag = sessionTags(w.control)[0] as string;
      const holderPid = holderTag === "p1" ? 1001 : 1002;
      const holder = runs.find((r) => r.tag === holderTag) as Run;
      const other = runs.find((r) => r !== holder) as Run;
      await step("the other exits 0 with no claim; lane.lock names the holder; one claim in total", async () => {
        expect(other.result?.code).toBe(0);
        expect(other.result?.out).toEqual([`lane ${RACE_LANE} is already running (pid ${holderPid}, ${LANE_LOCK_FILE}); exiting without a claim`]);
        const lock = parseLaneLock(readFileSync(join(host.laneDir, LANE_LOCK_FILE), "utf8"));
        expect(lock.ok ? lock.value.pid : lock.error.message).toBe(holderPid);
        expect(sessionUnit(w.control, holderTag)).toBe(UNIT);
        expect((await area.history()).filter((m) => m.startsWith("ledger: claim "))).toEqual([claimMessage(UNIT)]);
        expect(await recordOf(area, UNIT)).toMatchObject({ state: "claimed", host: host.hostId, generation: 1 });
      }, diag);
      await step("after the release, the holder exits 0 and lane.lock is gone", async () => {
        release(w.control, holderTag);
        expect((await holder.done).code).toBe(0);
        expect(existsSync(join(host.laneDir, LANE_LOCK_FILE))).toBe(false);
      }, diag);
    } finally {
      await endWorld(w);
    }
  }, REHEARSAL_MS);

  hostTest("same lane, two OS processes (fake-mode children): one holds lane.lock and claims, the other exits 0 without a claim", () => twoProcessesCase(fakeArea()), REHEARSAL_MS);

  test("a fake-mode child lane claims, is killed by PID, ends by SIGKILL and leaves lane.lock naming it", async () => {
    const area = fakeArea();
    const w = newWorld("xarabot-race-kill-", area.kind);
    const diag = diagnostics(w);
    try {
      const host = hostIn(w, "h", area);
      const child = startChild(w, area, host, "k", ["1.1"]);
      await step("the child's session starts on story:1.1", async () => {
        await waitFor(() => sessionTags(w.control).includes("k") || child.done(), startMs(area), "the child's session");
        if (child.done()) {
          const ended = await child.exited;
          throw new Error(`the child exited ${ended.code}:\n${ended.stdout}\n${ended.stderr}`);
        }
        expect(sessionUnit(w.control, "k")).toBe(UNIT);
      }, diag);
      await step("killed by PID, it ends by SIGKILL and leaves lane.lock naming it", async () => {
        killChild(child);
        const ended = await child.exited;
        expect(ended.signal).toBe("SIGKILL");
        expect(ended.code).toBeNull();
        const lock = parseLaneLock(readFileSync(join(host.laneDir, LANE_LOCK_FILE), "utf8"));
        expect(lock.ok ? lock.value.pid : lock.error.message).toBe(child.pid);
      }, diag);
    } finally {
      await endWorld(w);
    }
  }, REHEARSAL_MS);

  test("the takeover: B idles before the stale age, takes over at generation + 1 after it, and A's replayed late push is fenced", () => killedMidUnitCase(fakeArea(), "in-process"), REHEARSAL_MS);
});

// ------------------------------------------------------------ skip reporting

/** Every live case's name starts `live race:` or `live long:`, and nothing else in this file starts `live`, so `-t "^live"` picks them alone. */
describe("skip reporting", () => {
  const nested = (pattern: string, extra: Record<string, string>, unset: readonly string[]): { code: number; output: string } => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !unset.includes(k)) env[k] = v;
    Object.assign(env, extra);
    const r = Bun.spawnSync([process.execPath, "test", "test/e2e/claims-race.test.ts", "-t", pattern], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return { code: r.exitCode ?? -1, output: r.stdout.toString() + r.stderr.toString() };
  };
  const SCRATCH = { XARABOT_LIVE_GITHUB_REPO: "acme/scratch", XARABOT_LIVE_GITHUB_LOGIN: "alice" };
  const expectSkipped = (r: { code: number; output: string }, skipped: number): void => {
    expect(r.code).toBe(0);
    expect(r.output).toMatch(new RegExp(`\\b${skipped} skip\\b`));
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  };

  test("XARABOT_LIVE unset: the 4 live cases report skipped", () => {
    expectSkipped(nested("^live", SCRATCH, ["XARABOT_LIVE", "XARABOT_LIVE_LONG"]), 4);
  }, NESTED_MS);

  test("XARABOT_LIVE=1 with no scratch variables: the 4 live cases report skipped", () => {
    expectSkipped(nested("^live", { XARABOT_LIVE: "1", XARABOT_LIVE_LONG: "1" }, ["XARABOT_LIVE_GITHUB_REPO", "XARABOT_LIVE_GITHUB_LOGIN"]), 4);
  }, NESTED_MS);

  test("XARABOT_LIVE=1 inside a sandbox (XARABOT_SANDBOXED=1): the 4 live cases report skipped", () => {
    expectSkipped(nested("^live", { ...SCRATCH, XARABOT_LIVE: "1", XARABOT_LIVE_LONG: "1", XARABOT_SANDBOXED: "1" }, []), 4);
  }, NESTED_MS);

  test("XARABOT_LIVE=1 with the scratch variables but no XARABOT_LIVE_LONG: the long case reports skipped", () => {
    expectSkipped(nested("^live long:", { ...SCRATCH, XARABOT_LIVE: "1" }, ["XARABOT_LIVE_LONG", "XARABOT_SANDBOXED"]), 1);
  }, NESTED_MS);
});

// ------------------------------------------------------------ live

const liveRace = test.skipIf(!liveGithubEnabled || isSandboxed) as typeof test;
const liveLong = test.skipIf(!liveGithubEnabled || isSandboxed || !isLiveLong) as typeof test;

liveRace("live race: one unit, two hosts: exactly one claim wins, only its session starts, the loser idles", () => onLiveArea(oneUnitCase), 15 * 60_000);

liveRace("live race: overlapping globs, asymmetric views: exactly one of 1.1 and 1.2 is claimed, the loser takes 1.3", () => onLiveArea(overlapCase), 15 * 60_000);

liveRace("live race: same lane, two OS processes on one host: one holds lane.lock and claims once, the other exits 0", () => onLiveArea(twoProcessesCase), 15 * 60_000);

liveLong(
  "live long: a lane killed by PID mid-unit is taken over 30 min after its last heartbeat, and its replayed late push is fenced",
  () => onLiveArea((area) => killedMidUnitCase(area, "kill")),
  75 * 60_000,
);
