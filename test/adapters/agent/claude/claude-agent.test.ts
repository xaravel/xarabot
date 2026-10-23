import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_HOSTS,
  BUILD_AUTO_OUTCOMES,
  createClaudeAgent,
  CREDENTIAL,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  MIN_VERSION,
  SETTINGS_JSON,
} from "../../../../src/adapters/agent/claude/claude-agent.ts";
import type { AgentSettings, AgentUnit, AgentUsage, Effort } from "../../../../src/ports/agent.ts";
import type { LaunchSpec } from "../../../../src/ports/sandbox.ts";

const agent = createClaudeAgent();
const RESULT = "/private/var/folders/xy/T/xarabot-lane/tmp/result.json";
const SESSION = "8e4efa3c-b975-432e-913a-43cbb0b8721e";
const SPIKE = readFileSync(join(import.meta.dir, "fixtures", "spike-not-logged-in.jsonl"), "utf8");
const ALL: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function spec(unit: AgentUnit, settings: AgentSettings = {}): LaunchSpec {
  const r = agent.launchSpec(unit, settings, RESULT);
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function usage(lines: readonly unknown[]): AgentUsage {
  const r = agent.parseUsage(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const NO_USAGE: AgentUsage = { sessionId: null, model: null, tokens: null, cost: null, isError: null, usageLimit: null };

describe("launchSpec", () => {
  test("defaults: opus 5.5 at high, prompt on stdin, never in argv", () => {
    const prompt = "# Task\n\nBuild Story 1.14 (`1-14-the-claude-adapter`)";
    const s = spec({ kind: "session", prompt });
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(DEFAULT_EFFORT).toBe("high");
    expect(s.argv).toEqual([
      "claude",
      "-p",
      "--model",
      "claude-opus-5-5",
      "--effort",
      "high",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      SETTINGS_JSON,
    ]);
    expect(s.stdin).toBe(prompt);
    expect(s.argv.some((a) => a.includes("Build Story"))).toBe(false);
  });

  test("vendor, vendor home, credential and API hosts", () => {
    const s = spec({ kind: "session", prompt: "p" });
    expect(s.vendor).toBe("claude");
    expect(s.vendorHomeEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(s.credential).toEqual({ file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(CREDENTIAL).toEqual(s.credential);
    expect(s.apiHosts).toEqual(["api.anthropic.com"]);
    expect(API_HOSTS).toEqual(s.apiHosts);
  });

  test("settings JSON turns attribution and claude's own sandbox off", () => {
    expect(JSON.parse(SETTINGS_JSON)).toEqual({
      includeCoAuthoredBy: false,
      attribution: { commit: "", pr: "" },
      sandbox: { enabled: false },
    });
  });

  test("model and effort from settings", () => {
    const s = spec({ kind: "session", prompt: "p" }, { model: "claude-opus-4-6", effort: "max" });
    expect(flag(s.argv, "--model")).toBe("claude-opus-4-6");
    expect(flag(s.argv, "--effort")).toBe("max");
  });

  test("resume: same flags plus --resume, stdin asks only for the result and names its path", () => {
    const fresh = spec({ kind: "session", prompt: "p" });
    const s = spec({ kind: "resume", session: SESSION });
    expect(s.argv).toEqual([...fresh.argv, "--resume", SESSION]);
    expect(s.stdin).toContain(`\`${RESULT}\``);
    expect(s.stdin).toContain("$XARABOT_RESULT");
    expect(s.stdin).toContain("Do nothing else.");
    expect(s.stdin).not.toMatch(/bmad-|Build Story/);
  });

  test.each(["not-a-uuid", "", `${SESSION} --dangerously-skip-permissions`, "--help"])("resume refuses session %j", (session) => {
    const r = agent.launchSpec({ kind: "resume", session }, {}, RESULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid-input");
  });

  test("an empty prompt or relative result path is invalid input", () => {
    for (const r of [agent.launchSpec({ kind: "session", prompt: " \n" }, {}, RESULT), agent.launchSpec({ kind: "session", prompt: "p" }, {}, "tmp/result.json")]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("invalid-input");
    }
  });

  test.each<[AgentSettings, string]>([
    [{ model: "claude-opus-4-6", effort: "xhigh" }, "claude-opus-4-6"],
    [{ model: "claude-sonnet-4-6", effort: "xhigh" }, "claude-sonnet-4-6"],
    [{ model: "claude-unknown-9", effort: "high" }, "claude-unknown-9"],
    [{ model: "claude-unknown-9" }, "claude-unknown-9"],
  ])("refuses an unsupported effort: %j", (settings, model) => {
    const r = agent.launchSpec({ kind: "session", prompt: "p" }, settings, RESULT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("refused");
      expect(r.error.message).toContain(model);
      expect(r.error.message).toContain(settings.effort ?? "high");
    }
  });

  test("no GitHub host or token anywhere in the spec", () => {
    const s = spec({ kind: "session", prompt: "p" });
    expect(JSON.stringify(s)).not.toMatch(/github|gh[pousr]_|GH_TOKEN|GITHUB_TOKEN/i);
  });
});

describe("effortValues", () => {
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
  ])("%s takes all five", (model) => {
    expect(agent.effortValues(model)).toEqual({ ok: true, value: ALL });
  });

  test.each(["claude-opus-4-6", "claude-sonnet-4-6"])("%s takes no xhigh", (model) => {
    expect(agent.effortValues(model)).toEqual({ ok: true, value: ["low", "medium", "high", "max"] });
  });

  test.each(["claude-opus-4-5", "gpt-5", "", "toString", "__proto__", "constructor"])("%j takes none", (model) => {
    expect(agent.effortValues(model)).toEqual({ ok: true, value: [] });
  });
});

describe("startCheck", () => {
  test("accepts 2.1.309 and the minimum, applying defaults", () => {
    expect(agent.startCheck({}, "2.1.309 (Claude Code)\n")).toEqual({
      ok: true,
      value: { version: "2.1.309", model: "claude-opus-5-5", effort: "high" },
    });
    expect(agent.startCheck({}, `${MIN_VERSION} (Claude Code)`).ok).toBe(true);
    expect(agent.startCheck({}, "3.0.0").ok).toBe(true);
    expect(agent.startCheck({}, "2.2.0 (Claude Code)").ok).toBe(true);
  });

  test.each(["2.1.303 (Claude Code)", "2.0.999 (Claude Code)", "1.9.400", "garbage", "", "v2.1.309", "2.1 (Claude Code)", "2.1.309x"])(
    "refuses %j",
    (out) => {
      const r = agent.startCheck({}, out);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("refused");
    },
  );

  test("refuses an unsupported effort or unknown model, naming both", () => {
    for (const settings of [{ model: "claude-opus-4-6", effort: "xhigh" }, { model: "claude-unknown-9", effort: "low" }] as const) {
      const r = agent.startCheck(settings, "2.1.309 (Claude Code)");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("refused");
        expect(r.error.message).toContain(settings.model);
        expect(r.error.message).toContain(settings.effort);
      }
    }
  });
});

describe("parseUsage", () => {
  test("the AR42 spike's real output (not logged in)", () => {
    expect(usage([SPIKE])).toEqual({
      sessionId: SESSION,
      model: "claude-haiku-5-5",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      cost: { usd: 0, estimate: true },
      isError: true,
      usageLimit: null,
    });
  });

  test("tokens, cost and session from a result line; non-JSON lines skipped", () => {
    const u = usage([
      "warning: something on stdout",
      { type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5" },
      "{not json",
      "[1,2]",
      {
        type: "result",
        session_id: SESSION,
        is_error: false,
        total_cost_usd: 1.25,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      },
    ]);
    expect(u).toEqual({
      sessionId: SESSION,
      model: "claude-opus-5-5",
      tokens: { input: 10, output: 20, cacheRead: 300, cacheCreation: 40 },
      cost: { usd: 1.25, estimate: true },
      isError: false,
      usageLimit: null,
    });
  });

  test("session id from the result line when there is no init line", () => {
    expect(usage([{ type: "result", session_id: SESSION }]).sessionId).toBe(SESSION);
  });

  test("empty or garbage output gives all nulls", () => {
    expect(usage([""])).toEqual(NO_USAGE);
    expect(usage(["garbage", "{", "null", "42"])).toEqual(NO_USAGE);
  });

  test("a result without usage numbers has null tokens", () => {
    expect(usage([{ type: "result", usage: { input_tokens: "x" } }]).tokens).toBeNull();
  });

  test("usage limit from a rejected rate_limit_event, resetsAt in ms", () => {
    const u = usage([
      { type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5" },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1761234567, rateLimitType: "five_hour" } },
      { type: "result", is_error: true, result: "You've hit your session limit · resets 11:50pm" },
    ]);
    expect(u.usageLimit).toEqual({ resetAt: 1761234567000, text: "You've hit your session limit · resets 11:50pm" });
  });

  test("an allowed rate_limit_event is no limit", () => {
    expect(usage([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1761234567 } }]).usageLimit).toBeNull();
  });

  test("a rejected event without a reset time", () => {
    expect(usage([{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }]).usageLimit).toEqual({ resetAt: null, text: null });
  });

  test("limit text only: resetAt null, text kept", () => {
    const u = usage([{ type: "result", is_error: true, result: "You've hit your session limit · resets 11:50pm" }]);
    expect(u.usageLimit).toEqual({ resetAt: null, text: "You've hit your session limit · resets 11:50pm" });
  });

  test("limit text with a |<epoch> suffix gives the reset", () => {
    const u = usage([{ type: "result", is_error: true, result: "Claude AI usage limit reached|1761234567" }]);
    expect(u.usageLimit).toEqual({ resetAt: 1761234567000, text: "Claude AI usage limit reached|1761234567" });
  });

  test("limit text in an API-error assistant message", () => {
    const u = usage([
      {
        type: "assistant",
        is_api_error_message: true,
        message: { content: [{ type: "text", text: "You've hit your usage limit · resets 3am" }] },
      },
    ]);
    expect(u.usageLimit).toEqual({ resetAt: null, text: "You've hit your usage limit · resets 3am" });
  });

  test("an agent's own prose about limits is no limit", () => {
    const long = `Done. I added handling for when you've hit your session limit. ${"Details. ".repeat(50)}`;
    const u = usage([
      { type: "assistant", message: { content: [{ type: "text", text: "the usage limit reached branch" }] } },
      { type: "result", is_error: false, result: long },
    ]);
    expect(u.usageLimit).toBeNull();
  });
});

describe("verifyModel", () => {
  const base = { ...NO_USAGE, sessionId: SESSION };
  test("matches the configured model, default applied", () => {
    expect(agent.verifyModel({ ...base, model: "claude-opus-5-5" }, {})).toEqual({ ok: true, value: "claude-opus-5-5" });
    expect(agent.verifyModel({ ...base, model: "claude-haiku-5-5" }, { model: "claude-haiku-5-5" }).ok).toBe(true);
  });

  test.each([["claude-sonnet-5-5"], [null]])("configured opus 5.5, reported %j: model-mismatch", (model) => {
    const r = agent.verifyModel({ ...base, model }, { model: "claude-opus-5-5" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("model-mismatch");
  });
});

describe("AR42 outcome mapping", () => {
  test("bmad-build-auto's halts and their build outcomes; never no-op", () => {
    expect(BUILD_AUTO_OUTCOMES).toEqual([
      { halt: "`done`", outcome: "done", kind: null },
      { halt: "`blocked`", outcome: "blocked", kind: "table" },
      { halt: "`ready-for-dev`", outcome: "blocked", kind: "other" },
      { halt: "any other way", outcome: "blocked", kind: "other" },
    ]);
    expect(BUILD_AUTO_OUTCOMES.map((r) => r.outcome as string)).not.toContain("no-op");
  });
});
