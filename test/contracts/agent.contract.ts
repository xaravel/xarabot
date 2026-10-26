import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Agent, AgentLaunchSpec, AgentSettings } from "../../src/ports/agent.ts";
import type { LaunchSpec, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { configDir } from "../../src/sandbox/environment.ts";
import { createMacSandbox } from "../../src/sandbox/macos.ts";
import { cliVersion, which } from "../../src/sandbox/tools.ts";
import { isLive } from "../support/live.ts";
import { canSandbox, liveSandboxTest, sandboxTest } from "../support/sandbox.ts";
import { runContract } from "./run-contract.ts";

/**
 * The `Agent` contract (AR1): pure properties of every adapter, then the
 * adapter's launch spec run through the real macOS sandbox with a stub CLI
 * (env, working directory, the prompt, the credential, resume), then the
 * real CLI (a start with a dummy credential, and live sessions), only under
 * `XARABOT_LIVE=1`. Where the prompt goes (stdin or the last argument) and
 * how the credential is passed (a variable or a vendor-home file) come from
 * the adapter's own spec and the harness. Sandbox
 * cases report skipped off macOS and under `XARABOT_SANDBOXED=1`; real-CLI
 * cases also report skipped without `XARABOT_LIVE=1`.
 */

export type AgentHarness = {
  readonly name: string;
  readonly make: () => Agent;
  /** Where a fresh prompt goes: on stdin, or as the last argument (after `--`) with no stdin. */
  readonly prompt: "stdin" | "argv";
  /** Variables, besides `XARABOT_RESULT`, that must name a folder inside the session's temp folder. */
  readonly tempEnv: readonly string[];
  /** What the stub's credential file holds; default a one-line token. */
  readonly credentialText?: string;
  /**
   * Usage output in the vendor's format that the stub CLI prints, and what
   * `parseUsage` must read from it. `homeFiles` (paths relative to the vendor
   * home) are what the stub also writes there, for a CLI that keeps its
   * model in session files: `model` is what `parseUsage` reads given the
   * vendor home, `stdoutModel` (default `model`) from stdout alone.
   */
  readonly stub: {
    readonly stdout: string;
    readonly sessionId: string;
    readonly model: string;
    readonly stdoutModel?: string | null;
    readonly homeFiles?: Readonly<Record<string, string>>;
  };
  /** The settings live sessions use. */
  readonly live: AgentSettings;
  /** The adapter live sessions use, with the operator's real credential; default `make`. */
  readonly makeLive?: () => Agent;
  /** The adapter and dummy credential text the real-CLI start check uses; default `make` and a one-line dummy token. */
  readonly probe?: { readonly make: () => Agent; readonly credentialText: string };
};

const PROMPT = "# Task\n\nBuild Story 1.7 (`1-7-contract`)\n\nprompt-marker-7f3a\n";
const TOKEN = "tok-contract-123";
const GITHUB_HOST = /(^|\.)github(usercontent)?\.com$|(^|\.)ghcr\.io$/i;

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Where a spec puts its prompt: stdin, or the last argument. */
function promptOf(spec: LaunchSpec): string | undefined {
  return spec.stdin ?? spec.argv.at(-1);
}

/**
 * A stub CLI: saves its prompt (stdin, or its last argument) to the result
 * file, prints its cwd, env, vendor home and argv (each argument in hex, so
 * a multi-line prompt stays one line), marks the vendor home, writes the
 * harness's home files, then prints `usage`.
 */
function stubScript(spec: LaunchSpec, usage: string, prompt: AgentHarness["prompt"], homeFiles: Readonly<Record<string, string>>): string {
  const vh = `"$${spec.vendorHomeEnv}"`;
  const files = Object.entries(homeFiles).flatMap(([rel, text]) => [`mkdir -p "$(dirname ${vh}/${sh(rel)})"`, `printf '%s' ${sh(text)} > ${vh}/${sh(rel)}`]);
  return [
    "#!/bin/sh",
    prompt === "stdin" ? 'cat > "$XARABOT_RESULT"' : 'eval "last=\\${$#}"; printf \'%s\' "$last" > "$XARABOT_RESULT"',
    "printf 'cwd:%s\\n' \"$(pwd -P)\"",
    "env | while IFS= read -r l; do printf 'env:%s\\n' \"$l\"; done",
    `ls -A ${vh} | while IFS= read -r l; do printf 'home:%s\\n' "$l"; done`,
    `: > ${vh}/transcript`,
    ...files,
    "for a in \"$@\"; do printf 'arg:%s\\n' \"$(printf '%s' \"$a\" | od -An -tx1 | tr -d ' \\n')\"; done",
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
    if (line.startsWith("arg:")) args.push(Buffer.from(line.slice(4), "hex").toString("utf8"));
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

    test(`a fresh launch spec: the prompt ${h.prompt === "stdin" ? "on stdin only" : "last in argv, after --, with no stdin"}, a command name, no GitHub`, async () => {
      const a = await agent();
      const s = unwrap(a.launchSpec({ kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT));
      if (h.prompt === "stdin") {
        expect(s.stdin).toBe(PROMPT);
        expect(s.argv.some((arg) => arg.includes("prompt-marker-7f3a"))).toBe(false);
      } else {
        expect(s.stdin).toBeUndefined();
        expect(s.argv.slice(-2)).toEqual(["--", PROMPT]);
        expect(s.argv.filter((arg) => arg.includes("prompt-marker-7f3a"))).toHaveLength(1);
      }
      expect(s.argv[0]).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(s.vendor).toBe(a.vendor);
      expect(s.resume).toBeUndefined();
      expect(s.apiHosts.length).toBeGreaterThan(0);
      expect(s.apiHosts.filter((host) => GITHUB_HOST.test(host))).toEqual([]);
      const credEnv = "env" in s.credential ? s.credential.env : "";
      expect(credEnv).not.toMatch(/^(GH_|GITHUB_)/);
      expect(s.argv.join(" ")).toContain(a.defaultModel);
    });

    test("a resume launch spec: resume set, its prompt names the result path", async () => {
      const a = await agent();
      const s = unwrap(a.launchSpec({ kind: "resume", sessionId: h.stub.sessionId }, { effort: "high" }, RESULT));
      expect(s.resume).toBe(true);
      expect(promptOf(s)).toContain(RESULT);
      if (h.prompt === "argv") expect(s.stdin).toBeUndefined();
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
      expect(u.model).toBe(h.stub.stdoutModel === undefined ? h.stub.model : h.stub.stdoutModel);
      expect(a.parseUsage("")).toEqual({ sessionId: null, model: null, tokens: null, cost: null, usageLimit: null });
      expect(a.parseUsage("", "/nonexistent/xarabot-vendor-home", 0)).toEqual({ sessionId: null, model: null, tokens: null, cost: null, usageLimit: null });
    });

    test("the stub CLI itself, run with sh outside any sandbox: the prompt, argv and home files round-trip", async () => {
      const a = await agent();
      const root = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-agent-stub-")));
      try {
        const vendorHome = join(root, "vendor");
        mkdirSync(vendorHome);
        const resultPath = join(root, "result.json");
        const s = unwrap(a.launchSpec({ kind: "fresh", prompt: PROMPT }, { effort: "high" }, resultPath));
        const script = join(root, "stub");
        writeFileSync(script, stubScript(s, h.stub.stdout, h.prompt, h.stub.homeFiles ?? {}));
        chmodSync(script, 0o755);
        const child = Bun.spawn([script, ...s.argv.slice(1)], {
          cwd: root,
          env: { PATH: "/usr/bin:/bin", XARABOT_RESULT: resultPath, [s.vendorHomeEnv]: vendorHome },
          stdin: s.stdin === undefined ? "ignore" : new Blob([s.stdin]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect(code).toBe(0);
        expect(readFileSync(resultPath, "utf8")).toBe(PROMPT);
        expect(report(stdout).args).toEqual(s.argv.slice(1));
        for (const [rel, text] of Object.entries(h.stub.homeFiles ?? {})) expect(readFileSync(join(vendorHome, rel), "utf8")).toBe(text);
        expect(a.parseUsage(stdout, vendorHome, 0).model).toBe(h.stub.model);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
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
      writeFileSync(cmd, stubScript(s, h.stub.stdout, h.prompt, h.stub.homeFiles ?? {}));
      chmodSync(cmd, 0o755);
      launching = { PATH: `${stubBin}:/usr/bin:/bin`, HOME: lane.root, GH_TOKEN: "ghs_secret", GITHUB_TOKEN: "ghs_secret2", LANG: "en_US.UTF-8" };
      const cred = join(configDir(launching) as string, "xarabot", "vendors", s.vendor, s.credential.file);
      mkdirSync(dirname(cred), { recursive: true });
      writeFileSync(cred, h.credentialText ?? `${TOKEN}\n`);
      chmodSync(cred, 0o600);
    });

    afterAll(() => {
      if (lane !== null) rmSync(lane.root, { recursive: true, force: true });
    });

    async function runStub(unit: Parameters<Agent["launchSpec"]>[0]): Promise<{ spec: AgentLaunchSpec; run: SandboxRun; report: Report }> {
      const a = await agent();
      if (lane === null) throw new Error("no lane");
      const s = unwrap(a.launchSpec(unit, { effort: "high" }, lane.profile.resultPath));
      const sandbox = createMacSandbox({ launchingEnv: launching });
      const r = unwrap(await sandbox.run(s, lane.profile, new AbortController().signal));
      return { spec: s, run: r, report: report(r.stdout) };
    }

    sandboxTest("a stub session: env, cwd, the prompt, the credential and usage", async () => {
      const { spec: s, run: r, report: rep } = await runStub({ kind: "fresh", prompt: PROMPT });
      const p = (lane as Lane).profile;
      expect(r.exitCode).toBe(0);
      expect(rep.cwd).toBe(p.clone);
      expect(rep.env["XARABOT_RESULT"]).toBe(p.resultPath);
      expect(inside(rep.env["XARABOT_RESULT"], p.tempDir)).toBe(true);
      expect(rep.env[s.vendorHomeEnv]).toBe(p.vendorHome);
      if ("env" in s.credential) expect(rep.env[s.credential.env]).toBe(TOKEN);
      if ("homeFile" in s.credential) {
        // Seeded into the fresh vendor home, mode 600; the stub left it as it was.
        expect(rep.home).toContain(s.credential.homeFile);
        expect(r.credentialRewritten).toBe(false);
      }
      if (h.prompt === "argv") expect(s.stdin).toBeUndefined();
      for (const name of h.tempEnv) {
        expect(inside(rep.env[name], p.tempDir)).toBe(true);
        expect(existsSync(rep.env[name] as string)).toBe(true);
      }
      expect(Object.keys(rep.env).filter((k) => k.startsWith("GH_") || k.startsWith("GITHUB_"))).toEqual([]);
      expect(rep.args).toEqual(s.argv.slice(1));
      expect(rep.home).not.toContain("transcript");
      expect(readFileSync(p.resultPath, "utf8")).toBe(PROMPT);
      const u = (await agent()).parseUsage(r.stdout, p.vendorHome, r.startedAt);
      expect(u.sessionId).toBe(h.stub.sessionId);
      expect(u.model).toBe(h.stub.model);
    });

    sandboxTest("a resume keeps the vendor home; the next fresh session empties it", async () => {
      await runStub({ kind: "fresh", prompt: PROMPT });
      const resumed = await runStub({ kind: "resume", sessionId: h.stub.sessionId });
      expect(resumed.run.exitCode).toBe(0);
      expect(resumed.report.home).toContain("transcript");
      expect(readFileSync((lane as Lane).profile.resultPath, "utf8")).toBe(promptOf(resumed.spec) as string);
      const fresh = await runStub({ kind: "fresh", prompt: PROMPT });
      expect(fresh.report.home).not.toContain("transcript");
    });

    // Live sessions with the real CLI.

    function liveLane(): { lane: Lane; launching: Record<string, string | undefined> } {
      const l = makeLane("xarabot-agent-live-");
      return { lane: l, launching: process.env };
    }

    // The real CLI with a dummy credential, under `XARABOT_LIVE=1`: it must start in the sandbox; auth may fail.
    const probe = unwrap(h.make().launchSpec({ kind: "fresh", prompt: PROMPT }, h.live, RESULT));
    const realCli = test.skipIf(!isLive || !canSandbox || which(probe.argv[0] as string, process.env.PATH) === null) as typeof test;
    realCli(
      "the real CLI passes the start check and starts in the sandbox without EPERM",
      async () => {
        const a = h.probe?.make() ?? (await agent());
        const l = makeLane("xarabot-agent-start-");
        try {
          const env = { PATH: process.env.PATH ?? "", HOME: l.root, LANG: "en_US.UTF-8" };
          const s = unwrap(a.launchSpec({ kind: "fresh", prompt: "Reply with the single word OK. Use no tools." }, h.live, l.profile.resultPath));
          const cred = join(configDir(env) as string, "xarabot", "vendors", s.vendor, s.credential.file);
          mkdirSync(dirname(cred), { recursive: true });
          writeFileSync(cred, h.probe?.credentialText ?? "dummy-not-a-real-token\n");
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
        const a = h.makeLive?.() ?? (await agent());
        const { lane: l, launching: env } = liveLane();
        try {
          const prompt = `Write exactly the JSON object {"ok":true} to the file named by the environment variable $XARABOT_RESULT, which is \`${l.profile.resultPath}\`. Do nothing else, and do nothing after it.`;
          const s = unwrap(a.launchSpec({ kind: "fresh", prompt }, h.live, l.profile.resultPath));
          const r = unwrap(await createMacSandbox({ launchingEnv: env }).run(s, l.profile, AbortSignal.timeout(240_000)));
          expect(r.exitCode).toBe(0);
          expect(JSON.parse(readFileSync(l.profile.resultPath, "utf8"))).toEqual({ ok: true });
          const u = a.parseUsage(r.stdout, l.profile.vendorHome, r.startedAt);
          expect(u.sessionId).not.toBeNull();
          expect(u.model).toBe(h.live.model ?? a.defaultModel);
          expect(u.failure).toBeUndefined();
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
