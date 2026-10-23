import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { isGitHubHost } from "../../src/core/network/hosts.ts";
import { BuildResultSchema } from "../../src/core/schemas/session-result.ts";
import type { Agent, AgentSettings } from "../../src/ports/agent.ts";
import type { LaunchSpec, Sandbox, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { STUB_COST, STUB_TOKENS } from "./fixtures/stub-claude.ts";

/**
 * The `Agent` contract (FR7, AR15, AR18): an adapter's specs, run through a
 * `Sandbox` against a stub CLI (`fixtures/stub-claude.ts`), reach the session
 * with its credential, vendor home, result path and prompt, and the adapter
 * reads the stub's session id, model and tokens back.
 */

export type AgentHarness = {
  readonly agent: Agent;
  readonly sandbox: Sandbox;
  readonly profile: SandboxProfile;
  /** The trimmed credential the session must see. */
  readonly credential: string;
  /** The settings to run with; their model must be one the adapter knows. */
  readonly settings: AgentSettings;
};

/** What the stub recorded in its result's `body`. */
type Seen = {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly credential: string | null;
  readonly configDir: string | null;
  readonly result: string | null;
  readonly sandboxed: string | null;
  readonly githubVars: readonly string[];
  readonly session: string;
  readonly model: string | null;
};

const SESSION = "0b7c3f9e-4a51-4c2e-9d0a-6f1e2b3c4d5e";

async function runSpec(h: AgentHarness, spec: LaunchSpec): Promise<{ run: SandboxRun; seen: Seen }> {
  const r = await h.sandbox.run(spec, h.profile, new AbortController().signal);
  if (!r.ok) throw new Error(`refused: ${r.error.message}`);
  expect({ exitCode: r.value.exitCode, stderr: r.value.stderr }).toEqual({ exitCode: 0, stderr: "" });
  const result = BuildResultSchema.parse(JSON.parse(readFileSync(h.profile.resultPath, "utf8")));
  return { run: r.value, seen: JSON.parse(result.body) as Seen };
}

function real(path: string): string {
  return realpathSync(path);
}

export function agentContract(make: () => AgentHarness | Promise<AgentHarness>, t: typeof test = test): void {
  t("a session sees its credential, vendor home, result path and prompt on stdin", async () => {
    const h = await make();
    const prompt = "# Task\n\nBuild Story 9.9 (`9-9-stub`)\n\n# Result\n\nWrite it to `$XARABOT_RESULT`.";
    const spec = h.agent.launchSpec({ kind: "session", prompt }, h.settings, h.profile.resultPath);
    if (!spec.ok) throw new Error(spec.error.message);
    const { run, seen } = await runSpec(h, spec.value);
    expect(seen.credential).toBe(h.credential);
    expect(seen.configDir).not.toBeNull();
    expect(real(seen.configDir ?? "")).toBe(real(h.profile.vendorHome));
    expect(real(seen.result ?? "")).toBe(real(h.profile.resultPath));
    expect(real(seen.cwd)).toBe(real(h.profile.clone));
    expect(seen.sandboxed).toBe("1");
    expect(seen.githubVars).toEqual([]);
    expect(seen.stdin).toBe(prompt);
    expect(seen.argv.join("\n")).not.toContain("Build Story");

    const usage = h.agent.parseUsage(run.stdout);
    if (!usage.ok) throw new Error(usage.error.message);
    expect(usage.value.sessionId).toBe(seen.session);
    expect(usage.value.model).toBe(seen.model);
    expect(usage.value.tokens).toEqual({
      input: STUB_TOKENS.input_tokens,
      output: STUB_TOKENS.output_tokens,
      cacheRead: STUB_TOKENS.cache_read_input_tokens,
      cacheCreation: STUB_TOKENS.cache_creation_input_tokens,
    });
    expect(usage.value.cost).toEqual({ usd: STUB_COST, estimate: true });
    expect(usage.value.isError).toBe(false);
    expect(usage.value.usageLimit).toBeNull();
    expect(h.agent.verifyModel(usage.value, h.settings)).toEqual({ ok: true, value: seen.model ?? "" });
  });

  t("a resume continues the named session and asks only for the result", async () => {
    const h = await make();
    const spec = h.agent.launchSpec({ kind: "resume", session: SESSION }, h.settings, h.profile.resultPath);
    if (!spec.ok) throw new Error(spec.error.message);
    const { run, seen } = await runSpec(h, spec.value);
    expect(seen.session).toBe(SESSION);
    expect(seen.stdin).toContain(h.profile.resultPath);
    expect(seen.credential).toBe(h.credential);
    const usage = h.agent.parseUsage(run.stdout);
    expect(usage.ok && usage.value.sessionId).toBe(SESSION);
  });

  t("a spec names no GitHub host and carries no token", async () => {
    const h = await make();
    for (const unit of [{ kind: "session", prompt: "p" }, { kind: "resume", session: SESSION }] as const) {
      const spec = h.agent.launchSpec(unit, h.settings, h.profile.resultPath);
      if (!spec.ok) throw new Error(spec.error.message);
      expect(spec.value.apiHosts.length).toBeGreaterThan(0);
      expect(spec.value.apiHosts.filter(isGitHubHost)).toEqual([]);
      expect(spec.value.argv[0]).toBe(h.agent.command);
      expect(JSON.stringify(spec.value)).not.toContain(h.credential);
      expect(JSON.stringify(spec.value)).not.toMatch(/gh[pousr]_|GH_TOKEN|GITHUB_TOKEN/);
    }
  });

  t("an unknown model's effort is refused", async () => {
    const h = await make();
    const bad = h.agent.launchSpec({ kind: "session", prompt: "p" }, { model: "xarabot-no-such-model", effort: "high" }, h.profile.resultPath);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("refused");
  });
}
