import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCredentialKind, createCodexAgent, type CodexCredentialKind } from "../../../../src/adapters/agent/codex/codex-agent.ts";
import { codexSessions, codexTokens } from "../../../../src/adapters/agent/codex/usage.ts";
import { PACKAGE_HOSTS } from "../../../../src/core/network/hosts.ts";
import { buildPrompt } from "../../../../src/core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../../../../src/core/prompt/template.ts";
import { parseSessionResult } from "../../../../src/core/schemas/session-result.ts";
import type { Agent, AgentSettings, AgentUnit } from "../../../../src/ports/agent.ts";
import type { SandboxProfile, SandboxRun } from "../../../../src/ports/sandbox.ts";
import { configDir } from "../../../../src/sandbox/environment.ts";
import { createMacSandbox } from "../../../../src/sandbox/macos.ts";
import { which } from "../../../../src/sandbox/tools.ts";
import { canSandbox, isSandboxed } from "../../../support/sandbox.ts";
import { isLive } from "../../../support/live.ts";

/**
 * Live `codex` cases (Story 3.1): the real CLI in the real macOS sandbox with
 * the operator's credential, `<config>/xarabot/vendors/codex/auth.json` or
 * `api-key`. They run only under `XARABOT_LIVE=1`, on macOS, outside a
 * session (`XARABOT_SANDBOXED` unset), with `codex` on `PATH`; otherwise they
 * report skipped. Each runs one short session at effort `low`, and prints
 * what the Maintainer records in the live evidence.
 */

const LIVE: AgentSettings = { effort: "low" };

function credentialDir(): string | null {
  const config = configDir(process.env);
  return config === null ? null : join(config, "xarabot", "vendors", "codex");
}

function operatorKind(): CodexCredentialKind | null {
  const dir = credentialDir();
  if (dir === null) return null;
  const kind = codexCredentialKind((file) => {
    try {
      lstatSync(join(dir, file));
      return true;
    } catch {
      return false;
    }
  }, dir);
  return kind.ok ? kind.value : null;
}

const kind = operatorKind();
const runnable = isLive && canSandbox && !isSandboxed && kind !== null && which("codex", process.env.PATH) !== null;
const liveCodex = test.skipIf(!runnable) as typeof test;
const liveChatGpt = test.skipIf(!runnable || kind !== "auth-json") as typeof test;

type Lane = { readonly root: string; readonly profile: SandboxProfile };

function makeLane(): Lane {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-codex-live-")));
  const lane = join(root, ".xarabot", "repos", "o__r", "lanes", "l");
  for (const d of ["clone/.git", "runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
  return {
    root,
    profile: { clone: join(lane, "clone"), vendorHome: join(lane, "vendor"), tempDir: join(lane, "tmp"), runnerGit: join(lane, "runner.git"), resultPath: join(lane, "tmp", "result.json") },
  };
}

function agent(): Agent {
  return createCodexAgent({ credential: kind ?? "auth-json" });
}

async function run(l: Lane, unit: AgentUnit, ms = 240_000): Promise<SandboxRun> {
  const s = agent().launchSpec(unit, LIVE, l.profile.resultPath);
  if (!s.ok) throw new Error(s.error.message);
  const r = await createMacSandbox({ launchingEnv: process.env }).run(s.value, l.profile, AbortSignal.timeout(ms));
  if (!r.ok) throw new Error(`sandbox refused: ${r.error.message}`);
  return r.value;
}

function hostOf(target: string): string {
  return target.replace(/:\d+$/, "");
}

describe("codex live", () => {
  liveCodex(
    "outcome mapping: a ready-for-dev halt is reported as blocked/other, never no-op, through the shared build prompt",
    async () => {
      const l = makeLane();
      try {
        const template = {
          ...PACKAGE_TEMPLATE,
          first_build: `# Task

Build Story {{story_id}} (\`{{sprint_key}}\`)

Do not run any skill and do not change any file. For this check, act as if \`bmad-build-auto\` ran and halted \`ready-for-dev\` (it stopped after planning), with the summary "planned only".`,
        };
        const prompt = buildPrompt({ template, unit: { kind: "story", id: "1.7", sprint_key: "1-7-live" }, mode: { mode: "build" }, sections: [], human_live_steps: [], result_path: l.profile.resultPath });
        if (!prompt.ok) throw new Error(prompt.error.message);
        const r = await run(l, { kind: "fresh", prompt: prompt.value });
        expect(r.exitCode).toBe(0);
        const parsed = parseSessionResult(l.profile.resultPath, readFileSync(l.profile.resultPath, "utf8"), "build");
        if (!parsed.ok) throw new Error(`${parsed.error.kind}: ${parsed.error.message}`);
        expect(parsed.value.outcome).toBe("blocked");
        expect(parsed.value.outcome === "blocked" ? parsed.value.blocked.kind : null).toBe("other");
        const u = agent().parseUsage(r.stdout, l.profile.vendorHome, r.startedAt);
        expect(u.model).toBe(agent().defaultModel);
        expect(u.failure).toBeUndefined();
      } finally {
        rmSync(l.root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  liveCodex(
    "resume: a run that wrote no result is resumed with codex exec … resume <thread_id> and writes it",
    async () => {
      const l = makeLane();
      try {
        const first = await run(l, { kind: "fresh", prompt: "Remember the word kumquat. Reply with only: ok. Write no file." });
        expect(first.exitCode).toBe(0);
        expect(existsSync(l.profile.resultPath)).toBe(false);
        const id = agent().parseUsage(first.stdout).sessionId;
        expect(id).not.toBeNull();
        const second = await run(l, { kind: "resume", sessionId: id as string });
        expect(second.exitCode).toBe(0);
        expect(agent().parseUsage(second.stdout).sessionId).toBe(id);
        expect(existsSync(l.profile.resultPath)).toBe(true);
      } finally {
        rmSync(l.root, { recursive: true, force: true });
      }
    },
    500_000,
  );

  liveCodex(
    "subagent tokens: children's tokens are added to the parent's turn.completed, which counts only the parent's own",
    async () => {
      const l = makeLane();
      try {
        const r = await run(
          l,
          {
            kind: "fresh",
            prompt:
              "Spawn two subagents in parallel in a single tool-call message. Subagent A replies with the word alpha; subagent B replies with the word beta. Do no other work. Wait for both to finish, then reply with their two answers on one line.",
          },
          300_000,
        );
        expect(r.exitCode).toBe(0);
        const usage = agent().parseUsage(r.stdout, l.profile.vendorHome, r.startedAt);
        const completed = r.stdout
          .split("\n")
          .filter((line) => line.includes('"turn.completed"'))
          .map((line) => codexTokens((JSON.parse(line) as { usage: unknown }).usage))
          .at(-1);
        const sessions = codexSessions(l.profile.vendorHome);
        const parent = sessions.find((s) => s.id === usage.sessionId);
        const children = sessions.filter((s) => s.parentId === usage.sessionId);
        console.log(JSON.stringify({ turnCompleted: completed, parentRollout: parent?.tokens, children: children.map((c) => c.tokens), parsed: usage.tokens }));
        expect(children.length).toBeGreaterThanOrEqual(1);
        // turn.completed is the parent thread's own total: the spike's open question.
        expect(completed).toEqual(parent?.tokens ?? null);
        expect((usage.tokens?.input ?? 0) + (usage.tokens?.cacheRead ?? 0)).toBeGreaterThan((completed?.input ?? 0) + (completed?.cacheRead ?? 0));
      } finally {
        rmSync(l.root, { recursive: true, force: true });
      }
    },
    400_000,
  );

  liveChatGpt(
    "auth.json: the run reports whether codex rewrote the seeded copy; the operator's file is never changed",
    async () => {
      const l = makeLane();
      const dir = credentialDir() as string;
      const before = readFileSync(join(dir, "auth.json"), "utf8");
      try {
        const r = await run(l, { kind: "fresh", prompt: "Reply with only: ok" });
        expect(r.exitCode).toBe(0);
        console.log(`credentialRewritten: ${String(r.credentialRewritten)}`);
        expect(typeof r.credentialRewritten).toBe("boolean");
        expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe(before);
      } finally {
        rmSync(l.root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  liveCodex(
    "proxy hosts: every request the session made is recorded; the allowed ones are all on the allowlist",
    async () => {
      const l = makeLane();
      try {
        const r = await run(l, { kind: "fresh", prompt: "Reply with only: ok" });
        expect(r.exitCode).toBe(0);
        const spec = agent().launchSpec({ kind: "fresh", prompt: "x" }, LIVE, l.profile.resultPath);
        if (!spec.ok) throw new Error(spec.error.message);
        const requests = r.proxyRequests ?? [];
        const hosts = [...new Set(requests.map((p) => `${p.allowed ? "allow" : "deny"} ${p.target}`))].sort();
        console.log(`proxy hosts:\n${hosts.join("\n")}`);
        expect(requests.length).toBeGreaterThan(0);
        for (const p of requests.filter((q) => q.allowed)) expect([...spec.value.apiHosts, ...PACKAGE_HOSTS]).toContain(hostOf(p.target));
      } finally {
        rmSync(l.root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
