import { describe, expect, test } from "bun:test";
import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import { claim, deleteMerged, type LedgerEdit } from "../../src/core/ledger/edits.ts";
import { ok } from "../../src/core/result.ts";
import { CAS_MAX_TRIES, defaultSleep, jitterDelay, swapLedger, type Sleep } from "../../src/lane/ledger-cas.ts";
import { ALICE, BOB, COORD, NOW, rec, tip } from "../core/ledger/fixtures.ts";

const claimAlice: LedgerEdit = claim({ unit: "story:1.5", by: ALICE, now: NOW, globs: ["src/core/ledger/**"], expectGeneration: null });

function recorder(onSleep?: (n: number) => void): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
      onSleep?.(waits.length);
    },
  };
}

/** A foreign commit holding another lane's claim on `story:2.<n>`. */
function foreign(n: number) {
  const r = rec({ unit: `story:2.${n}`, owner: BOB.owner, host: BOB.host, lane: BOB.lane, globs: [`src/other${n}/**`] });
  return { message: `bob ${n} [skip ci]`, writes: tip([r]), deletes: [] };
}

describe("swapLedger", () => {
  test("retries over 3 foreign commits and applies the edit on the latest tip on try 4", async () => {
    const { forge, control } = createFakeForge();
    control.beforeSwap(({ n }) => {
      if (n <= 3) control.writeForeignLedger(foreign(n));
    });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep, random: () => 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tries).toBe(4);
    expect(r.value.commit).not.toBeNull();
    expect(waits).toEqual([50, 100, 200]);
    const log = control.ledgerLog();
    expect(log).toHaveLength(5);
    expect(log[4]?.sha).toBe(r.value.tip);
    expect(log[4]?.parent).toBe(log[3]?.sha as string);
    const s = await forge.snapshot({ signal: new AbortController().signal });
    if (!s.ok) throw new Error(s.error.message);
    const ledger = parseLedger(s.value.ledger.files);
    if (!ledger.ok) throw new Error(ledger.error.message);
    expect([...ledger.value.units.keys()].sort()).toEqual(["story:1.5", "story:2.1", "story:2.2", "story:2.3"]);
    expect(ledger.value.units.get("story:1.5")?.owner).toBe("alice");
  });

  test("a foreign claim of the unit is an edit failure, not retried", async () => {
    const { forge, control } = createFakeForge();
    control.beforeSwap(({ n }) => {
      if (n === 1) {
        const bobs = rec({ owner: BOB.owner, host: BOB.host, lane: BOB.lane });
        control.writeForeignLedger({ message: "bob claims [skip ci]", writes: tip([bobs]), deletes: [] });
      }
    });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep, random: () => 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("edit");
    if (r.error.kind === "edit") expect(r.error.edit).toBe("precondition");
    expect(r.error.tries).toBe(2);
    expect(waits).toHaveLength(1);
  });

  test("conflict on every try is exhausted after exactly 10 tries with capped jitter", async () => {
    const { forge, control } = createFakeForge();
    let swaps = 0;
    control.beforeSwap(({ n }) => {
      swaps = n;
      control.writeForeignLedger({ message: `noise ${n}`, writes: { [`noise/${n}.txt`]: "x" }, deletes: [] });
    });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep, random: () => 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("exhausted");
    expect(r.error.tries).toBe(CAS_MAX_TRIES);
    if (r.error.kind === "exhausted") expect(r.error.last.kind).toBe("conflict");
    expect(swaps).toBe(10);
    expect(waits).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000]);
  });

  test("maxTries bounds the loop", async () => {
    const { forge, control } = createFakeForge();
    control.beforeSwap(({ n }) => {
      control.writeForeignLedger({ message: `noise ${n}`, writes: { [`noise/${n}.txt`]: "x" }, deletes: [] });
    });
    const { sleep } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep, maxTries: 3 });
    expect(r.ok ? "ok" : [r.error.kind, r.error.tries]).toEqual(["exhausted", 3]);
  });

  test("a signal aborting mid-loop is deadline", async () => {
    const { forge, control } = createFakeForge();
    control.beforeSwap(({ n }) => {
      control.writeForeignLedger({ message: `noise ${n}`, writes: { [`noise/${n}.txt`]: "x" }, deletes: [] });
    });
    const ac = new AbortController();
    const { sleep, waits } = recorder((n) => {
      if (n === 2) ac.abort();
    });
    const r = await swapLedger({ forge, edit: claimAlice, signal: ac.signal, sleep, random: () => 0 });
    expect(r.ok ? "ok" : [r.error.kind, r.error.tries]).toEqual(["deadline", 2]);
    expect(waits).toHaveLength(2);
  });

  test("an already-aborted signal is deadline before any forge call", async () => {
    const { forge, control } = createFakeForge();
    const r = await swapLedger({ forge, edit: claimAlice, signal: AbortSignal.abort() });
    expect(r.ok ? "ok" : [r.error.kind, r.error.tries]).toEqual(["deadline", 0]);
    expect(control.trace()).toEqual([]);
  });

  test("auth on swap is a forge failure, not retried", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("ledgerSwap", { kind: "auth", message: "token revoked" });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("forge");
    if (r.error.kind === "forge") expect(r.error.forge).toEqual({ kind: "auth", message: "token revoked" });
    expect(r.error.tries).toBe(1);
    expect(waits).toEqual([]);
    expect(control.ledgerLog()).toHaveLength(1);
  });

  test.each(["forbidden", "uninstalled", "not-found"] as const)("%s on snapshot is a forge failure", async (k) => {
    const { forge, control } = createFakeForge();
    control.injectError("snapshot", { kind: k, message: k });
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep });
    expect(r.ok ? "ok" : [r.error.kind, r.error.tries]).toEqual(["forge", 1]);
  });

  test("rate-limited waits retry_after seconds and counts as a try", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("snapshot", { kind: "rate-limited", message: "slow", retry_after: 3 });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep, random: () => 0.5 });
    expect(r.ok ? r.value.tries : r.error.kind).toBe(2);
    expect(waits).toEqual([3000]);
  });

  test("not-fast-forward on swap is a forge failure, not retried", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("ledgerSwap", { kind: "not-fast-forward", message: "nff" });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep });
    expect(r.ok ? "ok" : [r.error.kind, r.error.tries]).toEqual(["forge", 1]);
    expect(waits).toEqual([]);
  });

  test("a non-retried error arriving as the signal aborts is still a forge failure", async () => {
    const { forge, control } = createFakeForge();
    const ac = new AbortController();
    const swap = forge.ledgerSwap.bind(forge);
    const racing = {
      ...forge,
      ledgerSwap: async (...args: Parameters<typeof forge.ledgerSwap>) => {
        const r = await swap(...args);
        ac.abort();
        return r;
      },
    };
    control.injectError("ledgerSwap", { kind: "auth", message: "token revoked" });
    const r = await swapLedger({ forge: racing, edit: claimAlice, signal: ac.signal, sleep: recorder().sleep });
    expect(ac.signal.aborted).toBe(true);
    expect(r.ok ? "ok" : [r.error.kind, r.error.tries]).toEqual(["forge", 1]);
    if (!r.ok && r.error.kind === "forge") expect(r.error.forge.kind).toBe("auth");
  });

  test("transient on swap backs off with jitter and retries", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("ledgerSwap", { kind: "transient", message: "transient" });
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep, random: () => 0.25 });
    expect(r.ok ? r.value.tries : r.error.kind).toBe(2);
    expect(waits).toEqual([25]);
  });

  test("an edit returning null is ok with commit null and no swap", async () => {
    const { forge, control } = createFakeForge();
    let swapped = false;
    control.beforeSwap(() => {
      swapped = true;
    });
    const noop: LedgerEdit = () => ok(null);
    const r = await swapLedger({ forge, edit: noop, signal: new AbortController().signal });
    expect(r).toEqual({ ok: true, value: { tip: control.ledgerLog()[0]?.sha as string, commit: null, tries: 1 } });
    expect(swapped).toBe(false);
    expect(control.ledgerLog()).toHaveLength(1);
  });

  test("an uncontended swap succeeds on try 1 with no sleep", async () => {
    const { forge, control } = createFakeForge();
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep });
    expect(r.ok ? r.value.tries : r.error.kind).toBe(1);
    expect(waits).toEqual([]);
    expect(control.ledgerLog()).toHaveLength(2);
  });

  test("lost ack: a swap that lands but reports transient is ok on the next try without a second write", async () => {
    const { forge, control } = createFakeForge();
    const swap = forge.ledgerSwap.bind(forge);
    let swaps = 0;
    const lossy = {
      ...forge,
      ledgerSwap: async (...args: Parameters<typeof forge.ledgerSwap>) => {
        swaps += 1;
        const r = await swap(...args);
        return swaps === 1 && r.ok ? ({ ok: false, error: { kind: "transient", message: "ack lost" } } as const) : r;
      },
    };
    const { sleep, waits } = recorder();
    const r = await swapLedger({ forge: lossy, edit: claimAlice, signal: new AbortController().signal, sleep, random: () => 0.5 });
    const log = control.ledgerLog();
    expect(log).toHaveLength(2);
    expect(swaps).toBe(1);
    expect(waits).toEqual([50]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tries).toBe(2);
    expect(r.value.tip).toBe(log[1]?.sha as string);
    expect(r.value.commit?.message).toBe(log[1]?.message as string);
  });

  test("lost ack: a delete-only swap that lands but reports transient is ok with its commit", async () => {
    const { forge, control } = createFakeForge();
    control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([rec({ state: "merged" })]), deletes: [] });
    const swap = forge.ledgerSwap.bind(forge);
    let swaps = 0;
    let attempted: Parameters<typeof forge.ledgerSwap>[1] | undefined;
    const lossy = {
      ...forge,
      ledgerSwap: async (...args: Parameters<typeof forge.ledgerSwap>) => {
        swaps += 1;
        attempted = args[1];
        const r = await swap(...args);
        return swaps === 1 && r.ok ? ({ ok: false, error: { kind: "transient", message: "ack lost" } } as const) : r;
      },
    };
    const edit = deleteMerged({ unit: "story:1.5", by: COORD, now: NOW });
    const r = await swapLedger({ forge: lossy, edit, signal: new AbortController().signal, sleep: recorder().sleep });
    expect(swaps).toBe(1);
    expect(control.ledgerLog()).toHaveLength(3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(attempted?.deletes).toEqual(["units/story__1.5.json"]);
    expect(r.value.commit).toEqual(attempted as NonNullable<typeof attempted>);
    expect(r.value.tries).toBe(2);
    expect(r.value.tip).toBe(control.ledgerLog()[2]?.sha as string);
  });

  test("lost ack check: a transient swap that did not land retries the edit", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("ledgerSwap", { kind: "transient", message: "timeout" });
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep });
    expect(r.ok ? [r.value.tries, r.value.commit === null] : r.error.kind).toEqual([2, false]);
    expect(control.ledgerLog()).toHaveLength(2);
  });

  test("lost ack check: a foreign commit after a transient swap is not taken for it", async () => {
    const { forge, control } = createFakeForge();
    let swaps = 0;
    const flaky = {
      ...forge,
      ledgerSwap: async (...args: Parameters<typeof forge.ledgerSwap>) => {
        swaps += 1;
        if (swaps === 1) {
          control.writeForeignLedger(foreign(1));
          return { ok: false, error: { kind: "transient", message: "timeout" } } as const;
        }
        return forge.ledgerSwap(...args);
      },
    };
    const r = await swapLedger({ forge: flaky, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep });
    expect(r.ok ? r.value.tries : r.error.kind).toBe(2);
    expect(swaps).toBe(2);
    expect(control.ledgerLog()).toHaveLength(3);
  });

  /** The fake's snapshot calls so far: each one reads the ledger first. */
  const snapshots = (control: ReturnType<typeof createFakeForge>["control"]): number => control.trace().filter((t) => t === "ledger").length;

  test("reconcile: a swap that lands but loses its ack at the deadline is ok with our commit", async () => {
    const { forge, control } = createFakeForge();
    control.loseSwapAck();
    const ac = new AbortController();
    // The deadline passes during the back-off after the lost ack.
    const sleep: Sleep = async () => ac.abort();
    const r = await swapLedger({ forge, edit: claimAlice, signal: ac.signal, sleep });
    const log = control.ledgerLog();
    expect(log).toHaveLength(2);
    expect(snapshots(control)).toBe(2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tip).toBe(log[1]?.sha as string);
    expect(r.value.commit?.message).toBe(log[1]?.message as string);
    expect(r.value.tries).toBe(1);
  });

  test("reconcile: a lost ack on the last try is ok", async () => {
    const { forge, control } = createFakeForge();
    control.loseSwapAck();
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep, maxTries: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.commit).not.toBeNull();
    expect(r.value.tip).toBe(control.ledgerLog()[1]?.sha as string);
    expect(snapshots(control)).toBe(2);
  });

  test("reconcile: a transient swap that did not land is exhausted after exactly one extra snapshot", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("ledgerSwap", { kind: "transient", message: "timeout" });
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep, maxTries: 1 });
    expect(r.ok ? "ok" : r.error.kind).toBe("exhausted");
    expect(snapshots(control)).toBe(2);
    expect(control.ledgerLog()).toHaveLength(1);
  });

  test("reconcile: a failed reconciling read returns the original error", async () => {
    const { forge, control } = createFakeForge();
    control.loseSwapAck();
    // The swap lands and loses its ack; the next snapshot, the reconciling one, fails.
    control.beforeSwap(() => control.injectError("snapshot", { kind: "transient", message: "snapshot: down" }));
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep, maxTries: 1 });
    expect(r.ok ? "ok" : [r.error.kind, r.error.message]).toEqual(["exhausted", "ledger swap: gave up after 1 tries: ledgerSwap: ack lost"]);
    expect(control.ledgerLog()).toHaveLength(2);
  });

  test("reconcile: a reconciling read that throws returns the original error", async () => {
    const { forge, control } = createFakeForge();
    let snaps = 0;
    const throwing = {
      ...forge,
      snapshot: (o: Parameters<typeof forge.snapshot>[0]) => {
        snaps += 1;
        if (snaps === 2) throw new Error("boom");
        return forge.snapshot(o);
      },
    };
    control.loseSwapAck();
    const r = await swapLedger({ forge: throwing, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep, maxTries: 1 });
    expect(r.ok ? "ok" : r.error.kind).toBe("exhausted");
    expect(snaps).toBe(2);
  });

  test("reconcile: the reconciling read runs under its own deadline, not the aborted caller's", async () => {
    const { forge, control } = createFakeForge();
    control.loseSwapAck();
    const ac = new AbortController();
    const signals: AbortSignal[] = [];
    const watched = {
      ...forge,
      snapshot: (o: Parameters<typeof forge.snapshot>[0]) => {
        signals.push(o.signal);
        return forge.snapshot(o);
      },
    };
    const r = await swapLedger({ forge: watched, edit: claimAlice, signal: ac.signal, sleep: async () => ac.abort(), reconcileMs: 1_000 });
    expect(r.ok).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(ac.signal);
    expect(signals[1]).not.toBe(ac.signal);
    expect(signals[1]?.aborted).toBe(false);
  });

  test("no reconcile without an unacked swap: a conflict exhausted on its last try takes no extra snapshot", async () => {
    const { forge, control } = createFakeForge();
    control.beforeSwap(({ n }) => {
      if (n === 1) control.writeForeignLedger(foreign(1));
    });
    const r = await swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, sleep: recorder().sleep, maxTries: 1 });
    expect(r.ok ? "ok" : r.error.kind).toBe("exhausted");
    expect(snapshots(control)).toBe(1);
  });

  test("maxTries must be a positive integer", async () => {
    const { forge } = createFakeForge();
    await expect(swapLedger({ forge, edit: claimAlice, signal: new AbortController().signal, maxTries: 0 })).rejects.toThrow(RangeError);
  });
});

describe("jitterDelay", () => {
  test("is random times min(5 s, 100 ms · 2^(try−1))", () => {
    expect([1, 2, 3, 6, 7, 10].map((t) => jitterDelay(t, () => 1))).toEqual([100, 200, 400, 3200, 5000, 5000]);
    expect(jitterDelay(4, () => 0.5)).toBe(400);
    expect(jitterDelay(4, () => 0)).toBe(0);
  });
});

describe("defaultSleep", () => {
  test("resolves after the delay, or at once when the signal aborts", async () => {
    const start = performance.now();
    await defaultSleep(5, new AbortController().signal);
    expect(performance.now() - start).toBeGreaterThanOrEqual(4);
    const ac = new AbortController();
    const pending = defaultSleep(60_000, ac.signal);
    ac.abort();
    await pending;
    await defaultSleep(60_000, AbortSignal.abort());
  });
});
