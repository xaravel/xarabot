import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../../core/result.ts";
import type { AgentUsage, TokenTotals } from "../../../ports/agent.ts";

/**
 * Reads a `codex exec --json` session (the AR42 spike record is in
 * `codex-agent.ts`): its stdout, plus the session files codex keeps under
 * the lane's `CODEX_HOME` (`sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`).
 * One JSON object per line; lines that are not one are skipped, and so is a
 * file that can't be read. Never throws.
 *
 * - stdout: `thread.started` {`thread_id`}; `turn.completed` {`usage`:
 *   `input_tokens`, `cached_input_tokens` (part of the input),
 *   `cache_write_input_tokens`, `output_tokens`}; `turn.failed` {`error`:
 *   {`message`}}. No model, no cost, no rate limits.
 * - A session file: `session_meta` (its thread id and, for a subagent, its
 *   `parent_thread_id`; a subagent's file, from codex 0.163.0, also carries
 *   its parent's `session_meta` after its own, so only the first counts),
 *   `turn_context` {`model`, `effort`}, and
 *   `token_count` events {`info.total_token_usage`, `rate_limits`:
 *   `primary`/`secondary` {`used_percent`, `window_minutes`, `resets_at`
 *   Unix s}, `rate_limit_reached_type`}. Each line is either the record itself
 *   or `{type, payload}`, an `event_msg` wrapping its own `payload.type`.
 *
 * `turn.completed` counts only the parent thread (spike: subagent threads
 * appear only in session files), so each descendant subagent's own total is
 * added, from its last `token_count`.
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

function jsonLines(text: string): Json[] {
  const out: Json[] = [];
  for (const raw of text.split("\n")) {
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

/** OpenAI usage (`turn.completed` or `total_token_usage`) as Xarabot's totals: `input` is the uncached part. */
export function codexTokens(usage: unknown): TokenTotals | null {
  if (!isObject(usage)) return null;
  const input = num(usage["input_tokens"]);
  const cached = Math.min(num(usage["cached_input_tokens"]), input);
  return {
    input: input - cached,
    output: num(usage["output_tokens"]),
    cacheRead: cached,
    cacheCreation: num(usage["cache_write_input_tokens"]),
  };
}

function addTokens(a: TokenTotals | null, b: TokenTotals | null): TokenTotals | null {
  if (a === null) return b;
  if (b === null) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}

// ------------------------------------------------------------ prices

/** USD per 1M tokens. Cache writes are billed as input. */
export type CodexPrice = { readonly input: number; readonly cached: number; readonly output: number };

/**
 * Per-model prices, third-party figures (OpenAI publishes none for these
 * models), so every cost is an estimate. A model not listed has no cost.
 */
export const CODEX_PRICES: Readonly<Record<string, CodexPrice>> = {
  "gpt-6.1-sol": { input: 2.0, cached: 0.1, output: 10.0 },
};

export function codexPrice(model: string): CodexPrice | null {
  return Object.hasOwn(CODEX_PRICES, model) ? (CODEX_PRICES[model] ?? null) : null;
}

/** The estimated USD cost of `tokens` on `model`, or `null` for an unpriced model. */
export function codexCost(model: string, tokens: TokenTotals): number | null {
  const p = codexPrice(model);
  if (p === null) return null;
  return ((tokens.input + tokens.cacheCreation) * p.input + tokens.cacheRead * p.cached + tokens.output * p.output) / 1_000_000;
}

// ------------------------------------------------------------ session files

export type CodexRateLimits = {
  /**
   * The windows at or over 100% used, with their reset in epoch ms (`null`
   * when unreadable). With `rate_limit_reached_type` set and no window full:
   * one entry, the earliest readable reset (or `null`).
   */
  readonly reached: readonly { readonly resetAt: number | null }[];
};

/** One session file under `CODEX_HOME/sessions`. */
export type CodexSession = {
  readonly file: string;
  readonly mtimeMs: number;
  /** The thread id: the first `session_meta`'s, else the file name's trailing UUID. */
  readonly id: string | null;
  /** A subagent's parent thread, from the first `session_meta`; `null` for a top-level thread. */
  readonly parentId: string | null;
  /** The last `turn_context.model`. */
  readonly model: string | null;
  /** The last `token_count`'s `info.total_token_usage`. */
  readonly tokens: TokenTotals | null;
  /** The last `token_count.rate_limits`, or `null` when none was written. */
  readonly rateLimits: CodexRateLimits | null;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FILE_ID = new RegExp(`(${UUID.source})\\.jsonl$`, "i");
/** How deep under `sessions/` a file may be, and how many are read at most. */
const MAX_DEPTH = 6;
const MAX_FILES = 2000;

/** A record's kind and body: `{type, payload}` lines are unwrapped, and so is an `event_msg`'s own `payload.type`. */
function entry(line: Json): { readonly type: string | null; readonly body: Json } {
  const payload = line["payload"];
  if (isObject(payload)) {
    const inner = str(payload["type"]);
    if ((line["type"] === "event_msg" || line["type"] === "response_item") && inner !== null) return { type: inner, body: payload };
    return { type: str(line["type"]), body: payload };
  }
  return { type: str(line["type"]), body: line };
}

function at(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A subagent's parent thread id, wherever this codex version puts it. */
function parentOf(meta: Json): string | null {
  return (
    str(at(meta, "source", "subagent", "thread_spawn", "parent_thread_id")) ??
    str(at(meta, "source", "subagent", "parent_thread_id")) ??
    str(meta["parent_thread_id"]) ??
    str(at(meta, "thread_source", "parent_thread_id"))
  );
}

/** Unix seconds (or ms, when already that large) as epoch ms. */
function epochMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}

export function readRateLimits(v: unknown): CodexRateLimits | null {
  if (!isObject(v)) return null;
  const windows = ["primary", "secondary"].map((k) => v[k]).filter(isObject);
  const full = windows.filter((w) => typeof w["used_percent"] === "number" && (w["used_percent"] as number) >= 100);
  const named = str(v["rate_limit_reached_type"]) !== null;
  if (full.length > 0) return { reached: full.map((w) => ({ resetAt: epochMs(w["resets_at"]) })) };
  if (!named) return { reached: [] };
  // Named but no window full: only the soonest readable reset, never a far window it never hit; unknown when none is readable.
  const resets = windows.map((w) => epochMs(w["resets_at"])).filter((r): r is number => r !== null);
  return { reached: [{ resetAt: resets.length === 0 ? null : Math.min(...resets) }] };
}

/** Reads one session file; `null` when it can't be read. */
export function readCodexSession(file: string): CodexSession | null {
  let text: string;
  let mtimeMs: number;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return null;
    mtimeMs = st.mtimeMs;
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let meta: Json | null = null;
  let model: string | null = null;
  let tokens: TokenTotals | null = null;
  let rateLimits: CodexRateLimits | null = null;
  for (const line of jsonLines(text)) {
    const { type, body } = entry(line);
    if (type === "session_meta") {
      // Later ones are another thread's: a subagent's file repeats its parent's.
      meta ??= body;
    } else if (type === "turn_context") {
      model = str(body["model"]) ?? model;
    } else if (type === "token_count") {
      tokens = codexTokens(at(body, "info", "total_token_usage")) ?? tokens;
      const limits = readRateLimits(body["rate_limits"]);
      if (limits !== null) rateLimits = limits;
    }
  }
  const id = meta === null ? null : (str(meta["id"]) ?? str(meta["thread_id"]));
  const parentId = meta === null ? null : parentOf(meta);
  return { file, mtimeMs, id: id ?? FILE_ID.exec(file)?.[1] ?? null, parentId, model, tokens, rateLimits };
}

/** Every session file under `<vendorHome>/sessions`, read; none when the folder is missing. */
export function codexSessions(vendorHome: string): CodexSession[] {
  const out: CodexSession[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (seen >= MAX_FILES) return;
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (st.isFile() && name.endsWith(".jsonl")) {
        seen += 1;
        const s = readCodexSession(path);
        if (s !== null) out.push(s);
      }
    }
  };
  walk(join(vendorHome, "sessions"), 0);
  return out;
}

/** The sessions descending from `root` through `parentId`, `root` itself excluded. */
export function descendants(sessions: readonly CodexSession[], root: string): CodexSession[] {
  const ids = new Set([root]);
  const out: CodexSession[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of sessions) {
      if (s.id === null || ids.has(s.id) || s.parentId === null || !ids.has(s.parentId)) continue;
      ids.add(s.id);
      out.push(s);
      grew = true;
    }
  }
  return out;
}

// ------------------------------------------------------------ parseUsage

/**
 * The session's usage: the id from `thread.started`; tokens from the last
 * `turn.completed`, plus each descendant subagent file touched at or after
 * `since`; the model from the parent session file's last `turn_context`;
 * a usage limit only from its last `token_count.rate_limits`, and only when
 * the run did not end in a `turn.completed`; `failure` for a `turn.failed`
 * that is not a usage limit. The cost is always an estimate.
 */
export function parseCodexUsage(stdout: string, vendorHome?: string, since?: number): AgentUsage {
  let sessionId: string | null = null;
  let parentTokens: TokenTotals | null = null;
  let lastTurn: { readonly kind: "completed" } | { readonly kind: "failed"; readonly message: string } | null = null;
  for (const line of jsonLines(stdout)) {
    const type = line["type"];
    if (type === "thread.started") sessionId = str(line["thread_id"]) ?? sessionId;
    else if (type === "turn.completed") {
      parentTokens = codexTokens(line["usage"]) ?? parentTokens;
      lastTurn = { kind: "completed" };
    } else if (type === "turn.failed") {
      lastTurn = { kind: "failed", message: str(at(line, "error", "message")) ?? "turn.failed with no message" };
    }
  }

  let model: string | null = null;
  let rateLimits: CodexRateLimits | null = null;
  let children: CodexSession[] = [];
  if (vendorHome !== undefined && sessionId !== null) {
    const sessions = codexSessions(vendorHome);
    const parent = sessions.find((s) => s.id === sessionId) ?? null;
    model = parent?.model ?? null;
    rateLimits = parent?.rateLimits ?? null;
    children = descendants(sessions, sessionId).filter((s) => since === undefined || s.mtimeMs >= since);
  }

  let tokens = parentTokens;
  for (const c of children) tokens = addTokens(tokens, c.tokens);

  // Each part priced on its own model; any unpriced part leaves the whole uncosted.
  let usd: number | null = null;
  if (tokens !== null && model !== null) {
    const parts: { model: string; tokens: TokenTotals | null }[] = [{ model, tokens: parentTokens }, ...children.map((c) => ({ model: c.model ?? model, tokens: c.tokens }))];
    usd = 0;
    for (const p of parts) {
      if (p.tokens === null) continue;
      const c = codexCost(p.model, p.tokens);
      if (c === null) {
        usd = null;
        break;
      }
      usd += c;
    }
  }

  const reached = lastTurn?.kind !== "completed" && rateLimits !== null && rateLimits.reached.length > 0 ? rateLimits.reached : null;
  const resets = reached?.map((r) => r.resetAt).filter((r): r is number => r !== null) ?? [];
  const usageLimit = reached === null ? null : { resetAt: resets.length === 0 ? null : Math.max(...resets) };
  const failure = lastTurn?.kind === "failed" && usageLimit === null ? lastTurn.message : undefined;

  return {
    sessionId,
    model,
    tokens,
    cost: usd === null ? null : { usd, estimate: true },
    usageLimit,
    ...(failure === undefined ? {} : { failure }),
  };
}

/** Refuses a session whose reported model is missing or is not the configured one. */
export function checkCodexModel(usage: AgentUsage, configured: string): Result<string, "model-mismatch"> {
  if (usage.model === null) return err("model-mismatch", `codex: the session reported no model; configured ${configured}`);
  if (usage.model !== configured) return err("model-mismatch", `codex: the session ran ${usage.model}, not the configured ${configured}`);
  return ok(usage.model);
}
