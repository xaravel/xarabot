import { describe, expect, test } from "bun:test";
import { checkPid, commandMatches, coordinatorTrailingWaitMs, trailingWaitMs, usageLimitSleepMs, type CheckPidParams, type PidCheck } from "../../../src/core/lane/waits.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-23T10:00:00.000Z");

describe("trailingWaitMs", () => {
  test.each([
    ["progress", MIN],
    ["idle", 30 * MIN],
    ["failed", 15 * MIN],
    ["stop", null],
  ] as const)("%s → %p", (outcome, ms) => {
    expect(trailingWaitMs(outcome)).toBe(ms);
  });
});

describe("coordinatorTrailingWaitMs", () => {
  test.each([
    ["progress", MIN],
    ["idle", 10 * MIN],
    ["failed", 15 * MIN],
    ["stop", null],
  ] as const)("%s → %p", (outcome, ms) => {
    expect(coordinatorTrailingWaitMs(outcome)).toBe(ms);
  });
});

describe("usageLimitSleepMs", () => {
  test.each([
    ["reset in 1 min", NOW + MIN, 3 * MIN],
    ["reset now", NOW, 2 * MIN],
    ["reset 2 min ago", NOW - 2 * MIN, 0],
    ["reset long ago", NOW - 5 * HOUR, 0],
    ["reset in 20 h", NOW + 20 * HOUR, 8 * HOUR],
    ["reset in 7 h 58 min", NOW + 7 * HOUR + 58 * MIN, 8 * HOUR],
    ["reset in 7 h 59 min", NOW + 7 * HOUR + 59 * MIN, 8 * HOUR],
    ["reset in 7 h", NOW + 7 * HOUR, 7 * HOUR + 2 * MIN],
    ["unparsed", null, 15 * MIN],
  ] as const)("%s", (_name, resetAt, ms) => {
    expect(usageLimitSleepMs(resetAt, NOW)).toBe(ms);
  });
});

describe("commandMatches", () => {
  test.each([
    ["sleep", "sleep 60", false, true],
    ["sleep", "/bin/sleep 60", true, true],
    ["sleep", "  sleep   60  ", true, true],
    ["sleep", "cat sleep", false, true],
    ["sleep", "cat sleep", true, false],
    ["sleep", "cat /tmp/sleeper", false, false],
    ["claude", "sandbox-exec -f /tmp/p.sb /usr/local/bin/claude -p", false, true],
    ["claude", "sandbox-exec -f /tmp/p.sb /usr/local/bin/claude -p", true, false],
    ["bun", "/Users/x/.bun/bin/bun /Users/x/.xarabot/runner/0.1.0/src/cli/main.ts lane run", false, true],
    ["", "sleep 60", false, false],
    ["sleep", "", false, false],
  ] as const)("%s in %j (first %p) → %p", (command, args, first, expected) => {
    expect(commandMatches(command, args, first)).toBe(expected);
  });
});

describe("checkPid", () => {
  const base: CheckPidParams = { command: "sleep", writtenMs: NOW, info: { startMs: NOW - 500, args: "sleep 60" }, first: true };
  test.each([
    ["a live sleep started before the write", base, "ok"],
    ["started in the same second", { ...base, info: { startMs: NOW + 1000, args: "sleep 60" } }, "ok"],
    ["no process", { ...base, info: null }, "gone"],
    ["started more than 1 s after the write", { ...base, info: { startMs: NOW + 1001, args: "sleep 60" } }, "started-later"],
    ["started later and another command", { ...base, info: { startMs: NOW + 5000, args: "cat" } }, "started-later"],
    ["another command", { ...base, info: { startMs: NOW - 500, args: "cat /tmp/x" } }, "command"],
    ["the command only as an argument, first", { ...base, info: { startMs: NOW - 500, args: "cat sleep" } }, "command"],
    ["the command as an argument, any word", { ...base, first: false, info: { startMs: NOW - 500, args: "cat sleep" } }, "ok"],
  ] as const)("%s → %s", (_name, params, expected: PidCheck) => {
    expect(checkPid(params)).toBe(expected);
  });
});
