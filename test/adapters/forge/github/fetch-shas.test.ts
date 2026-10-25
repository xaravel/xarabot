import { afterEach, describe, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubFetch } from "../../../../src/adapters/forge/github/fetch-shas.ts";
import { openRunnerGit, runGit } from "../../../../src/adapters/forge/github/runner-git.ts";
import type { ForgeResult } from "../../../../src/ports/forge.ts";
import { hostTest } from "../../../support/sandbox.ts";
import { createFakeGitHub, testKeys } from "./fake-github.ts";
import { startGitServer } from "./git-server.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const live = () => AbortSignal.timeout(30_000);

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const dir = mkdtempSync(join(tmpdir(), "xarabot-fetch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = await startGitServer({ root: join(dir, "remote"), owner: "acme", name: "widgets", tokenValid: (t) => gh.control.tokenValid(t) });
  cleanups.push(() => server.stop());
  // Two commits on the remote, one on a branch and one only reachable from it.
  const ident = { name: "t", email: "t@x.invalid" };
  const a = value(await runGit(server.repoDir, ["commit-tree", EMPTY_TREE, "-m", "a"], { signal: live(), identity: ident })).stdout.trim();
  const b = value(await runGit(server.repoDir, ["commit-tree", EMPTY_TREE, "-p", a, "-m", "b"], { signal: live(), identity: ident })).stdout.trim();
  value(await runGit(server.repoDir, ["update-ref", "refs/heads/main", b], { signal: live() }));
  const gitDir = value(await openRunnerGit(join(dir, "lane"), { signal: live() }));
  const fetch = createGitHubFetch({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    gitDir,
    gitUrl: server.url,
    apiUrl: gh.control.apiUrl,
    fetch: gh.fetch,
    now: gh.control.clock,
  });
  const has = async (sha: string) => value(await runGit(gitDir, ["cat-file", "-e", `${sha}^{commit}`], { signal: live() })).code === 0;
  return { gh, server, gitDir, fetch, a, b, has };
}

describe("createGitHubFetch", () => {
  hostTest("fetches the SHAs into runner.git with a minted token", async () => {
    const { gh, server, fetch, a, b, has } = await setup();
    expect(await has(b)).toBe(false);
    expect(await fetch([b, a], live())).toEqual({ ok: true, value: undefined });
    expect(await has(a)).toBe(true);
    expect(await has(b)).toBe(true);
    const minted = gh.control.tokens();
    expect(minted).toHaveLength(1);
    expect(server.seen()).toContain(minted[0] as string);
  });

  hostTest("no SHAs: nothing fetched, no token", async () => {
    const { gh, fetch } = await setup();
    expect(await fetch([], live())).toEqual({ ok: true, value: undefined });
    expect(gh.control.mints()).toBe(0);
  });

  hostTest("a SHA the remote lacks is an error, and the token never shows", async () => {
    const { gh, fetch } = await setup();
    const r = await fetch(["1".repeat(40)], live());
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.error.message;
    for (const t of gh.control.tokens()) expect(text).not.toContain(t);
  });

  hostTest("a rejected token is an error with the token redacted", async () => {
    const { gh, fetch, a, b } = await setup();
    // Mint with one fetch, then revoke, so the git server refuses the cached token.
    expect((await fetch([a], live())).ok).toBe(true);
    gh.control.revokeTokens();
    const r = await fetch([b], live());
    expect(r.ok ? "ok" : r.error.kind).toBe("fetch");
    expect(r.ok ? "" : r.error.message).toContain("git exited");
    // The refused token was dropped: the next fetch mints a fresh one and succeeds.
    expect(gh.control.mints()).toBe(1);
    expect(await fetch([b], live())).toEqual({ ok: true, value: undefined });
    expect(gh.control.mints()).toBe(2);
    for (const t of gh.control.tokens()) expect(r.ok ? "" : r.error.message).not.toContain(t);
  });

  hostTest("a non-SHA is refused before any git run", async () => {
    const { gh, fetch } = await setup();
    const r = await fetch(["main"], live());
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
    expect(gh.control.mints()).toBe(0);
  });
});
