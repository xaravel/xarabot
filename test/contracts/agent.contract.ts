import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Agent, AgentSettings } from "../../src/ports/agent.ts";
import type { LaunchSpec, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { configDir } from "../../src/sandbox/environment.ts";
import { createMacSandbox } from "../../src/sandbox/macos.ts";
import { cliVersion, which } from "../../src/sandbox/tools.ts";
import { canSandbox, liveSandboxTest, sandboxTest } from "../support/sandbox.ts";
import { runContract } from "./run-contract.ts";

/**
 * The `Agent` contract (AR1): pure properties of every adapter, then the
 * adapter's launch spec run through the real macOS sandbox with a stub CLI
 * (env, working directory, stdin, resume), then live sessions with the real
 * CLI under `XARABOT_LIVE=1`. Sandbox cases report skipped off macOS and under
 * `XARABOT_SANDBOXED=1`.
 */

export type AgentHarness = {
  readonly name: string;
  readonly make: () => Agent;
  /** Variables, besides `XARABOT_RESULT`, that must name a folder inside the session's temp folder. */
  readonly tempEnv: readonly string[];
  /** Usage output in the vendor's format that the stub CLI prints, and what `parseUsage` must read from it. */
  readonly stub: { readonly stdout: string; readonly sessionId: string; readonly model: string };
  /** The settings live sessions use. */
  readonly live: AgentSettings;
};

const PROMPT = "# Task\n\nBuild Story 1.7 (`1-7-contract`)\n\nprompt-marker-7f3a\n";
const TOKEN = "tok-contract-123";
const GITHUB_HOST = /(^|\.)github(usercontent)?\.com$|(^|\.)ghcr\.io$/i;

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A stub CLI: saves stdin to the result file, prints its cwd, env, vendor home and argv, marks the vendor home, then prints `usage`. */
function stubScript(spec: LaunchSpec, usage: string): string {
  const vh = `"$${spec.vendorHomeEnv}"`;
  return [
    "#!/bin/sh",
    'cat > "$XARABOT_RESULT"',
    "printf 'cwd:%s\\n' \"$(pwd -P)\"",
    "env | while IFS= read -r l; do printf 'env:%s\\n' \"$l\"; done",
    `ls -A ${vh} | while IFS= read -r l; do printf 'home:%s\\n' "$l"; done`,
    `: > ${vh}/transcript`,
    "for a in \"$@\"; do printf 'arg:%s\\n' \"$a\"; done",
    `printf '%s\\n' ${sh(usage)}`,
    "",
  ].join("\n");
}

type Report = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly home: readonly string[];
  readonly args: readonly string[];
};

function report(stdout: string): Report {
  const env: Record<string, string> = {};
  const home: string[] = [];
  const args: string[] = [];
  let cwd = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("cwd:")) cwd = line.slice(4);
    if (line.startsWith("env:")) {
      const kv = line.slice(4);
      const at = kv.indexOf("=");
      if (at > 0) env[kv.slice(0, at)] = kv.slice(at + 1);
    }
    if (line.startsWith("home:")) home.push(line.slice(5));
    if (line.startsWith("arg:")) args.push(line.slice(4));
  }
  return { cwd, env, home, args };
}

function inside(path: string | undefined, dir: string): boolean {
  return path !== undefined && path.startsWith(`${dir}/`);
}

/** A fake lane laid out like the Structural Seed, in a fresh home. */
type Lane = { readonly root: string; readonly profile: SandboxProfile };

function makeLane(prefix: string): Lane {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const lane = join(root, ".xarabot", "repos", "o__r", "lanes", "l");
  for (const d of ["clone/.git", "runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
  return {
    root,
    profile: {
      clone: join(lane, "clone"),
      vendorHome: join(lane, "vendor"),
      tempDir: join(lane, "tmp"),
      runnerGit: join(lane, "runner.git"),
      resultPath: join(lane, "tmp", "result.json"),
    },
  };
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { kind: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

export function agentContract(h: AgentHarness): void {
  runContract("Agent", [{ name: h.name, make: h.make }], (make) => {
    const agent = async (): Promise<Agent> => await make();
    const RESULT = "/lane/tmp/result.json";

    // Pure properties: every host.

    test("the default model offers the lane's default effort, high", async () => {
      const a = await agent();
      expect(a.effortValues(a.defaultModel)).toContain("high");
      expect(a.startCheck({ effort: "high" }, a.minVersion)).toEqual({ ok: true, value: { model: a.defaultModel, version: a.minVersion } });
    });

    test("a fresh launch spec: the prompt on stdin only, a command name, no GitHub", async () => {
      const a = await agent();
      const s = unwrap(a.launchSpec({ kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT));
      expect(s.stdin).toBe(PROMPT);
      expect(s.argv.some((arg) => arg.includes("prompt-marker-7f3a"))).toBe(false);
      expect(s.argv[0]).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(s.vendor).toBe(a.vendor);
      expect(s.resume).toBeUndefined();
      expect(s.apiHosts.length).toBeGreaterThan(0);
      expect(s.apiHosts.filter((host) => GITHUB_HOST.test(host))).toEqual([]);
      const credEnv = "env" in s.credential ? s.credential.env : "";
      expect(credEnv).not.toMatch(/^(GH_|GITHUB_)/);
      expect(s.argv.join(" ")).toContain(a.defaultModel);
    });

    test("a resume launch spec: resume set, stdin names the result path", async () => {
      const a = await agent();
      const s = unwrap(a.launchSpec({ kind: "resume", sessionId: h.stub.sessionId }, { effort: "high" }, RESULT));
      expect(s.resume).toBe(true);
      expect(s.stdin).toContain(RESULT);
      expect(s.argv).toContain(h.stub.sessionId);
    });

    test("bad input is invalid", async () => {
      const a = await agent();
      for (const [unit, path] of [
        [{ kind: "fresh", prompt: "" }, RESULT],
        [{ kind: "fresh", prompt: "a\0b" }, RESULT],
        [{ kind: "fresh", prompt: PROMPT }, "relative/result.json"],
        [{ kind: "resume", sessionId: "--bad" }, RESULT],
      ] as const) {
        const r = a.launchSpec(unit, { effort: "high" }, path);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.kind).toBe("invalid");
      }
    });

    test("the start check refuses an unknown model, an unreadable version and one below minVersion", async () => {
      const a = await agent();
      expect(a.effortValues("xarabot-no-such-model")).toEqual([]);
      expect(a.startCheck({ model: "xarabot-no-such-model", effort: "high" }, a.minVersion).ok).toBe(false);
      expect(a.startCheck({ effort: "high" }, "garbage").ok).toBe(false);
      const [maj, min, patch] = a.minVersion.split(".").map(Number) as [number, number, number];
      const older = patch > 0 ? `${maj}.${min}.${patch - 1}` : min > 0 ? `${maj}.${min - 1}.999` : `${maj - 1}.999.999`;
      const r = a.startCheck({ effort: "high" }, older);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("refused");
    });

    test("parseUsage reads the stub's usage and gives nulls for empty output", async () => {
      const a = await agent();
      const u = a.parseUsage(h.stub.stdout);
      expect(u.sessionId).toBe(h.stub.sessionId);
      expect(u.model).toBe(h.stub.model);
      expect(a.parseUsage("")).toEqual({ sessionId: null, model: null, tokens: null, cost: null, usageLimit: null });
    });

    // A stub CLI in the real sandbox.

    let lane: Lane | null = null;
    let stubBin = "";
    let launching: Record<string, string> = {};

    beforeAll(async () => {
      if (!canSandbox) return;
      const a = await agent();
      lane = makeLane("xarabot-agent-");
      stubBin = join(lane.root, "stub-bin");
      mkdirSync(stubBin);
      const s = unwrap(a.launchSpec({ kind: "fresh", prompt: PROMPT }, { effort: "high" }, lane.profile.resultPath));
      const cmd = join(stubBin, s.argv[0] as string);
      writeFileSync(cmd, stubScript(s, h.stub.stdout));
      chmodSync(cmd, 0o755);
      launching = { PATH: `${stubBin}:/usr/bin:/bin`, HOME: lane.root, GH_TOKEN: "ghs_secret", GITHUB_TOKEN: "ghs_secret2", LANG: "en_US.UTF-8" };
      const cred = join(configDir(launching) as string, "xarabot", "vendors", s.vendor, s.credential.file);
      mkdirSync(dirname(cred), { recursive: true });
      writeFileSync(cred, `${TOKEN}\n`);
      chmodSync(cred, 0o600);
    });

    afterAll(() => {
      if (lane !== null) rmSync(lane.root, { recursive: true, force: true });
    });

    async function runStub(unit: Parameters<Agent["launchSpec"]>[0]): Promise<{ spec: LaunchSpec; run: SandboxRun; report: Report }> {
      const a = await agent();
      if (lane === null) throw new Error("no lane");
      const s = unwrap(a.launchSpec(unit, { effort: "high" }, lane.profile.resultPath));
      const sandbox = createMacSandbox({ launchingEnv: launching });
      const r = unwrap(await sandbox.run(s, lane.profile, new AbortController().signal));
      return { spec: s, run: r, report: report(r.stdout) };
    }

    sandboxTest("a stub session: env, cwd, stdin and usage", async () => {
      const { spec: s, run: r, report: rep } = await runStub({ kind: "fresh", prompt: PROMPT });
      const p = (lane as Lane).profile;
      expect(r.exitCode).toBe(0);
      expect(rep.cwd).toBe(p.clone);
      expect(rep.env["XARABOT_RESULT"]).toBe(p.resultPath);
      expect(inside(rep.env["XARABOT_RESULT"], p.tempDir)).toBe(true);
      expect(rep.env[s.vendorHomeEnv]).toBe(p.vendorHome);
      if ("env" in s.credential) expect(rep.env[s.credential.env]).toBe(TOKEN);
      for (const name of h.tempEnv) {
        expect(inside(rep.env[name], p.tempDir)).toBe(true);
        expect(existsSync(rep.env[name] as string)).toBe(true);
      }
      expect(Object.keys(rep.env).filter((k) => k.startsWith("GH_") || k.startsWith("GITHUB_"))).toEqual([]);
      expect(rep.args).toEqual(s.argv.slice(1));
      expect(rep.home).not.toContain("transcript");
      expect(readFileSync(p.resultPath, "utf8")).toBe(PROMPT);
      const u = (await agent()).parseUsage(r.stdout);
      expect(u.sessionId).toBe(h.stub.sessionId);
      expect(u.model).toBe(h.stub.model);
    });

    sandboxTest("a resume keeps the vendor home; the next fresh session empties it", async () => {
      await runStub({ kind: "fresh", prompt: PROMPT });
      const resumed = await runStub({ kind: "resume", sessionId: h.stub.sessionId });
      expect(resumed.run.exitCode).toBe(0);
      expect(resumed.report.home).toContain("transcript");
      expect(readFileSync((lane as Lane).profile.resultPath, "utf8")).toBe(resumed.spec.stdin as string);
      const fresh = await runStub({ kind: "fresh", prompt: PROMPT });
      expect(fresh.report.home).not.toContain("transcript");
    });

    // Live sessions with the real CLI.

    function liveLane(): { lane: Lane; launching: Record<string, string | undefined> } {
      const l = makeLane("xarabot-agent-live-");
      return { lane: l, launching: process.env };
    }

    // The real CLI with a dummy credential: it must start in the sandbox; auth may fail.
    const probe = unwrap(h.make().launchSpec({ kind: "fresh", prompt: PROMPT }, h.live, RESULT));
    const realCli = test.skipIf(!canSandbox || which(probe.argv[0] as string, process.env.PATH) === null) as typeof test;
    realCli(
      "the real CLI passes the start check and starts in the sandbox without EPERM",
      async () => {
        const a = await agent();
        const l = makeLane("xarabot-agent-start-");
        try {
          const env = { PATH: process.env.PATH ?? "", HOME: l.root, LANG: "en_US.UTF-8" };
          const s = unwrap(a.launchSpec({ kind: "fresh", prompt: "Reply with the single word OK. Use no tools." }, h.live, l.profile.resultPath));
          const cred = join(configDir(env) as string, "xarabot", "vendors", s.vendor, s.credential.file);
          mkdirSync(dirname(cred), { recursive: true });
          writeFileSync(cred, "dummy-not-a-real-token\n");
          chmodSync(cred, 0o600);
          unwrap(a.startCheck(h.live, unwrap(await cliVersion(s.argv[0] as string, env))));
          const r = unwrap(await createMacSandbox({ launchingEnv: env }).run(s, l.profile, AbortSignal.timeout(60_000)));
          expect(`${r.stdout}\n${r.stderr}`).not.toContain("EPERM");
          // It started: the init line names the session.
          expect(a.parseUsage(r.stdout).sessionId).not.toBeNull();
        } finally {
          rmSync(l.root, { recursive: true, force: true });
        }
      },
      90_000,
    );

    liveSandboxTest(
      "live: a smoke session writes a result and reports its usage",
      async () => {
        const a = await agent();
        const { lane: l, launching: env } = liveLane();
        try {
          const prompt = `Write exactly the JSON object {"ok":true} to the file named by the environment variable $XARABOT_RESULT, which is \`${l.profile.resultPath}\`. Do nothing else, and do nothing after it.`;
          const s = unwrap(a.launchSpec({ kind: "fresh", prompt }, h.live, l.profile.resultPath));
          const r = unwrap(await createMacSandbox({ launchingEnv: env }).run(s, l.profile, AbortSignal.timeout(240_000)));
          expect(r.exitCode).toBe(0);
          expect(JSON.parse(readFileSync(l.profile.resultPath, "utf8"))).toEqual({ ok: true });
          const u = a.parseUsage(r.stdout);
          expect(u.sessionId).not.toBeNull();
          expect(u.model).toBe(h.live.model ?? a.defaultModel);
          expect(u.tokens).not.toBeNull();
          expect(u.cost).not.toBeNull();
          expect(u.usageLimit).toBeNull();
        } finally {
          rmSync(l.root, { recursive: true, force: true });
        }
      },
      300_000,
    );
  });
}
