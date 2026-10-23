import { describe, expect, test } from "bun:test";
import { checkModel, parseClaudeUsage } from "../../../../src/adapters/agent/claude/usage.ts";

const SID = "6f1c2b9e-3d4a-4e5f-8a7b-0c1d2e3f4a5b";

/** Lines shaped like Claude Code 2.1.309's `stream-json --verbose` output (the AR42 spike record). */
const INIT = { type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", apiKeySource: "none", tools: [] };
const ASSISTANT = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, session_id: SID };
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: SID,
  total_cost_usd: 0.42,
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  modelUsage: {
    "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.4 },
    "claude-haiku-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.02 },
  },
};

function stream(...lines: readonly unknown[]): string {
  return lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
}

describe("parseClaudeUsage", () => {
  test("id, reported model, summed modelUsage tokens and an estimated cost; no limit", () => {
    expect(parseClaudeUsage(stream(INIT, ASSISTANT, RESULT))).toEqual({
      sessionId: SID,
      model: "claude-opus-5-5",
      tokens: { input: 11, output: 22, cacheRead: 303, cacheCreation: 44 },
      cost: { usd: 0.42, estimate: true },
      usageLimit: null,
    });
  });

  test("falls back to usage when modelUsage is absent, and to summed costUSD without total_cost_usd", () => {
    const { modelUsage: _m, ...noModelUsage } = RESULT;
    expect(parseClaudeUsage(stream(INIT, noModelUsage)).tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    const { total_cost_usd: _t, ...noTotal } = RESULT;
    expect(parseClaudeUsage(stream(INIT, noTotal)).cost?.usd).toBeCloseTo(0.42, 10);
  });

  test("no result line: tokens and cost are null, the id and model still come from init", () => {
    expect(parseClaudeUsage(stream(INIT, ASSISTANT))).toEqual({ sessionId: SID, model: "claude-opus-5-5", tokens: null, cost: null, usageLimit: null });
  });

  test("non-JSON lines are skipped", () => {
    const u = parseClaudeUsage(stream("warning: something", "{not json", "[1,2]", INIT, "", RESULT, "trailing text"));
    expect(u.sessionId).toBe(SID);
    expect(u.tokens?.input).toBe(11);
  });

  test("empty output gives all nulls", () => {
    expect(parseClaudeUsage("")).toEqual({ sessionId: null, model: null, tokens: null, cost: null, usageLimit: null });
  });

  test.each([
    ["ANTHROPIC_API_KEY", false],
    ["apiKeyHelper", false],
    ["none", true],
    ["claude.ai", true],
  ])("apiKeySource %j: estimate %p", (source, estimate) => {
    expect(parseClaudeUsage(stream({ ...INIT, apiKeySource: source }, RESULT)).cost?.estimate).toBe(estimate);
  });

  test("a rejected rate_limit_event gives resetAt in epoch ms", () => {
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1761300000 } };
    expect(parseClaudeUsage(stream(INIT, ev)).usageLimit).toEqual({ resetAt: 1761300000000 });
  });

  test("a rejected rate_limit_event with resetsAt already in ms keeps it", () => {
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1761300000000 } };
    expect(parseClaudeUsage(stream(INIT, ev)).usageLimit).toEqual({ resetAt: 1761300000000 });
  });

  test("a rejected event, then a usage-limit error result with no suffix, keeps the event's reset", () => {
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1761300000 } };
    const r = { ...RESULT, is_error: true, result: "You've hit your usage limit" };
    expect(parseClaudeUsage(stream(INIT, ev, r)).usageLimit).toEqual({ resetAt: 1761300000000 });
  });

  test("a rejected event, then a successful result, is no limit", () => {
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1761300000 } };
    expect(parseClaudeUsage(stream(INIT, ev, RESULT)).usageLimit).toBeNull();
  });

  test("an allowed rate_limit_event is no limit", () => {
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1761300000 } };
    expect(parseClaudeUsage(stream(INIT, ev, RESULT)).usageLimit).toBeNull();
  });

  test.each([undefined, "soon", -5, null])("a rejected rate_limit_event with resetsAt %p gives resetAt null", (resetsAt) => {
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } };
    expect(parseClaudeUsage(stream(ev)).usageLimit).toEqual({ resetAt: null });
  });

  test("an error result saying the usage limit was hit, with a |<epoch> suffix", () => {
    const r = { ...RESULT, is_error: true, result: "Claude AI usage limit reached|1761300000" };
    expect(parseClaudeUsage(stream(INIT, r)).usageLimit).toEqual({ resetAt: 1761300000000 });
  });

  test("an error result saying the usage limit was hit, with no parseable reset", () => {
    const r = { ...RESULT, is_error: true, result: "You've hit your usage limit · resets 3pm" };
    expect(parseClaudeUsage(stream(INIT, r)).usageLimit).toEqual({ resetAt: null });
  });

  test("an error result about something else is no limit; a success mentioning the limit is none either", () => {
    expect(parseClaudeUsage(stream({ ...RESULT, is_error: true, result: "API Error: 500" })).usageLimit).toBeNull();
    expect(parseClaudeUsage(stream({ ...RESULT, result: "I read about the usage limit|1761300000" })).usageLimit).toBeNull();
  });
});

describe("checkModel", () => {
  const usage = parseClaudeUsage(stream(INIT, RESULT));

  test("accepts the configured model", () => {
    expect(checkModel(usage, "claude-opus-5-5")).toEqual({ ok: true, value: "claude-opus-5-5" });
  });

  test("refuses a different reported model", () => {
    const r = checkModel({ ...usage, model: "claude-sonnet-5-5" }, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("model-mismatch");
      expect(r.error.message).toContain("claude-sonnet-5-5");
      expect(r.error.message).toContain("claude-opus-5-5");
    }
  });

  test("refuses a missing reported model", () => {
    const r = checkModel({ ...usage, model: null }, "claude-opus-5-5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("model-mismatch");
  });
});
