import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LaunchSpec, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { createMacSandbox, type MacSandboxOpts } from "../../src/sandbox/macos.ts";
import { which } from "../../src/sandbox/tools.ts";
import { canSandbox, sandboxTest } from "../support/sandbox.ts";

/**
 * Real sessions in a fake home laid out like the Structural Seed:
 * `<home>/.xarabot/repos/o__r/lanes/l/{clone,runner.git,vendor,tmp}`.
 * Every case that spawns runs through `sandboxTest`.
 */

let home = "";
let lane = "";
let profile: SandboxProfile;
let launching: Record<string, string>;

const TOKEN = "tok-sandbox-123";
const SECRET = "s3cret-contents";
const LAUNCH_PATH = process.env.PATH ?? "/usr/bin:/bin";

/** Paths in the fake home a session must not read, each holding `SECRET`. */
const DENIED_FILES = [
  ".xarabot/repos/o__r/lanes/l/runner.git/config",
  ".xarabot/STOP",
  ".xarabot/repos/o__r/lanes/other/vendor/token",
  ".config/xarabot/vendors/claude/other-token",
  ".config/gh/hosts.yml",
  ".ssh/id_ed25519",
  "Library/Keychains/login.keychain-db",
  ".git-credentials",
  ".netrc",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".pi/agent/auth.json",
];

function credFile(name = "oauth-token"): string {
  return join(home, ".config", "xarabot", "vendors", "claude", name);
}

function writeCred(content: string | null, mode = 0o600, name = "oauth-token"): void {
  const f = credFile(name);
  mkdirSync(dirname(f), { recursive: true });
  rmSync(f, { force: true });
  if (content === null) return;
  writeFileSync(f, content);
  chmodSync(f, mode);
}

beforeAll(() => {
  if (!canSandbox) return;
  home = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-sbx-")));
  lane = join(home, ".xarabot", "repos", "o__r", "lanes", "l");
  for (const d of ["clone/.git", "runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
  writeFileSync(join(lane, "clone", "README.md"), "clone file\n");
  for (const rel of DENIED_FILES) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), `${SECRET}\n`);
  }
  writeCred(`${TOKEN}\n`);
  profile = {
    clone: join(lane, "clone"),
    vendorHome: join(lane, "vendor"),
    tempDir: join(lane, "tmp"),
    runnerGit: join(lane, "runner.git"),
    resultPath: join(lane, "tmp", "result.json"),
  };
  launching = {
    PATH: LAUNCH_PATH,
    HOME: home,
    GH_TOKEN: "ghs_secret",
    GITHUB_TOKEN: "ghs_secret2",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    FOO: "bar",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
});

afterAll(() => {
  if (home !== "") {
    try {
      chmodSync(credFile(), 0o600);
    } catch {
      // Not there.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

const ENV_CRED: LaunchSpec["credential"] = { file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" };

function spec(argv: readonly string[], patch: Partial<LaunchSpec> = {}): LaunchSpec {
  return { argv, vendor: "claude", vendorHomeEnv: "CLAUDE_CONFIG_DIR", credential: ENV_CRED, ...patch };
}

type Outcome = { readonly run: SandboxRun; readonly spawned: number[] };

async function run(argv: readonly string[], opts: { spec?: Partial<LaunchSpec>; profile?: Partial<SandboxProfile>; sandbox?: MacSandboxOpts; signal?: AbortSignal } = {}) {
  const spawned: number[] = [];
  const sandbox = createMacSandbox({ launchingEnv: launching, ...opts.sandbox });
  const r = await sandbox.run(spec(argv, opts.spec), { ...profile, ...opts.profile }, opts.signal ?? new AbortController().signal, {
    onSpawn: (pid) => spawned.push(pid),
  });
  return { r, spawned };
}

async function ran(argv: readonly string[], opts: Parameters<typeof run>[1] = {}): Promise<Outcome> {
  const { r, spawned } = await run(argv, opts);
  if (!r.ok) throw new Error(`refused: ${r.error.message}`);
  return { run: r.value, spawned };
}

async function sh(script: string, opts: Parameters<typeof run>[1] = {}): Promise<SandboxRun> {
  return (await ran(["sh", "-c", script], opts)).run;
}

async function refusedWith(argv: readonly string[], opts: Parameters<typeof run>[1], fragment: string): Promise<void> {
  const { r, spawned } = await run(argv, opts);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.kind).toBe("refused");
    expect(r.error.message).toContain(fragment);
  }
  expect(spawned).toEqual([]);
}

/** A sandbox test that also needs `tool` on the launching PATH; reported skipped otherwise. */
function toolTest(tool: string): typeof test {
  return test.skipIf(!canSandbox || which(tool, LAUNCH_PATH) === null) as typeof test;
}

describe("probe reads", () => {
  sandboxTest("a system file", async () => {
    const r = (await ran(["cat", "/etc/hosts"])).run;
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  sandboxTest("a clone file", async () => {
    const r = (await ran(["cat", "README.md"])).run;
    expect(r).toMatchObject({ exitCode: 0, stdout: "clone file\n" });
  });

  sandboxTest("a vendor home file", async () => {
    const r = (await ran(["cat", join(lane, "vendor", ".credentials.json")], { spec: { credential: { file: "oauth-token", homeFile: ".credentials.json" } } })).run;
    expect(r).toMatchObject({ exitCode: 0, stdout: `${TOKEN}\n` });
  });

  sandboxTest("a temp file", async () => {
    writeFileSync(join(lane, "tmp", "prefetched.json"), "{}\n");
    const r = (await ran(["cat", join(lane, "tmp", "prefetched.json")])).run;
    expect(r).toMatchObject({ exitCode: 0, stdout: "{}\n" });
  });
});

describe("denied reads", () => {
  for (const rel of DENIED_FILES) {
    sandboxTest(`cat and ls of ~/${rel} fail`, async () => {
      const path = join(home, rel);
      const cat = (await ran(["cat", path])).run;
      expect(cat.exitCode).not.toBe(0);
      expect(cat.stdout).not.toContain(SECRET);
      const ls = (await ran(["ls", "-la", dirname(path)])).run;
      expect(ls.exitCode).not.toBe(0);
      expect(ls.stdout).not.toContain(basename(path));
    });
  }

  sandboxTest("the launching home and ~/.local/bin are not listable", async () => {
    const r = await sh(`ls "${home}"; ls "${join(homedir(), ".local", "bin")}"; ls /Users`);
    expect(r.stdout).toBe("");
  });
});

describe("runner repo", () => {
  sandboxTest("ls of runner.git and a write into it both fail", async () => {
    const ls = (await ran(["ls", join(lane, "runner.git")])).run;
    expect(ls.exitCode).not.toBe(0);
    const write = await sh(`echo x > "${join(lane, "runner.git", "planted")}"`);
    expect(write.exitCode).not.toBe(0);
    expect(existsSync(join(lane, "runner.git", "planted"))).toBe(false);
  });
});

describe("writes", () => {
  for (const [name, rel] of [
    ["the clone", "clone/w.txt"],
    ["the clone's .git", "clone/.git/w.txt"],
    ["the vendor home", "vendor/w.txt"],
    ["the temp folder", "tmp/w.txt"],
  ] as const) {
    sandboxTest(`a write into ${name} succeeds`, async () => {
      const target = join(lane, rel);
      // The vendor home is emptied at session start, so write and check within the session.
      const r = await sh(`echo w > "${target}" && cat "${target}"`);
      expect(r).toMatchObject({ exitCode: 0, stdout: "w\n" });
      expect(existsSync(target)).toBe(true);
    });
  }

  sandboxTest("a write outside them fails", async () => {
    const targets = [join(home, "outside.txt"), join(lane, "outside.txt"), join(home, ".xarabot", "STOP2"), "/tmp/xarabot-sandbox-outside.txt"];
    for (const t of targets) {
      rmSync(t, { force: true });
      const r = await sh(`echo w > "${t}"`);
      expect(r.exitCode).not.toBe(0);
      expect(existsSync(t)).toBe(false);
    }
  });
});

describe("exec", () => {
  // A copy of bun: a copied Apple platform binary such as /bin/echo is killed by the system anywhere.
  const BUN_REAL = realpathSync(process.execPath);

  sandboxTest("a binary outside the readable roots cannot be executed, even by absolute path", async () => {
    const outside = join(home, "outside-bin", "tool-copy");
    mkdirSync(dirname(outside), { recursive: true });
    copyFileSync(BUN_REAL, outside);
    chmodSync(outside, 0o755);
    const r = await sh(`"${outside}" --version; echo rc=$?`);
    expect(r.stdout).toBe("rc=126\n");
  });

  sandboxTest("a binary in a writable root can be executed", async () => {
    const inside = join(lane, "tmp", "tool-copy");
    copyFileSync(BUN_REAL, inside);
    chmodSync(inside, 0o755);
    const r = await sh(`"${inside}" --version`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
    rmSync(inside);
  });

  sandboxTest("another terminal is neither readable nor writable", async () => {
    const r = await sh("for t in /dev/ttys000 /dev/ttys001; do echo x > $t && echo wrote; cat $t < /dev/null && echo read; done; true");
    expect(r.stdout).toBe("");
  });
});

describe("network", () => {
  sandboxTest("connecting to a Unix socket the host listens on fails", async () => {
    if (which("bun", LAUNCH_PATH) === null) throw new Error("bun is not on PATH");
    const sock = join(lane, "tmp", "host.sock");
    let accepted = 0;
    const server = Bun.listen({ unix: sock, socket: { open: () => void (accepted += 1), data: () => {} } });
    try {
      // The host itself can connect, so a failure below is the sandbox's doing.
      const probe = await Bun.connect({ unix: sock, socket: { data: () => {} } });
      probe.end();
      const script = `try { const s = await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }); s.end(); console.log("connected"); } catch (e) { console.log("refused"); process.exit(3); }`;
      const r = (await ran(["bun", "-e", script])).run;
      expect(r.stdout).not.toContain("connected");
      expect(r.exitCode).not.toBe(0);
      expect(accepted).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("environment", () => {
  sandboxTest("env prints exactly the allowlist", async () => {
    const r = (await ran(["env"])).run;
    const env = Object.fromEntries(
      r.stdout
        .trimEnd()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const tmp = join(lane, "tmp");
    expect(env).toEqual({
      PATH: `${tmp}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: `${tmp}/home`,
      TMPDIR: tmp,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      CLAUDE_CONFIG_DIR: join(lane, "vendor"),
      XARABOT_RESULT: join(tmp, "result.json"),
      XARABOT_SANDBOXED: "1",
      UV_CACHE_DIR: `${tmp}/uv-cache`,
    });
  });

  sandboxTest("HOME is fresh and holds only a .gitconfig that resets credential.helper", async () => {
    mkdirSync(join(lane, "tmp", "home"), { recursive: true });
    writeFileSync(join(lane, "tmp", "home", "stale"), "x");
    const r = await sh('ls -A "$HOME"; cat "$HOME/.gitconfig"');
    expect(r.stdout).toBe(".gitconfig\n[credential]\n\thelper =\n");
  });

  sandboxTest("the session runs in the clone, as the agent's own PID", async () => {
    const { run: r, spawned } = await ran(["sh", "-c", "pwd; echo $$"]);
    expect(r.stdout).toBe(`${join(lane, "clone")}\n${r.pid}\n`);
    expect(spawned).toEqual([r.pid]);
  });

  sandboxTest("stdin reaches the session", async () => {
    const r = (await ran(["cat"], { spec: { stdin: "hello\n" } })).run;
    expect(r.stdout).toBe("hello\n");
  });

  sandboxTest("times come from the injected clock", async () => {
    let t = 1_000;
    const r = (await ran(["true"], { sandbox: { now: () => (t += 500) } })).run;
    expect(r).toMatchObject({ startedAt: 1_500, endedAt: 2_000, durationMs: 500, exitCode: 0, signal: null });
  });
});

describe("session folders", () => {
  sandboxTest("a result file from a previous session is gone when the session starts", async () => {
    writeFileSync(join(lane, "tmp", "result.json"), '{"stale":true}');
    const r = await sh('test -e "$XARABOT_RESULT" && echo present || echo gone');
    expect(r.stdout).toBe("gone\n");
  });

  sandboxTest("a planted result symlink is removed, not followed", async () => {
    const target = join(lane, "clone", "victim.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(lane, "tmp", "result.json"));
    const r = await sh('test -e "$XARABOT_RESULT" || test -L "$XARABOT_RESULT" && echo present || echo gone');
    expect(r.stdout).toBe("gone\n");
    expect(existsSync(target)).toBe(true);
    rmSync(target);
  });

  sandboxTest("a result path whose name starts with .. is accepted", async () => {
    const r = await sh('printf %s "$XARABOT_RESULT"', { profile: { resultPath: join(lane, "tmp", "..result.json") } });
    expect(r.stdout).toBe(join(lane, "tmp", "..result.json"));
  });

  for (const [name, rel] of [
    ["the vendor home", "vendor/locked"],
    ["tmp/home", "tmp/home/locked"],
    ["tmp/bin", "tmp/bin/locked"],
  ] as const) {
    sandboxTest(`a mode-000 folder left in ${name} does not wedge the lane`, async () => {
      const dir = join(lane, rel);
      mkdirSync(join(dir, "inner"), { recursive: true });
      writeFileSync(join(dir, "inner", "f"), "x");
      chmodSync(join(dir, "inner"), 0o000);
      chmodSync(dir, 0o000);
      const r = await sh("true");
      expect(r.exitCode).toBe(0);
      expect(existsSync(dir)).toBe(false);
    });
  }

  sandboxTest("a file at tmp/uv-cache is replaced by a folder", async () => {
    const cache = join(lane, "tmp", "uv-cache");
    rmSync(cache, { recursive: true, force: true });
    writeFileSync(cache, "not a folder");
    const r = await sh('test -d "$UV_CACHE_DIR" && echo dir');
    expect(r.stdout).toBe("dir\n");
  });
});

describe("credentials", () => {
  sandboxTest("env mode: the variable holds the token and the vendor home is empty", async () => {
    writeFileSync(join(lane, "vendor", "left-over"), "x");
    const r = await sh('printf %s "$CLAUDE_CODE_OAUTH_TOKEN"; ls -A "$CLAUDE_CONFIG_DIR"');
    expect(r.stdout).toBe(TOKEN);
    expect(readdirSync(join(lane, "vendor"))).toEqual([]);
  });

  sandboxTest("homeFile mode: the vendor home holds only that file, mode 600", async () => {
    const r = await sh('ls -A "$CLAUDE_CONFIG_DIR"; stat -f %Lp "$CLAUDE_CONFIG_DIR/.credentials.json"; printf %s "${CLAUDE_CODE_OAUTH_TOKEN:-unset}"', {
      spec: { credential: { file: "oauth-token", homeFile: ".credentials.json" } },
    });
    expect(r.stdout).toBe(".credentials.json\n600\nunset");
  });

  for (const [name, content, mode] of [
    ["missing", null, 0o600],
    ["mode 000", TOKEN, 0o000],
    ["mode 644", TOKEN, 0o644],
    ["empty", "", 0o600],
  ] as const) {
    sandboxTest(`a ${name} credential refuses, naming the file`, async () => {
      writeCred(content, mode, "bad-token");
      await refusedWith(["true"], { spec: { credential: { file: "bad-token", env: "CLAUDE_CODE_OAUTH_TOKEN" } } }, credFile("bad-token"));
    });
  }
});

describe("refusals", () => {
  sandboxTest("a clone whose .git is a file (a linked worktree)", async () => {
    const clone = join(home, ".xarabot", "repos", "o__r", "lanes", "wt", "clone");
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, ".git"), "gitdir: /elsewhere\n");
    await refusedWith(["true"], { profile: { clone } }, ".git is not a directory");
  });

  sandboxTest("a clone with no .git", async () => {
    const clone = join(home, "bare-clone");
    mkdirSync(clone, { recursive: true });
    await refusedWith(["true"], { profile: { clone } }, "has no .git");
  });

  sandboxTest("a missing sandbox-exec spawns nothing", async () => {
    await refusedWith(["true"], { sandbox: { sandboxExec: join(home, "no-sandbox-exec") } }, "no-sandbox-exec");
  });

  sandboxTest("a missing agent CLI", async () => {
    await refusedWith(["xarabot-no-such-cli"], {}, "xarabot-no-such-cli");
  });

  sandboxTest("a clone path containing a quote fails to generate the profile", async () => {
    const clone = join(lane, 'quo"te', "clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    await refusedWith(["true"], { profile: { clone } }, "profile fails to generate");
  });

  // Patches are thunks: the fake home only exists once beforeAll has run.
  for (const [name, patch, fragment] of [
    ["a temp folder inside runner.git", () => ({ tempDir: join(lane, "runner.git", "tmp"), resultPath: join(lane, "runner.git", "tmp", "r.json") }), "runner.git"],
    ["a temp folder equal to the lane folder", () => ({ tempDir: lane, resultPath: join(lane, "r.json") }), "not inside the lane folder"],
    ["a vendor home equal to runner.git", () => ({ vendorHome: join(lane, "runner.git") }), "runner.git"],
    ["a vendor home inside ~/.ssh", () => ({ vendorHome: join(home, ".ssh", "v") }), "not inside the lane folder"],
    ["a vendor home equal to ~/.claude", () => ({ vendorHome: join(home, ".claude") }), "not inside the lane folder"],
    ["a temp folder containing the config folder", () => ({ tempDir: join(home, ".config"), resultPath: join(home, ".config", "r.json") }), "not inside the lane folder"],
    ["a temp folder in another repo's folder", () => ({ tempDir: join(home, ".xarabot", "repos", "other__r"), resultPath: join(home, ".xarabot", "repos", "other__r", "r.json") }), "not inside the lane folder"],
    ["a temp folder in ~/Documents", () => ({ tempDir: join(home, "Documents"), resultPath: join(home, "Documents", "r.json") }), "not inside the lane folder"],
    ["a temp folder containing ~/.xarabot", () => ({ tempDir: home, resultPath: join(home, "r.json") }), "equals or contains"],
    ["a temp folder equal to ~/.xarabot", () => ({ tempDir: join(home, ".xarabot"), resultPath: join(home, ".xarabot", "r.json") }), "equals or contains"],
    ["a result inside tmp/bin", () => ({ resultPath: join(lane, "tmp", "bin", "r.json") }), "rebuilt bin"],
    ["a result inside tmp/home", () => ({ resultPath: join(lane, "tmp", "home", "r.json") }), "rebuilt home"],
    ["a result equal to tmp/uv-cache", () => ({ resultPath: join(lane, "tmp", "uv-cache") }), "rebuilt uv-cache"],
    ["a vendor home inside the clone", () => ({ vendorHome: join(lane, "clone", "vendor") }), "overlaps vendorHome"],
    ["a result outside the temp folder", () => ({ resultPath: join(lane, "result.json") }), "not inside tempDir"],
    ["a relative clone", () => ({ clone: "clone" }), "not an absolute path"],
  ] as const) {
    sandboxTest(`writable roots: ${name}`, async () => {
      await refusedWith(["true"], { profile: patch() }, fragment);
      expect(existsSync(join(lane, "runner.git", "tmp"))).toBe(false);
      expect(existsSync(join(home, ".ssh", "v"))).toBe(false);
    });
  }

  sandboxTest("argv[0] that is a path", async () => {
    await refusedWith(["/bin/sh"], {}, "command name");
  });

  sandboxTest("a credential variable named GH_TOKEN", async () => {
    await refusedWith(["true"], { spec: { credential: { file: "oauth-token", env: "GH_TOKEN" } } }, "reserved");
  });
});

describe("refusals before any check (any host)", () => {
  test("a host that isn't macOS", async () => {
    const sandbox = createMacSandbox({ platform: "linux", launchingEnv: { PATH: "/usr/bin:/bin", HOME: "/h" } });
    const r = await sandbox.run(spec(["true"]), { clone: "/c", vendorHome: "/v", tempDir: "/t", runnerGit: "/r", resultPath: "/t/r" }, new AbortController().signal);
    expect(r).toEqual({ ok: false, error: { kind: "refused", message: "sandbox: host is linux, not macOS" } });
  });

  test("a launching env that is already sandboxed", async () => {
    const sandbox = createMacSandbox({ platform: "darwin", launchingEnv: { PATH: "/usr/bin:/bin", HOME: "/h", XARABOT_SANDBOXED: "1" } });
    const r = await sandbox.run(spec(["true"]), { clone: "/c", vendorHome: "/v", tempDir: "/t", runnerGit: "/r", resultPath: "/t/r" }, new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("XARABOT_SANDBOXED=1");
  });
});

describe("host tools", () => {
  sandboxTest("security list-keychains fails", async () => {
    const r = (await ran(["security", "list-keychains"])).run;
    expect(r.exitCode).not.toBe(0);
  });

  for (const [tool, args, pattern] of [
    ["claude", ["--version"], /Claude Code/],
    ["bun", ["--version"], /^\d+\.\d+\.\d+/],
    ["git", ["--version"], /^git version /],
  ] as const) {
    toolTest(tool)(`${tool} starts when present`, async () => {
      const r = (await ran([tool, ...args])).run;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(pattern);
    });
  }

  toolTest("git")("git sees no credential helper and works in the clone", async () => {
    try {
      const r = await sh("git init -q . && git config --get credential.helper; echo rc=$?; git status --porcelain | head -1");
      expect(r.stdout).toContain("rc=");
      expect(r.stdout).not.toMatch(/\n?[^\n]*osxkeychain/);
      expect(r.stdout.split("\n")[0]).toBe("");
    } finally {
      rmSync(join(lane, "clone", ".git"), { recursive: true, force: true });
      mkdirSync(join(lane, "clone", ".git"));
    }
  });
});

describe("process", () => {
  sandboxTest("a grandchild holding the pipes does not hold the run past the grace", async () => {
    const started = Date.now();
    const r = await sh("sleep 30 & echo $! >&2; echo hi");
    const elapsed = Date.now() - started;
    const leftover = Number.parseInt(r.stderr.trim(), 10);
    if (Number.isInteger(leftover) && leftover > 0) {
      try {
        process.kill(leftover, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    expect(r.stdout).toBe("hi\n");
    expect(r.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(7_500);
  }, 15_000);

  sandboxTest("a throwing onSpawn hook keeps the run ok", async () => {
    const r = await createMacSandbox({ launchingEnv: launching }).run(spec(["sh", "-c", "echo ok"]), profile, new AbortController().signal, {
      onSpawn: () => {
        throw new Error("hook failed");
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ exitCode: 0, stdout: "ok\n" });
  });
});

describe("XDG_CONFIG_HOME", () => {
  sandboxTest("the credential comes from $XDG_CONFIG_HOME, whose xarabot folder the session cannot read", async () => {
    const xdg = join(home, "xdg-config");
    const cred = join(xdg, "xarabot", "vendors", "claude", "oauth-token");
    mkdirSync(dirname(cred), { recursive: true });
    writeFileSync(cred, "xdg-token\n");
    chmodSync(cred, 0o600);
    const saved = launching;
    launching = { ...launching, XDG_CONFIG_HOME: xdg };
    try {
      const r = await sh(`printf %s "$CLAUDE_CODE_OAUTH_TOKEN"; echo; cat "${cred}" && echo catted; ls "${dirname(cred)}" && echo listed; true`);
      expect(r.stdout).toBe("xdg-token\n");
    } finally {
      launching = saved;
    }
  });
});

describe("abort", () => {
  sandboxTest("an abort sends SIGTERM to the agent's PID", async () => {
    const ac = new AbortController();
    const spawned: number[] = [];
    const sandbox = createMacSandbox({ launchingEnv: launching });
    const pending = sandbox.run(spec(["sleep", "30"]), profile, ac.signal, {
      onSpawn: (pid) => {
        spawned.push(pid);
        setTimeout(() => ac.abort(), 200);
      },
    });
    const r = await pending;
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ exitCode: null, signal: "SIGTERM", pid: spawned[0] });
    expect(r.value.durationMs).toBeLessThan(10_000);
  });

  sandboxTest(
    "an agent that ignores SIGTERM gets SIGKILL 10 s later",
    async () => {
      const ac = new AbortController();
      const sandbox = createMacSandbox({ launchingEnv: launching });
      const pending = sandbox.run(spec(["sh", "-c", 'trap "" TERM; echo ready; while :; do :; done']), profile, ac.signal, {
        onSpawn: () => void setTimeout(() => ac.abort(), 300),
      });
      const r = await pending;
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value).toMatchObject({ exitCode: null, signal: "SIGKILL", stdout: "ready\n" });
      expect(r.value.durationMs).toBeGreaterThanOrEqual(10_000);
    },
    20_000,
  );

  sandboxTest("an already-aborted signal refuses before spawning", async () => {
    const ac = new AbortController();
    ac.abort();
    const spawned: number[] = [];
    const r = await createMacSandbox({ launchingEnv: launching }).run(spec(["true"]), profile, ac.signal, { onSpawn: (p) => spawned.push(p) });
    expect(r.ok).toBe(false);
    expect(spawned).toEqual([]);
  });
});
