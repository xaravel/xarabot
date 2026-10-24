import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit } from "../../src/adapters/forge/github/runner-git.ts";
import { ok } from "../../src/core/result.ts";
import type { ForgeResult } from "../../src/ports/forge.ts";
import { installRunner, RUNNER_MARKER, type InstallDeps } from "../../src/lane/runner-install.ts";
import { startGitServer, type GitServer } from "../adapters/forge/github/git-server.ts";

const TOKEN = "ghs_runner_install_token";
const live = () => AbortSignal.timeout(60_000);
const IDENT = { name: "t", email: "t@x.invalid" };

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type World = { server: GitServer; runnerRoot: string; sha: string; annotatedSha: string };

/** A remote with `v0.2.0` (lightweight) and `v0.3.0` (annotated) tags on commits with a no-dependency package.json. */
async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "xarabot-runner-install-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = await startGitServer({ root: join(dir, "remote"), owner: "xaravel", name: "xarabot", tokenValid: (t) => t === TOKEN });
  cleanups.push(() => server.stop());
  const src = join(dir, "src");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  };
  put("package.json", `${JSON.stringify({ name: "runner-fixture", version: "0.2.0" })}\n`);
  put("src/cli/main.ts", "console.log(Bun.argv.slice(2).join(' '));\n");
  const git = async (args: string[]) => value(await runGit(server.repoDir, args, { signal: live(), workTree: src, identity: IDENT, indexFile: join(dir, "index") }));
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "v0.2.0"]);
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["tag", "v0.2.0"]);
  put("src/cli/main.ts", "console.log('v3');\n");
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "v0.3.0"]);
  const annotatedSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["tag", "-a", "v0.3.0", "-m", "release"]);
  return { server, runnerRoot: join(dir, "home", ".xarabot", "runner"), sha, annotatedSha };
}

const leftovers = (root: string) => (existsSync(root) ? readdirSync(root).filter((n) => n.startsWith(".staging-")) : []);

describe("installRunner", () => {
  test("installs a tag: checked out, marked, no .git, dependencies installed", async () => {
    const w = await world();
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v0.2.0", url: w.server.repoUrl, credential: { url: w.server.repoUrl, token: TOKEN }, signal: live() });
    const dir = join(w.runnerRoot, "v0.2.0");
    expect(r).toEqual({ ok: true, value: { installed: true, dir } });
    expect(readFileSync(join(dir, "src/cli/main.ts"), "utf8")).toBe("console.log(Bun.argv.slice(2).join(' '));\n");
    expect(readFileSync(join(dir, RUNNER_MARKER), "utf8")).toBe(`v0.2.0\n${w.sha}\n`);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, "node_modules"))).toBe(true);
    expect(leftovers(w.runnerRoot)).toEqual([]);
    expect(w.server.seen()).toContain(TOKEN);
  });

  test("an annotated tag installs its commit", async () => {
    const w = await world();
    const deps: InstallDeps = async () => ok(undefined);
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v0.3.0", url: w.server.repoUrl, credential: { url: w.server.repoUrl, token: TOKEN }, signal: live(), installDeps: deps });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(w.runnerRoot, "v0.3.0", RUNNER_MARKER), "utf8")).toBe(`v0.3.0\n${w.annotatedSha}\n`);
  });

  test("already present: nothing fetched", async () => {
    const w = await world();
    mkdirSync(join(w.runnerRoot, "v0.2.0"), { recursive: true });
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v0.2.0", url: w.server.repoUrl, signal: live() });
    expect(r).toEqual({ ok: true, value: { installed: false, dir: join(w.runnerRoot, "v0.2.0") } });
    expect(w.server.seen()).toEqual([]);
  });

  test("a missing tag: an error naming the fetch, no runner folder, no staging left", async () => {
    const w = await world();
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v9.9.9", url: w.server.repoUrl, credential: { url: w.server.repoUrl, token: TOKEN }, signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("fetch");
    expect(r.ok ? "" : r.error.message).toContain("fetch");
    expect(existsSync(join(w.runnerRoot, "v9.9.9"))).toBe(false);
    expect(leftovers(w.runnerRoot)).toEqual([]);
  });

  test("a failed dependency install leaves no runner folder and no staging", async () => {
    const w = await world();
    const deps: InstallDeps = async () => ({ ok: false, error: { kind: "deps", message: "boom" } });
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v0.2.0", url: w.server.repoUrl, credential: { url: w.server.repoUrl, token: TOKEN }, signal: live(), installDeps: deps });
    expect(r.ok ? "ok" : r.error.kind).toBe("deps");
    expect(existsSync(join(w.runnerRoot, "v0.2.0"))).toBe(false);
    expect(leftovers(w.runnerRoot)).toEqual([]);
  });

  test("losing the rename race to an existing folder counts as success", async () => {
    const w = await world();
    const deps: InstallDeps = async () => {
      mkdirSync(join(w.runnerRoot, "v0.2.0", "src"), { recursive: true });
      return ok(undefined);
    };
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v0.2.0", url: w.server.repoUrl, credential: { url: w.server.repoUrl, token: TOKEN }, signal: live(), installDeps: deps });
    expect(r).toEqual({ ok: true, value: { installed: false, dir: join(w.runnerRoot, "v0.2.0") } });
    expect(leftovers(w.runnerRoot)).toEqual([]);
  });

  test.each([["../x"], ["v1/2"], [""], ["..."]])("version %j is refused before anything is written", async (version) => {
    const root = mkdtempSync(join(tmpdir(), "xarabot-runner-bad-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runnerRoot = join(root, "runner");
    const r = await installRunner({ runnerRoot, version, url: "https://example.invalid/x.git", signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("version");
    expect(existsSync(runnerRoot)).toBe(false);
  });

  test("a wrong token fails the fetch and the token is not in the message", async () => {
    const w = await world();
    const r = await installRunner({ runnerRoot: w.runnerRoot, version: "v0.2.0", url: w.server.repoUrl, credential: { url: w.server.repoUrl, token: "ghs_wrong" }, signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("fetch");
    expect(r.ok ? "" : r.error.message).not.toContain("ghs_wrong");
    expect(leftovers(w.runnerRoot)).toEqual([]);
  });
});
