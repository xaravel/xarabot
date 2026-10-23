import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubForge, mapPushResult } from "../../../../src/adapters/forge/github/github-forge.ts";
import { openRunnerGit, runGit, runnerGitEnv } from "../../../../src/adapters/forge/github/runner-git.ts";
import type { Forge, ForgeResult, PushLease } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";
import { startGitServer, type GitServer } from "./git-server.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const live = () => ({ signal: AbortSignal.timeout(30_000) });

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function kind<T>(r: ForgeResult<T>): string {
  return r.ok ? "ok" : r.error.kind;
}

type Setup = { gh: FakeGitHub; server: GitServer; forge: Forge; gitDir: string; lane: string; commit: () => Promise<string> };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(extra: { hold?: (r: Request) => Promise<void>; runnerGit?: boolean } = {}): Promise<Setup> {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const dir = mkdtempSync(join(tmpdir(), "xarabot-push-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = await startGitServer({
    root: join(dir, "remote"),
    owner: "acme",
    name: "widgets",
    tokenValid: (t) => gh.control.tokenValid(t),
    onPush: (refs) => {
      for (const [b, sha] of Object.entries(refs)) gh.control.setBranch(b, sha);
    },
    hold: extra.hold,
  });
  cleanups.push(() => server.stop());
  const lane = join(dir, "lane");
  const gitDir = value(await openRunnerGit(lane, live()));
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    runnerGit: extra.runnerGit === false ? undefined : gitDir,
    gitUrl: server.url,
  });
  let n = 0;
  const commit = async () => {
    const r = value(await runGit(gitDir, ["commit-tree", EMPTY_TREE, "-m", `c${n++}`], { ...live(), identity: { name: "t", email: "t@x.invalid" } }));
    return r.stdout.trim();
  };
  return { gh, server, forge, gitDir, lane, commit };
}

describe("pushBranch", () => {
  test("new branch: a null lease creates it; a second null lease to another sha is conflict", async () => {
    const { forge, server, commit } = await setup();
    const [a, b] = [await commit(), await commit()];
    expect(value(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()))).toEqual({ sha: a });
    expect(await server.refs()).toEqual({ "story/1.9": a });
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: b }, live()))).toBe("conflict");
    expect(await server.refs()).toEqual({ "story/1.9": a });
  });

  test("stale lease: remote at A, lease expects C is conflict and the remote is unchanged", async () => {
    const { forge, server, commit } = await setup();
    const [a, b, c] = [await commit(), await commit(), await commit()];
    value(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()));
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: c, sha: b }, live()))).toBe("conflict");
    expect(await server.refs()).toEqual({ "story/1.9": a });
    expect(value(await forge.pushBranch({ branch: "story/1.9", expected_sha: a, sha: b }, live()))).toEqual({ sha: b });
    expect(await server.refs()).toEqual({ "story/1.9": b });
  });

  test("a lease on a missing branch is conflict", async () => {
    const { forge, server, commit } = await setup();
    const [a, b] = [await commit(), await commit()];
    expect(kind(await forge.pushBranch({ branch: "story/2.2", expected_sha: a, sha: b }, live()))).toBe("conflict");
    expect(await server.refs()).toEqual({});
  });

  test("up to date: remote at A, pushing A with a null lease is conflict; expecting A is ok", async () => {
    const { forge, commit } = await setup();
    const a = await commit();
    value(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()));
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()))).toBe("conflict");
    expect(value(await forge.pushBranch({ branch: "story/1.9", expected_sha: a, sha: a }, live()))).toEqual({ sha: a });
  });

  test("the pushed branch moves the emulator's ref, so an open PR's head follows", async () => {
    const { forge, gh, commit } = await setup();
    const [a, b] = [await commit(), await commit()];
    value(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()));
    const pr = value(await forge.openPr({ branch: "story/1.9", base: "main", title: "t", body: "b" }, live()));
    expect(pr.head_sha).toBe(a);
    value(await forge.pushBranch({ branch: "story/1.9", expected_sha: a, sha: b }, live()));
    expect(gh.control.ref("story/1.9")).toBe(b);
    expect(value(await forge.listPrsByBranch("story/1.9", live()))[0]?.head_sha).toBe(b);
  });

  test("unknown sha: valid hex not in runner.git, or not hex at all, is not-found", async () => {
    const { forge, server } = await setup();
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: "a".repeat(40) }, live()))).toBe("not-found");
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: "HEAD" }, live()))).toBe("not-found");
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: EMPTY_TREE }, live()))).toBe("not-found");
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: "main", sha: "a".repeat(40) }, live()))).toBe("not-found");
    expect(await server.refs()).toEqual({});
  });

  test("reserved and invalid branches are forbidden", async () => {
    const { forge, server, commit } = await setup();
    const a = await commit();
    for (const branch of ["main", "xarabot/claims", "bad..name", "a b", "x:y", "ends.lock", "", "-x/"]) {
      expect([branch, kind(await forge.pushBranch({ branch, expected_sha: null, sha: a }, live()))]).toEqual([branch, "forbidden"]);
    }
    expect(await server.refs()).toEqual({});
  });

  test("without runnerGit the push is forbidden", async () => {
    const { forge } = await setup({ runnerGit: false });
    const r = await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: "a".repeat(40) }, live());
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "forbidden", message: "pushBranch: no runner.git configured" });
  });

  test("a revoked token is auth", async () => {
    const { forge, gh, commit } = await setup();
    const a = await commit();
    value(await forge.snapshot(live()));
    gh.control.revokeTokens();
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()))).toBe("auth");
    // The dropped token is re-minted for the next call.
    expect(value(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()))).toEqual({ sha: a });
  });

  test("hooks and a credential helper planted in runner.git do nothing", async () => {
    const { forge, server, gitDir, lane, commit } = await setup();
    const marker = join(lane, "hook-ran");
    const hooks = join(lane, "planted-hooks");
    for (const d of [join(gitDir, "hooks"), hooks]) {
      await Bun.write(join(d, "pre-push"), `#!/bin/sh\necho ran >> ${marker}\n`);
      await Bun.write(join(d, "reference-transaction"), `#!/bin/sh\necho ran >> ${marker}\n`);
      for (const h of ["pre-push", "reference-transaction"]) Bun.spawnSync(["chmod", "755", join(d, h)]);
    }
    const a = await commit();
    for (const [key, val] of [
      ["core.hooksPath", hooks],
      ["credential.helper", "!f() { echo username=x-access-token; echo password=planted; }; f"],
    ] as const) {
      expect(value(await runGit(gitDir, ["config", key, val], live())).code).toBe(0);
    }
    value(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()));
    expect(existsSync(marker)).toBe(false);
    expect(server.seen()).not.toContain("planted");
  });

  test("an aborted push changes nothing", async () => {
    const { forge, server, commit } = await setup();
    const a = await commit();
    expect(kind(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, { signal: AbortSignal.abort() }))).toBe("transient");
    expect(await server.refs()).toEqual({});
  });
});

describe("token leak", () => {
  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...filesUnder(p));
      else out.push(p);
    }
    return out;
  }

  test("a push held mid-request: ps, git's env, lane files, console, results and messages never hold the token; the server saw it", async () => {
    const psDumps: string[] = [];
    const hold = async (r: Request) => {
      if (r.headers.get("authorization") === null) return;
      const ps = Bun.spawn(["ps", "-axwwE"], { stdio: ["ignore", "pipe", "ignore"] });
      psDumps.push(await new Response(ps.stdout).text());
      await ps.exited;
    };
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => spyOn(console, m));
    try {
      const { forge, gh, server, gitDir, lane, commit } = await setup({ hold });
      const [a, b] = [await commit(), await commit()];
      const results: unknown[] = [];
      results.push(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: a }, live()));
      results.push(await forge.pushBranch({ branch: "story/1.9", expected_sha: null, sha: b }, live()));
      results.push(await forge.pushBranch({ branch: "story/1.9", expected_sha: a, sha: b }, live()));
      expect(results.map((r) => kind(r as ForgeResult<unknown>))).toEqual(["ok", "conflict", "ok"]);

      const [token] = gh.control.tokens();
      if (token === undefined) throw new Error("no token minted");
      expect(server.seen()).toContain(token);
      expect(psDumps.length).toBeGreaterThan(0);
      // The git processes were alive and visible while the request was held.
      expect(psDumps.some((d) => d.includes("git-remote-http"))).toBe(true);

      const haystacks = [
        ...psDumps,
        JSON.stringify(runnerGitEnv(gitDir)),
        JSON.stringify(process.env),
        process.argv.join(" "),
        ...filesUnder(lane).map((f) => readFileSync(f, "latin1")),
        JSON.stringify(spies.map((s) => s.mock.calls)),
        JSON.stringify(results),
      ];
      for (const h of haystacks) expect(h.includes(token)).toBe(false);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("mapPushResult", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const lease = (expected: string | null, sha = B): PushLease => ({ branch: "story/1.9", expected_sha: expected, sha });
  const line = (flag: string, summary: string, ref = "refs/heads/story/1.9") => `To https://github.com/acme/widgets.git\n${flag}\t${B}:${ref}\t${summary}\nDone\n`;

  test.each([
    ["new branch", lease(null), line("*", "[new branch]"), 0, "", "ok"],
    ["forced update", lease(A), line("+", `${A.slice(0, 7)}...${B.slice(0, 7)} (forced update)`), 0, "", "ok"],
    ["fast-forward", lease(A), line(" ", `${A.slice(0, 7)}..${B.slice(0, 7)}`), 0, "", "ok"],
    ["up to date, lease held", lease(B), line("=", "[up to date]"), 0, "", "ok"],
    ["up to date, null lease", lease(null), line("=", "[up to date]"), 0, "", "conflict"],
    ["up to date, other lease", lease(A), line("=", "[up to date]"), 0, "", "conflict"],
    ["stale info", lease(A), line("!", "[rejected] (stale info)"), 1, "error: failed to push", "conflict"],
    ["fetch first", lease(A), line("!", "[rejected] (fetch first)"), 1, "", "conflict"],
    ["non-fast-forward", lease(A), line("!", "[rejected] (non-fast-forward)"), 1, "", "conflict"],
    ["remote rejected, lock", lease(A), line("!", "[remote rejected] (cannot lock ref 'refs/heads/story/1.9')"), 1, "", "transient"],
    ["remote rejected, rule", lease(A), line("!", "[remote rejected] (protected branch hook declined)"), 1, "", "forbidden"],
    ["other ref only", lease(A), line("*", "[new branch]", "refs/heads/other"), 1, "", "transient"],
    ["auth failed", lease(A), "", 128, "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'", "auth"],
    ["invalid password", lease(A), "", 128, "remote: Invalid username or password.", "auth"],
    ["401", lease(A), "", 128, "fatal: unable to access 'x': The requested URL returned error: 401", "auth"],
    ["403", lease(A), "", 128, "fatal: unable to access 'x': The requested URL returned error: 403", "forbidden"],
    ["permission", lease(A), "", 128, "remote: Permission to acme/widgets.git denied to bot.", "forbidden"],
    ["not found", lease(A), "", 128, "remote: Repository not found.", "not-found"],
    ["404", lease(A), "", 128, "fatal: unable to access 'x': The requested URL returned error: 404", "not-found"],
    ["429", lease(A), "", 128, "fatal: unable to access 'x': The requested URL returned error: 429", "rate-limited"],
    ["network", lease(A), "", 128, "fatal: unable to access 'x': Could not resolve host: github.com", "transient"],
  ] as const)("%s", (_name, l, stdout, code, stderr, expected) => {
    const r = mapPushResult(l, { code, stdout, stderr });
    expect(kind(r)).toBe(expected);
    if (r.ok) expect(r.value).toEqual({ sha: l.sha });
    if (!r.ok && r.error.kind === "rate-limited") expect(r.error.retry_after).toBe(60);
  });
});
