import { describe, expect, test } from "bun:test";
import { classifyChecks, PASSING_CONCLUSIONS, pollDelayMs, type CheckRun } from "../../../src/core/ci/checks.ts";

const done = (name: string, conclusion: string | null): CheckRun => ({ name, status: "completed", conclusion });
const running = (name: string, status: CheckRun["status"] = "in_progress"): CheckRun => ({ name, status, conclusion: null });

describe("classifyChecks", () => {
  const cases: [string, CheckRun[], string[], ReturnType<typeof classifyChecks>][] = [
    ["an empty list is pending", [], [], { kind: "pending" }],
    ["all success passes", [done("lint", "success"), done("test", "success")], [], { kind: "passed" }],
    ["neutral and skipped pass", [done("a", "neutral"), done("b", "skipped")], [], { kind: "passed" }],
    ["a queued check is pending", [done("lint", "success"), running("test", "queued")], [], { kind: "pending" }],
    ["an in-progress check is pending", [running("test")], [], { kind: "pending" }],
    ["a failure fails", [done("lint", "failure")], [], { kind: "failed", failing: ["lint"] }],
    ["cancelled, timed_out and action_required fail", [done("a", "cancelled"), done("b", "timed_out"), done("c", "action_required")], [], { kind: "failed", failing: ["a", "b", "c"] }],
    ["a completed check with no conclusion fails", [done("a", null)], [], { kind: "failed", failing: ["a"] }],
    ["a failure fails at once, while others still run", [done("lint", "failure"), running("test")], [], { kind: "failed", failing: ["lint"] }],
    ["an expected failure is ignored", [done("protected-paths", "failure"), done("test", "success")], ["protected-paths"], { kind: "passed" }],
    ["an expected failure alongside a running check is pending", [done("protected-paths", "failure"), running("test")], ["protected-paths"], { kind: "pending" }],
    ["only unexpected failures are named, each once", [done("protected-paths", "failure"), done("lint", "failure"), done("lint", "failure")], ["protected-paths"], { kind: "failed", failing: ["lint"] }],
  ];
  test.each(cases)("%s", (_name, checks, expected, want) => {
    expect(classifyChecks(checks, expected)).toEqual(want);
  });

  test("the passing conclusions are success, neutral and skipped", () => {
    expect([...PASSING_CONCLUSIONS]).toEqual(["success", "neutral", "skipped"]);
  });
});

describe("pollDelayMs", () => {
  test.each([
    [0, 30_000],
    [1, 60_000],
    [2, 120_000],
    [3, 240_000],
    [4, 300_000],
    [5, 300_000],
    [50, 300_000],
  ])("poll %d sleeps %d ms", (n, ms) => {
    expect(pollDelayMs(n)).toBe(ms);
  });
});
