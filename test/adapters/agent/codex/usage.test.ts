import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodexModel, codexCost, codexSessions, descendants, parseCodexUsage } from "../../../../src/adapters/agent/codex/usage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PARENT = "01a1752c-71b3-7072-9f95-df9cf17d6444";
const CHILD_A = "01a1752c-8000-7000-8000-00000000000a";
const CHILD_B = "01a1752c-8000-7000-8000-00000000000b";
const GRANDCHILD = "01a1752c-8000-7000-8000-0000000000aa";
const STRANGER = "01a1752c-8000-7000-8000-0000000000ff";
const RESET_S = 1793571963;

function lines(...ls: readonly unknown[]): string {
  return ls.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
}

/** `codex exec --json` stdout, as the spike saw it. */
function stdout(o: { id?: string; end?: "completed" | "failed" | "none"; usage?: Record<string, number>; message?: string } = {}): string {
  const usage = o.usage ?? { input_tokens: 78219, cached_input_tokens: 71040, cache_write_input_tokens: 0, output_tokens: 130, reasoning_output_tokens: 0 };
  const end = o.end ?? "completed";
  return lines(
    { type: "thread.started", thread_id: o.id ?? PARENT },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "alpha beta" } },
    ...(end === "completed" ? [{ type: "turn.completed", usage }] : []),
    ...(end === "failed"
      ? [
          { type: "error", message: o.message ?? "boom" },
          { type: "turn.failed", error: { message: o.message ?? "boom" } },
        ]
      : []),
  );
}

type Limits = { primary?: Record<string, unknown> | null; secondary?: Record<string, unknown> | null; rate_limit_reached_type?: string | null };

function tokenCount(total: Record<string, number> | null, limits?: Limits): unknown {
  return {
    timestamp: "2026-10-25T22:26:58.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: total === null ? null : { total_token_usage: total, last_token_usage: total },
      rate_limits:
        limits === undefined
          ? undefined
          : { limit_id: "codex", primary: limits.primary ?? null, secondary: limits.secondary ?? null, plan_type: "self_serve_business_prolite", rate_limit_reached_type: limits.rate_limit_reached_type ?? null },
    },
  };
}

function meta(id: string, parent?: string): unknown {
  return {
    timestamp: "2026-10-25T22:26:50.000Z",
    type: "session_meta",
    payload: parent === undefined ? { id, source: "exec" } : { id, thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/a" } } } },
  };
}

function turnContext(model: string): unknown {
  return { timestamp: "2026-10-25T22:26:51.000Z", type: "turn_context", payload: { model, effort: "low", approval_policy: "never" } };
}

const OPEN = { used_percent: 4.0, window_minutes: 10080, resets_at: RESET_S };

/** A temp vendor home with session files `{ id: lines }`, each at `sessions/2026/10/25/rollout-<ts>-<id>.jsonl`. */
function home(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "xarabot-codex-home-"));
  dirs.push(root);
  const day = join(root, "sessions", "2026", "10", "25");
  mkdirSync(day, { recursive: true });
  for (const [id, text] of Object.entries(files)) writeFileSync(join(day, `rollout-2026-10-25T15-26-50-${id}.jsonl`), text);
  return root;
}

function rollout(path: string, id: string): string {
  return join(path, "sessions", "2026", "10", "25", `rollout-2026-10-25T15-26-50-${id}.jsonl`);
}

const PARENT_FILE = lines(meta(PARENT), turnContext("gpt-6.1-sol"), tokenCount({ input_tokens: 78219, cached_input_tokens: 71040, output_tokens: 130 }, { primary: OPEN }));

describe("parseCodexUsage: stdout alone", () => {
  test("the thread id and the last turn.completed's tokens; no model without the vendor home, so no cost", () => {
    expect(parseCodexUsage(stdout())).toEqual({
      sessionId: PARENT,
      model: null,
      tokens: { input: 78219 - 71040, output: 130, cacheRead: 71040, cacheCreation: 0 },
      cost: null,
      usageLimit: null,
    });
  });

  test("the last turn.completed wins", () => {
    const out = stdout() + lines({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 2, output_tokens: 3 } });
    expect(parseCodexUsage(out).tokens).toEqual({ input: 6, output: 3, cacheRead: 4, cacheCreation: 2 });
  });

  test("non-JSON lines are skipped; the stdin notice is on stderr anyway", () => {
    const u = parseCodexUsage(`Reading additional input from stdin...\n{not json\n[1]\n${stdout()}trailing`);
    expect(u.sessionId).toBe(PARENT);
    expect(u.tokens?.output).toBe(130);
  });

  test("empty output gives all nulls and no failure", () => {
    expect(parseCodexUsage("")).toEqual({ sessionId: null, model: null, tokens: null, cost: null, usageLimit: null });
    expect("failure" in parseCodexUsage("")).toBe(false);
  });

  test("a failed turn (HTTP 400) with no rate limit: failure set, no limit", () => {
    const msg = "Invalid response.create payload: Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.";
    const u = parseCodexUsage(stdout({ end: "failed", message: msg }));
    expect(u.failure).toBe(msg);
    expect(u.usageLimit).toBeNull();
    expect(u.tokens).toBeNull();
  });

  test("a usage-limit message in the text is never read as a limit", () => {
    const u = parseCodexUsage(stdout({ end: "failed", message: "You've hit your usage limit. Try again at 3:00 PM." }));
    expect(u.usageLimit).toBeNull();
    expect(u.failure).toContain("usage limit");
  });
});

describe("parseCodexUsage: with the vendor home", () => {
  test("the model from the parent's last turn_context, and a cost estimate", () => {
    const h = home({ [PARENT]: lines(meta(PARENT), turnContext("gpt-6-luna"), turnContext("gpt-6.1-sol"), tokenCount({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, { primary: OPEN })) });
    const u = parseCodexUsage(stdout(), h);
    expect(u.model).toBe("gpt-6.1-sol");
    expect(u.cost?.estimate).toBe(true);
    // 7179 uncached input at $2, 71040 cached at $0.10, 130 output at $10 per 1M.
    expect(u.cost?.usd).toBeCloseTo((7179 * 2 + 71040 * 0.1 + 130 * 10) / 1e6, 12);
    expect(u.usageLimit).toBeNull();
  });

  test("no session file for the thread: no model, no cost", () => {
    const h = home({ [STRANGER]: lines(meta(STRANGER), turnContext("gpt-6.1-sol")) });
    expect(parseCodexUsage(stdout(), h)).toMatchObject({ model: null, cost: null });
  });

  test("a missing sessions folder or vendor home is no error", () => {
    expect(parseCodexUsage(stdout(), "/nonexistent/xarabot-codex-home").model).toBeNull();
  });

  test("an unpriced model: tokens, no cost", () => {
    const h = home({ [PARENT]: lines(meta(PARENT), turnContext("gpt-6-luna")) });
    const u = parseCodexUsage(stdout(), h);
    expect(u.model).toBe("gpt-6-luna");
    expect(u.tokens).not.toBeNull();
    expect(u.cost).toBeNull();
  });

  test("the thread id from the file name when session_meta has none", () => {
    const h = home({ [PARENT]: lines(turnContext("gpt-6.1-sol")) });
    expect(parseCodexUsage(stdout(), h).model).toBe("gpt-6.1-sol");
  });

  test("flat records (no payload wrapper) are read too", () => {
    const h = home({ [PARENT]: lines({ type: "session_meta", id: PARENT }, { type: "turn_context", model: "gpt-6.1-sol" }) });
    expect(parseCodexUsage(stdout(), h).model).toBe("gpt-6.1-sol");
  });

  test("subagent tokens: each descendant's last total is added; a stranger's thread is not", () => {
    const child = (id: string, parent: string, input: number) =>
      lines(meta(id, parent), turnContext("gpt-6.1-sol"), tokenCount({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }), tokenCount({ input_tokens: input, cached_input_tokens: 100, output_tokens: 10 }));
    const h = home({
      [PARENT]: PARENT_FILE,
      [CHILD_A]: child(CHILD_A, PARENT, 1000),
      [CHILD_B]: child(CHILD_B, PARENT, 2000),
      [GRANDCHILD]: child(GRANDCHILD, CHILD_A, 500),
      [STRANGER]: child(STRANGER, "01a1752c-0000-7000-8000-000000000000", 99999),
    });
    const u = parseCodexUsage(stdout(), h);
    expect(u.tokens).toEqual({
      input: 78219 - 71040 + (1000 - 100) + (2000 - 100) + (500 - 100),
      output: 130 + 30,
      cacheRead: 71040 + 300,
      cacheCreation: 0,
    });
    expect(descendants(codexSessions(h), PARENT).map((s) => s.id).sort()).toEqual([CHILD_A, CHILD_B, GRANDCHILD].sort());
  });

  test("subagent files touched before `since` are not counted", () => {
    const h = home({
      [PARENT]: PARENT_FILE,
      [CHILD_A]: lines(meta(CHILD_A, PARENT), tokenCount({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 })),
      [CHILD_B]: lines(meta(CHILD_B, PARENT), tokenCount({ input_tokens: 2000, cached_input_tokens: 0, output_tokens: 20 })),
    });
    const since = Date.now() - 60_000;
    const old = new Date(since - 3_600_000);
    utimesSync(rollout(h, CHILD_A), old, old);
    const u = parseCodexUsage(stdout(), h, since);
    expect(u.tokens?.output).toBe(130 + 20);
  });

  test("a child on an unpriced model leaves the whole session uncosted", () => {
    const h = home({ [PARENT]: PARENT_FILE, [CHILD_A]: lines(meta(CHILD_A, PARENT), turnContext("gpt-6-luna"), tokenCount({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 })) });
    const u = parseCodexUsage(stdout(), h);
    expect(u.tokens?.output).toBe(131);
    expect(u.cost).toBeNull();
  });

  test("usage limit: turn.failed and a primary window at 100%: resetAt = resets_at * 1000, no failure", () => {
    const h = home({ [PARENT]: lines(meta(PARENT), turnContext("gpt-6.1-sol"), tokenCount(null, { primary: { used_percent: 100.0, window_minutes: 10080, resets_at: RESET_S }, rate_limit_reached_type: "primary" })) });
    const u = parseCodexUsage(stdout({ end: "failed", message: "You've hit your usage limit. Try again at 3:00 PM." }), h);
    expect(u.usageLimit).toEqual({ resetAt: RESET_S * 1000 });
    expect("failure" in u).toBe(false);
  });

  test("usage limit: only the last rate_limits counts", () => {
    const full = { primary: { used_percent: 100, window_minutes: 300, resets_at: RESET_S } };
    const h1 = home({ [PARENT]: lines(meta(PARENT), turnContext("gpt-6.1-sol"), tokenCount(null, full), tokenCount(null, { primary: OPEN })) });
    const failed = stdout({ end: "failed" });
    expect(parseCodexUsage(failed, h1).usageLimit).toBeNull();
    expect(parseCodexUsage(failed, h1).failure).toBe("boom");
    const h2 = home({ [PARENT]: lines(meta(PARENT), turnContext("gpt-6.1-sol"), tokenCount(null, { primary: OPEN }), tokenCount(null, full), tokenCount({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 })) });
    // A later token_count with no rate_limits keeps the last one written.
    expect(parseCodexUsage(failed, h2).usageLimit).toEqual({ resetAt: RESET_S * 1000 });
  });

  test("usage limit: both windows full takes the later reset; the secondary alone counts", () => {
    const both = home({ [PARENT]: lines(meta(PARENT), tokenCount(null, { primary: { used_percent: 100, resets_at: RESET_S }, secondary: { used_percent: 100.5, resets_at: RESET_S + 3600 } })) });
    expect(parseCodexUsage(stdout({ end: "failed" }), both).usageLimit).toEqual({ resetAt: (RESET_S + 3600) * 1000 });
    const second = home({ [PARENT]: lines(meta(PARENT), tokenCount(null, { primary: OPEN, secondary: { used_percent: 100, resets_at: RESET_S + 60 } })) });
    expect(parseCodexUsage(stdout({ end: "failed" }), second).usageLimit).toEqual({ resetAt: (RESET_S + 60) * 1000 });
  });

  test("usage limit: rate_limit_reached_type set with no full window; an unreadable reset is null", () => {
    const named = home({ [PARENT]: lines(meta(PARENT), tokenCount(null, { primary: { used_percent: 99.9, resets_at: RESET_S }, rate_limit_reached_type: "primary" })) });
    expect(parseCodexUsage(stdout({ end: "failed" }), named).usageLimit).toEqual({ resetAt: RESET_S * 1000 });
    const noReset = home({ [PARENT]: lines(meta(PARENT), tokenCount(null, { primary: { used_percent: 100 } })) });
    expect(parseCodexUsage(stdout({ end: "failed" }), noReset).usageLimit).toEqual({ resetAt: null });
  });

  test("usage limit: named with no full window takes the earliest reset, never a far window it never hit", () => {
    const h = home({
      [PARENT]: lines(
        meta(PARENT),
        tokenCount(null, { primary: { used_percent: 99.9, window_minutes: 300, resets_at: RESET_S + 600 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: RESET_S + 5 * 86400 }, rate_limit_reached_type: "primary" }),
      ),
    });
    expect(parseCodexUsage(stdout({ end: "failed" }), h).usageLimit).toEqual({ resetAt: (RESET_S + 600) * 1000 });
  });

  test("usage limit: a run killed before its turn ended (no turn event) still reports a full window", () => {
    const h = home({ [PARENT]: lines(meta(PARENT), tokenCount(null, { primary: { used_percent: 100, resets_at: RESET_S } })) });
    const u = parseCodexUsage(stdout({ end: "none" }), h);
    expect(u.usageLimit).toEqual({ resetAt: RESET_S * 1000 });
    expect("failure" in u).toBe(false);
  });

  test("a completed turn is no limit, even with a full window", () => {
    const h = home({ [PARENT]: lines(meta(PARENT), turnContext("gpt-6.1-sol"), tokenCount(null, { primary: { used_percent: 100, resets_at: RESET_S } })) });
    expect(parseCodexUsage(stdout(), h).usageLimit).toBeNull();
  });

  test("an unreadable session file is skipped; parseUsage never throws", () => {
    const h = home({ [PARENT]: PARENT_FILE });
    mkdirSync(join(h, "sessions", "2026", "10", "25", `rollout-x-${CHILD_A}.jsonl`));
    writeFileSync(join(h, "sessions", "2026", "10", "25", "garbage.jsonl"), "\u0000\u0001not json\n{");
    expect(() => parseCodexUsage(stdout(), h, 0)).not.toThrow();
    expect(parseCodexUsage(stdout(), h).model).toBe("gpt-6.1-sol");
  });
});

describe("codexCost", () => {
  test("gpt-6.1-sol: $2 input, $0.10 cached, $10 output per 1M; cache writes as input", () => {
    expect(codexCost("gpt-6.1-sol", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 })).toBeCloseTo(2 + 10 + 0.1 + 2, 12);
  });

  test.each(["gpt-6-luna", "", "toString"])("%j is unpriced", (model) => {
    expect(codexCost(model, { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 })).toBeNull();
  });
});

describe("checkCodexModel", () => {
  const usage = parseCodexUsage(stdout());

  test("accepts the configured model", () => {
    expect(checkCodexModel({ ...usage, model: "gpt-6.1-sol" }, "gpt-6.1-sol")).toEqual({ ok: true, value: "gpt-6.1-sol" });
  });

  test("refuses another model, naming both", () => {
    const r = checkCodexModel({ ...usage, model: "gpt-6-luna" }, "gpt-6.1-sol");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("model-mismatch");
      expect(r.error.message).toContain("gpt-6-luna");
      expect(r.error.message).toContain("gpt-6.1-sol");
    }
  });

  test("refuses no model", () => {
    const r = checkCodexModel(usage, "gpt-6.1-sol");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("model-mismatch");
  });
});
