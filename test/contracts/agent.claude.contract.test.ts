import { createClaudeAgent } from "../../src/adapters/agent/claude/claude-agent.ts";
import { agentContract } from "./agent.contract.ts";

const SID = "6f1c2b9e-3d4a-4e5f-8a7b-0c1d2e3f4a5b";

/** Shaped like Claude Code 2.1.309's `stream-json --verbose` output (the AR42 spike record). */
const STUB_STDOUT = [
  { type: "system", subtype: "init", session_id: SID, model: "claude-opus-5-5", apiKeySource: "none" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1761300000 } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: SID,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
  },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

agentContract({
  name: "claude",
  make: createClaudeAgent,
  tempEnv: ["CLAUDE_CODE_TMPDIR"],
  stub: { stdout: STUB_STDOUT, sessionId: SID, model: "claude-opus-5-5" },
  live: { effort: "low" },
});
