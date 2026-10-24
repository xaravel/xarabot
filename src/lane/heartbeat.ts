import { HEARTBEAT_MS, HEARTBEAT_RETRY_MS, heartbeatRetryMs, wouldLapse } from "../core/lane/heartbeat.ts";
import { keepAlive, release, STALE_AFTER_MS, type LedgerEdit } from "../core/ledger/edits.ts";
import type { LaneIdentity, UnitRecord } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
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
  /** Aborted (with the end's kind as its reason) when the unit is lost, released or lapsed. */
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
  const { forge, identity, unit, generation, clock } = params;
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

  /** The keeper's lapse release: no attempt counted. */
  const releaseUnit = async (why: string): Promise<void> => {
    const r = await swap(release({ unit, by: identity, now: params.forgeNow(), generation }));
    if (r.ok) {
      finish({ kind: "released", message: `${unit} released: ${why}`, record: writtenRecord(r.value.commit, unit) });
      return;
    }
    finish({ kind: "lapsed", message: `${unit} lapsed: ${why}; the release failed: ${r.error.message}` });
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
      const r = await swap(keepAlive({ unit, by: identity, now: params.forgeNow(), generation }));
      if (r.ok) {
        if (r.value.commit === null) {
          finish({ kind: "moved-on", message: `${unit} moved on at generation ${generation}; the keeper stops` });
          return;
        }
        lastGood = at;
        delay = everyMs;
        continue;
      }
      const e = r.error;
      if (e.kind === "edit" && e.edit === "precondition") {
        finish({ kind: "lost", message: `${unit} lost: ${e.message}` });
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
