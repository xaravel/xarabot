import { describe, expect, test } from "bun:test";
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_MIN_VERSION,
  claudeEffortValues,
  createClaudeAgent,
  parseVersion,
} from "../../../../src/adapters/agent/claude/claude-agent.ts";
import { PACKAGE_TEMPLATE } from "../../../../src/core/prompt/template.ts";
import type { AgentSettings, Effort } from "../../../../src/ports/agent.ts";
import type { LaunchSpec } from "../../../../src/ports/sandbox.ts";

const agent = createClaudeAgent();
const RESULT = "/lane/tmp/result.json";
const SID = "6f1c2b9e-3d4a-4e5f-8a7b-0c1d2e3f4a5b";
const PROMPT = "# Task\n\nBuild Story 1.7 (`1-7-x`)\n";

function spec(...args: Parameters<typeof agent.launchSpec>): LaunchSpec {
  const r = agent.launchSpec(...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The argv the AR42 spike settled on, before any `--resume`. */
function spikeArgv(model: string, effort: string): string[] {
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    '{"attribution":false,"sandbox":{"enabled":false}}',
  ];
}

describe("launchSpec", () => {
  test("defaults: claude-opus-5-5, high, stream-json, the settings JSON; the prompt on stdin", () => {
    const s = spec({ kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT);
    expect(s).toEqual({
      argv: spikeArgv("claude-opus-5-5", "high"),
      stdin: PROMPT,
      vendor: "claude",
      vendorHomeEnv: "CLAUDE_CONFIG_DIR",
      credential: { file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
      apiHosts: ["api.anthropic.com"],
    });
    expect(s.argv.some((a) => a.includes("Build Story"))).toBe(false);
  });

  test("the lane's model and effort", () => {
    expect(spec({ kind: "fresh", prompt: PROMPT }, { model: "claude-sonnet-5-5", effort: "xhigh" }, RESULT).argv).toEqual(
      spikeArgv("claude-sonnet-5-5", "xhigh"),
    );
  });

  test("resume: the same argv plus --resume <id>, resume true, stdin asks only for the result at resultPath", () => {
    const s = spec({ kind: "resume", sessionId: SID }, { effort: "high" }, RESULT);
    expect(s.argv).toEqual([...spikeArgv("claude-opus-5-5", "high"), "--resume", SID]);
    expect(s.resume).toBe(true);
    expect(s.stdin).toContain(`\`${RESULT}\``);
    expect(s.stdin).toContain("$XARABOT_RESULT");
    expect(s.stdin).toContain("Do no other work");
    expect(s.stdin).not.toContain("bmad-");
  });

  test.each<[string, Parameters<typeof agent.launchSpec>, string]>([
    ["a relative resultPath", [{ kind: "fresh", prompt: PROMPT }, { effort: "high" }, "tmp/result.json"], "resultPath"],
    ["an empty prompt", [{ kind: "fresh", prompt: "" }, { effort: "high" }, RESULT], "prompt"],
    ["a blank prompt", [{ kind: "fresh", prompt: " \n" }, { effort: "high" }, RESULT], "prompt"],
    ["a NUL in the prompt", [{ kind: "fresh", prompt: "a\0b" }, { effort: "high" }, RESULT], "prompt"],
    ["a bad session id", [{ kind: "resume", sessionId: "--dangerously" }, { effort: "high" }, RESULT], "sessionId"],
    ["an empty session id", [{ kind: "resume", sessionId: "" }, { effort: "high" }, RESULT], "sessionId"],
    ["a model that reads as a flag", [{ kind: "fresh", prompt: PROMPT }, { model: "--evil", effort: "high" }, RESULT], "model"],
    ["an empty model", [{ kind: "fresh", prompt: PROMPT }, { model: "", effort: "high" }, RESULT], "model"],
  ])("%s is invalid, naming the field", (_name, args, field) => {
    const r = agent.launchSpec(...args);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid");
      expect(r.error.message).toContain(field);
    }
  });
});

describe("effortValues", () => {
  const ALL: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
  test.each([
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
  ])("%s offers all five", (model) => {
    expect(claudeEffortValues(model)).toEqual(ALL);
  });

  test.each(["claude-opus-4-6", "claude-sonnet-4-6"])("%s offers low medium high max", (model) => {
    expect(claudeEffortValues(model)).toEqual(["low", "medium", "high", "max"]);
  });

  test.each(["opus", "sonnet", "claude-opus-9", "", "toString", "__proto__"])("%j offers none (no aliases; fails closed)", (model) => {
    expect(claudeEffortValues(model)).toEqual([]);
  });
});

describe("startCheck", () => {
  const V = "2.1.309 (Claude Code)";

  test("accepts the defaults on a current CLI", () => {
    expect(agent.startCheck({ effort: "high" }, V)).toEqual({ ok: true, value: { model: CLAUDE_DEFAULT_MODEL, version: "2.1.309" } });
  });

  test.each<[string, AgentSettings, string[]]>([
    ["xhigh on claude-opus-4-6", { model: "claude-opus-4-6", effort: "xhigh" }, ["claude-opus-4-6", "xhigh", "low, medium, high, max"]],
    ["an unknown model", { model: "claude-unknown-1", effort: "high" }, ["claude-unknown-1", "high", "none"]],
    ["an alias", { model: "opus", effort: "high" }, ["opus", "high", "none"]],
  ])("refuses %s, naming model, effort and the offered list", (_name, settings, fragments) => {
    const r = agent.startCheck(settings, V);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("refused");
      for (const f of fragments) expect(r.error.message).toContain(f);
    }
  });

  test.each(["2.1.303 (Claude Code)", "garbage", "", "2.1", "1.99.999", "2.1.x"])("refuses the version output %j", (out) => {
    const r = agent.startCheck({ effort: "high" }, out);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("refused");
  });

  test.each(["2.1.304 (Claude Code)", "2.1.310", "2.2.0", "3.0.0 (Claude Code)", "  2.1.309 (Claude Code)\n"])("accepts %j", (out) => {
    expect(agent.startCheck({ effort: "max", model: "claude-opus-4-6" }, out).ok).toBe(true);
  });

  test("minVersion is 2.1.304 and parses", () => {
    expect(agent.minVersion).toBe(CLAUDE_MIN_VERSION);
    expect(parseVersion(CLAUDE_MIN_VERSION)).toEqual([2, 1, 304]);
  });
});

describe("AR42 spike record", () => {
  test("output format: stream-json with --verbose", () => {
    const argv = spec({ kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT).argv;
    const i = argv.indexOf("--output-format");
    expect(argv[i + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
  });

  test("outcome mapping: the first-build step maps ready-for-dev to blocked/other and never offers no-op", () => {
    expect(PACKAGE_TEMPLATE.result_build).toContain("`ready-for-dev`");
    expect(PACKAGE_TEMPLATE.result_build).toMatch(/`ready-for-dev`[^\n]*`outcome` `blocked` with `blocked\.kind` `other`/);
    expect(PACKAGE_TEMPLATE.result_build).toContain("It halted `done`: `outcome` `done`.");
    expect(PACKAGE_TEMPLATE.result_build).toContain("`bmad-build-auto` has no `no-op` outcome, so never report `no-op` after it.");
  });

  test("outcome mapping: the fix step keeps no-op", () => {
    expect(PACKAGE_TEMPLATE.result_fix).toContain("`no-op`");
  });

  test("resume: --resume <session_id> after the fresh argv, in the kept vendor home", () => {
    const fresh = spec({ kind: "fresh", prompt: PROMPT }, { effort: "low" }, RESULT);
    const resume = spec({ kind: "resume", sessionId: SID }, { effort: "low" }, RESULT);
    expect(resume.argv).toEqual([...fresh.argv, "--resume", SID]);
    expect(fresh.resume).toBeUndefined();
    expect(resume.resume).toBe(true);
    expect(resume.vendorHomeEnv).toBe(fresh.vendorHomeEnv);
  });
});
