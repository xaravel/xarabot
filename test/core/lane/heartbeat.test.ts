import { describe, expect, test } from "bun:test";
import { HEARTBEAT_MS, HEARTBEAT_RETRY_MS, heartbeatRetryMs, wouldLapse, type LapseParams } from "../../../src/core/lane/heartbeat.ts";

const MIN = 60_000;
const STALE = 30 * MIN;
const T = Date.parse("2026-10-23T10:00:00.000Z");

describe("heartbeat timing", () => {
  test("a beat every 5 min, a retry after 60 s", () => {
    expect(HEARTBEAT_MS).toBe(5 * MIN);
    expect(HEARTBEAT_RETRY_MS).toBe(MIN);
  });
});

describe("wouldLapse", () => {
  const at = (over: Partial<LapseParams>): LapseParams => ({
    lastBeatMs: T,
    nowMs: T,
    delayMs: MIN,
    callTimeoutMs: MIN,
    staleAfterMs: STALE,
    ...over,
  });

  test.each([
    ["right after a good beat", at({}), false],
    ["the next try lands 1 ms before the stale age", at({ nowMs: T + 28 * MIN - 1 }), false],
    ["the next try lands exactly at the stale age", at({ nowMs: T + 28 * MIN }), true],
    ["the next try lands 1 ms after the stale age", at({ nowMs: T + 28 * MIN + 1 }), true],
    ["already stale", at({ nowMs: T + 31 * MIN }), true],
    ["a long retry_after makes a short gap lapse", at({ nowMs: T + 10 * MIN, delayMs: 19 * MIN }), true],
    ["the same gap with a 60 s retry holds", at({ nowMs: T + 10 * MIN }), false],
    ["the deadline counts: no delay, a 30 min deadline", at({ delayMs: 0, callTimeoutMs: STALE }), true],
    ["the deadline counts: no delay, a deadline 1 ms short", at({ delayMs: 0, callTimeoutMs: STALE - 1 }), false],
    ["exactly 30 min of delay alone", at({ delayMs: STALE, callTimeoutMs: 0 }), true],
    ["a host clock behind the last beat", at({ nowMs: T - 5 * MIN }), false],
  ] as const)("%s → %p", (_name, params, expected) => {
    expect(wouldLapse(params)).toBe(expected);
  });
});

describe("heartbeatRetryMs", () => {
  test.each([
    ["no retry_after", null, MIN],
    ["a shorter retry_after", 30, MIN],
    ["an equal retry_after", 60, MIN],
    ["a longer retry_after", 120, 2 * MIN],
    ["retry_after 0", 0, MIN],
  ] as const)("%s → %p ms", (_name, retryAfter, expected) => {
    expect(heartbeatRetryMs(MIN, retryAfter)).toBe(expected);
  });
});
