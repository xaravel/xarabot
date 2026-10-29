import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerGit, runGit } from "../../src/adapters/forge/github/runner-git.ts";
import { githubConnect } from "../../src/cli/lane-connection.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { ForgeResult } from "../../src/ports/forge.ts";
import { createFakeGitHub, testKeys } from "../adapters/forge/github/fake-github.ts";
import { startGitServer } from "../adapters/forge/github/git-server.ts";
import { hostTest } from "../support/sandbox.ts";

/**
 * The production `githubConnect` (C14): the App credentials it loads from
 * `$XDG_CONFIG_HOME/xarabot/apps/<owner>-xarabot/`, against the fake GitHub
 * and a local git server in place of github.com. The push binds a socket, so
 * it is a `hostTest`; the alert and the credential cases run anywhere.
 */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LANE: Lane = { repo: "acme/widgets", role: "builder", owner: "alice", agent: "claude", effort: "high" };
const live = () => ({ signal: AbortSignal.timeout(30_000) });

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A temp folder with the App credentials where `loadAppCredentials` reads them; the fake GitHub on the host's clock. */
function world() {
  const { privateKey, publicKey } = testKeys();
  // The fake's clock is the host's, so the JWT the token source signs with `Date.now` is current.
  const gh = createFakeGitHub({ publicKey, now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), "xarabot-connect-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const xdg = join(dir, "config");
  const appDir = join(xdg, "xarabot", "apps", "alice-xarabot");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "private-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(join(appDir, "private-key.pem"), 0o600);
  writeFileSync(join(appDir, "app.json"), JSON.stringify({ id: 4242, slug: "alice-xarabot" }));
  return { gh, dir, env: { HOME: join(dir, "home"), XDG_CONFIG_HOME: xdg } };
}

async function connected(connect: ReturnType<typeof githubConnect>) {
  const c = await connect(LANE);
  if (!c.ok) throw new Error(c.message);
  return c.connection;
}

describe("githubConnect", () => {
  test("the production connection's maintainer forge posts an alert through the API", async () => {
    const { gh, env } = world();
    const connection = await connected(githubConnect(env, { fetch: gh.fetch, apiUrl: gh.control.apiUrl }));
    const main = gh.control.ref("main") as string;
    expect(value(await connection.forge({ maintainer: "alice" }).alert("forge-auth", main, live()))).toEqual({ posted: true });
    const [issue, ...more] = gh.control.issues();
    expect(more).toEqual([]);
    expect(issue).toMatchObject({ assignees: ["alice"] });
    expect(gh.control.comments(issue?.number as number)).toHaveLength(1);
    // The installation token comes through the same injected API.
    expect(value(await connection.token(live().signal)).length).toBeGreaterThan(0);
    expect(value(await connection.botUserId(live().signal))).toBe(41898282);
  });

  test("the production connection's forge deletes only in its unit-branch namespace: another branch is forbidden with no request", async () => {
    const { gh, env } = world();
    const connection = await connected(githubConnect(env, { fetch: gh.fetch, apiUrl: gh.control.apiUrl }));
    const main = gh.control.ref("main") as string;
    gh.control.setBranch("bot/reconcile-1", main);
    gh.control.setBranch("xarabot/reconcile-1", main);
    const forge = connection.forge({ unitBranchPrefix: "bot/" });
    gh.control.clearLog();
    const refused = await forge.deleteBranch("xarabot/reconcile-1", live());
    expect(refused.ok ? "ok" : refused.error.kind).toBe("forbidden");
    expect(gh.control.log()).toEqual([]);
    expect(gh.control.ref("xarabot/reconcile-1")).toBe(main);
    expect(value(await forge.deleteBranch("bot/reconcile-1", live()))).toEqual({ deleted: true });
    expect(gh.control.ref("bot/reconcile-1")).toBeUndefined();
  });

  hostTest("the production connection's runner.git forge pushes through git", async () => {
    const { gh, dir, env } = world();
    const server = await startGitServer({
      root: join(dir, "remote"),
      owner: "acme",
      name: "widgets",
      tokenValid: (t) => gh.control.tokenValid(t),
      onPush: (refs) => {
        for (const [b, sha] of Object.entries(refs)) gh.control.setBranch(b, sha);
      },
    });
    cleanups.push(() => server.stop());
    const connection = await connected(githubConnect(env, { fetch: gh.fetch, apiUrl: gh.control.apiUrl, gitUrl: server.url }));

    const gitDir = value(await openRunnerGit(join(dir, "lane"), live()));
    const made = value(await runGit(gitDir, ["commit-tree", EMPTY_TREE, "-m", "c0"], { ...live(), identity: { name: "t", email: "t@x.invalid" } }));
    const sha = made.stdout.trim();
    const forge = connection.forge({ runnerGit: gitDir });
    expect(value(await forge.pushBranch({ branch: "story/1.1", expected_sha: null, sha }, live()))).toEqual({ sha });
    expect(await server.refs()).toEqual({ "story/1.1": sha });
    expect(value(await forge.branchHead("story/1.1", live()))).toBe(sha);
  });

  test("missing credentials are an auth failure naming the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xarabot-connect-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = await githubConnect({ XDG_CONFIG_HOME: dir })(LANE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toStartWith("credentials auth: ");
    expect(r.message).toContain(join(dir, "xarabot", "apps", "alice-xarabot"));
  });
});
