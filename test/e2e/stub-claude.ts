/**
 * The canary's stub `claude` CLI (Story 1.20): a POSIX `sh` script that
 * stands in for Claude Code inside the real sandbox. It keeps no state: the
 * clock alone decides whether a run hits a usage limit or builds.
 *
 * - `--version` prints `2.1.309 (Claude Code)`.
 * - Before `limitUntil` (epoch s), a run prints a `system`/`init` line, a
 *   rejected `rate_limit_event` resetting at `reset` and an error `result`
 *   (`Claude AI usage limit reached|<reset>`), writes no result and exits 1.
 * - From `limitUntil` on, a run writes `canary/<runId>.md` and the Story's
 *   spec file (`status: done`, `## Auto Run Result` with `Status: done`) in
 *   the clone, prints `init` and a success `result`, then writes the build
 *   result JSON to `$XARABOT_RESULT` last.
 *
 * The caller sets `limitUntil = reset + 119`: the lane's usage-limit sleep
 * ends at `reset + 120 s`, so the session after the sleep always builds.
 */

export const STUB_VERSION = "2.1.309 (Claude Code)";
/** The session id every stub run reports. */
export const STUB_SESSION_ID = "5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const STUB_MODEL = "claude-opus-5-5";
/** The spec file the stub writes for Story 1.1; it matches the default `story_spec_path`. */
export const STUB_SPEC_PATH = "_bmad-output/implementation-artifacts/spec-1-1-canary.md";

export type StubParams = {
  /** Epoch seconds from which a run builds instead of hitting the limit. */
  readonly limitUntil: number;
  /** The usage limit's reset, epoch seconds. */
  readonly reset: number;
  /** Names `canary/<runId>.md`; letters, digits and `-` only. */
  readonly runId: string;
  /** The spec file's repo-relative path; default `STUB_SPEC_PATH`. */
  readonly specPath?: string;
};

/** The `canary/<runId>.md` path a building run writes. */
export function canaryPath(runId: string): string {
  return `canary/${runId}.md`;
}

/** The build result a building run writes to `$XARABOT_RESULT`. */
export function stubResult(runId: string): Record<string, unknown> {
  return {
    kind: "build",
    outcome: "done",
    summary: `Canary run ${runId}`,
    body: `Adds ${canaryPath(runId)}.`,
    verification: ["stub CLI: no checks run"],
    denied_actions: [],
  };
}

/** The spec file a building run writes. */
export function stubSpec(runId: string): string {
  return [
    "---",
    "title: 'Story 1.1: Canary'",
    "status: done",
    "---",
    "",
    `Canary run ${runId}.`,
    "",
    "## Auto Run Result",
    "",
    "Status: done",
    "",
  ].join("\n");
}

/** `value` single-quoted for POSIX `sh`. */
function sq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

export function stubClaudeScript(p: StubParams): string {
  const specPath = p.specPath ?? STUB_SPEC_PATH;
  if (!Number.isSafeInteger(p.limitUntil) || !Number.isSafeInteger(p.reset) || p.reset <= 0) throw new Error("stub: limitUntil and reset must be epoch seconds");
  if (!PLAIN.test(p.runId)) throw new Error(`stub: runId ${JSON.stringify(p.runId)} is not plain`);
  if (!REPO_PATH.test(specPath) || specPath.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error(`stub: spec path ${JSON.stringify(specPath)} is not a plain repo path`);
  const canary = canaryPath(p.runId);
  const dir = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const line = (v: unknown): string => `printf '%s\\n' ${sq(JSON.stringify(v))}`;
  const init = line({ type: "system", subtype: "init", session_id: STUB_SESSION_ID, model: STUB_MODEL, apiKeySource: "none" });
  return [
    "#!/bin/sh",
    "# The Xarabot canary's stub claude CLI (test/e2e/stub-claude.ts).",
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' ${sq(STUB_VERSION)}`,
    "  exit 0",
    "fi",
    "cat >/dev/null",
    `if [ "$(date +%s)" -lt ${p.limitUntil} ]; then`,
    `  ${init}`,
    `  ${line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: p.reset }, session_id: STUB_SESSION_ID })}`,
    `  ${line({ type: "result", subtype: "success", is_error: true, result: `Claude AI usage limit reached|${p.reset}`, session_id: STUB_SESSION_ID })}`,
    "  exit 1",
    "fi",
    `mkdir -p ${sq(dir(canary))} ${sq(dir(specPath))} || exit 1`,
    `printf '%s\\n' ${sq(`Canary run ${p.runId}.`)} > ${sq(canary)} || exit 1`,
    `printf '%s' ${sq(stubSpec(p.runId))} > ${sq(specPath)} || exit 1`,
    init,
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: STUB_SESSION_ID,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
    `printf '%s\\n' ${sq(JSON.stringify(stubResult(p.runId)))} > "$XARABOT_RESULT"`,
    "",
  ].join("\n");
}
