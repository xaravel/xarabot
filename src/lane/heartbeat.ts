import { HEARTBEAT_MS, HEARTBEAT_RETRY_MS, heartbeatRetryMs, wouldLapse } from "../core/lane/heartbeat.ts";
import { COORDINATOR_PATH } from "../core/ledger/codec.ts";
import { keepAlive, keepCoordinator, release, STALE_AFTER_MS, type LedgerCommit, type LedgerEdit } from "../core/ledger/edits.ts";
import type { LaneIdentity, UnitRecord } from "../core/schemas/ledger.ts";
import { isLaneStopKind, type Forge } from "../ports/forge.ts";
import { DEFAULT_CALL_TIMEOUT_MS, writtenRecord } from "./lane-process.ts";
import { defaultSleep, swapLedger, type Sleep, type SwapLedgerOutcome } from "./ledger-cas.ts";

/**
 * The heartbeat keeper (FR3, AR7, AR33): one per claimed unit, from the claim
 * until the lane process ends. Every `everyMs` it swaps `heartbeat_at` with a
 * `keepAlive` edit, which needs the lane's own `owner/host/lane` and
 * `generation`, so each beat also fences.
 *
 * - The record moved on by the lane's own steps (parked, released, merged):
 *   the keeper stops quietly, with no abort and no write.
 * - The record lost (another holder, another generation, no record): it
 *   aborts its signal with `lost` and writes nothing more.
 * - A beat whose swap fails with a forge lane-stop kind (`auth`, `forbidden`,
 *   `uninstalled`) or with the edit error `stop` (an unknown ledger
 *   `schema_version`): it aborts its signal with `stop`, naming the alert
 *   `condition` (`forge-<kind>` or `ledger-schema-version`), and writes
 *   nothing more. The lane stops; the record is left as it is.
 * - A failed beat retries after `retryMs`, or the forge's `retry_after` when
 *   longer. When the next try could land at or past the stale age since the
 *   last good beat, it releases the unit (no attempt counted) and aborts with
 *   `released`; if that release fails, with `lapsed`.
 *
 * It is a `sleep` loop, so beats never overlap, and it never throws.
 */

export type KeeperEnd =
  | { readonly kind: "lost"; readonly message: string }
  | { readonly kind: "released"; readonly message: string; readonly record: UnitRecord | null }
  | { readonly kind: "lapsed"; readonly message: string }
  /** A beat met a lane-stop condition: `condition` is `forge-<kind>` or `ledger-schema-version`. */
  | { readonly kind: "stop"; readonly condition: string; readonly message: string }
  /** The lane's own steps moved the record on; the signal is not aborted. */
  | { readonly kind: "moved-on"; readonly message: string };

export type HeartbeatParams = {
  readonly forge: Forge;
  readonly identity: LaneIdentity;
  readonly unit: string;
  readonly generation: number;
  /** The host clock in epoch ms. */
  readonly clock: () => number;
  /** The forge time to stamp: the last forge `now` seen, advanced by the host time since. */
  readonly forgeNow: () => string;
  /** Default `HEARTBEAT_MS` (5 min). */
  readonly everyMs?: number;
  /** Default `HEARTBEAT_RETRY_MS` (60 s). */
  readonly retryMs?: number;
  /** Each swap's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The loop's waits and the swaps' back-off. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** The host time of the claim, the first good beat; default `clock()` at start. */
  readonly claimedMs?: number;
  readonly log: (text: string) => void;
};

export type Heartbeat = {
  /** Aborted (with the end's kind as its reason) when the unit is lost, released or lapsed, or the lane stops. */
  readonly signal: AbortSignal;
  /** How the keeper ended, or `null` while it runs or after a plain `stop()`. */
  end(): KeeperEnd | null;
  /** Ends the loop: aborts its sleep and awaits the beat in flight. */
  stop(): Promise<void>;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function startHeartbeat(params: HeartbeatParams): Heartbeat {
  const { identity, unit, generation } = params;
  return startKeeper({
    ...params,
    what: unit,
    beat: (now) => keepAlive({ unit, by: identity, now, generation }),
    release: {
      edit: (now) => release({ unit, by: identity, now, generation }),
      record: (commit) => writtenRecord(commit, unit),
    },
  });
}

/** The coordinator keeper's parameters: `HeartbeatParams` for `coordinator.json`, at the claim's generation. */
export type CoordinatorHeartbeatParams = Omit<HeartbeatParams, "unit">;

/**
 * The `coordinator.json` keeper (FR4, AD-8): the unit keeper's timing and
 * lapse rule, beating `keepCoordinator` at the claim's generation. It never
 * releases: a lost claim aborts its signal with `lost`, and a heartbeat
 * about to lapse aborts it with `lapsed`.
 */
export function startCoordinatorHeartbeat(params: CoordinatorHeartbeatParams): Heartbeat {
  const { identity, generation } = params;
  return startKeeper({ ...params, what: COORDINATOR_PATH, beat: (now) => keepCoordinator({ by: identity, now, generation }), release: null });
}

type KeeperParams = Omit<HeartbeatParams, "unit" | "identity"> & {
  /** What the keeper keeps, for its log lines. */
  readonly what: string;
  /** One beat at forge time `now`; a `null` commit means the record moved on. */
  readonly beat: (now: string) => LedgerEdit;
  /** The release on a lapse and the record it wrote, or `null` for none (the end is `lapsed`). */
  readonly release: { readonly edit: (now: string) => LedgerEdit; readonly record: (commit: LedgerCommit | null) => UnitRecord | null } | null;
};

function startKeeper(params: KeeperParams): Heartbeat {
  const { forge, what, clock } = params;
  const everyMs = params.everyMs ?? HEARTBEAT_MS;
  const retryMs = params.retryMs ?? HEARTBEAT_RETRY_MS;
  const callTimeoutMs = params.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = params.sleep ?? defaultSleep;
  const lost = new AbortController();
  const stopping = new AbortController();
  let ended: KeeperEnd | null = null;

  const log = (text: string): void => {
    try {
      params.log(`heartbeat: ${text}`);
    } catch {
      // A log that cannot be written never ends the keeper.
    }
  };

  const finish = (end: KeeperEnd): void => {
    ended = end;
    log(end.message);
    if (end.kind !== "moved-on") lost.abort(end.kind);
  };

  const swap = async (edit: LedgerEdit): Promise<SwapLedgerOutcome> => {
    try {
      return await swapLedger({
        forge,
        edit,
        signal: AbortSignal.timeout(callTimeoutMs),
        sleep,
        ...(params.random !== undefined ? { random: params.random } : {}),
      });
    } catch (e) {
      return { ok: false, error: { kind: "deadline", message: `ledger swap threw: ${message(e)}`, tries: 0 } };
    }
  };

  /** The keeper's lapse release: no attempt counted. With no release, the end is `lapsed`. */
  const releaseUnit = async (why: string): Promise<void> => {
    const rel = params.release;
    if (rel === null) {
      finish({ kind: "lapsed", message: `${what} lapsed: ${why}` });
      return;
    }
    const r = await swap(rel.edit(params.forgeNow()));
    if (r.ok) {
      finish({ kind: "released", message: `${what} released: ${why}`, record: rel.record(r.value.commit) });
      return;
    }
    finish({ kind: "lapsed", message: `${what} lapsed: ${why}; the release failed: ${r.error.message}` });
  };

  const loop = async (): Promise<void> => {
    let lastGood = params.claimedMs ?? clock();
    let delay = everyMs;
    for (;;) {
      if (stopping.signal.aborted) return;
      await sleep(delay, stopping.signal);
      if (stopping.signal.aborted) return;
      // The host time of this beat's stamp, taken before the swap: a slow swap never moves the baseline later.
      const at = clock();
      const r = await swap(params.beat(params.forgeNow()));
      if (r.ok) {
        if (r.value.commit === null) {
          finish({ kind: "moved-on", message: `${what} moved on at generation ${params.generation}; the keeper stops` });
          return;
        }
        lastGood = at;
        delay = everyMs;
        continue;
      }
      const e = r.error;
      if (e.kind === "edit" && e.edit === "precondition") {
        finish({ kind: "lost", message: `${what} lost: ${e.message}` });
        return;
      }
      if (e.kind === "forge" && isLaneStopKind(e.forge.kind)) {
        finish({ kind: "stop", condition: `forge-${e.forge.kind}`, message: `${what}: beat failed: forge ${e.forge.kind}: ${e.message}; the lane stops` });
        return;
      }
      if (e.kind === "edit" && e.edit === "stop") {
        finish({ kind: "stop", condition: "ledger-schema-version", message: `${what}: beat failed: ${e.message}; the lane stops` });
        return;
      }
      if (stopping.signal.aborted) return;
      const retryAfter = e.kind === "exhausted" && e.last.kind === "rate-limited" ? e.last.retry_after : null;
      delay = heartbeatRetryMs(retryMs, retryAfter);
      const failure = `beat failed: ${e.kind}${e.kind === "edit" ? ` ${e.edit}` : ""}: ${e.message}`;
      if (wouldLapse({ lastBeatMs: lastGood, nowMs: clock(), delayMs: delay, callTimeoutMs, staleAfterMs: STALE_AFTER_MS })) {
        log(`${failure}; the next try could land after the heartbeat lapses`);
        await releaseUnit(`the heartbeat would lapse (last good beat ${new Date(lastGood).toISOString()} host time)`);
        return;
      }
      log(`${failure}; retrying in ${delay} ms`);
    }
  };

  const running = loop().catch((e: unknown) => {
    // Never reached by design; a keeper that throws stops beating, which the stale age covers.
    log(`keeper threw: ${message(e)}`);
  });

  return {
    signal: lost.signal,
    end: () => ended,
    async stop() {
      stopping.abort();
      await running;
    },
  };
}
