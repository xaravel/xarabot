import { describe, expect, test } from "bun:test";
import { describeStale, LANE_LOCK_FILE, laneLockText, lockVerdict, parseLaneLock, type LaneLock } from "../../../src/core/lane/lane-lock.ts";

const START = Date.parse("2026-10-23T10:00:00.250Z");
const LOCK: LaneLock = { pid: 4242, command: "bun", startedMs: START };
const TEXT = "4242\nbun\n2026-10-23T10:00:00.250Z\n";

describe("LANE_LOCK_FILE", () => {
  test("is lane.lock", () => {
    expect(LANE_LOCK_FILE).toBe("lane.lock");
  });
});

describe("laneLockText", () => {
  test.each([
    ["a lock", LOCK, TEXT],
    ["a fractional start is cut to the millisecond", { ...LOCK, startedMs: START + 0.875 }, TEXT],
    ["a whole-second start", { pid: 1, command: "xarabot-lane", startedMs: Date.parse("2026-10-23T10:00:00Z") }, "1\nxarabot-lane\n2026-10-23T10:00:00.000Z\n"],
  ] as const)("%s", (_name, lock, text) => {
    expect(laneLockText(lock)).toEqual({ ok: true, value: text });
  });

  test.each([
    ["PID 0", { ...LOCK, pid: 0 }],
    ["a negative PID", { ...LOCK, pid: -1 }],
    ["a fractional PID", { ...LOCK, pid: 1.5 }],
    ["an empty command", { ...LOCK, command: "" }],
    ["a command with a slash", { ...LOCK, command: "/usr/bin/bun" }],
    ["a command with a newline", { ...LOCK, command: "bun\nx" }],
    ["a NaN start", { ...LOCK, startedMs: Number.NaN }],
    ["an infinite start", { ...LOCK, startedMs: Number.POSITIVE_INFINITY }],
    ["a start out of Date's range", { ...LOCK, startedMs: 9e15 }],
  ] as const)("%s is invalid", (_name, lock) => {
    const r = laneLockText(lock);
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });
});

describe("parseLaneLock", () => {
  test.each([
    ["the text laneLockText writes", TEXT, LOCK],
    ["a start with no milliseconds", "7\nbun\n2026-10-23T10:00:00Z\n", { pid: 7, command: "bun", startedMs: Date.parse("2026-10-23T10:00:00Z") }],
  ] as const)("%s", (_name, text, lock) => {
    expect(parseLaneLock(text)).toEqual({ ok: true, value: lock });
  });

  test("round-trips laneLockText", () => {
    const text = laneLockText(LOCK);
    if (!text.ok) throw new Error(text.error.message);
    expect(parseLaneLock(text.value)).toEqual({ ok: true, value: LOCK });
  });

  test.each([
    ["empty", ""],
    ["no trailing newline", "4242\nbun\n2026-10-23T10:00:00.250Z"],
    ["two lines", "4242\nbun\n"],
    ["four lines", `${TEXT}extra\n`],
    ["PID 0", "0\nbun\n2026-10-23T10:00:00.250Z\n"],
    ["a PID with a sign", "+42\nbun\n2026-10-23T10:00:00.250Z\n"],
    ["a PID with a leading zero", "042\nbun\n2026-10-23T10:00:00.250Z\n"],
    ["a huge PID", "99999999999999999999\nbun\n2026-10-23T10:00:00.250Z\n"],
    ["an empty command", "4242\n\n2026-10-23T10:00:00.250Z\n"],
    ["a command path", "4242\n/bin/bun\n2026-10-23T10:00:00.250Z\n"],
    ["a local time", "4242\nbun\n2026-10-23T10:00:00.250+02:00\n"],
    ["epoch ms", "4242\nbun\n1792749600250\n"],
    ["an impossible date", "4242\nbun\n2026-13-45T10:00:00.250Z\n"],
    ["CRLF lines", "4242\r\nbun\r\n2026-10-23T10:00:00.250Z\r\n"],
    ["garbage", "garbage"],
  ] as const)("%s is malformed", (_name, text) => {
    const r = parseLaneLock(text);
    expect(r.ok ? "ok" : r.error.kind).toBe("malformed");
  });
});

describe("lockVerdict", () => {
  const BUN_ARGS = "/opt/homebrew/bin/bun /h/.xarabot/runner/v1/src/cli/main.ts lane run xaravel/xarabot builder-1";
  test.each([
    ["the same process, started before the recorded start", { startMs: START - 250, args: BUN_ARGS }, { kind: "live" }],
    ["started 1 s after the recorded start (lstart has whole seconds)", { startMs: START + 1000, args: BUN_ARGS }, { kind: "live" }],
    ["bun anywhere in the args (not only the first word)", { startMs: START, args: `env FOO=1 ${BUN_ARGS}` }, { kind: "live" }],
    ["no process for the PID", null, { kind: "stale", reason: "gone" }],
    ["a process started after the recorded start + 1 s: a reused PID", { startMs: START + 1001, args: BUN_ARGS }, { kind: "stale", reason: "started-later" }],
    ["another command", { startMs: START, args: "/bin/sleep 60" }, { kind: "stale", reason: "command" }],
    ["a command that only contains the name", { startMs: START, args: "/usr/bin/bunzip2 x" }, { kind: "stale", reason: "command" }],
  ] as const)("%s", (_name, info, verdict) => {
    expect(lockVerdict(LOCK, info)).toEqual(verdict);
  });
});

describe("describeStale", () => {
  test.each([
    ["gone", "no process has its PID"],
    ["started-later", "its PID's process started after the lock was taken (a reused PID)"],
    ["command", "its PID runs another command"],
    ["malformed", "its text does not parse"],
  ] as const)("%s", (reason, text) => {
    expect(describeStale(reason)).toBe(text);
  });
});
