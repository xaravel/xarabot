import { lstatSync } from "node:fs";
import { join } from "node:path";
import { codexCredentialKind, createCodexAgent, type CodexCredentialKind } from "../../src/adapters/agent/codex/codex-agent.ts";
import { configDir } from "../../src/sandbox/environment.ts";
import { agentContract } from "./agent.contract.ts";

const SID = "01a1752b-acea-7ed3-883a-77eb2ba61eae";

/** Shaped like codex-cli 0.163.0's `exec --json` output (the AR42 spike record). */
const STUB_STDOUT = [
  { type: "thread.started", thread_id: SID },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } },
  { type: "turn.completed", usage: { input_tokens: 28344, cached_input_tokens: 24576, cache_write_input_tokens: 0, output_tokens: 68, reasoning_output_tokens: 0 } },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

/** The session file codex keeps under `CODEX_HOME`, which the stub writes: the model is only there. */
const STUB_ROLLOUT = [
  { timestamp: "2026-10-25T22:26:00.000Z", type: "session_meta", payload: { id: SID, source: "exec" } },
  { timestamp: "2026-10-25T22:26:01.000Z", type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high", approval_policy: "never" } },
  {
    timestamp: "2026-10-25T22:26:03.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 28344, cached_input_tokens: 24576, output_tokens: 68 } },
      rate_limits: { limit_id: "codex", primary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1793571963 }, secondary: null, rate_limit_reached_type: null },
    },
  },
]
  .map((l) => `${JSON.stringify(l)}\n`)
  .join("");

/** A fake ChatGPT-login `auth.json`. */
const STUB_AUTH = `${JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: "y", refresh_token: "z", account_id: "a" } })}\n`;

/** The operator's credential kind, from the files in their codex vendor folder; `auth-json` when it can't tell. */
function operatorKind(): CodexCredentialKind {
  const config = configDir(process.env);
  if (config === null) return "auth-json";
  const dir = join(config, "xarabot", "vendors", "codex");
  const kind = codexCredentialKind((file) => {
    try {
      lstatSync(join(dir, file));
      return true;
    } catch {
      return false;
    }
  }, dir);
  return kind.ok ? kind.value : "auth-json";
}

agentContract({
  name: "codex",
  make: () => createCodexAgent({ credential: "auth-json" }),
  prompt: "argv",
  tempEnv: [],
  credentialText: STUB_AUTH,
  stub: {
    stdout: STUB_STDOUT,
    sessionId: SID,
    model: "gpt-6.1-sol",
    stdoutModel: null,
    homeFiles: { [`sessions/2026/10/25/rollout-2026-10-25T15-26-00-${SID}.jsonl`]: STUB_ROLLOUT },
  },
  live: { effort: "low" },
  makeLive: () => createCodexAgent({ credential: operatorKind() }),
  // A dummy API key: codex starts (its first line names the thread) and the turn fails on auth.
  probe: { make: () => createCodexAgent({ credential: "api-key" }), credentialText: "sk-dummy-not-a-real-key\n" },
});
