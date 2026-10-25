import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_HELPER,
  openRunnerGit,
  RUNNER_GIT_CONFIG,
  runGit,
  runnerGitArgs,
  runnerGitEnv,
  type GitRun,
} from "../../../../src/adapters/forge/github/runner-git.ts";
import type { ForgeResult } from "../../../../src/ports/forge.ts";
import { hostTest } from "../../../support/sandbox.ts";
import { startGitServer, type GitServer } from "./git-server.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const IDENTITY = { name: "t", email: "t@xarabot.invalid" };
const live = () => ({ signal: AbortSignal.timeout(30_000) });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xarabot-runner-git-"));
  dirs.push(d);
  return d;
}

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function ran(r: ForgeResult<GitRun>): string {
  const v = value(r);
  if (v.code !== 0) throw new Error(`git exited ${v.code}: ${v.stderr}`);
  return v.stdout.trim();
}

async function fresh(): Promise<{ lane: string; gitDir: string }> {
  const lane = join(tempDir(), "lane");
  return { lane, gitDir: value(await openRunnerGit(lane, live())) };
}

/** Plain, unhardened git: what an attacker-planted config would get. */
async function plainGit(gitDir: string, args: readonly string[]): Promise<number> {
  const p = Bun.spawn(["git", `--git-dir=${gitDir}`, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return p.exited;
}

describe("openRunnerGit", () => {
  test("first run: creates the lane folder (700) and a bare runner.git on main; a second call keeps it", async () => {
    const { lane, gitDir } = await fresh();
    expect(gitDir).toBe(join(lane, "runner.git"));
    expect(statSync(lane).mode & 0o777).toBe(0o700);
    expect(ran(await runGit(gitDir, ["rev-parse", "--is-bare-repository"], live()))).toBe("true");
    expect(ran(await runGit(gitDir, ["symbolic-ref", "HEAD"], live()))).toBe("refs/heads/main");

    const sha = ran(await runGit(gitDir, ["commit-tree", EMPTY_TREE, "-m", "keep"], { ...live(), identity: IDENTITY }));
    ran(await runGit(gitDir, ["update-ref", "refs/heads/keep", sha], live()));
    expect(value(await openRunnerGit(lane, live()))).toBe(gitDir);
    expect(ran(await runGit(gitDir, ["rev-parse", "refs/heads/keep"], live()))).toBe(sha);
  });

  test("an aborted signal creates nothing", async () => {
    const lane = join(tempDir(), "lane");
    const r = await openRunnerGit(lane, { signal: AbortSignal.abort() });
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
    expect(existsSync(lane)).toBe(false);
  });
});

describe("runGit hardening", () => {
  hostTest("hooks planted in hooks/ and through core.hooksPath never run", async () => {
    const { gitDir } = await fresh();
    const marker = join(tempDir(), "hook-ran");
    const script = `#!/bin/sh\necho ran >> ${marker}\n`;
    const custom = join(tempDir(), "custom-hooks");
    mkdirSync(custom);
    for (const d of [join(gitDir, "hooks"), custom]) {
      for (const hook of ["reference-transaction", "pre-push", "post-update"]) {
        writeFileSync(join(d, hook), script);
        chmodSync(join(d, hook), 0o755);
      }
    }
    ran(await runGit(gitDir, ["config", "core.hooksPath", custom], live()));
    const sha = ran(await runGit(gitDir, ["commit-tree", EMPTY_TREE, "-m", "x"], { ...live(), identity: IDENTITY }));

    ran(await runGit(gitDir, ["update-ref", "refs/heads/a", sha], live()));
    expect(existsSync(marker)).toBe(false);

    // The control: unhardened git runs the planted hook.
    expect(await plainGit(gitDir, ["update-ref", "refs/heads/b", sha])).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test("the file protocol is refused", async () => {
    const { gitDir } = await fresh();
    const other = (await fresh()).gitDir;
    const r = value(await runGit(gitDir, ["fetch", `file://${other}`, "refs/heads/*:refs/remotes/o/*"], live()));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("transport 'file' not allowed");
  });

  test("the environment is the allowlist only", async () => {
    const { gitDir } = await fresh();
    process.env["XARABOT_CANARY"] = "leaked-canary";
    try {
      const out = ran(await runGit(gitDir, ["-c", "alias.envdump=!env", "envdump"], { ...live(), identity: IDENTITY }));
      const keys = out.split("\n").map((l) => l.slice(0, l.indexOf("=")));
      expect(out).not.toContain("leaked-canary");
      const allowed = Object.keys(runnerGitEnv(gitDir, IDENTITY));
      // What git, the shell and macOS's /usr/bin/git (an xcrun shim) add on their own.
      const added = ["GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_EXEC_PATH", "GIT_PREFIX", "PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"];
      const xcrun = ["CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT"];
      for (const k of keys) expect([k, allowed.includes(k) || added.includes(k) || xcrun.includes(k)]).toEqual([k, true]);
    } finally {
      delete process.env["XARABOT_CANARY"];
    }
  });

  test("runnerGitEnv: exactly the allowlist, identity only when given", () => {
    const base = ["PATH", "HOME", "LANG", "LC_ALL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT"];
    expect(Object.keys(runnerGitEnv("/x/runner.git")).sort()).toEqual([...base].sort());
    expect(runnerGitEnv("/x/runner.git")).toMatchObject({
      HOME: "/x/runner.git",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    const withId = runnerGitEnv("/x", { name: "bot", email: "b@x", date: "2026-10-22T10:00:00Z" });
    expect(Object.keys(withId).filter((k) => !base.includes(k)).sort()).toEqual([
      "GIT_AUTHOR_DATE",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_DATE",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
    ]);
  });

  test("runnerGitArgs: every -c setting, then the scoped helper after the reset; never the token", () => {
    const args = runnerGitArgs("/g", ["push"], { url: "https://h.test/o/r.git", token: "ghs_secret" });
    const settings = args.filter((_, i) => args[i - 1] === "-c");
    expect(settings).toEqual([...RUNNER_GIT_CONFIG, `credential.https://h.test/o/r.git.helper=${CREDENTIAL_HELPER}`]);
    expect(RUNNER_GIT_CONFIG.at(-1)).toBe("credential.helper=");
    expect(args[0]).toBe("--git-dir=/g");
    expect(args.at(-1)).toBe("push");
    expect(args.join(" ")).not.toContain("ghs_secret");
    expect(runnerGitArgs("/g", ["status"]).some((a) => a.includes("helper=!"))).toBe(false);
  });

  test("an abort kills git by its PID and returns transient", async () => {
    const { gitDir } = await fresh();
    const ac = new AbortController();
    const started = Date.now();
    const pending = runGit(gitDir, ["-c", "alias.nap=!sleep 20", "nap"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await pending;
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "transient", message: "git -c: deadline passed" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  hostTest("the credential goes only to its own URL: another remote never sees the token", async () => {
    const { gitDir } = await fresh();
    const servers = await Promise.all(
      ["a", "b"].map((n) => startGitServer({ root: join(tempDir(), "remote"), owner: "acme", name: n, tokenValid: (t) => t === "ghs_scoped" })),
    );
    const [a, b] = servers as [GitServer, GitServer];
    try {
      const sha = ran(await runGit(gitDir, ["commit-tree", EMPTY_TREE, "-m", "scoped"], { ...live(), identity: IDENTITY }));
      const credential = { url: a.repoUrl, token: "ghs_scoped" };
      const other = value(await runGit(gitDir, ["push", "--porcelain", b.repoUrl, `${sha}:refs/heads/x`], { ...live(), credential }));
      expect(other.code).not.toBe(0);
      expect(b.seen()).not.toContain("ghs_scoped");
      expect(await b.refs()).toEqual({});
      ran(await runGit(gitDir, ["push", "--porcelain", a.repoUrl, `${sha}:refs/heads/x`], { ...live(), credential }));
      expect(a.seen()).toContain("ghs_scoped");
    } finally {
      await Promise.all(servers.map((s) => s.stop()));
    }
  });

  test("an already-aborted signal starts nothing", async () => {
    const r = await runGit("/nonexistent/runner.git", ["status"], { signal: AbortSignal.abort() });
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
  });
});

describe("runGit options: stdin, workTree, indexFile", () => {
  test("stdin is written to git's stdin", async () => {
    const { gitDir } = await fresh();
    const sha = ran(await runGit(gitDir, ["hash-object", "--stdin"], { ...live(), stdin: "hello\n" }));
    expect(sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const msg = ran(await runGit(gitDir, ["commit-tree", EMPTY_TREE], { ...live(), identity: IDENTITY, stdin: "line one\n\nline two\n" }));
    expect(ran(await runGit(gitDir, ["log", "-1", "--format=%B", msg], live()))).toBe("line one\n\nline two");
  });

  test("workTree and indexFile: add from a work tree into a separate index; runner.git gets no index", async () => {
    const { gitDir } = await fresh();
    const work = tempDir();
    writeFileSync(join(work, "a.txt"), "a\n");
    mkdirSync(join(work, "d"));
    writeFileSync(join(work, "d", "b.txt"), "b\n");
    const indexFile = join(tempDir(), "index");
    ran(await runGit(gitDir, ["add", "-A"], { ...live(), workTree: work, indexFile }));
    expect(ran(await runGit(gitDir, ["ls-files"], { ...live(), indexFile })).split("\n")).toEqual(["a.txt", "d/b.txt"]);
    expect(existsSync(indexFile)).toBe(true);
    expect(existsSync(join(gitDir, "index"))).toBe(false);
  });

  test("runnerGitArgs puts --work-tree right after --git-dir; runnerGitEnv sets GIT_INDEX_FILE only when given", () => {
    const args = runnerGitArgs("/g", ["status"], undefined, "/w");
    expect(args.slice(0, 2)).toEqual(["--git-dir=/g", "--work-tree=/w"]);
    expect(runnerGitArgs("/g", ["status"]).some((a) => a.startsWith("--work-tree"))).toBe(false);
    expect(runnerGitEnv("/g", undefined, "/i/index")["GIT_INDEX_FILE"]).toBe("/i/index");
    expect("GIT_INDEX_FILE" in runnerGitEnv("/g")).toBe(false);
  });
});

describe("the adapter source", () => {
  test("Bun.spawn appears only in runner-git.ts:runGit", () => {
    const dir = join(import.meta.dir, "../../../../src/adapters/forge/github");
    const hits: string[] = [];
    for (const file of readdirSync(dir)) {
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/Bun\s*\.\s*spawn|child_process|\bspawnSync\b/.test(line)) hits.push(`${file}:${i + 1}`);
        });
    }
    expect(hits).toHaveLength(1);
    const [file, line] = (hits[0] as string).split(":");
    expect(file).toBe("runner-git.ts");
    const source = readFileSync(join(dir, "runner-git.ts"), "utf8").split("\n");
    const start = source.findIndex((l) => l.startsWith("export async function runGit("));
    const end = source.findIndex((l, i) => i > start && l === "}");
    expect(Number(line) - 1).toBeGreaterThan(start);
    expect(Number(line) - 1).toBeLessThan(end);
  });

  test("src/lane/ never spawns git: its git goes through runGit", () => {
    const dir = join(import.meta.dir, "../../../../src/lane");
    // The only spawns in src/lane/: `ps` in the process table, the wait's `sleep` (Story 1.18)
    // and the runner install's `bun install` (Story 1.19), whose git still goes through runGit.
    const NON_GIT = new Set(["processes.ts", "wait.ts", "runner-install.ts"]);
    const hits: string[] = [];
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || NON_GIT.has(file)) continue;
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/Bun\s*\.\s*spawn|Bun\s*\.\s*\$|child_process|\bspawnSync\b/.test(line)) hits.push(`${file}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
