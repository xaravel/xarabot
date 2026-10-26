import { err, ok, type Result } from "../../../core/result.ts";
import type { Agent, AgentLaunchSpec, AgentSettings, AgentUnit, Effort } from "../../../ports/agent.ts";
import type { LaunchCredential } from "../../../ports/sandbox.ts";
import { checkCodexModel, parseCodexUsage } from "./usage.ts";

/**
 * The `codex` adapter (FR7, AR15, AR18, AR22, AR42). It only describes a
 * session; the `Sandbox` runs it.
 *
 * AR42 spike record, the `codex` half (codex-cli 0.163.0, 2026-10-25; the
 * full notes are `_bmad-output/planning-artifacts/notes/codex-ar42-spike-2026-10-25.md`):
 *
 * - Launch: `codex exec -m <model> --json -c model_reasoning_effort=<effort>
 *   --dangerously-bypass-approvals-and-sandbox -- <prompt>`. The bypass flag
 *   turns codex's own sandbox and approvals off (`approval_policy: never`,
 *   `danger-full-access`); Xarabot's sandbox is the only one. No
 *   attribution setting is passed: codex 0.163.0 ignores `-c
 *   commit_attribution=""` ("`commit_attribution` is ignored", live check
 *   2026-10-26), so only the runner's sanitizer keeps the `Co-authored-by:
 *   Codex` trailer and the "Generated with [Codex]" line out of forge text,
 *   and commits are the runner's own. The prompt is the last
 *   argument, after `--`; stdin stays closed (`/dev/null`), since codex
 *   reads a piped stdin into the prompt. Never `--ephemeral`: it saves no
 *   session file, so the run could not be resumed or its model read.
 * - Vendor home: `CODEX_HOME`, private to the lane and re-seeded before
 *   every session. codex writes its sessions, caches and a `config.toml`
 *   trust entry there. Skills come from the clone's `.agents/skills`, which
 *   codex reads natively.
 * - Output: `--json` prints `thread.started` {`thread_id`} first, then items,
 *   then `turn.completed` {`usage`} or `turn.failed` {`error`} (exit 1). It
 *   has no model, no cost and no rate limits: those come from the session
 *   file under `CODEX_HOME/sessions/` (`turn_context.model`,
 *   `token_count.rate_limits` with `resets_at` in Unix seconds). A usage
 *   limit is read only from `rate_limits`, never from the message text.
 * - Subagents: `codex exec` runs them (`spawn_agent`/`wait_agent`); they show
 *   in `--json` only as `collab_tool_call` items, and their threads only in
 *   session files (`parent_thread_id`). `parseUsage` adds their tokens.
 * - Outcome mapping: the shared build prompt's, as for `claude`:
 *   `bmad-build-auto` halts `done`, `blocked` or `ready-for-dev` and never
 *   yields `no-op`. `done` maps to `done`; `blocked` to `blocked` with the
 *   kinds in the template; `ready-for-dev` or any other halt to
 *   `blocked`/`other`. The result is written to `$XARABOT_RESULT`, which
 *   reaches codex's shell tool (observed).
 * - Resume: the same options, then `resume <thread_id> -- <prompt>`, in the
 *   same vendor home, which the sandbox then does not empty. The prompt asks
 *   only for the result, naming its path. One resume, never more: the lane
 *   counts.
 * - Efforts: `low` … `max` on `gpt-6.1-sol` (the default model) and
 *   `gpt-6-luna`. `ultra` is accepted by the CLI but is not on Xarabot's
 *   scale; `none` and `minimal` are not either. Any other model offers none.
 * - Hosts: `chatgpt.com`, `ab.chatgpt.com` and `auth.openai.com` (login and
 *   token refresh), plus `api.openai.com` in API-key mode. The list is final.
 *   `2606:4700:440b::ac40:9034` is one of the AAAA records of the four
 *   `sdmntpr{central,northcentral,southcentral,westcentral}us.oaiusercontent.com`
 *   hosts, which stay denied: codex passes every live check without them.
 *   `files.openai.com` stays out because no run reached it.
 *
 * The credential is exactly one mode-600 file under
 * `<config>/xarabot/vendors/codex/`: `auth.json` (a ChatGPT login, copied to
 * `$CODEX_HOME/auth.json`) or `api-key` (passed as `CODEX_API_KEY`).
 */

export const CODEX_COMMAND = "codex";
export const CODEX_DEFAULT_MODEL = "gpt-6.1-sol";
export const CODEX_MIN_VERSION = "0.163.0";
export const CODEX_HOME_ENV = "CODEX_HOME";
/** The ChatGPT-login hosts every codex session reaches. */
export const CODEX_API_HOSTS: readonly string[] = ["chatgpt.com", "ab.chatgpt.com", "auth.openai.com"];
/** The API host, only in API-key mode. */
export const CODEX_API_KEY_HOST = "api.openai.com";
/** The longest prompt, in UTF-8 bytes: it goes in argv. */
export const MAX_PROMPT_BYTES = 256 * 1024;

/** Which credential file the operator keeps. */
export type CodexCredentialKind = "auth-json" | "api-key";

/** The credential files, by kind, as `<config>/xarabot/vendors/codex/<file>`. */
export const CODEX_CREDENTIAL_FILES: Readonly<Record<CodexCredentialKind, string>> = { "auth-json": "auth.json", "api-key": "api-key" };

const CREDENTIALS: Readonly<Record<CodexCredentialKind, LaunchCredential>> = {
  "auth-json": { file: "auth.json", homeFile: "auth.json" },
  "api-key": { file: "api-key", env: "CODEX_API_KEY" },
};

/**
 * The credential kind from which files exist: exactly one may. Both refuse,
 * and so does none (missing). `where` names the folder in the message.
 */
export function codexCredentialKind(exists: (file: string) => boolean, where = "the codex vendor folder"): Result<CodexCredentialKind, "refused"> {
  const auth = exists(CODEX_CREDENTIAL_FILES["auth-json"]);
  const key = exists(CODEX_CREDENTIAL_FILES["api-key"]);
  if (auth && key) return err("refused", `codex: credential: both auth.json and api-key exist in ${where}; keep exactly one`);
  if (auth) return ok("auth-json");
  if (key) return ok("api-key");
  return err("refused", `codex: credential missing: neither auth.json nor api-key exists in ${where}`);
}

const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Exact model ids and the efforts Xarabot runs them at; any other model offers none. */
export const CODEX_EFFORTS: Readonly<Record<string, readonly Effort[]>> = {
  "gpt-6.1-sol": ALL_EFFORTS,
  "gpt-6-luna": ALL_EFFORTS,
};

export function codexEffortValues(model: string): readonly Effort[] {
  return Object.hasOwn(CODEX_EFFORTS, model) ? (CODEX_EFFORTS[model] ?? []) : [];
}

/** A model id as an argument: starts with a letter or digit, so it can never read as a flag. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
/** codex thread ids are UUIDs. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The resume prompt: it asks only for the result. */
export function codexResumePrompt(resultPath: string): string {
  return `# Result

Your session ended without writing its result. Do no other work now. Write your result, exactly as the earlier \`# Result\` section asked, as one JSON object to the file named by the environment variable \`$XARABOT_RESULT\`, which is \`${resultPath}\`. Write this file last, and do nothing after it.
`;
}

function modelOf(settings: AgentSettings): string {
  return settings.model ?? CODEX_DEFAULT_MODEL;
}

export function codexLaunchSpec(
  kind: CodexCredentialKind,
  unit: AgentUnit,
  settings: AgentSettings,
  resultPath: string,
): Result<AgentLaunchSpec, "invalid"> {
  if (!resultPath.startsWith("/") || resultPath.includes("\0")) {
    return err("invalid", `codex: resultPath ${JSON.stringify(resultPath)} is not an absolute path`);
  }
  const model = modelOf(settings);
  if (!MODEL_ID.test(model)) return err("invalid", `codex: model ${JSON.stringify(model)} is not a model id`);
  if (!ALL_EFFORTS.includes(settings.effort)) return err("invalid", `codex: effort ${JSON.stringify(settings.effort)} is not an effort`);
  let prompt: string;
  const resume: string[] = [];
  if (unit.kind === "fresh") {
    if (unit.prompt.trim() === "") return err("invalid", "codex: prompt is empty");
    if (unit.prompt.includes("\0")) return err("invalid", "codex: prompt contains NUL");
    prompt = unit.prompt;
  } else {
    if (!SESSION_ID.test(unit.sessionId)) return err("invalid", `codex: sessionId ${JSON.stringify(unit.sessionId)} is not a session id`);
    prompt = codexResumePrompt(resultPath);
    resume.push("resume", unit.sessionId);
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) return err("invalid", `codex: prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv limit`);
  return ok({
    argv: [
      CODEX_COMMAND,
      "exec",
      "-m",
      model,
      "--json",
      "-c",
      `model_reasoning_effort=${settings.effort}`,
      "--dangerously-bypass-approvals-and-sandbox",
      ...resume,
      "--",
      prompt,
    ],
    vendor: "codex",
    vendorHomeEnv: CODEX_HOME_ENV,
    credential: CREDENTIALS[kind],
    apiHosts: kind === "api-key" ? [...CODEX_API_HOSTS, CODEX_API_KEY_HOST] : CODEX_API_HOSTS,
    ...(unit.kind === "resume" ? { resume: true } : {}),
  });
}

/** `[major, minor, patch]` from `codex --version` output (`codex-cli 0.163.0`, or a bare `0.163.0`), or `null`. */
export function parseCodexVersion(output: string): readonly [number, number, number] | null {
  const m = /^(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(output.trim());
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

export function codexStartCheck(
  settings: AgentSettings,
  versionOutput: string,
): Result<{ readonly model: string; readonly version: string }, "refused"> {
  const model = modelOf(settings);
  const offered = codexEffortValues(model);
  if (!offered.includes(settings.effort)) {
    const list = offered.length === 0 ? "none" : offered.join(", ");
    return err("refused", `codex: model ${model} does not offer effort ${settings.effort} (offered: ${list})`);
  }
  const version = parseCodexVersion(versionOutput);
  if (version === null) return err("refused", `codex: cannot read the CLI version from ${JSON.stringify(versionOutput.trim().slice(0, 80))}`);
  const min = parseCodexVersion(CODEX_MIN_VERSION) as readonly [number, number, number];
  const text = version.join(".");
  if (compareVersions(version, min) < 0) return err("refused", `codex: CLI ${text} is older than ${CODEX_MIN_VERSION}`);
  return ok({ model, version: text });
}

export type CodexAgentOpts = {
  /** Which credential file the operator keeps (`codexCredentialKind`). */
  readonly credential: CodexCredentialKind;
};

export function createCodexAgent(opts: CodexAgentOpts): Agent {
  return {
    vendor: "codex",
    defaultModel: CODEX_DEFAULT_MODEL,
    minVersion: CODEX_MIN_VERSION,
    launchSpec: (unit, settings, resultPath) => codexLaunchSpec(opts.credential, unit, settings, resultPath),
    parseUsage: parseCodexUsage,
    checkModel: checkCodexModel,
    effortValues: codexEffortValues,
    startCheck: codexStartCheck,
  };
}
