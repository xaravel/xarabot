import { describe, expect, test } from "bun:test";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import { unitPath, type CoordinatorRecord, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import { startCoordinatorHeartbeat, startHeartbeat, type Heartbeat } from "../../src/lane/heartbeat.ts";
import type { Sleep } from "../../src/lane/ledger-cas.ts";
import type { Forge, ForgeError } from "../../src/ports/forge.ts";
import { ALICE, BOB, COORD, rec, tip } from "../core/ledger/fixtures.ts";

const MIN = 60_000;
const UNIT = "story:1.5";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
/** The forge clock runs an hour ahead of the host clock, so forge-time stamps differ from host time. */
const FORGE_AHEAD = 60 * MIN;
/** The forge time the keeper stamps at host time `ms`. */
const forgeIso = (ms: number) => iso(ms + FORGE_AHEAD);
const iso = (ms: number) => new Date(ms).toISOString();

type WorldOpts = {
  /** Loop sleeps from this index on wait until the keeper stops; default never. */
  readonly holdAt?: number;
  /** Runs inside loop sleep `i`, after the host clock advanced. */
  readonly onLoopSleep?: (i: number, w: World) => void | Promise<void>;
  readonly retryMs?: number;
};

type World = {
  readonly fake: FakeForge;
  readonly keeper: Heartbeat;
  /** The keeper loop's waits, in order. */
  readonly loopSleeps: number[];
  /** The swaps' back-off waits, in order. */
  readonly casSleeps: number[];
  readonly logs: string[];
  /** Ledger swaps the keeper asked for, by edit name. */
  readonly swaps: string[];
  now(): number;
  /** Swaps of these edits fail with `error` (`null` lets them through). */
  fail(error: ForgeError | null, edits?: readonly string[]): void;
  /** Swaps wait on this until it resolves (`null` lets them through). */
  gate(g: Promise<void> | null): void;
  record(): Promise<UnitRecord | undefined>;
  keepAlives(): number;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function abortOf(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

function editName(message: string): string {
  return /^ledger: (\S+)/.exec(message)?.[1] ?? message;
}

function world(o: WorldOpts = {}): World {
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z" });
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([rec()]), deletes: [] });
  let clock = T0;
  const loopSleeps: number[] = [];
  const casSleeps: number[] = [];
  const logs: string[] = [];
  const swaps: string[] = [];
  let failing: { readonly error: ForgeError; readonly edits: readonly string[] } | null = null;
  let gate: Promise<void> | null = null;
  let loopSignal: AbortSignal | null = null;

  const forge: Forge = {
    ...fake.forge,
    ledgerSwap: async (oldSha, commit, opts) => {
      const name = editName(commit.message);
      swaps.push(name);
      if (gate !== null) await gate;
      if (failing !== null && failing.edits.includes(name)) return { ok: false, error: failing.error };
      return fake.forge.ledgerSwap(oldSha, commit, opts);
    },
  };

  const sleep: Sleep = async (ms, signal) => {
    // The keeper's first call is its loop's wait; the loop's signal tells its waits from the swaps' back-off.
    loopSignal ??= signal;
    if (signal !== loopSignal) {
      casSleeps.push(ms);
      clock += ms;
      await tick();
      return;
    }
    await tick();
    const i = loopSleeps.length;
    loopSleeps.push(ms);
    if (o.holdAt !== undefined && i >= o.holdAt) return abortOf(signal);
    clock += ms;
    await o.onLoopSleep?.(i, w);
  };

  const keeper = startHeartbeat({
    forge,
    identity: ALICE,
    unit: UNIT,
    generation: 1,
    clock: () => clock,
    forgeNow: () => forgeIso(clock),
    sleep,
    random: () => 0,
    ...(o.retryMs !== undefined ? { retryMs: o.retryMs } : {}),
    log: (text) => logs.push(text),
  });

  const w: World = {
    fake,
    keeper,
    loopSleeps,
    casSleeps,
    logs,
    swaps,
    now: () => clock,
    fail(error, edits = ["keepAlive"]) {
      failing = error === null ? null : { error, edits };
    },
    gate(g) {
      gate = g;
    },
    async record() {
      const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return l.value.units.get(UNIT);
    },
    keepAlives: () => fake.control.ledgerLog().filter((c) => c.message === `ledger: keepAlive ${UNIT} [skip ci]`).length,
  };
  return w;
}

/** Waits until the keeper ended on its own or reached the held sleep, then stops it. */
async function settle(w: World, holdAt?: number): Promise<void> {
  await until(() => w.keeper.end() !== null || (holdAt !== undefined && w.loopSleeps.length > holdAt));
  await w.keeper.stop();
}

const transient: ForgeError = { kind: "transient", message: "502" };

describe("startHeartbeat", () => {
  test("beats: a keepAlive every 5 min stamps heartbeat_at with the forge-time estimate", async () => {
    const w = world({ holdAt: 3 });
    await settle(w, 3);
    expect(w.keepAlives()).toBe(3);
    expect(w.loopSleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
    expect(await w.record()).toMatchObject({ state: "claimed", generation: 1, owner: "alice", heartbeat_at: forgeIso(T0 + 15 * MIN) });
    expect(w.keeper.signal.aborted).toBe(false);
    expect(w.keeper.end()).toBeNull();
  });

  test("beats while merging too", async () => {
    const w = world({
      holdAt: 1,
      onLoopSleep: (i, ww) => {
        if (i !== 0) return;
        const merging = rec({ state: "merging", pr: 7, passed_sha: "a".repeat(40) });
        ww.fake.control.writeForeignLedger({ message: "merging [skip ci]", writes: tip([merging]), deletes: [] });
      },
    });
    await settle(w, 1);
    expect(w.keepAlives()).toBe(1);
    expect(await w.record()).toMatchObject({ state: "merging", heartbeat_at: forgeIso(T0 + 5 * MIN) });
  });

  test.each([
    ["parked", rec({ state: "parked", park: { kind: "blocked", reason: "no-op", inbox_owner: "alice", globs_held: [] } })],
    ["released", rec({ state: "released", attempts: 1 })],
    ["merged", rec({ state: "merged", pr: 7 })],
  ] as const)("moved on: the lane's own steps left it %s, so the keeper stops with no abort and no write", async (_state, moved) => {
    const w = world({
      onLoopSleep: (i, ww) => {
        if (i === 0) ww.fake.control.writeForeignLedger({ message: "own step [skip ci]", writes: tip([moved]), deletes: [] });
      },
    });
    await settle(w);
    expect(w.keeper.end()?.kind).toBe("moved-on");
    expect(w.keeper.signal.aborted).toBe(false);
    expect(w.keepAlives()).toBe(0);
    expect(w.swaps).toEqual([]);
    expect(w.loopSleeps).toEqual([5 * MIN]);
    expect(await w.record()).toEqual(moved);
  });

  test.each([
    ["another lane at generation + 1", { writes: tip([rec({ owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2 })]), deletes: [] }],
    ["the same lane name at generation + 1", { writes: tip([rec({ generation: 2 })]), deletes: [] }],
    ["no record", { writes: {}, deletes: [unitPath(UNIT)] }],
  ] as const)("lost to %s: the signal aborts with lost and nothing more is written", async (_name, commit) => {
    let before = null as UnitRecord | undefined | null;
    const w = world({
      onLoopSleep: async (i, ww) => {
        if (i !== 0) return;
        // Read inside the first sleep, before the foreign write: a read after world() returns races it.
        before = await ww.record();
        ww.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: { ...commit.writes }, deletes: [...commit.deletes] });
      },
    });
    await settle(w);
    const end = w.keeper.end();
    expect(end?.kind).toBe("lost");
    expect(end?.message).toContain("lost");
    expect(w.keeper.signal.aborted).toBe(true);
    expect(w.keeper.signal.reason).toBe("lost");
    expect(w.keepAlives()).toBe(0);
    // The edit fails on the tip, so no swap is even tried.
    expect(w.swaps).toEqual([]);
    expect(w.loopSleeps).toEqual([5 * MIN]);
    expect(w.logs.some((l) => l.includes("lost"))).toBe(true);
    expect(before).toEqual(rec());
    const after = await w.record();
    if (commit.deletes.length > 0) expect(after).toBeUndefined();
    else expect(after?.generation).toBe(2);
  });

  test.each([
    ["transient", transient],
    ["not-fast-forward", { kind: "not-fast-forward", message: "nope" } as ForgeError],
    ["rejected (neither lane-stop nor back-off)", { kind: "rejected", message: "422" } as ForgeError],
  ] as const)("a %s beat failure is logged and retried after 60 s, then beats go on", async (_name, error) => {
    const w = world({
      holdAt: 2,
      onLoopSleep: (i, ww) => {
        if (i === 1) ww.fail(null);
      },
    });
    w.fail(error);
    await settle(w, 2);
    expect(w.loopSleeps).toEqual([5 * MIN, MIN, 5 * MIN]);
    expect(w.keepAlives()).toBe(1);
    expect(w.keeper.end()).toBeNull();
    expect(w.keeper.signal.aborted).toBe(false);
    expect(w.logs.some((l) => l.includes("beat failed") && l.includes("retrying in 60000 ms"))).toBe(true);
  });

  test.each(["auth", "forbidden", "uninstalled"] as const)(
    "a forge %s beat failure ends the keeper with stop forge-<kind>: the signal aborts, nothing is released",
    async (kind) => {
      const w = world();
      w.fail({ kind, message: "nope" } as ForgeError);
      await settle(w);
      const end = w.keeper.end();
      expect(end).toMatchObject({ kind: "stop", condition: `forge-${kind}` });
      expect(end?.message).toContain(kind);
      expect(w.keeper.signal.aborted).toBe(true);
      expect(w.keeper.signal.reason).toBe("stop");
      expect(w.loopSleeps).toEqual([5 * MIN]);
      expect(w.swaps).toEqual(["keepAlive"]);
      expect(await w.record()).toEqual(rec());
    },
  );

  test("a forge auth on the swap's snapshot ends the keeper with stop forge-auth too", async () => {
    const w = world();
    w.fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    await settle(w);
    expect(w.keeper.end()).toMatchObject({ kind: "stop", condition: "forge-auth" });
    expect(w.keeper.signal.reason).toBe("stop");
    expect(w.swaps).toEqual([]);
  });

  test("an edit stop (an unknown schema_version on the tip) ends the keeper with stop ledger-schema-version, never a throw", async () => {
    const w = world();
    const v2 = serializeUnitRecord(rec({ unit: "story:9.9" })).replace('"schema_version": 1', '"schema_version": 2');
    w.fake.control.writeForeignLedger({ message: "future [skip ci]", writes: { "units/story__9.9.json": v2 }, deletes: [] });
    await settle(w);
    expect(w.keeper.end()).toMatchObject({ kind: "stop", condition: "ledger-schema-version" });
    expect(w.keeper.signal.reason).toBe("stop");
    expect(w.loopSleeps).toEqual([5 * MIN]);
    expect(w.swaps).toEqual([]);
    expect(w.logs.some((l) => l.includes("the lane stops"))).toBe(true);
  });

  test("a rate-limited beat waits its retry_after when longer than 60 s", async () => {
    const w = world({ holdAt: 1 });
    w.fail({ kind: "rate-limited", message: "slow down", retry_after: 120 });
    await settle(w, 1);
    // The swap itself waited retry_after between its tries before giving up.
    expect(w.casSleeps.length).toBeGreaterThan(0);
    expect(w.casSleeps.every((ms) => ms === 120_000)).toBe(true);
    expect(w.loopSleeps).toEqual([5 * MIN, 2 * MIN]);
    expect(w.keeper.end()).toBeNull();
  });

  test("would lapse: failing beats until the next try could land 30 min after the claim release the unit, attempts unchanged", async () => {
    const w = world();
    w.fail(transient);
    await settle(w);
    const end = w.keeper.end();
    expect(end?.kind).toBe("released");
    expect(w.keeper.signal.aborted).toBe(true);
    expect(w.keeper.signal.reason).toBe("released");
    // Beats at 5, 6, …, 28 min; at 28 min, 60 s of retry plus the 60 s deadline reach 30 min.
    expect(w.loopSleeps).toEqual([5 * MIN, ...Array.from({ length: 23 }, () => MIN)]);
    expect(w.now()).toBe(T0 + 28 * MIN);
    const after = await w.record();
    expect(after).toMatchObject({ state: "released", attempts: 0, generation: 1, owner: "alice", heartbeat_at: forgeIso(T0 + 28 * MIN) });
    if (end?.kind === "released") expect(end.record).toEqual(after ?? null);
    expect(w.swaps.at(-1)).toBe("release");
    expect(w.swaps.filter((s) => s === "release")).toHaveLength(1);
  });

  test("would lapse after good beats: measured from the last good beat, not the claim", async () => {
    const w = world({
      onLoopSleep: (i, ww) => {
        // Beats at 5 and 10 min succeed; from 15 min on they fail.
        if (i === 2) ww.fail(transient);
      },
    });
    await settle(w);
    expect(w.keeper.end()?.kind).toBe("released");
    expect(w.keepAlives()).toBe(2);
    // Failures at 15, 16, …, 38 min; at 38 min, 60 s of retry plus the 60 s deadline reach 10 + 30 min.
    expect(w.loopSleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN, ...Array.from({ length: 23 }, () => MIN)]);
    expect(w.now()).toBe(T0 + 38 * MIN);
    expect(await w.record()).toMatchObject({ state: "released", attempts: 0, heartbeat_at: forgeIso(T0 + 38 * MIN) });
  });

  test("would lapse with a long retry_after: released at once", async () => {
    const w = world();
    // 9 waits of 3 min inside the swap: 5 + 27 min, past the stale age.
    w.fail({ kind: "rate-limited", message: "slow down", retry_after: 180 });
    await settle(w);
    expect(w.keeper.end()?.kind).toBe("released");
    expect(w.loopSleeps).toEqual([5 * MIN]);
    expect((await w.record())?.state).toBe("released");
  });

  test("the release on a lapse fails too: aborted with lapsed, the record left as it was", async () => {
    const w = world();
    w.fail(transient, ["keepAlive", "release"]);
    await settle(w);
    const end = w.keeper.end();
    expect(end?.kind).toBe("lapsed");
    expect(end?.message).toContain("release failed");
    expect(w.keeper.signal.reason).toBe("lapsed");
    expect(await w.record()).toEqual(rec());
  });

  test("a custom retryMs sets the wait after a failure", async () => {
    const w = world({ holdAt: 1, retryMs: 2 * MIN });
    w.fail(transient);
    await settle(w, 1);
    expect(w.loopSleeps).toEqual([5 * MIN, 2 * MIN]);
  });

  test("stop() mid-beat aborts no beat: it waits for the beat in flight, then the loop ends", async () => {
    let open: () => void = () => {};
    const w = world();
    w.gate(new Promise<void>((resolve) => (open = resolve)));
    await until(() => w.swaps.length === 1);
    let stopped = false;
    const stopping = w.keeper.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    w.gate(null);
    open();
    await stopping;
    expect(stopped).toBe(true);
    expect(w.keepAlives()).toBe(1);
    expect(w.loopSleeps).toEqual([5 * MIN]);
    expect(w.keeper.end()).toBeNull();
    expect(w.keeper.signal.aborted).toBe(false);
  });

  test("stop() during the sleep ends the loop with no beat", async () => {
    const w = world({ holdAt: 0 });
    await until(() => w.loopSleeps.length === 1);
    await w.keeper.stop();
    expect(w.swaps).toEqual([]);
    expect(w.keeper.end()).toBeNull();
  });
});

describe("startCoordinatorHeartbeat", () => {
  const claimRec = (over: Partial<CoordinatorRecord> = {}): CoordinatorRecord => ({
    schema_version: 1,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator",
    generation: 2,
    heartbeat_at: "2026-10-23T10:00:00Z",
    digest_posted_at: "2026-10-23T08:00:00Z",
    rulings_cursor: "r-1",
    ...over,
  });

  type CoordWorld = {
    readonly fake: FakeForge;
    readonly keeper: Heartbeat;
    readonly loopSleeps: number[];
    readonly swaps: string[];
    record(): Promise<CoordinatorRecord | null>;
    beats(): number;
  };

  function coordWorld(o: { readonly holdAt?: number; readonly failing?: boolean; readonly onLoopSleep?: (i: number, fake: FakeForge) => void } = {}): CoordWorld {
    const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", ledger: { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) } });
    let clock = T0;
    const loopSleeps: number[] = [];
    const swaps: string[] = [];
    let loopSignal: AbortSignal | null = null;
    const forge: Forge = {
      ...fake.forge,
      ledgerSwap: async (oldSha, commit, opts) => {
        swaps.push(editName(commit.message));
        if (o.failing === true) return { ok: false, error: transient };
        return fake.forge.ledgerSwap(oldSha, commit, opts);
      },
    };
    const sleep: Sleep = async (ms, signal) => {
      loopSignal ??= signal;
      if (signal !== loopSignal) {
        clock += ms;
        await tick();
        return;
      }
      await tick();
      const i = loopSleeps.length;
      loopSleeps.push(ms);
      if (o.holdAt !== undefined && i >= o.holdAt) return abortOf(signal);
      clock += ms;
      o.onLoopSleep?.(i, fake);
    };
    const keeper = startCoordinatorHeartbeat({
      forge,
      identity: COORD,
      generation: 2,
      clock: () => clock,
      forgeNow: () => forgeIso(clock),
      sleep,
      random: () => 0,
      log: () => {},
    });
    return {
      fake,
      keeper,
      loopSleeps,
      swaps,
      async record() {
        const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
        if (!s.ok) throw new Error(s.error.message);
        const l = parseLedger(s.value.ledger.files);
        if (!l.ok) throw new Error(l.error.message);
        return l.value.coordinator;
      },
      beats: () => fake.control.ledgerLog().filter((c) => c.message === "ledger: keepCoordinator coordinator [skip ci]").length,
    };
  }

  const settleC = async (w: CoordWorld, holdAt?: number): Promise<void> => {
    await until(() => w.keeper.end() !== null || (holdAt !== undefined && w.loopSleeps.length > holdAt));
    await w.keeper.stop();
  };

  test("beats: keepCoordinator every 5 min stamps heartbeat_at only, at the same generation", async () => {
    const w = coordWorld({ holdAt: 2 });
    await settleC(w, 2);
    expect(w.beats()).toBe(2);
    expect(w.loopSleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN]);
    expect(await w.record()).toEqual(claimRec({ heartbeat_at: forgeIso(T0 + 10 * MIN) }));
    expect(w.keeper.end()).toBeNull();
    expect(w.keeper.signal.aborted).toBe(false);
  });

  test.each([
    ["another identity took it over", claimRec({ owner: "dave", host: "44444444-4444-4444-8444-444444444444", generation: 3 })],
    ["the same identity at another generation", claimRec({ generation: 3 })],
  ] as const)("lost: %s, so the signal aborts with lost and nothing is written", async (_name, foreign) => {
    const w = coordWorld({
      onLoopSleep: (i, fake) => {
        if (i === 0) fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(foreign) }, deletes: [] });
      },
    });
    await settleC(w);
    expect(w.keeper.end()?.kind).toBe("lost");
    expect(w.keeper.end()?.message).toContain("the coordinator claim is lost");
    expect(w.keeper.signal.reason).toBe("lost");
    expect(w.beats()).toBe(0);
    expect(w.swaps).toEqual([]);
    expect(await w.record()).toEqual(foreign);
  });

  test("lost: coordinator.json deleted", async () => {
    const w = coordWorld({
      onLoopSleep: (i, fake) => {
        if (i === 0) fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: {}, deletes: [COORDINATOR_PATH] });
      },
    });
    await settleC(w);
    expect(w.keeper.end()?.kind).toBe("lost");
  });

  test("lapsed: failing beats until the next try could land past the stale age abort with lapsed; nothing is released", async () => {
    const w = coordWorld({ failing: true });
    await settleC(w);
    const end = w.keeper.end();
    expect(end?.kind).toBe("lapsed");
    expect(w.keeper.signal.reason).toBe("lapsed");
    expect(w.loopSleeps).toEqual([5 * MIN, ...Array.from({ length: 23 }, () => MIN)]);
    expect(w.swaps.every((s) => s === "keepCoordinator")).toBe(true);
    expect(await w.record()).toEqual(claimRec());
  });

  test("a forge auth beat ends the coordinator keeper with stop forge-auth", async () => {
    const w = coordWorld();
    w.fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    await settleC(w);
    expect(w.keeper.end()).toMatchObject({ kind: "stop", condition: "forge-auth" });
    expect(w.keeper.signal.reason).toBe("stop");
    expect(await w.record()).toEqual(claimRec());
  });
});
