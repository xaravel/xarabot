#!/usr/bin/env bun
// A stand-in for `claude -p` in the Agent contract suite, run through a
// symlink named `claude` on the session's PATH.
//
// It reads its prompt from stdin, writes a `build` result to $XARABOT_RESULT
// whose `body` records what the session saw (argv, stdin, cwd and the
// sandbox's variables), and prints stream-json like the real CLI.

export const STUB_TOKENS = { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 };
export const STUB_COST = 0.5;
export const STUB_VERSION = "2.1.309 (Claude Code)";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    console.log(STUB_VERSION);
    return 0;
  }
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] ?? null);
  };
  const env = process.env;
  const stdin = await Bun.stdin.text();
  const session = flag("--resume") ?? crypto.randomUUID();
  const model = flag("--model");
  const seen = {
    argv: args,
    stdin,
    cwd: process.cwd(),
    credential: env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    configDir: env.CLAUDE_CONFIG_DIR ?? null,
    result: env.XARABOT_RESULT ?? null,
    sandboxed: env.XARABOT_SANDBOXED ?? null,
    githubVars: Object.keys(env).filter((k) => k.startsWith("GH_") || k.startsWith("GITHUB_")),
    session,
    model,
  };
  const out = (line: unknown): void => console.log(JSON.stringify(line));
  out({ type: "system", subtype: "init", cwd: seen.cwd, session_id: session, model, claude_code_version: "2.1.309" });
  console.log("a stray non-JSON line");
  out({ type: "assistant", message: { model, role: "assistant", content: [{ type: "text", text: "writing the result" }] }, session_id: session });
  if (seen.result === null) {
    out({ type: "result", subtype: "error", is_error: true, session_id: session, result: "XARABOT_RESULT is not set" });
    return 1;
  }
  const result = {
    kind: "build",
    outcome: "done",
    summary: "stub session",
    body: JSON.stringify(seen),
    verification: [],
    denied_actions: [],
  };
  await Bun.write(seen.result, JSON.stringify(result));
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    total_cost_usd: STUB_COST,
    usage: STUB_TOKENS,
    result: "done",
  });
  return 0;
}

if (import.meta.main) process.exitCode = await main();
