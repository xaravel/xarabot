import { MINUTE_MS } from "./waits.ts";

/**
 * The heartbeat keeper's timing (FR3, AR7, AR33). Pure.
 */

/** How often the keeper stamps `heartbeat_at`. */
export const HEARTBEAT_MS = 5 * MINUTE_MS;
/** The wait after a failed beat, unless the forge asks for longer. */
export const HEARTBEAT_RETRY_MS = MINUTE_MS;

export type LapseParams = {
  /** The host time of the last good beat (or the claim). */
  readonly lastBeatMs: number;
  /** The host time now. */
  readonly nowMs: number;
  /** The wait before the next try. */
  readonly delayMs: number;
  /** The next try's own deadline. */
  readonly callTimeoutMs: number;
  /** How old a heartbeat is when the record goes stale. */
  readonly staleAfterMs: number;
};

/**
 * Whether the next try, landing at the end of its deadline, would come at or
 * after the record goes stale: `now + delay + deadline ≥ last good beat + stale`.
 */
export function wouldLapse(p: LapseParams): boolean {
  return p.nowMs + p.delayMs + p.callTimeoutMs >= p.lastBeatMs + p.staleAfterMs;
}

/** The wait after a failed beat: `retryMs`, or the forge's `retry_after` (seconds) when longer. */
export function heartbeatRetryMs(retryMs: number, retryAfterSeconds: number | null): number {
  return retryAfterSeconds === null ? retryMs : Math.max(retryMs, retryAfterSeconds * 1000);
}
