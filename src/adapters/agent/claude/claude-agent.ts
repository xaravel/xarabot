import { err, ok, type Result } from "../../../core/result.ts";
import type { Agent, AgentLaunchSpec, AgentSettings, AgentUnit, Effort } from "../../../ports/agent.ts";
import { checkModel, parseClaudeUsage } from "./usage.ts";

/**
 * The `claude` adapter (FR7, AR15, AR22, AR30). It only describes a session;
 * the `Sandbox` runs it.
 *
 * AR42 spike record, the `claude` half (Claude Code 2.1.309):
 *
 * - Output format: `--output-format stream-json --verbose` (stream-json
 *   needs `--verbose` under `-p`). A `system`/`init` line carries
 *   `session_id`, `model` and `apiKeySource`; a final `result` line carries
 *   `session_id`, `usage`, `modelUsage` (per model: `inputTokens`,
 *   `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
 *   `costUSD`), `total_cost_usd`, `is_error` and `result`; a
 *   `rate_limit_event` line carries `rate_limit_info` {`status`, `resetsAt`
 *   epoch seconds}. `json` gives only the result line: no `model`, no reset
 *   time.
 * - Outcome mapping: `bmad-build-auto` halts `done`, `blocked` or
 *   `ready-for-dev` (only when told to halt after planning) and never yields
 *   `no-op`. `done` maps to `done`; `blocked` to `blocked` with the kinds in
 *   the template; `ready-for-dev` or any other halt to `blocked`/`other`. The
 *   first-build result step never offers `no-op`; the fix result step keeps
 *   it.
 * - Resume: the same argv plus `--resume <session_id>`, run in the same
 *   vendor home, which the sandbox then does not empty (the transcript lives
 *   there). The prompt on stdin asks only for the result, naming its path.
 *   One resume, never more: the lane counts.
 *
 * The credential is `<config>/xarabot/vendors/claude/oauth-token` (mode 600,
 * the one-line token `claude setup-token` prints), passed as
 * `CLAUDE_CODE_OAUTH_TOKEN`; see `docs/maintainer/claude-credential.md`.
 */

export const CLAUDE_COMMAND = "claude";
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
export const CLAUDE_MIN_VERSION = "2.1.304";
export const CLAUDE_API_HOSTS: readonly string[] = ["api.anthropic.com"];
/** Attribution off (no co-author trailer) and Claude Code's own sandbox off: the Xarabot sandbox is the only one. */
export const CLAUDE_SETTINGS = JSON.stringify({ attribution: false, sandbox: { enabled: false } });

const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const FOUR_EFFORTS: readonly Effort[] = ["low", "medium", "high", "max"];

/** Exact model ids and the efforts the CLI offers for each; any other model offers none. */
export const CLAUDE_EFFORTS: Readonly<Record<string, readonly Effort[]>> = {
  "claude-fable-5-1": ALL_EFFORTS,
  "claude-fable-5": ALL_EFFORTS,
  "claude-opus-5-5": ALL_EFFORTS,
  "claude-opus-5": ALL_EFFORTS,
  "claude-opus-4-8": ALL_EFFORTS,
  "claude-opus-4-7": ALL_EFFORTS,
  "claude-sonnet-5-5": ALL_EFFORTS,
  "claude-sonnet-5": ALL_EFFORTS,
  "claude-haiku-5-5": ALL_EFFORTS,
  "claude-opus-4-6": FOUR_EFFORTS,
  "claude-sonnet-4-6": FOUR_EFFORTS,
};

export function claudeEffortValues(model: string): readonly Effort[] {
  return Object.hasOwn(CLAUDE_EFFORTS, model) ? (CLAUDE_EFFORTS[model] ?? []) : [];
}

/** A model id as an argument: starts with a letter or digit, so it can never read as a flag. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
/** Claude Code session ids are UUIDs. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The resume prompt: it asks only for the result. */
export function resumePrompt(resultPath: string): string {
  return `# Result

Your session ended without writing its result. Do no other work now. Write your result, exactly as the earlier \`# Result\` section asked, as one JSON object to the file named by the environment variable \`$XARABOT_RESULT\`, which is \`${resultPath}\`. Write this file last, and do nothing after it.
`;
}

function modelOf(settings: AgentSettings): string {
  return settings.model ?? CLAUDE_DEFAULT_MODEL;
}

export function claudeLaunchSpec(unit: AgentUnit, settings: AgentSettings, resultPath: string): Result<AgentLaunchSpec, "invalid"> {
  if (!resultPath.startsWith("/") || resultPath.includes("\0")) {
    return err("invalid", `claude: resultPath ${JSON.stringify(resultPath)} is not an absolute path`);
  }
  const model = modelOf(settings);
  if (!MODEL_ID.test(model)) return err("invalid", `claude: model ${JSON.stringify(model)} is not a model id`);
  if (!ALL_EFFORTS.includes(settings.effort)) return err("invalid", `claude: effort ${JSON.stringify(settings.effort)} is not an effort`);
  let stdin: string;
  const resume: string[] = [];
  if (unit.kind === "fresh") {
    if (unit.prompt.trim() === "") return err("invalid", "claude: prompt is empty");
    if (unit.prompt.includes("\0")) return err("invalid", "claude: prompt contains NUL");
    stdin = unit.prompt;
  } else {
    if (!SESSION_ID.test(unit.sessionId)) return err("invalid", `claude: sessionId ${JSON.stringify(unit.sessionId)} is not a session id`);
    stdin = resumePrompt(resultPath);
    resume.push("--resume", unit.sessionId);
  }
  return ok({
    argv: [
      CLAUDE_COMMAND,
      "-p",
      "--model",
      model,
      "--effort",
      settings.effort,
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      CLAUDE_SETTINGS,
      ...resume,
    ],
    stdin,
    vendor: "claude",
    vendorHomeEnv: "CLAUDE_CONFIG_DIR",
    credential: { file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
    apiHosts: CLAUDE_API_HOSTS,
    ...(unit.kind === "resume" ? { resume: true } : {}),
  });
}

/** `[major, minor, patch]` from the start of `claude --version` output (`2.1.309 (Claude Code)`), or `null`. */
export function parseVersion(output: string): readonly [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(output.trim());
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

export function claudeStartCheck(
  settings: AgentSettings,
  versionOutput: string,
): Result<{ readonly model: string; readonly version: string }, "refused"> {
  const model = modelOf(settings);
  const offered = claudeEffortValues(model);
  if (!offered.includes(settings.effort)) {
    const list = offered.length === 0 ? "none" : offered.join(", ");
    return err("refused", `claude: model ${model} does not offer effort ${settings.effort} (offered: ${list})`);
  }
  const version = parseVersion(versionOutput);
  if (version === null) return err("refused", `claude: cannot read the CLI version from ${JSON.stringify(versionOutput.trim().slice(0, 80))}`);
  const min = parseVersion(CLAUDE_MIN_VERSION) as readonly [number, number, number];
  const text = version.join(".");
  if (compareVersions(version, min) < 0) return err("refused", `claude: CLI ${text} is older than ${CLAUDE_MIN_VERSION}`);
  return ok({ model, version: text });
}

export function createClaudeAgent(): Agent {
  return {
    vendor: "claude",
    defaultModel: CLAUDE_DEFAULT_MODEL,
    minVersion: CLAUDE_MIN_VERSION,
    launchSpec: claudeLaunchSpec,
    parseUsage: parseClaudeUsage,
    checkModel,
    effortValues: claudeEffortValues,
    startCheck: claudeStartCheck,
  };
}
