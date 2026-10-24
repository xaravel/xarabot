import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeLaunchSpec, claudeStartCheck } from "../../src/adapters/agent/claude/claude-agent.ts";
import { parseClaudeUsage } from "../../src/adapters/agent/claude/usage.ts";
import { fetchBotUserId } from "../../src/adapters/forge/github/bot-user.ts";
import { createGitHubFetch } from "../../src/adapters/forge/github/fetch-shas.ts";
import { createGitHubForge } from "../../src/adapters/forge/github/github-forge.ts";
import { GITHUB_OPERATIONS, isSuccess, request, type Operation } from "../../src/adapters/forge/github/http.ts";
import { openRunnerGit, runGit } from "../../src/adapters/forge/github/runner-git.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { laneDirFor } from "../../src/cli/host-paths.ts";
import type { Connect } from "../../src/cli/lane-connection.ts";
import { laneRun } from "../../src/cli/lane-run.ts";
import { approvalPaths } from "../../src/core/ci/approval.ts";
import { loadRepoConfig } from "../../src/core/config/load-repo-config.ts";
import { storySpecGlob } from "../../src/core/config/story-spec-path.ts";
import { checkBuildSpec, specMatches } from "../../src/core/lane/build-check.ts";
import { runnerFileText } from "../../src/core/lane/runner.ts";
import { USAGE_LIMIT_MARGIN_MS } from "../../src/core/lane/waits.ts";
import { next } from "../../src/core/next/next.ts";
import { assembleSnapshot } from "../../src/core/next/snapshot.ts";
import { CONFIG_DEFAULTS } from "../../src/core/schemas/config.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import { parseSessionResult } from "../../src/core/schemas/session-result.ts";
import { readsPath } from "../../src/lane/lane-process.ts";
import { laneLayout } from "../../src/lane/lane-store.ts";
import { DEFAULT_POLL_MS } from "../../src/lane/wait.ts";
import type { ForgeResult } from "../../src/ports/forge.ts";
import type { SandboxProfile } from "../../src/ports/sandbox.ts";
import { configDir } from "../../src/sandbox/environment.ts";
import { createMacSandbox } from "../../src/sandbox/macos.ts";
import { cliVersion } from "../../src/sandbox/tools.ts";
import { cleanupScratch, LIVE_LOGIN, liveCredentials, liveGithubEnabled, liveRepo, prefixed, type RawCall } from "../support/live-github.ts";
import { canSandbox, sandboxTest } from "../support/sandbox.ts";
import { checkBotCommit } from "./bot-commit.ts";
import { scratchSeed, SEED_SPRINT_KEY } from "./scratch-seed.ts";
import { canaryPath, STUB_SPEC_PATH, STUB_VERSION, stubClaudeScript, type StubParams } from "./stub-claude.ts";

/**
 * The canary (Story 1.20, NFR13, NFR14). Non-live: the stub CLI's phases in
 * the real sandbox, the scratch seed through `loadRepoConfig` and `next`,
 * and the commit check. Live (`XARABOT_LIVE=1` with
 * `XARABOT_LIVE_GITHUB_REPO` and `XARABOT_LIVE_GITHUB_LOGIN`, on the host,
 * outside any sandbox): one real `laneRun` against the seeded scratch repo,
 * from a usage-limit sleep through the bot commit, the PR, CI, the merge
 * queue and `merged`, then a STOP in the trailing wait.
 */

const ROOT = join(import.meta.dir, "..", "..");
/**
 * The canary's lane name. Ledger records name their lane `coordinator` or
 * `builder-<n>` (`LaneName`), so the canary's builder lane, in its own temp
 * `host.yaml`, is `builder-1`.
 */
const LANE = "builder-1";
const nowS = (): number => Math.floor(Date.now() / 1000);

/** A stub `claude` in `<root>/bin`, beside a fresh home holding the dummy credential. */
type StubWorld = { readonly root: string; readonly bin: string; readonly home: string };

function stubWorld(prefix: string): StubWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, bin, home };
}

function writeStub(bin: string, p: StubParams): void {
  const path = join(bin, "claude");
  writeFileSync(path, stubClaudeScript(p));
  chmodSync(path, 0o755);
}

function writeDummyCredential(configRoot: string): void {
  const file = join(configRoot, "xarabot", "vendors", "claude", "oauth-token");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "sk-ant-oat-canary-dummy\n");
  chmodSync(file, 0o600);
}

// ------------------------------------------------------------ the stub CLI

describe("stub claude", () => {
  test("--version passes cliVersion and claudeStartCheck", async () => {
    const w = stubWorld("xarabot-canary-ver-");
    try {
      writeStub(w.bin, { limitUntil: nowS() + 3600, reset: nowS() + 60, runId: "ver" });
      const v = await cliVersion("claude", { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home });
      expect(v).toEqual({ ok: true, value: STUB_VERSION });
      if (!v.ok) return;
      expect(claudeStartCheck({ effort: "high" }, v.value).ok).toBe(true);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  test("bad parameters are refused", () => {
    expect(() => stubClaudeScript({ limitUntil: 1, reset: 1, runId: "a b" })).toThrow();
    expect(() => stubClaudeScript({ limitUntil: 1, reset: 1, runId: "a", specPath: "../x.md" })).toThrow();
    expect(() => stubClaudeScript({ limitUntil: 1.5, reset: 1, runId: "a" })).toThrow();
  });

  let w: StubWorld | null = null;
  let profile: SandboxProfile;
  let launching: Record<string, string>;

  beforeAll(() => {
    if (!canSandbox) return;
    w = stubWorld("xarabot-canary-stub-");
    const lane = join(w.home, ".xarabot", "repos", "o__r", "lanes", "l");
    for (const d of ["clone/.git", "runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
    profile = {
      clone: join(lane, "clone"),
      vendorHome: join(lane, "vendor"),
      tempDir: join(lane, "tmp"),
      runnerGit: join(lane, "runner.git"),
      resultPath: join(lane, "tmp", "result.json"),
    };
    launching = { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, LANG: "en_US.UTF-8" };
    writeDummyCredential(configDir(launching) as string);
  });

  afterAll(() => {
    if (w !== null) rmSync(w.root, { recursive: true, force: true });
  });

  /** Runs the stub once in the real sandbox, the way the lane launches `claude`. */
  async function runStub(p: StubParams) {
    const world = w as StubWorld;
    writeStub(world.bin, p);
    rmSync(profile.resultPath, { force: true });
    const spec = claudeLaunchSpec({ kind: "fresh", prompt: "Build Story 1.1 (`1-1-canary`)\n" }, { effort: "high" }, profile.resultPath);
    if (!spec.ok) throw new Error(spec.error.message);
    const r = await createMacSandbox({ launchingEnv: launching }).run(spec.value, profile, new AbortController().signal);
    if (!r.ok) throw new Error(`refused: ${r.error.message}`);
    return r.value;
  }

  sandboxTest("limit phase: no result, exit 1, and parseClaudeUsage reads the reset", async () => {
    const reset = nowS() + 30;
    const run = await runStub({ limitUntil: reset + 119, reset, runId: "limit" });
    expect(run.exitCode).toBe(1);
    expect(existsSync(profile.resultPath)).toBe(false);
    expect(existsSync(join(profile.clone, canaryPath("limit")))).toBe(false);
    expect(parseClaudeUsage(run.stdout).usageLimit).toEqual({ resetAt: reset * 1000 });
  });

  sandboxTest("build phase: a valid build result, a done spec and the canary file", async () => {
    const limitUntil = nowS();
    const run = await runStub({ limitUntil, reset: limitUntil - 119, runId: "build" });
    expect(run.exitCode).toBe(0);
    expect(parseClaudeUsage(run.stdout).usageLimit).toBeNull();
    const result = parseSessionResult(profile.resultPath, readFileSync(profile.resultPath, "utf8"), "build");
    expect(result.ok ? result.value.outcome : result.error.message).toBe("done");
    const glob = storySpecGlob(CONFIG_DEFAULTS.story_spec_path, "1.1");
    expect(glob.ok).toBe(true);
    if (glob.ok) expect(specMatches(glob.value, [STUB_SPEC_PATH, canaryPath("build")])).toEqual([STUB_SPEC_PATH]);
    const spec = checkBuildSpec("done", readFileSync(join(profile.clone, STUB_SPEC_PATH), "utf8"));
    expect(spec.ok ? spec.value.status : spec.error.message).toBe("done");
    expect(existsSync(join(profile.clone, canaryPath("build")))).toBe(true);
  });
});

// ------------------------------------------------------------ the scratch seed

describe("scratch seed", () => {
  const REPO = "acme/canary";
  const LOGIN = "alice";
  const HOST = "22222222-2222-4222-8222-222222222222";

  test("as main with an empty ledger: config loads, next picks story:1.1, the stub's paths need no approval", async () => {
    const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: scratchSeed({ repo: REPO, login: LOGIN }) });
    const snapped = await fake.forge.snapshot({ signal: AbortSignal.timeout(10_000), read: readsPath });
    if (!snapped.ok) throw new Error(snapped.error.message);
    const snap = snapped.value;
    const repo = loadRepoConfig({ repo: REPO, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
    if (!repo.ok) throw new Error(`${repo.error.kind}: ${repo.error.message}`);
    expect(repo.value.repo.policy.unattended_adapters).toEqual(["claude"]);
    expect(repo.value.repo.policy.expected_checks).toEqual(["check"]);
    expect(repo.value.repo.config.maintainer).toBe(LOGIN);

    const assembled = assembleSnapshot({
      repo: REPO,
      now: snap.now,
      tree: [...snap.main.tree],
      files: { ...snap.main.files },
      main_sha: snap.main.sha,
      blob_shas: snap.main.blob_shas,
      ledger_tip: snap.ledger.tip,
      ledger_files: snap.ledger.files,
      prs: snap.prs,
      escalations: null,
      lane: { owner: LOGIN, host: HOST, lane: LANE },
      role: "builder",
    });
    if (!assembled.ok) throw new Error(`${assembled.error.kind}: ${assembled.error.message}`);
    const picked = next(assembled.value, "builder");
    expect(picked.kind).toBe("unit");
    if (picked.kind !== "unit") return;
    expect(picked.story.unit).toBe("story:1.1");
    expect(picked.story.sprint_key).toBe(SEED_SPRINT_KEY);
    expect(picked.story.globs).toEqual(["canary/**"]);

    const policy = repo.value.repo.policy;
    expect(approvalPaths([canaryPath("run-1"), STUB_SPEC_PATH], [...policy.owner_approval_paths, ...policy.effective_protected_paths])).toEqual([]);
  });

  test("the CI workflow runs a check job on pull_request and merge_group", () => {
    const ci = Bun.YAML.parse(scratchSeed({ repo: REPO, login: LOGIN })[".github/workflows/ci.yml"] as string) as {
      on: Record<string, unknown>;
      jobs: Record<string, unknown>;
    };
    expect(Object.keys(ci.on).sort()).toEqual(["merge_group", "pull_request"]);
    expect(Object.keys(ci.jobs)).toEqual(["check"]);
  });

  test("a numeric login stays a string: the seed still loads", async () => {
    const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: scratchSeed({ repo: "123/456", login: "123" }) });
    const snapped = await fake.forge.snapshot({ signal: AbortSignal.timeout(10_000), read: readsPath });
    if (!snapped.ok) throw new Error(snapped.error.message);
    const s = snapped.value;
    const repo = loadRepoConfig({ repo: "123/456", now: s.now, tree: [...s.main.tree], files: { ...s.main.files } });
    expect(repo.ok ? repo.value.repo.config.maintainer : repo.error.message).toBe("123");
  });

  test("bad parameters are refused", () => {
    expect(() => scratchSeed({ repo: "nope", login: LOGIN })).toThrow();
    expect(() => scratchSeed({ repo: REPO, login: "-bad" })).toThrow();
  });

  test("run as a script, it writes the files into <dir>", () => {
    const dir = mkdtempSync(join(tmpdir(), "xarabot-canary-seed-"));
    try {
      const r = Bun.spawnSync([process.execPath, "test/e2e/scratch-seed.ts", dir, REPO, LOGIN], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      for (const [path, text] of Object.entries(scratchSeed({ repo: REPO, login: LOGIN }))) {
        expect(readFileSync(join(dir, path), "utf8")).toBe(text);
      }
      const usage = Bun.spawnSync([process.execPath, "test/e2e/scratch-seed.ts", dir], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(usage.exitCode).toBe(1);
      expect(usage.stderr.toString()).toContain("usage:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ the commit check

describe("checkBotCommit", () => {
  const LOGIN = "alice";
  const BOT = "alice-xarabot[bot]";
  const EMAIL = "4242+alice-xarabot[bot]@users.noreply.github.com";
  const commit = (o: { author?: string; committer?: string; message?: string } = {}): string =>
    [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "parent 1111111111111111111111111111111111111111",
      `author ${o.author ?? `${BOT} <${EMAIL}>`} 1761213600 +0000`,
      `committer ${o.committer ?? `${BOT} <${EMAIL}>`} 1761213600 +0000`,
      "",
      o.message ?? "1.1: Canary run abc\n",
    ].join("\n");

  test.each([
    ["the bot, a clean message", commit(), null],
    ["the bot, a body without trailers", commit({ message: "1.1: Canary\n\nAdds canary/abc.md.\n" }), null],
    ["a human author", commit({ author: "Alice <alice@example.com>" }), '"Alice"'],
    ["a human committer", commit({ committer: `${BOT} <alice@example.com>` }), "committer email"],
    ["another owner's bot", commit({ author: `bob-xarabot[bot] <1+bob-xarabot[bot]@users.noreply.github.com>` }), "bob-xarabot[bot]"],
    ["Co-Authored-By", commit({ message: "1.1: Canary\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n" }), "Co-Authored-By"],
    ["Generated with", commit({ message: "1.1: Canary\n\nGenerated with Claude Code\n" }), "Generated with"],
    ["a bot email without the <id>+ prefix", commit({ committer: `${BOT} <x+alice-xarabot[bot]@users.noreply.github.com>` }), "email"],
    ["a human committer name with the bot email", commit({ committer: `Alice <${EMAIL}>` }), "committer"],
    ["a Signed-off-by: trailer", commit({ message: "1.1: Canary\n\nBody.\n\nSigned-off-by: Alice <alice@example.com>\n" }), "trailer"],
  ] as const)("%s", (_name, raw, fragment) => {
    const r = checkBotCommit(raw, LOGIN);
    if (fragment === null) expect(r).toEqual({ ok: true });
    else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(fragment);
    }
  });
});

// ------------------------------------------------------------ skip reporting

/** The live case's name; nothing else in this file contains it, so `-t` picks it alone. */
const LIVE_CASE = "live canary: a usage limit, the claim, the bot commit, the PR, CI, the queue, merged, then STOP in the trailing wait";

describe("live switch", () => {
  const nested = (extra: Record<string, string>, unset: readonly string[]): { code: number; output: string } => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !unset.includes(k)) env[k] = v;
    Object.assign(env, extra);
    const r = Bun.spawnSync([process.execPath, "test", "test/e2e/canary.test.ts", "-t", "^live canary:"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    return { code: r.exitCode ?? -1, output: r.stdout.toString() + r.stderr.toString() };
  };
  const SCRATCH = { XARABOT_LIVE_GITHUB_REPO: "acme/canary", XARABOT_LIVE_GITHUB_LOGIN: "alice" };

  test("XARABOT_LIVE unset: the live canary reports skipped", () => {
    const r = nested(SCRATCH, ["XARABOT_LIVE"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b1 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  });

  test("XARABOT_LIVE=1 inside a sandbox (XARABOT_SANDBOXED=1): the live canary reports skipped", () => {
    const r = nested({ ...SCRATCH, XARABOT_LIVE: "1", XARABOT_SANDBOXED: "1" }, []);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b1 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  });
});

// ------------------------------------------------------------ live

const liveCanary = test.skipIf(!canSandbox || !liveGithubEnabled) as typeof test;

/** How often the watcher looks for `outcome` and `wait.pid`. */
const WATCH_MS = 250;
/** The lane's own deadline here; the test's timeout leaves room for cleanup after it. */
const LANE_DEADLINE_MS = 40 * 60_000;
const callSignal = (): AbortSignal => AbortSignal.timeout(60_000);

function must<T>(r: ForgeResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error.kind}: ${r.error.message}`);
  return r.value;
}

/** Runs one named step; a failure inside it is reported as `step "<name>": ...`. */
async function step<T>(name: string, run: () => T | Promise<T>, context?: () => string): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const extra = context === undefined ? "" : context();
    throw new Error(`step "${name}": ${e instanceof Error ? e.message : String(e)}${extra === "" ? "" : `\n${extra}`}`, { cause: e });
  }
}

liveCanary(
  LIVE_CASE,
  async () => {
    const repo = liveRepo();
    const slug = `${repo.owner}/${repo.name}`;
    const credentials = await liveCredentials();
    const ledgerBranch = `xarabot/test-${crypto.randomUUID()}`;
    const prefix = `xarabot-test/${crypto.randomUUID()}/`;
    const runId = crypto.randomUUID();
    const touched = new Set<string>();
    const tokens = createTokenSource({ credentials, repo });
    const raw: RawCall = async (op: Operation, path: string, body?: unknown) => {
      const s = callSignal();
      const token = must(await tokens.get(s), "installation token");
      const r = must(await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token, signal: s, body }), op.name);
      return { status: r.status, body: r.body };
    };
    /** The unprefixed forge on the scratch ledger: reads and cleanup. */
    const inner = createGitHubForge({ repo, credentials, ledgerBranch });

    const root = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-canary-live-")));
    const bin = join(root, "bin");
    const home = join(root, "home");
    const xdg = join(root, "config");
    const lane: Lane = { repo: slug, role: "builder", owner: LIVE_LOGIN, agent: "claude", effort: "high" };
    const laneDir = laneDirFor(join(home, ".xarabot"), lane, LANE);
    const layout = laneLayout(laneDir);
    const out: string[] = [];
    const errOut: string[] = [];

    /** The lane's output and the tail of its unit logs, for a failed step after the run. */
    const diagnostics = (): string => {
      const parts = [`--- laneRun stdout ---\n${out.join("\n")}`, `--- laneRun stderr ---\n${errOut.join("\n")}`];
      try {
        for (const f of readdirSync(layout.logs).sort()) {
          const text = readFileSync(join(layout.logs, f), "utf8");
          parts.push(`--- ${f} (tail) ---\n${text.slice(-4000)}`);
        }
      } catch {
        // No logs.
      }
      return parts.join("\n");
    };

    let laneDone: Promise<number> | null = null;
    try {
      // 1. The scratch main.
      const runnerVersion = await step("scratch main loads", async () => {
        const snap = must(await inner.snapshot({ signal: callSignal(), read: readsPath }), "snapshot");
        const loaded = loadRepoConfig({ repo: slug, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
        if (!loaded.ok) throw new Error(`loadRepoConfig: ${loaded.error.kind}: ${loaded.error.message} (seed the scratch repo with bun test/e2e/scratch-seed.ts)`);
        expect(Object.keys(snap.ledger.files).filter((f) => f.startsWith("units/"))).toEqual([]);
        return loaded.value.repo.config.runner_version;
      }, diagnostics);

      // 2. The host: host.yaml, the dummy credential, the runner file, the stub first on PATH.
      const reset = await step("host setup", () => {
        mkdirSync(bin, { recursive: true });
        mkdirSync(home, { recursive: true });
        const hostYaml = join(xdg, "xarabot", "host.yaml");
        mkdirSync(dirname(hostYaml), { recursive: true });
        writeFileSync(
          hostYaml,
          [
            "schema_version: 1",
            `host_id: ${crypto.randomUUID()}`,
            "lanes:",
            `  ${LANE}:`,
            `    repo: ${slug}`,
            "    role: builder",
            `    owner: ${LIVE_LOGIN}`,
            "    agent: claude",
            "",
          ].join("\n"),
        );
        writeDummyCredential(xdg);
        mkdirSync(laneDir, { recursive: true });
        writeFileSync(join(laneDir, "runner"), runnerFileText(runnerVersion));
        const r = nowS() + 30;
        writeStub(bin, { limitUntil: r + 119, reset: r, runId });
        return r;
      }, diagnostics);

      // 3. The real App credentials, a fresh ledger branch and prefixed unit branches.
      const connect: Connect = async (l) => {
        if (l.repo !== slug) return { ok: false, message: `canary connect: lane repo ${l.repo} is not ${slug}` };
        return {
          ok: true,
          connection: {
            forge: (o) =>
              prefixed(
                createGitHubForge({
                  repo,
                  credentials,
                  ledgerBranch,
                  ...(o.runnerGit !== undefined ? { runnerGit: o.runnerGit } : {}),
                  ...(o.maintainer !== undefined ? { maintainer: o.maintainer } : {}),
                }),
                prefix,
                touched,
              ),
            token: (signal) => tokens.get(signal),
            fetchShas: (gitDir) => createGitHubFetch({ repo, credentials, gitDir }),
            botUserId: (signal) => fetchBotUserId({ slug: credentials.app.slug, signal }),
          },
        };
      };
      const env: Record<string, string> = {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LANG: "en_US.UTF-8",
      };
      const run = () => laneRun([slug, LANE], { env, connect, out: (l) => out.push(l), errOut: (l) => errOut.push(l) });

      // 4. The run, with STOP written once the outcome is in and the trailing wait has begun.
      const { code, stopAt, exitAt } = await step(
        "laneRun to its trailing wait",
        async () => {
          let stopAt: number | null = null;
          let exitAt: number | null = null;
          const done = run().then((c) => {
            exitAt = Date.now();
            return c;
          });
          laneDone = done;
          const deadline = Date.now() + LANE_DEADLINE_MS;
          let finished = false;
          void done
            .finally(() => {
              finished = true;
            })
            .catch(() => {});
          while (!finished) {
            if (stopAt === null && existsSync(layout.outcome) && existsSync(join(laneDir, "wait.pid"))) {
              writeFileSync(layout.stop, "canary\n");
              stopAt = Date.now();
            }
            if (Date.now() > deadline) {
              if (stopAt === null) writeFileSync(layout.stop, "canary deadline\n");
              throw new Error(`laneRun did not exit within ${LANE_DEADLINE_MS / 60_000} min`);
            }
            await Bun.sleep(WATCH_MS);
          }
          const c = await done;
          return { code: c, stopAt: stopAt as number | null, exitAt: exitAt as number | null };
        },
        diagnostics,
      );

      await step(
        "laneRun exits 0 with progress soon after the STOP",
        () => {
          expect(code).toBe(0);
          expect(readFileSync(layout.outcome, "utf8")).toBe("progress\n");
          expect(out).toContain(`lane ${LANE}: progress`);
          if (stopAt === null || exitAt === null) throw new Error("the lane exited before its trailing wait began, so no STOP was written");
          expect(exitAt - stopAt).toBeLessThanOrEqual(5_000 + DEFAULT_POLL_MS);
        },
        diagnostics,
      );

      // 5. The ledger: story:1.1 merged, and nothing else.
      const record = await step(
        "the ledger holds story:1.1 merged and nothing else",
        async () => {
          const snap = must(await inner.snapshot({ signal: callSignal() }), "snapshot");
          const units = Object.keys(snap.ledger.files).filter((f) => f.startsWith("units/"));
          expect(units).toEqual(["units/story__1.1.json"]);
          const rec = JSON.parse(snap.ledger.files["units/story__1.1.json"] as string) as { state: string; pr: number | null };
          expect(rec.state).toBe("merged");
          if (rec.pr === null) throw new Error("the merged record has no PR");
          return { pr: rec.pr, tip: snap.ledger.tip };
        },
        diagnostics,
      );

      // 6. The journal: one usage-limit span to reset + 2 min, then one unit record.
      await step(
        "the journal has the usage-limit span, then the merged unit",
        () => {
          const lines = readFileSync(layout.journal, "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as Record<string, unknown>);
          const spans = lines.filter((l) => l["type"] === "span" && l["span"] === "usage-limit");
          expect(spans.length).toBe(1);
          const span = spans[0] as Record<string, unknown>;
          expect(Date.parse(span["ended_at"] as string)).toBeGreaterThanOrEqual(reset * 1000 + USAGE_LIMIT_MARGIN_MS - 1000);
          const units = lines.filter((l) => l["type"] === "unit");
          expect(units.length).toBe(1);
          const unit = units[0] as Record<string, unknown>;
          expect(lines.indexOf(unit)).toBeGreaterThan(lines.indexOf(span));
          expect({ unit: unit["unit"], sessions: unit["sessions"], result: unit["result"], state: unit["state"], outcome: unit["outcome"] }).toEqual({
            unit: "story:1.1",
            sessions: 2,
            result: "done",
            state: "merged",
            outcome: "progress",
          });
        },
        diagnostics,
      );

      // 7. The PR head commit is the bot's, with no trailers.
      await step("the PR head commit is the bot's", async () => {
        const pull = await raw(GITHUB_OPERATIONS.getPull, `/pulls/${record.pr}`);
        if (!isSuccess(pull.status)) throw new Error(`GET pulls/${record.pr}: ${pull.status}`);
        const head = (pull.body as { head?: { sha?: unknown } }).head?.sha;
        if (typeof head !== "string") throw new Error(`PR #${record.pr} has no head sha`);
        const gitDir = must(await openRunnerGit(join(root, "scratch"), { signal: callSignal() }), "scratch git dir");
        const url = `https://github.com/${slug}.git`;
        const token = must(await tokens.get(callSignal()), "installation token");
        const fetched = must(
          await runGit(gitDir, ["fetch", "--quiet", "--no-tags", url, `+refs/pull/${record.pr}/head:refs/remotes/pr/head`], {
            signal: callSignal(),
            credential: { url, token },
          }),
          "git fetch",
        );
        if (fetched.code !== 0) throw new Error(`git fetch exited ${fetched.code}: ${fetched.stderr}`);
        const shown = must(await runGit(gitDir, ["cat-file", "commit", head], { signal: callSignal() }), "git cat-file");
        if (shown.code !== 0) throw new Error(`git cat-file exited ${shown.code}: ${shown.stderr}`);
        const checked = checkBotCommit(shown.stdout, LIVE_LOGIN);
        expect(checked.ok ? "ok" : checked.error).toBe("ok");
      }, diagnostics);

      // 8. With STOP still present, a second run exits 0 and claims nothing.
      await step("a second laneRun with STOP present changes nothing", async () => {
        const before = out.length;
        const again = await run();
        expect(again).toBe(0);
        expect(out.slice(before).some((l) => l.includes(`present; not starting lane ${LANE}`))).toBe(true);
        const snap = must(await inner.snapshot({ signal: callSignal() }), "snapshot");
        expect(snap.ledger.tip).toBe(record.tip);
      }, diagnostics);
    } finally {
      // A lane past the deadline gets 30 s after its STOP to exit; cleanup runs either way.
      if (laneDone !== null) {
        const pending = Symbol("pending");
        const settled = await Promise.race([(laneDone as Promise<number>).catch(() => 0), Bun.sleep(30_000).then(() => pending)]);
        if (settled === pending) console.error("canary: laneRun is still running; cleanup may be incomplete (the lane may push or claim after it)");
      }
      try {
        await cleanupScratch({ forge: inner, raw, touched, ledgerBranch, signal: callSignal });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  LANE_DEADLINE_MS + 10 * 60_000,
);
