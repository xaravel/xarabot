import { err, ok, type Result } from "../../../core/result.ts";
import type { AgentUsage, TokenTotals } from "../../../ports/agent.ts";

/**
 * Reads `claude -p --output-format stream-json --verbose` output (the AR42
 * spike record is in `claude-agent.ts`). Pure: one JSON object per line;
 * lines that are not a JSON object are skipped.
 *
 * - `system`/`init`: `session_id`, `model`, `apiKeySource`.
 * - `result`: `session_id`, `usage`, `modelUsage`, `total_cost_usd`,
 *   `is_error`, `result`.
 * - `rate_limit_event`: `rate_limit_info` {`status`, `resetsAt` epoch s}.
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** A finite epoch in seconds, or ms when it is already that large, as epoch ms. */
function epochMs(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Sum of `modelUsage` across models, or `null` when it has no model entry. */
function fromModelUsage(v: unknown): TokenTotals | null {
  if (!isObject(v)) return null;
  const models = Object.values(v).filter(isObject);
  if (models.length === 0) return null;
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const m of models) {
    t.input += num(m["inputTokens"]);
    t.output += num(m["outputTokens"]);
    t.cacheRead += num(m["cacheReadInputTokens"]);
    t.cacheCreation += num(m["cacheCreationInputTokens"]);
  }
  return t;
}

function fromUsage(v: unknown): TokenTotals | null {
  if (!isObject(v)) return null;
  return {
    input: num(v["input_tokens"]),
    output: num(v["output_tokens"]),
    cacheRead: num(v["cache_read_input_tokens"]),
    cacheCreation: num(v["cache_creation_input_tokens"]),
  };
}

function costOf(line: Json): number | null {
  const total = line["total_cost_usd"];
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  const mu = line["modelUsage"];
  if (!isObject(mu)) return null;
  const costs = Object.values(mu)
    .filter(isObject)
    .map((m) => m["costUSD"])
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c >= 0);
  return costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0);
}

/** `apiKeySource` names an API key (`ANTHROPIC_API_KEY`, `apiKeyHelper`), so the cost is billed, not an estimate. */
function isApiKey(source: string | null): boolean {
  return source !== null && /api_?key/i.test(source);
}

const USAGE_LIMIT_TEXT = /usage limit/i;

function lines(stdout: string): Json[] {
  const out: Json[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v)) out.push(v);
    } catch {
      // Not JSON: skipped.
    }
  }
  return out;
}

export function parseClaudeUsage(stdout: string): AgentUsage {
  let sessionId: string | null = null;
  let model: string | null = null;
  let apiKeySource: string | null = null;
  let result: Json | null = null;
  let usageLimit: { resetAt: number | null } | null = null;

  for (const line of lines(stdout)) {
    const type = line["type"];
    if (type === "system" && line["subtype"] === "init") {
      sessionId = str(line["session_id"]) ?? sessionId;
      model = str(line["model"]) ?? model;
      apiKeySource = str(line["apiKeySource"]) ?? apiKeySource;
    } else if (type === "result") {
      result = line;
      sessionId = str(line["session_id"]) ?? sessionId;
      const text = line["result"];
      if (line["is_error"] === true && typeof text === "string" && USAGE_LIMIT_TEXT.test(text)) {
        const m = /\|\s*(\d+)\s*$/.exec(text);
        // No suffix: keep a reset an earlier rate_limit_event gave.
        usageLimit = { resetAt: m === null ? ((usageLimit as { resetAt: number | null } | null)?.resetAt ?? null) : epochMs(m[1]) };
      } else if (line["is_error"] !== true) {
        // A successful result: the session got through, so no limit stopped it.
        usageLimit = null;
      }
    } else if (type === "rate_limit_event") {
      const info = line["rate_limit_info"];
      if (isObject(info) && info["status"] === "rejected") usageLimit = { resetAt: epochMs(info["resetsAt"]) };
    }
  }

  const tokens = result === null ? null : (fromModelUsage(result["modelUsage"]) ?? fromUsage(result["usage"]));
  const usd = result === null ? null : costOf(result);
  return {
    sessionId,
    model,
    tokens,
    cost: usd === null ? null : { usd, estimate: !isApiKey(apiKeySource) },
    usageLimit,
  };
}

/** Refuses a session whose reported model is missing or is not the configured one. */
export function checkModel(usage: AgentUsage, configured: string): Result<string, "model-mismatch"> {
  if (usage.model === null) return err("model-mismatch", `claude: the session reported no model; configured ${configured}`);
  if (usage.model !== configured) return err("model-mismatch", `claude: the session ran ${usage.model}, not the configured ${configured}`);
  return ok(usage.model);
}
