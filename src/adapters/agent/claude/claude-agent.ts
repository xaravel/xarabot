import { isAbsolute } from "node:path";
import { err, ok } from "../../../core/result.ts";
import type {
  Agent,
  AgentResult,
  AgentSettings,
  AgentStart,
  AgentTokens,
  AgentUnit,
  AgentUsage,
  AgentUsageLimit,
  Effort,
} from "../../../ports/agent.ts";
import type { LaunchCredential, LaunchSpec } from "../../../ports/sandbox.ts";

/**
 * The `claude` adapter (FR7, AR15, AR18, AR22, AR30, AR42): Claude Code run
 * as `claude -p` inside the `Sandbox`. It builds the launch spec and parses
 * the `stream-json` output; it never spawns anything itself.
 *
 * AR42 spike, run against claude 2.1.309:
 * - Outcomes: `bmad-build-auto` halts only `done`, `blocked` or
 *   `ready-for-dev` (after planning) and never yields `no-op`; the mapping
 *   onto the `build` result is `BUILD_AUTO_OUTCOMES`, which the first-build
 *   prompt states row for row.
 * - Resume: `claude -p --resume <session_id>` with the same flags continues
 *   the session; the session id is in the `init` and `result` lines.
 * - Output format: `--output-format json` prints only the final result;
 *   `stream-json` (which needs `--verbose`) adds the `system`/`init` line
 *   (session id, model) and `rate_limit_event` (reset time), so it is used.
 */

export const CLAUDE_COMMAND = "claude";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "high";
/** The oldest CLI whose flags and output this adapter was checked against. */
export const MIN_VERSION = "2.1.304";
export const VENDOR_HOME_ENV = "CLAUDE_CONFIG_DIR";
/** `claude setup-token`'s token, at `<config>/xarabot/vendors/claude/oauth-token`, mode 600. */
export const CREDENTIAL: LaunchCredential = { file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" };
export const API_HOSTS: readonly string[] = ["api.anthropic.com"];

/**
 * The `--settings` JSON: commit and PR attribution off (the bot account is
 * the only marker of lane-made work), and Claude Code's own sandbox off
 * (Xarabot's sandbox confines the whole process).
 */
export const SETTINGS = {
  includeCoAuthoredBy: false,
  attribution: { commit: "", pr: "" },
  sandbox: { enabled: false },
} as const;
export const SETTINGS_JSON = JSON.stringify(SETTINGS);

/** How a `bmad-build-auto` halt maps onto the `build` result (AR42 spike). `kind: "table"` means the prompt's kind table. */
export const BUILD_AUTO_OUTCOMES = [
  { halt: "`done`", outcome: "done", kind: null },
  { halt: "`blocked`", outcome: "blocked", kind: "table" },
  { halt: "`ready-for-dev`", outcome: "blocked", kind: "other" },
  { halt: "any other way", outcome: "blocked", kind: "other" },
] as const;

const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: readonly Effort[] = ["low", "medium", "high", "max"];

/** The efforts each known model accepts; any other model accepts none. */
export const MODEL_EFFORTS: Readonly<Record<string, readonly Effort[]>> = {
  "claude-fable-5-1": ALL_EFFORTS,
  "claude-fable-5": ALL_EFFORTS,
  "claude-opus-5-5": ALL_EFFORTS,
  "claude-opus-5": ALL_EFFORTS,
  "claude-opus-4-8": ALL_EFFORTS,
  "claude-opus-4-7": ALL_EFFORTS,
  "claude-sonnet-5-5": ALL_EFFORTS,
  "claude-sonnet-5": ALL_EFFORTS,
  "claude-haiku-5-5": ALL_EFFORTS,
  "claude-opus-4-6": NO_XHIGH,
  "claude-sonnet-4-6": NO_XHIGH,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?=\s|$)/;
/** Claude Code's usage-limit messages: "You've hit your session limit · resets 11:50pm", "Claude AI usage limit reached|1761234567". */
const LIMIT_TEXT = /hit your [a-z ]*limit|usage limit reached/i;
const LIMIT_EPOCH = /\|(\d{9,11})(?!\d)/;
/** A limit message is one short line; longer text that mentions a limit is the agent talking about one. */
const LIMIT_TEXT_MAX = 300;

function effortsFor(model: string): readonly Effort[] {
  return Object.hasOwn(MODEL_EFFORTS, model) ? (MODEL_EFFORTS[model] as readonly Effort[]) : [];
}

function effective(settings: AgentSettings): { readonly model: string; readonly effort: Effort } {
  return { model: settings.model ?? DEFAULT_MODEL, effort: settings.effort ?? DEFAULT_EFFORT };
}

function checkEffort(settings: AgentSettings): AgentResult<{ readonly model: string; readonly effort: Effort }> {
  const s = effective(settings);
  const allowed = effortsFor(s.model);
  if (!allowed.includes(s.effort)) {
    const why = allowed.length === 0 ? "an unknown model" : `it takes ${allowed.join(", ")}`;
    return err("refused", `claude: model ${s.model} does not support effort ${s.effort} (${why})`);
  }
  return ok(s);
}

function parseVersion(text: string): readonly [number, number, number] | null {
  const m = VERSION.exec(text.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const MIN_PARTS = parseVersion(MIN_VERSION) as readonly [number, number, number];

function startCheck(settings: AgentSettings, versionOutput: string): AgentResult<AgentStart> {
  const parts = parseVersion(versionOutput);
  if (parts === null) return err("refused", `claude: cannot read the CLI version from ${JSON.stringify(versionOutput.trim().slice(0, 80))}`);
  const version = parts.join(".");
  if (compareVersions(parts, MIN_PARTS) < 0) return err("refused", `claude: CLI ${version} is older than ${MIN_VERSION}`);
  const s = checkEffort(settings);
  if (!s.ok) return s;
  return ok({ version, ...s.value });
}

/** The resume prompt: asks only for the result, naming where it goes. */
export function resumePrompt(resultPath: string): string {
  return [
    "Your session ended without writing its result.",
    "",
    `Write it now: one JSON object, as the prompt's \`# Result\` section describes, to the file named by the environment variable \`$XARABOT_RESULT\`, which is \`${resultPath}\`. Do nothing else.`,
  ].join("\n");
}

function launchSpec(unit: AgentUnit, settings: AgentSettings, resultPath: string): AgentResult<LaunchSpec> {
  if (!isAbsolute(resultPath)) return err("invalid-input", `claude: result path ${JSON.stringify(resultPath)} is not absolute`);
  const s = checkEffort(settings);
  if (!s.ok) return s;
  const argv = [
    CLAUDE_COMMAND,
    "-p",
    "--model",
    s.value.model,
    "--effort",
    s.value.effort,
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    SETTINGS_JSON,
  ];
  let stdin: string;
  if (unit.kind === "session") {
    if (unit.prompt.trim() === "") return err("invalid-input", "claude: the prompt is empty");
    stdin = unit.prompt;
  } else {
    if (!UUID.test(unit.session)) return err("invalid-input", `claude: session ${JSON.stringify(unit.session)} is not a UUID`);
    argv.push("--resume", unit.session);
    stdin = resumePrompt(resultPath);
  }
  return ok({ argv, stdin, vendor: "claude", vendorHomeEnv: VENDOR_HOME_ENV, credential: CREDENTIAL, apiHosts: API_HOSTS });
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function readTokens(usage: unknown): AgentTokens | null {
  if (!isObject(usage)) return null;
  if (typeof usage["input_tokens"] !== "number" || typeof usage["output_tokens"] !== "number") return null;
  return {
    input: count(usage["input_tokens"]),
    output: count(usage["output_tokens"]),
    cacheRead: count(usage["cache_read_input_tokens"]),
    cacheCreation: count(usage["cache_creation_input_tokens"]),
  };
}

/** The text blocks of an assistant line the CLI flagged as an API error (where limit messages appear). */
function apiErrorTexts(line: Json): string[] {
  if (line["is_api_error_message"] !== true && line["error"] === undefined) return [];
  const message = line["message"];
  if (!isObject(message) || !Array.isArray(message["content"])) return [];
  return message["content"].flatMap((block) => (isObject(block) && typeof block["text"] === "string" ? [block["text"]] : []));
}

function limitFromText(text: string): AgentUsageLimit | null {
  const t = text.trim();
  if (t.length > LIMIT_TEXT_MAX || !LIMIT_TEXT.test(t)) return null;
  const epoch = LIMIT_EPOCH.exec(t);
  return { resetAt: epoch === null ? null : Number(epoch[1]) * 1000, text: t };
}

function parseLines(output: string): Json[] {
  const lines: Json[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v)) lines.push(v);
    } catch {
      // Not JSON: a stray line in the stream.
    }
  }
  return lines;
}

function parseUsage(output: string): AgentResult<AgentUsage> {
  let initSession: string | null = null;
  let model: string | null = null;
  let result: Json | null = null;
  let eventResetAt: number | null | undefined;
  let limitText: AgentUsageLimit | null = null;
  for (const line of parseLines(output)) {
    const type = line["type"];
    if (type === "system" && line["subtype"] === "init") {
      initSession ??= str(line["session_id"]);
      model ??= str(line["model"]);
    } else if (type === "result") {
      result = line;
      if (typeof line["result"] === "string") limitText = limitFromText(line["result"]) ?? limitText;
    } else if (type === "assistant") {
      for (const text of apiErrorTexts(line)) limitText = limitFromText(text) ?? limitText;
    } else if (type === "rate_limit_event") {
      const info = line["rate_limit_info"];
      if (isObject(info) && info["status"] === "rejected") {
        const at = info["resetsAt"];
        eventResetAt = typeof at === "number" && Number.isFinite(at) && at > 0 ? at * 1000 : null;
      }
    }
  }
  let usageLimit: AgentUsageLimit | null = limitText;
  if (eventResetAt !== undefined) usageLimit = { resetAt: eventResetAt ?? limitText?.resetAt ?? null, text: limitText?.text ?? null };
  const cost = result === null ? undefined : result["total_cost_usd"];
  return ok({
    sessionId: initSession ?? (result === null ? null : str(result["session_id"])),
    model,
    tokens: result === null ? null : readTokens(result["usage"]),
    cost: typeof cost === "number" && Number.isFinite(cost) ? { usd: cost, estimate: true } : null,
    isError: result !== null && typeof result["is_error"] === "boolean" ? result["is_error"] : null,
    usageLimit,
  });
}

function verifyModel(usage: AgentUsage, settings: AgentSettings): AgentResult<string> {
  const expected = effective(settings).model;
  if (usage.model === null) return err("model-mismatch", `claude: the session reported no model; configured ${expected}`);
  if (usage.model !== expected) return err("model-mismatch", `claude: the session ran ${usage.model}; configured ${expected}`);
  return ok(usage.model);
}

export function createClaudeAgent(): Agent {
  return {
    command: CLAUDE_COMMAND,
    startCheck,
    launchSpec,
    parseUsage,
    effortValues: (model) => ok(effortsFor(model)),
    verifyModel,
  };
}
