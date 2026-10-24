import { describe, expect, test } from "bun:test";
import {
  afterFailedStart,
  builderLimit,
  builderRefusal,
  checkRunnerVersion,
  MAX_FAILED_STARTS,
  parseFailedStarts,
  parseRunnerFile,
  runnerFileText,
  unattendedRefusal,
} from "../../../src/core/lane/runner.ts";
import type { HostConfig, Lane } from "../../../src/core/schemas/host.ts";

const kind = (r: { ok: boolean; error?: { kind: string } }) => (r.ok ? "ok" : r.error?.kind);

describe("checkRunnerVersion", () => {
  test.each([
    ["v0.2.0", "ok"],
    ["0.2.0", "ok"],
    ["v1.0.0-rc.1+build.5", "ok"],
    ["a", "ok"],
    ["A".repeat(100), "ok"],
    ["A".repeat(101), "invalid"],
    ["", "invalid"],
    ["../x", "invalid"],
    ["v1..2", "invalid"],
    [".hidden", "invalid"],
    ["-v1", "invalid"],
    ["v1/2", "invalid"],
    ["v1 2", "invalid"],
    ["v1\n", "invalid"],
    ["v1~", "invalid"],
  ])("%j is %s", (v, want) => {
    expect(kind(checkRunnerVersion(v))).toBe(want);
  });
});

describe("parseRunnerFile", () => {
  test.each([
    ["v0.2.0\n", { ok: true, value: "v0.2.0" }],
    ["v0.2.0", { ok: true, value: "v0.2.0" }],
    ["v0.2.0\nignored\n", { ok: true, value: "v0.2.0" }],
  ])("%j reads the first line", (text, want) => {
    expect(parseRunnerFile(text)).toEqual(want as never);
  });

  test.each([[""], ["\nv1\n"], ["../x\n"], [" v1\n"]])("%j is invalid", (text) => {
    expect(kind(parseRunnerFile(text))).toBe("invalid");
  });

  test("runnerFileText is the version and a newline", () => {
    expect(runnerFileText("v1")).toBe("v1\n");
  });
});

describe("failed starts", () => {
  test("MAX_FAILED_STARTS is 3", () => {
    expect(MAX_FAILED_STARTS).toBe(3);
  });

  test.each([
    [0, { count: 1, stop: false }],
    [1, { count: 2, stop: false }],
    [2, { count: 3, stop: true }],
    [3, { count: 4, stop: true }],
    [-1, { count: 1, stop: false }],
    [Number.NaN, { count: 1, stop: false }],
  ])("after %p", (count, want) => {
    expect(afterFailedStart(count)).toEqual(want);
  });

  test.each([
    ["2\n", 2],
    ["0\n", 0],
    ["", 0],
    ["x\n", 0],
    ["-1\n", 0],
    ["1.5\n", 0],
  ])("parseFailedStarts(%j) is %p", (text, want) => {
    expect(parseFailedStarts(text)).toBe(want);
  });
});

describe("builderLimit", () => {
  test.each([
    [undefined, { ok: true, value: 1 }],
    ["", { ok: true, value: 1 }],
    ["1", { ok: true, value: 1 }],
    ["4", { ok: true, value: 4 }],
  ])("%j", (raw, want) => {
    expect(builderLimit(raw)).toEqual(want as never);
  });

  test.each([["0"], ["-1"], ["1.5"], ["two"], [" 1"], ["01"]])("%j is an error", (raw) => {
    expect(kind(builderLimit(raw))).toBe("invalid");
  });
});

const lane = (repo: string, role: Lane["role"]): Lane => ({ repo, role, owner: "alice", agent: "claude", effort: "high" });

describe("builderRefusal", () => {
  const host = (lanes: Record<string, Lane>): HostConfig => ({ schema_version: 1, lanes });
  const one = host({ "builder-1": lane("xaravel/xarabot", "builder"), coord: lane("xaravel/xarabot", "coordinator") });
  const two = host({ "builder-1": lane("xaravel/xarabot", "builder"), "builder-2": lane("xaravel/xaravel", "builder"), coord: lane("xaravel/xarabot", "coordinator") });

  test.each([
    ["one builder, limit 1", one, "builder-1", 1, "ok"],
    ["two builders across repos, limit 1", two, "builder-1", 1, "refused"],
    ["the other repo's builder too", two, "builder-2", 1, "refused"],
    ["two builders, limit 2", two, "builder-2", 2, "ok"],
    ["a coordinator is never refused", two, "coord", 1, "ok"],
    ["an unknown lane", one, "nope", 1, "refused"],
  ])("%s", (_name, h, name, limit, want) => {
    expect(kind(builderRefusal(h, name, limit))).toBe(want);
  });

  test("the refusal names the count and the limit", () => {
    const r = builderRefusal(two, "builder-1", 1);
    expect(r.ok ? "" : r.error.message).toBe("host.yaml has 2 builder lanes (builder-1, builder-2), more than XARABOT_MAX_BUILDERS=1");
  });
});

describe("unattendedRefusal", () => {
  test.each([
    [["claude"], "claude", "ok"],
    [["claude", "codex"], "codex", "ok"],
    [[], "claude", "refused"],
    [["codex"], "claude", "refused"],
  ] as const)("%j allows %s: %s", (allowed, agent, want) => {
    expect(kind(unattendedRefusal({ unattended_adapters: [...allowed] }, agent))).toBe(want);
  });
});
