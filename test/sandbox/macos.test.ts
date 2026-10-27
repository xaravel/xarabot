import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LaunchSpec, ProxyRequest, SandboxProfile, SandboxRun } from "../../src/ports/sandbox.ts";
import { CODEX_API_HOSTS, CODEX_API_KEY_HOST } from "../../src/adapters/agent/codex/codex-agent.ts";
import {
  createMacSandbox,
  HOST_PROCESSES,
  MAX_PROXY_REQUESTS,
  PROXY_REQUESTS_MARKER,
  proxyRequest,
  REAPER_SCRIPT,
  recordProxyRequest,
  superviseSession,
  type GroupSignal,
  type MacSandboxOpts,
  type SessionProcesses,
  type SessionSpawnOptions,
} from "../../src/sandbox/macos.ts";
import { uvPythonDir, which } from "../../src/sandbox/tools.ts";
import { canSandbox, liveSandboxTest, sandboxTest } from "../support/sandbox.ts";

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
  return { argv, vendor: "claude", vendorHomeEnv: "CLAUDE_CONFIG_DIR", credential: ENV_CRED, apiHosts: [], ...patch };
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

/**
 * A fake agent CLI `cli` laid out like codex's native package outside every
 * readable root, `<home>/native/<cli>/vendor/aarch64-apple-darwin` with
 * `bin/<cli>`, `bin/codex-code-mode-host` and `codex-path/rg`. The CLI runs the
 * host and reads `rg`, as codex does for a tool call. Returns the launching
 * environment with the CLI first on `PATH`.
 */
function nativeCli(cli: string): Record<string, string> {
  const target = join(home, "native", cli, "vendor", "aarch64-apple-darwin");
  const host = join(target, "bin", "codex-code-mode-host");
  const rg = join(target, "codex-path", "rg");
  rmSync(join(home, "native", cli), { recursive: true, force: true });
  mkdirSync(join(target, "bin"), { recursive: true });
  mkdirSync(dirname(rg));
  writeFileSync(host, "#!/bin/sh\necho host ran\n");
  writeFileSync(rg, "rg\n");
  writeFileSync(join(target, "bin", cli), `#!/bin/sh\n"${host}"; echo rc=$?; cat "${rg}" 2>/dev/null || echo no-rg\n`);
  chmodSync(host, 0o755);
  chmodSync(join(target, "bin", cli), 0o755);
  const path = join(home, "native", `${cli}-path`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path);
  symlinkSync(join(target, "bin", cli), join(path, cli));
  return { ...launching, PATH: `${path}:${LAUNCH_PATH}` };
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

  sandboxTest("a claude CLI cannot run or read the files beside it, even a code-mode host", async () => {
    const r = (await ran(["claude"], { sandbox: { launchingEnv: nativeCli("claude") } })).run;
    expect(r.stdout).toBe("rc=126\nno-rg\n");
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

/**
 * A bun script that looks up each Mach service given and prints
 * `<name> kr=<kern_return_t> ms=<duration>` for each, one per line.
 */
function machLookupScript(names: readonly string[]): string {
  return [
    'import { dlopen, FFIType, ptr, read } from "bun:ffi";',
    'const lib = dlopen("/usr/lib/libSystem.B.dylib", { dlsym: { args: [FFIType.i64, FFIType.cstring], returns: FFIType.ptr }, bootstrap_look_up: { args: [FFIType.u32, FFIType.cstring, FFIType.ptr], returns: FFIType.i32 } });',
    // RTLD_DEFAULT is -2.
    'const bp = read.u32(lib.symbols.dlsym(-2, Buffer.from("bootstrap_port\\0")));',
    `for (const name of ${JSON.stringify(names)}) {`,
    "  const port = new Uint32Array(1);",
    "  const t = performance.now();",
    "  const kr = lib.symbols.bootstrap_look_up(bp, Buffer.from(`${name}\\0`), ptr(port));",
    "  console.log(`${name} kr=${kr} ms=${Math.round(performance.now() - t)}`);",
    "}",
  ].join("\n");
}

describe("mach lookups", () => {
  sandboxTest(
    "a lookup of an unlisted service fails at once instead of hanging; a listed one still succeeds",
    async () => {
      if (which("bun", LAUNCH_PATH) === null) throw new Error("bun is not on PATH");
      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(), 5_000);
      try {
        const r = (await ran(["bun", "-e", machLookupScript(["com.apple.FSEvents", "com.apple.logd"])], { signal: ac.signal })).run;
        expect(r.signal).toBeNull();
        expect(r.exitCode).toBe(0);
        const [unlisted, listed] = r.stdout.trimEnd().split("\n");
        const m = /^com\.apple\.FSEvents kr=(\d+) ms=(\d+)$/.exec(unlisted ?? "");
        expect(m).not.toBeNull();
        expect(Number(m?.[1])).not.toBe(0);
        expect(Number(m?.[2])).toBeLessThan(1_000);
        expect(listed).toMatch(/^com\.apple\.logd kr=0 ms=\d+$/);
      } finally {
        clearTimeout(deadline);
      }
    },
    15_000,
  );
});

/** This process's listening TCP sockets, from lsof. */
function listening(): string[] {
  const r = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .sort();
}

async function refusesConnections(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data: () => {} } });
    s.end();
    return false;
  } catch {
    return true;
  }
}

describe("network proxy", () => {
  const FIXTURE_HOST = "api.vendor.test";

  sandboxTest("a tunnel through $HTTPS_PROXY reaches an allowed host; the port refuses connections after run", async () => {
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`fixture-ok ${new URL(req.url).hostname}\n`) });
    try {
      const p = fixture.port as number;
      const r = await sh(
        [
          `curl -sS --max-time 10 --proxytunnel -x "$HTTPS_PROXY" http://${FIXTURE_HOST}:${p}/`,
          `curl -sS --max-time 10 --proxytunnel -x "$HTTPS_PROXY" http://mirror.example:${p}/`,
          `curl -sS --max-time 10 --proxytunnel -x "$HTTPS_PROXY" http://github.com:${p}/ >/dev/null 2>&1; echo github=$?`,
          `curl -sS --max-time 10 --proxytunnel -x "$HTTPS_PROXY" http://unlisted.example:${p}/ >/dev/null 2>&1; echo unlisted=$?`,
          'printf %s "$HTTPS_PROXY"',
        ].join("; "),
        {
          spec: { apiHosts: [FIXTURE_HOST] },
          profile: { repoHosts: ["mirror.example"] },
          sandbox: { proxy: { ports: [p], dial: () => "127.0.0.1" } },
        },
      );
      const lines = r.stdout.split("\n");
      expect(lines.slice(0, 4)).toEqual([`fixture-ok ${FIXTURE_HOST}`, "fixture-ok mirror.example", "github=56", "unlisted=56"]);
      const url = lines[4] as string;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await refusesConnections(Number(url.slice(url.lastIndexOf(":") + 1)))).toBe(true);
    } finally {
      fixture.stop(true);
    }
  });

  sandboxTest("TCP to another host-local port and HTTPS to a GitHub IP with --noproxy both fail", async () => {
    let accepted = 0;
    let probeAccepted: () => void = () => {};
    const probed = new Promise<void>((resolve) => {
      probeAccepted = resolve;
    });
    const other = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: () => {
          accepted += 1;
          probeAccepted();
        },
        data: () => {},
      },
    });
    try {
      // The host itself can connect, so a failure below is the sandbox's doing.
      expect(await refusesConnections(other.port)).toBe(false);
      // The server's accept of the probe can land after the client's connect resolves: wait for it before resetting.
      await Promise.race([
        probed,
        Bun.sleep(5000).then(() => {
          throw new Error("probe was never accepted");
        }),
      ]);
      accepted = 0;
      const r = await sh(
        `curl -sS --max-time 5 telnet://127.0.0.1:${other.port} </dev/null; echo local=$?; curl -sSk --max-time 10 --noproxy '*' https://140.82.112.3/ >/dev/null; echo github=$?`,
      );
      expect(r.stdout).toBe("local=7\ngithub=7\n");
      expect(accepted).toBe(0);
    } finally {
      other.stop(true);
    }
  });

  sandboxTest("DNS does not resolve inside the session", async () => {
    const r = await sh("curl -sS --max-time 10 --noproxy '*' https://pypi.org/ >/dev/null 2>&1; echo rc=$?");
    expect(r.stdout).toBe("rc=6\n");
  });

  for (const [name, patch] of [
    ["a GitHub API host", { spec: { apiHosts: ["api.github.com"] } }],
    ["a GitHub repo host", { profile: { repoHosts: ["objects.githubusercontent.com"] } }],
    ["an IP literal", { profile: { repoHosts: ["140.82.112.3"] } }],
    ["localhost", { spec: { apiHosts: ["localhost"] } }],
  ] as const) {
    sandboxTest(`an allowlist with ${name} refuses, spawning nothing and leaving no proxy listening`, async () => {
      const before = listening();
      await refusedWith(["true"], patch, "proxy allowlist");
      expect(listening()).toEqual(before);
    });
  }

  sandboxTest("a refusal after the proxy started leaves no proxy listening", async () => {
    const before = listening();
    const clone = join(lane, 'quo"te2', "clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    await refusedWith(["true"], { profile: { clone } }, "profile fails to generate");
    writeCred(null, 0o600, "absent-token");
    await refusedWith(["true"], { spec: { credential: { file: "absent-token", env: "CLAUDE_CODE_OAUTH_TOKEN" } } }, "absent-token");
    expect(listening()).toEqual(before);
  });

  sandboxTest("a spawn failure stops the proxy", async () => {
    const before = listening();
    // A sandbox-exec that is executable but cannot be spawned (no interpreter).
    const broken = join(home, "broken-sandbox-exec");
    writeFileSync(broken, "#!/nonexistent/interpreter\n");
    chmodSync(broken, 0o755);
    // posix_spawn fails with ENOENT, after the proxy has started.
    await refusedWith(["true"], { sandbox: { sandboxExec: broken } }, "sandbox: cannot start the session");
    expect(listening()).toEqual(before);
  });

  sandboxTest("the session's HOME links the uv Python folder at uv's default path", async () => {
    const pythons = join(home, "uv-pythons");
    mkdirSync(pythons, { recursive: true });
    writeFileSync(join(pythons, "marker"), "py\n");
    const saved = launching;
    launching = { ...launching, UV_PYTHON_INSTALL_DIR: pythons };
    try {
      const r = await sh('cat "$HOME/.local/share/uv/python/marker"; env | grep -c "^UV_PYTHON" || true');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("py\n0\n");
    } finally {
      launching = saved;
    }
  });

  liveSandboxTest(
    "uv installs ruamel.yaml from PyPI through the proxy",
    async () => {
      // The fake launching HOME has no uv-managed Pythons, so the launching env
      // names the host's; the session finds them through its HOME link alone.
      const dir = uvPythonDir(process.env);
      if (dir === null || !existsSync(dir)) throw new Error("no uv-managed Python on this host: run `uv python install 3.12` once");
      const pythons = realpathSync(dir);
      const saved = launching;
      launching = { ...launching, UV_PYTHON_INSTALL_DIR: pythons };
      try {
        const r = await sh(`uv run --no-cache --python '>=3.11' --with ruamel.yaml python -c 'import ruamel.yaml'`);
        if (r.exitCode !== 0) throw new Error(`uv failed (${r.exitCode}):\n${r.stderr}`);
        expect(r.exitCode).toBe(0);
      } finally {
        launching = saved;
      }
    },
    120_000,
  );
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
    const proxy = env["HTTPS_PROXY"] ?? "";
    expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env).toEqual({
      PATH: `${tmp}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: `${tmp}/home`,
      TMPDIR: tmp,
      TMPPREFIX: `${tmp}/zsh`,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      CLAUDE_CONFIG_DIR: join(lane, "vendor"),
      XARABOT_RESULT: join(tmp, "result.json"),
      XARABOT_SANDBOXED: "1",
      UV_CACHE_DIR: `${tmp}/uv-cache`,
      CLAUDE_CODE_TMPDIR: `${tmp}/cli-tmp`,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
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

  // zsh writes a heredoc's temp file at `$TMPPREFIX<pid>…`; its default `/tmp/zsh` is denied.
  toolTest("zsh")("a zsh heredoc succeeds: its temp file goes under TMPPREFIX", async () => {
    const r = (await ran(["zsh", "-c", "cat <<EOF\nheredoc ok\nEOF"])).run;
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("heredoc ok\n");
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

  sandboxTest("tmp/cli-tmp is rebuilt empty each session and is writable", async () => {
    mkdirSync(join(lane, "tmp", "cli-tmp", "claude-501"), { recursive: true });
    writeFileSync(join(lane, "tmp", "cli-tmp", "stale"), "x");
    const r = await sh('ls -A "$CLAUDE_CODE_TMPDIR"; mkdir "$CLAUDE_CODE_TMPDIR/claude-1" && echo ok > "$CLAUDE_CODE_TMPDIR/claude-1/f" && cat "$CLAUDE_CODE_TMPDIR/claude-1/f"');
    expect(r.stdout).toBe("ok\n");
  });

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

  sandboxTest("a resume keeps the vendor home's contents and still passes the credential", async () => {
    await sh('mkdir -p "$CLAUDE_CONFIG_DIR/projects" && echo t > "$CLAUDE_CONFIG_DIR/projects/s.jsonl"');
    const r = await sh('cat "$CLAUDE_CONFIG_DIR/projects/s.jsonl"; printf %s "$CLAUDE_CODE_OAUTH_TOKEN"', { spec: { resume: true } });
    expect(r.stdout).toBe(`t\n${TOKEN}`);
    const fresh = await sh('ls -A "$CLAUDE_CONFIG_DIR"');
    expect(fresh.stdout).toBe("");
  });

  sandboxTest("no credential: no credential variable and an empty vendor home, with no credential file read", async () => {
    writeFileSync(join(lane, "vendor", "left-over"), "x");
    writeCred(null);
    try {
      const r = await sh('printf %s "${CLAUDE_CODE_OAUTH_TOKEN:-unset}"; ls -A "$CLAUDE_CONFIG_DIR"; env | grep -c "^CLAUDE_CODE_OAUTH_TOKEN=" || true', {
        spec: { credential: undefined },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("unset0\n");
      expect(readdirSync(join(lane, "vendor"))).toEqual([]);
    } finally {
      writeCred(`${TOKEN}\n`);
    }
  });

  sandboxTest("a resume with a bad credential still refuses", async () => {
    writeCred(TOKEN, 0o644, "bad-token");
    await refusedWith(["true"], { spec: { resume: true, credential: { file: "bad-token", env: "CLAUDE_CODE_OAUTH_TOKEN" } } }, credFile("bad-token"));
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
    ["a result inside tmp/cli-tmp", () => ({ resultPath: join(lane, "tmp", "cli-tmp", "r.json") }), "rebuilt cli-tmp"],
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

  sandboxTest("a credential variable named CLAUDE_CODE_TMPDIR", async () => {
    await refusedWith(["true"], { spec: { credential: { file: "oauth-token", env: "CLAUDE_CODE_TMPDIR" } } }, "reserved");
  });

  sandboxTest("a credential variable or vendor home variable named TMPPREFIX", async () => {
    await refusedWith(["true"], { spec: { credential: { file: "oauth-token", env: "TMPPREFIX" } } }, "TMPPREFIX is reserved");
    await refusedWith(["true"], { spec: { vendorHomeEnv: "TMPPREFIX" } }, "TMPPREFIX is reserved");
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

  test("a spec with no credential key still checks its vendor home variable: TMPPREFIX refuses", async () => {
    const sandbox = createMacSandbox({ platform: "darwin", launchingEnv: { PATH: "/usr/bin:/bin", HOME: "/h" } });
    const noCredential: LaunchSpec = { argv: ["true"], vendor: "claude", vendorHomeEnv: "TMPPREFIX", apiHosts: [] };
    const r = await sandbox.run(noCredential, { clone: "/c", vendorHome: "/v", tempDir: "/t", runnerGit: "/r", resultPath: "/t/r" }, new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("TMPPREFIX is reserved");
  });
});

describe("host tools", () => {
  sandboxTest("security list-keychains fails", async () => {
    const r = (await ran(["security", "list-keychains"])).run;
    expect(r.exitCode).not.toBe(0);
  });

  sandboxTest("scutil --proxy returns the host's proxy settings", async () => {
    // The host's own answer: without configd the session's would differ (or hang).
    const host = Bun.spawnSync(["/usr/sbin/scutil", "--proxy"]);
    expect(host.exitCode).toBe(0);
    const r = await sh("/usr/sbin/scutil --proxy");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(host.stdout.toString());
  }, 15_000);

  for (const [tool, args, pattern] of [
    ["claude", ["--version"], /Claude Code/],
    ["codex", ["--version"], /^codex-cli \d+\.\d+\.\d+/],
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

/** True while `pid` exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits up to `ms` for `pid` to be gone (reaped, once its parent died); whether it is. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(50)) if (!alive(pid)) return true;
  return !alive(pid);
}

/** The grandchild PID a script echoed to stderr, killed here should the case fail. */
function leftoverOf(r: SandboxRun): number {
  const pid = Number.parseInt(r.stderr.trim(), 10);
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  return pid;
}

function killLeftover(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

describe("process", () => {
  sandboxTest("a grandchild left running is gone after the run, and does not hold it past the grace (Epic 3 retro item 1)", async () => {
    const started = Date.now();
    const r = await sh("sleep 30 & echo $! >&2; echo hi");
    const elapsed = Date.now() - started;
    const leftover = leftoverOf(r);
    try {
      expect(r.stdout).toBe("hi\n");
      expect(r.exitCode).toBe(0);
      expect(elapsed).toBeLessThan(7_500);
      expect(await gone(leftover)).toBe(true);
    } finally {
      killLeftover(leftover);
    }
  }, 15_000);

  sandboxTest("a grandchild in a subshell that outlives its parent is gone after the run", async () => {
    const r = await sh("(sleep 30 & echo $! >&2) ; echo hi");
    const leftover = leftoverOf(r);
    try {
      expect(r.stdout).toBe("hi\n");
      expect(await gone(leftover)).toBe(true);
    } finally {
      killLeftover(leftover);
    }
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
  sandboxTest("an abort sends SIGTERM to the agent's process group, led by its PID", async () => {
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

  sandboxTest("an abort reaches the session's grandchild too: it is gone after the run", async () => {
    const ac = new AbortController();
    const sandbox = createMacSandbox({ launchingEnv: launching });
    const r = await sandbox.run(spec(["sh", "-c", "sleep 30 & echo $! >&2; wait"]), profile, ac.signal, {
      onSpawn: () => void setTimeout(() => ac.abort(), 300),
    });
    if (!r.ok) throw new Error(r.error.message);
    const leftover = leftoverOf(r.value);
    try {
      expect(r.value).toMatchObject({ exitCode: null, signal: "SIGTERM" });
      expect(r.value.durationMs).toBeLessThan(10_000);
      expect(await gone(leftover)).toBe(true);
    } finally {
      killLeftover(leftover);
    }
  }, 15_000);

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

/** Session processes that run nothing: every spawn, group signal and exact-PID kill is recorded, and the test ends the session. */
function fakeProcesses(opts: { readonly reaperFails?: boolean; readonly sessionFails?: boolean } = {}) {
  const spawns: { argv: string[]; options: SessionSpawnOptions; pid: number }[] = [];
  const groupSignals: [number, GroupSignal][] = [];
  const pidKills: [number, GroupSignal][] = [];
  const ends = new Map<number, (exitCode: number | null, signal: string | null) => void>();
  const closed = (chunk?: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        if (chunk !== undefined) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
  const processes: SessionProcesses = {
    spawn: (argv, options) => {
      if (spawns.length === 0 && opts.sessionFails === true) throw new Error("no sandbox-exec");
      if (spawns.length === 1 && opts.reaperFails === true) throw new Error("no sh");
      const pid = 4242 + spawns.length;
      spawns.push({ argv, options, pid });
      let resolve: (code: number) => void = () => {};
      const exited = new Promise<number>((r) => (resolve = r));
      const proc = {
        pid,
        exited,
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdout: options.stdout === "pipe" ? closed("out\n") : null,
        stderr: options.stderr === "pipe" ? closed() : null,
        stdin: { end: () => {} },
        kill: (sig: GroupSignal) => {
          pidKills.push([pid, sig]);
          ends.get(pid)?.(null, sig);
        },
      };
      ends.set(pid, (exitCode, signal) => {
        if (!ends.has(pid)) return;
        ends.delete(pid);
        proc.exitCode = exitCode;
        proc.signalCode = signal;
        resolve(exitCode ?? 1);
      });
      return proc;
    },
    signalGroup: (pid, sig) => {
      groupSignals.push([pid, sig]);
      ends.get(pid)?.(null, sig);
    },
  };
  return { processes, spawns, groupSignals, pidKills, exit: (pid: number, code: number) => ends.get(pid)?.(code, null) };
}

const ARGV = ["/usr/bin/sandbox-exec", "-p", "(version 1)", "/lane/tmp/bin/claude", "-p"];
const SESSION_OPTS = { cwd: "/lane/clone", env: { PATH: "/usr/bin:/bin" }, stdin: "the prompt" };

describe("process groups (any host)", () => {
  test("the session leads its own group and its reaper its own; on exit the group gets SIGKILL and the reaper its exact-PID kill", async () => {
    const f = fakeProcesses();
    const spawned: number[] = [];
    const pending = superviseSession(ARGV, SESSION_OPTS, new AbortController().signal, { onSpawn: (p) => spawned.push(p) }, { processes: f.processes, now: () => 7 });
    const [session, reaper] = f.spawns;
    if (session === undefined || reaper === undefined) throw new Error("not spawned");
    expect(session.argv).toEqual(ARGV);
    expect(session.options).toMatchObject({ detached: true, cwd: "/lane/clone", env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(session.options.stdin).toBeInstanceOf(Blob);
    expect(reaper.argv).toEqual(["/bin/sh", "-c", REAPER_SCRIPT, "xarabot-reaper", String(session.pid)]);
    expect(reaper.options).toEqual({ detached: true, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    expect(spawned).toEqual([session.pid]);
    expect(f.groupSignals).toEqual([]);
    f.exit(session.pid, 0);
    const r = await pending;
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ pid: session.pid, exitCode: 0, signal: null, stdout: "out\n", stderr: "" });
    expect(f.groupSignals).toEqual([[session.pid, "SIGKILL"]]);
    expect(f.pidKills).toEqual([[reaper.pid, "SIGKILL"]]);
  });

  test("an abort sends the session's group SIGTERM, and its exit SIGKILL", async () => {
    const f = fakeProcesses();
    const ac = new AbortController();
    const pending = superviseSession(ARGV, SESSION_OPTS, ac.signal, undefined, { processes: f.processes, now: () => 7 });
    const [session, reaper] = f.spawns;
    if (session === undefined || reaper === undefined) throw new Error("not spawned");
    ac.abort();
    const r = await pending;
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    expect(f.groupSignals).toEqual([
      [session.pid, "SIGTERM"],
      [session.pid, "SIGKILL"],
    ]);
    expect(f.pidKills).toEqual([[reaper.pid, "SIGKILL"]]);
  });

  test("a reaper that cannot start refuses the session, whose group gets SIGKILL before the hook sees it", async () => {
    const f = fakeProcesses({ reaperFails: true });
    const spawned: number[] = [];
    const r = await superviseSession(ARGV, SESSION_OPTS, new AbortController().signal, { onSpawn: (p) => spawned.push(p) }, { processes: f.processes, now: () => 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("sandbox: cannot start the session's reaper: no sh");
    expect(f.groupSignals).toEqual([[4242, "SIGKILL"]]);
    expect(spawned).toEqual([]);
  });

  test("a session that cannot start refuses, starting no reaper", async () => {
    const f = fakeProcesses({ sessionFails: true });
    const r = await superviseSession(ARGV, SESSION_OPTS, new AbortController().signal, undefined, { processes: f.processes, now: () => 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("sandbox: cannot start the session: no sandbox-exec");
    expect(f.spawns).toEqual([]);
  });
});

/** The host's processes, each spawned PID recorded. */
function recordingProcesses(): { processes: SessionProcesses; pids: number[] } {
  const pids: number[] = [];
  return {
    pids,
    processes: {
      spawn: (argv, options) => {
        const p = HOST_PROCESSES.spawn(argv, options);
        pids.push(p.pid);
        return p;
      },
      signalGroup: HOST_PROCESSES.signalGroup,
    },
  };
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * A lane in its own process: it supervises `script` with the host's
 * processes, prints the session's PID and waits, so the case can end it as
 * `stop --now` (SIGTERM) or a crash (SIGKILL) would.
 */
async function laneWithSession(script: string): Promise<{ lane: ReturnType<typeof Bun.spawn>; session: number; dir: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-lane-")));
  const main = join(dir, "lane.ts");
  const macos = join(import.meta.dir, "..", "..", "src", "sandbox", "macos.ts");
  writeFileSync(
    main,
    `import { HOST_PROCESSES, superviseSession } from ${JSON.stringify(macos)};
await superviseSession(["/bin/sh", "-c", ${JSON.stringify(script)}], { cwd: ${JSON.stringify(dir)}, env: { PATH: "/usr/bin:/bin" } }, new AbortController().signal,
  { onSpawn: (pid) => console.log(pid) }, { processes: HOST_PROCESSES, now: Date.now });
`,
  );
  const lane = Bun.spawn([process.execPath, main], { cwd: dir, stdout: "pipe", stderr: "inherit" });
  const reader = lane.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const session = Number.parseInt(line, 10);
  expect(Number.isInteger(session) && session > 1).toBe(true);
  return { lane, session, dir };
}

describe("reaping with real processes (any host)", () => {
  test("a grandchild left running is gone after the run, and so is the reaper", async () => {
    const rec = recordingProcesses();
    const r = await superviseSession(["/bin/sh", "-c", "sleep 30 & echo $! >&2; echo hi"], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" } }, new AbortController().signal, undefined, {
      processes: rec.processes,
      now: Date.now,
    });
    if (!r.ok) throw new Error(r.error.message);
    const leftover = leftoverOf(r.value);
    try {
      expect(r.value.stdout).toBe("hi\n");
      expect(rec.pids).toHaveLength(2);
      expect(await gone(leftover)).toBe(true);
      for (const pid of rec.pids) expect(await gone(pid)).toBe(true);
    } finally {
      killLeftover(leftover);
      for (const pid of rec.pids) killLeftover(pid);
    }
  }, 15_000);

  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    test(`a lane that gets ${sig} mid-session leaves none of the session's processes: its reaper kills the group`, async () => {
      const { lane, session, dir } = await laneWithSession("sleep 30 & sleep 30 & wait");
      try {
        expect(alive(-session)).toBe(true);
        lane.kill(sig);
        await lane.exited;
        expect(await gone(-session)).toBe(true);
      } finally {
        lane.kill("SIGKILL");
        killGroup(session);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
  }
});

describe("proxyRequest (any host)", () => {
  test("a CONNECT is reported by its authority; anything else by its line, cut to 200 characters", () => {
    expect(proxyRequest("CONNECT chatgpt.com:443 HTTP/1.1", { allow: true, host: "chatgpt.com", port: 443 })).toEqual({ target: "chatgpt.com:443", allowed: true, reason: null });
    expect(proxyRequest("CONNECT github.com:443 HTTP/1.1", { allow: false, status: 403, reason: '"github.com" is a GitHub host' })).toEqual({
      target: "github.com:443",
      allowed: false,
      reason: '"github.com" is a GitHub host',
    });
    expect(proxyRequest(`GET /${"x".repeat(300)} HTTP/1.1`, { allow: false, status: 405, reason: "not CONNECT" }).target).toHaveLength(200);
    expect(MAX_PROXY_REQUESTS).toBeGreaterThan(1000);
  });

  test("recordProxyRequest keeps MAX_PROXY_REQUESTS decisions, then one marker, then nothing more", () => {
    const requests: ProxyRequest[] = [];
    const allow = { allow: true, host: "chatgpt.com", port: 443 } as const;
    for (let i = 0; i < MAX_PROXY_REQUESTS + 5; i += 1) recordProxyRequest(requests, "CONNECT chatgpt.com:443 HTTP/1.1", allow);
    expect(requests).toHaveLength(MAX_PROXY_REQUESTS + 1);
    expect(requests[0]).toEqual({ target: "chatgpt.com:443", allowed: true, reason: null });
    expect(requests.at(-1)).toEqual(PROXY_REQUESTS_MARKER);
    recordProxyRequest(requests, "CONNECT github.com:443 HTTP/1.1", { allow: false, status: 403, reason: "GitHub" });
    expect(requests).toHaveLength(MAX_PROXY_REQUESTS + 1);
    expect(requests.at(-1)).toEqual(PROXY_REQUESTS_MARKER);
  });
});

/** The codex adapter's specs, run through the sandbox with sh in place of codex. */
describe("a codex spec", () => {
  const AUTH = '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"rt-sandbox-123"}}\n';
  const KEY = "sk-codex-sandbox-123";
  const codexDir = () => join(home, ".config", "xarabot", "vendors", "codex");
  const AUTH_SPEC: Partial<LaunchSpec> = { vendor: "codex", vendorHomeEnv: "CODEX_HOME", credential: { file: "auth.json", homeFile: "auth.json" }, apiHosts: CODEX_API_HOSTS };
  const KEY_SPEC: Partial<LaunchSpec> = { vendor: "codex", vendorHomeEnv: "CODEX_HOME", credential: { file: "api-key", env: "CODEX_API_KEY" }, apiHosts: [...CODEX_API_HOSTS, CODEX_API_KEY_HOST] };

  function writeCodex(file: string, content: string | null, mode = 0o600): void {
    const f = join(codexDir(), file);
    mkdirSync(codexDir(), { recursive: true });
    rmSync(f, { force: true });
    if (content === null) return;
    writeFileSync(f, content);
    chmodSync(f, mode);
  }

  beforeAll(() => {
    if (!canSandbox) return;
    writeCodex("auth.json", AUTH);
    writeCodex("api-key", `${KEY}\n`);
  });

  sandboxTest("auth.json mode: CODEX_HOME holds only auth.json, mode 600, no credential variable, and the run reports it untouched", async () => {
    const { run: r } = await ran(["sh", "-c", 'ls -A "$CODEX_HOME"; stat -f %Lp "$CODEX_HOME/auth.json"; printf %s "${CODEX_API_KEY:-unset}"'], { spec: AUTH_SPEC });
    expect(r.stdout).toBe("auth.json\n600\nunset");
    expect(r.credentialRewritten).toBe(false);
  });

  sandboxTest("a session that rewrites auth.json is reported; the operator's file is left as it is", async () => {
    const { run: r } = await ran(["sh", "-c", 'printf %s \'{"tokens":"refreshed"}\' > "$CODEX_HOME/auth.json"'], { spec: AUTH_SPEC });
    expect(r.exitCode).toBe(0);
    expect(r.credentialRewritten).toBe(true);
    expect(readFileSync(join(codexDir(), "auth.json"), "utf8")).toBe(AUTH);
    expect(readFileSync(join(lane, "vendor", "auth.json"), "utf8")).toBe('{"tokens":"refreshed"}');
  });

  sandboxTest("a session that removes auth.json is reported as a rewrite", async () => {
    const { run: r } = await ran(["sh", "-c", 'rm "$CODEX_HOME/auth.json"'], { spec: AUTH_SPEC });
    expect(r.credentialRewritten).toBe(true);
  });

  sandboxTest("a resume re-seeds auth.json from the operator's file and keeps the transcript", async () => {
    await ran(["sh", "-c", 'mkdir -p "$CODEX_HOME/sessions" && echo t > "$CODEX_HOME/sessions/r.jsonl" && printf x > "$CODEX_HOME/auth.json"'], { spec: AUTH_SPEC });
    const { run: r } = await ran(["sh", "-c", 'cat "$CODEX_HOME/sessions/r.jsonl"; cat "$CODEX_HOME/auth.json"'], { spec: { ...AUTH_SPEC, resume: true } });
    expect(r.stdout).toBe(`t\n${AUTH}`);
    expect(r.credentialRewritten).toBe(false);
  });

  sandboxTest("api-key mode: CODEX_API_KEY holds the key, CODEX_HOME is empty, and no rewrite is reported", async () => {
    const { run: r } = await ran(["sh", "-c", 'printf %s "$CODEX_API_KEY"; ls -A "$CODEX_HOME"'], { spec: KEY_SPEC });
    expect(r.stdout).toBe(KEY);
    expect("credentialRewritten" in r).toBe(false);
  });

  sandboxTest("the prompt is the last argument, after --, and stdin is closed", async () => {
    const prompt = "# Task\n\nline two\n";
    const { run: r } = await ran(["sh", "-c", 'printf "<%s>" "$(cat)"; printf "[%s]" "$2"', "sh", "--", prompt], { spec: AUTH_SPEC });
    expect(r.stdout).toBe(`<>[${prompt}]`);
  });

  sandboxTest("every proxy request is reported: the allowed vendor host and the refused GitHub host", async () => {
    const FIXTURE = "chatgpt.com";
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok\n") });
    try {
      const p = fixture.port as number;
      const { run: r } = await ran(
        [
          "sh",
          "-c",
          `curl -sS --max-time 10 --proxytunnel -x "$HTTPS_PROXY" http://${FIXTURE}:${p}/; curl -sS --max-time 10 --proxytunnel -x "$HTTPS_PROXY" http://github.com:${p}/ >/dev/null 2>&1; echo github=$?`,
        ],
        { spec: AUTH_SPEC, sandbox: { proxy: { ports: [p], dial: () => "127.0.0.1" } } },
      );
      expect(r.stdout).toBe("ok\ngithub=56\n");
      expect(r.proxyRequests).toEqual([
        { target: `${FIXTURE}:${p}`, allowed: true, reason: null },
        { target: `github.com:${p}`, allowed: false, reason: '"github.com" is a GitHub host' },
      ]);
    } finally {
      fixture.stop(true);
    }
  });

  for (const [name, content, mode] of [
    ["missing", null, 0o600],
    ["mode 644", AUTH, 0o644],
    ["empty", "", 0o600],
  ] as const) {
    sandboxTest(`a ${name} auth.json refuses, naming the file`, async () => {
      writeCodex("auth.json", content, mode);
      try {
        await refusedWith(["true"], { spec: AUTH_SPEC }, join(codexDir(), "auth.json"));
      } finally {
        writeCodex("auth.json", AUTH);
      }
    });
  }

  sandboxTest("a credential variable named CODEX_HOME refuses: it names the vendor home", async () => {
    await refusedWith(["true"], { spec: { ...KEY_SPEC, credential: { file: "api-key", env: "CODEX_HOME" } } }, "names both the vendor home and the credential");
  });

  sandboxTest("codex runs its code-mode host and reads its native package folder", async () => {
    const r = (await ran(["codex"], { spec: KEY_SPEC, sandbox: { launchingEnv: nativeCli("codex") } })).run;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("host ran\nrc=0\nrg\n");
  });

  sandboxTest("a codex spec allowing a GitHub host refuses, spawning nothing", async () => {
    await refusedWith(["true"], { spec: { ...AUTH_SPEC, apiHosts: [...CODEX_API_HOSTS, "api.github.com"] } }, "proxy allowlist");
  });
});
