import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createClaudeAgent } from "../../src/adapters/agent/claude/claude-agent.ts";
import { BuildResultSchema } from "../../src/core/schemas/session-result.ts";
import { refused, sandboxOk, type LaunchSpec, type Sandbox, type SandboxProfile, type SandboxResult, type SandboxRun } from "../../src/ports/sandbox.ts";
import { buildSessionEnv, configDir, sessionDirs, type LaunchingEnv } from "../../src/sandbox/environment.ts";
import { createMacSandbox } from "../../src/sandbox/macos.ts";
import { agentVersion } from "../../src/sandbox/tools.ts";
import { seedVendorHome } from "../../src/sandbox/vendor-home.ts";
import { liveSandboxTest, sandboxTest } from "../support/sandbox.ts";
import { agentContract, type AgentHarness } from "./agent.contract.ts";
import { runContract } from "./run-contract.ts";

/**
 * Runs the `Agent` contract for the `claude` adapter against the stub CLI:
 * once through an env sandbox that sets up the session exactly as the
 * macOS sandbox does (vendor home, credential, `XARABOT_RESULT`, clone as
 * cwd, prompt on stdin) but without `sandbox-exec`, and once through the
 * real macOS sandbox where the host can run it. A live smoke test runs the
 * real `claude` in the sandbox under `XARABOT_LIVE=1` with the credential.
 */

const STUB = join(import.meta.dir, "fixtures", "stub-claude.ts");
const TOKEN = "stub-oauth-token-123";
const BUN = process.execPath;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Layout = { readonly home: string; readonly profile: SandboxProfile; readonly stubBin: string; readonly launching: LaunchingEnv };

/** A fake home laid out like the Structural Seed, with the credential file and a `claude` stub on PATH. */
function layout(): Layout {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-agent-")));
  roots.push(home);
  const lane = join(home, ".xarabot", "repos", "o__r", "lanes", "l");
  for (const d of ["clone/.git", "runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
  const cred = join(home, ".config", "xarabot", "vendors", "claude", "oauth-token");
  mkdirSync(dirname(cred), { recursive: true });
  writeFileSync(cred, `${TOKEN}\n`);
  chmodSync(cred, 0o600);
  // The stub's own copy, in the temp folder: Bun reads around a script's
  // directory to load it, which the macOS sandbox allows only in its roots.
  const stubDir = join(lane, "tmp", "stub");
  mkdirSync(stubDir);
  copyFileSync(STUB, join(stubDir, "stub-claude.ts"));
  chmodSync(join(stubDir, "stub-claude.ts"), 0o755);
  const stubBin = join(home, "stub-bin");
  mkdirSync(stubBin);
  symlinkSync(join(stubDir, "stub-claude.ts"), join(stubBin, "claude"));
  return {
    home,
    stubBin,
    profile: {
      clone: join(lane, "clone"),
      vendorHome: join(lane, "vendor"),
      tempDir: join(lane, "tmp"),
      runnerGit: join(lane, "runner.git"),
      resultPath: join(lane, "tmp", "result.json"),
    },
    launching: { PATH: `${stubBin}:${dirname(BUN)}:/usr/bin:/bin`, HOME: home, GH_TOKEN: "ghs_secret", GITHUB_TOKEN: "ghs_secret2", LANG: "en_US.UTF-8" },
  };
}

/**
 * A `Sandbox` that builds the session's environment, vendor home and temp
 * folder with the macOS sandbox's own functions, then runs the agent without
 * `sandbox-exec` or the proxy. For the contract only.
 */
function envSandbox(launching: LaunchingEnv): Sandbox {
  return {
    async run(spec: LaunchSpec, profile: SandboxProfile): Promise<SandboxResult<SandboxRun>> {
      const seeded = seedVendorHome({ launching, vendor: spec.vendor, credential: spec.credential, vendorHome: profile.vendorHome });
      if (!seeded.ok) return seeded;
      const dirs = sessionDirs(profile.tempDir);
      for (const d of [dirs.bin, dirs.home]) {
        rmSync(d, { recursive: true, force: true });
        mkdirSync(d, { recursive: true, mode: 0o700 });
      }
      rmSync(profile.resultPath, { force: true });
      const cmd = spec.argv[0] ?? "";
      const agentPath = (launching["PATH"] ?? "").split(":").map((p) => join(p, cmd)).find((p) => existsSync(p));
      if (agentPath === undefined) return refused(`env sandbox: ${cmd} not on PATH`);
      symlinkSync(realpathSync(agentPath), join(dirs.bin, cmd));
      symlinkSync(BUN, join(dirs.bin, "bun"));
      const env = buildSessionEnv(launching, {
        tempDir: profile.tempDir,
        vendorHome: profile.vendorHome,
        vendorHomeEnv: spec.vendorHomeEnv,
        resultPath: join(profile.tempDir, relative(resolve(profile.tempDir), resolve(profile.resultPath))),
        ...(seeded.value.env === undefined ? {} : { credential: seeded.value.env }),
      });
      if (!env.ok) return refused(env.error.message);
      const startedAt = Date.now();
      const child = Bun.spawn([join(dirs.bin, cmd), ...spec.argv.slice(1)], {
        cwd: profile.clone,
        env: env.value,
        stdin: spec.stdin === undefined ? "ignore" : new Blob([spec.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const endedAt = Date.now();
      return sandboxOk({ pid: child.pid, exitCode, signal: null, startedAt, endedAt, durationMs: endedAt - startedAt, stdout, stderr });
    },
  };
}

function harness(sandbox: (l: Layout) => Sandbox): () => AgentHarness {
  return () => {
    const l = layout();
    return { agent: createClaudeAgent(), sandbox: sandbox(l), profile: l.profile, credential: TOKEN, settings: { model: "claude-haiku-5-5", effort: "low" } };
  };
}

runContract<AgentHarness>("Agent", [{ name: "claude (stub CLI, env sandbox)", make: harness((l) => envSandbox(l.launching)) }], (make) => agentContract(make));

runContract<AgentHarness>(
  "Agent",
  [{ name: "claude (stub CLI, macOS sandbox)", make: harness((l) => createMacSandbox({ launchingEnv: l.launching })) }],
  (make) => agentContract(make, sandboxTest),
);

describe("agentVersion feeds startCheck", () => {
  test("the stub's --version passes the start check", async () => {
    const l = layout();
    // The probe runs with the system PATH only, so call the stub through a shell wrapper naming bun.
    const wrapper = join(l.home, "wrapped");
    mkdirSync(wrapper);
    writeFileSync(join(wrapper, "claude"), `#!/bin/sh\nexec ${JSON.stringify(BUN)} ${JSON.stringify(STUB)} "$@"\n`);
    chmodSync(join(wrapper, "claude"), 0o755);
    const version = await agentVersion({ PATH: wrapper, HOME: l.home }, "claude");
    if (!version.ok) throw new Error(version.error.message);
    expect(version.value).toBe("2.1.309 (Claude Code)");
    expect(createClaudeAgent().startCheck({}, version.value).ok).toBe(true);
  });
});

/** The operator's real `claude` credential file, or `null` when it is missing. */
function liveCredential(): string | null {
  const config = configDir(process.env);
  if (config === null) return null;
  const path = join(config, "xarabot", "vendors", "claude", "oauth-token");
  return existsSync(path) ? path : null;
}

const liveWithCredential: typeof test = liveCredential() === null ? (test.skip as typeof test) : liveSandboxTest;

describe("live smoke", () => {
  liveWithCredential(
    "the real claude runs sandboxed, writes its result and reports its session",
    async () => {
      const agent = createClaudeAgent();
      const launching: LaunchingEnv = process.env;
      const version = await agentVersion(launching, agent.command);
      if (!version.ok) throw new Error(version.error.message);
      const settings = { model: "claude-haiku-5-5", effort: "low" } as const;
      const start = agent.startCheck(settings, version.value);
      if (!start.ok) throw new Error(start.error.message);

      const lane = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-live-agent-")));
      roots.push(lane);
      for (const d of ["clone/.git", "runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
      const profile: SandboxProfile = {
        clone: join(lane, "clone"),
        vendorHome: join(lane, "vendor"),
        tempDir: join(lane, "tmp"),
        runnerGit: join(lane, "runner.git"),
        resultPath: join(lane, "tmp", "result.json"),
      };
      const result = { kind: "build", outcome: "done", summary: "smoke", body: "", verification: [], denied_actions: [] };
      const prompt = `Write exactly this JSON to the file named by the environment variable XARABOT_RESULT (${profile.resultPath}), and do nothing else:\n\n${JSON.stringify(result)}\n`;
      const spec = agent.launchSpec({ kind: "session", prompt }, settings, profile.resultPath);
      if (!spec.ok) throw new Error(spec.error.message);
      const run = await createMacSandbox({ launchingEnv: launching }).run(spec.value, profile, AbortSignal.timeout(300_000));
      if (!run.ok) throw new Error(run.error.message);
      const usage = agent.parseUsage(run.value.stdout);
      if (!usage.ok) throw new Error(usage.error.message);
      // stderr in the comparison, so a failed start says why.
      expect({ exitCode: run.value.exitCode, isError: usage.value.isError, stderr: run.value.stderr.slice(0, 2000) }).toEqual({
        exitCode: 0,
        isError: false,
        stderr: "",
      });
      expect(usage.value.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(usage.value.tokens).not.toBeNull();
      expect(agent.verifyModel(usage.value, settings).ok).toBe(true);
      expect(BuildResultSchema.safeParse(JSON.parse(readFileSync(profile.resultPath, "utf8"))).success).toBe(true);
    },
    330_000,
  );
});
