import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppCredentials, type AppCredentials } from "../../src/adapters/forge/github/credentials.ts";
import { createGitHubForge, type SnapshotPart } from "../../src/adapters/forge/github/github-forge.ts";
import { GITHUB_OPERATIONS, isSuccess, request, SWAP_CONFLICT_STATUS, type Operation } from "../../src/adapters/forge/github/http.ts";
import { openRunnerGit, runGit, type GitIdentity } from "../../src/adapters/forge/github/runner-git.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import type { Forge, ForgeOperation, ForgePr, ForgeResult, GitSha } from "../../src/ports/forge.ts";
import { createFakeGitHub, testKeys } from "../adapters/forge/github/fake-github.ts";
import { startGitServer, type GitServer } from "../adapters/forge/github/git-server.ts";
import { isLive } from "../support/live.ts";
import { forgeContract, type ForgeFixture } from "./forge.contract.ts";

/** The operations Stories 1.8 and 1.9 implement; the rest are stubs until Story 1.10. */
const IMPLEMENTED: readonly ForgeOperation[] = [
  "snapshot",
  "ledgerSwap",
  "pushBranch",
  "openPr",
  "updatePr",
  "closePr",
  "listPrsByBranch",
  "comment",
  "prefetch",
];

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TEST_IDENTITY: GitIdentity = { name: "xarabot test", email: "test@xarabot.invalid" };

function mustRun(r: Awaited<ReturnType<typeof runGit>>, what: string): string {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  if (r.value.code !== 0) throw new Error(`${what}: exit ${r.value.code}: ${r.value.stderr}`);
  return r.value.stdout.trim();
}

function must<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function signal(): AbortSignal {
  return AbortSignal.timeout(60_000);
}

// ------------------------------------------------------------ emulator

forgeContract({
  name: "github (emulator)",
  operations: IMPLEMENTED,
  controls: ["makeCommit", "comments", "setChecks", "setCiLog", "setMain", "setNow", "writeForeignLedger", "trace"],
  make: async (): Promise<ForgeFixture> => {
    const { privateKey, publicKey } = testKeys();
    const gh = createFakeGitHub({ publicKey });
    const dir = mkdtempSync(join(tmpdir(), "xarabot-gh-contract-"));
    let server: GitServer | undefined;
    try {
      server = await startGitServer({
        root: join(dir, "remote"),
        owner: "acme",
        name: "widgets",
        tokenValid: (t) => gh.control.tokenValid(t),
        onPush: (refs) => {
          for (const [branch, sha] of Object.entries(refs)) gh.control.setBranch(branch, sha);
        },
      });
      const gitDir = must(await openRunnerGit(join(dir, "lane"), { signal: signal() }));
      const trace: SnapshotPart[] = [];
      const forge = createGitHubForge({
        repo: { owner: "acme", name: "widgets" },
        credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
        fetch: gh.fetch,
        apiUrl: gh.control.apiUrl,
        now: gh.control.clock,
        onRead: (part) => trace.push(part),
        runnerGit: gitDir,
        gitUrl: server.url,
      });
      let n = 0;
      return {
        forge,
        control: {
          makeCommit: async () =>
            mustRun(
              await runGit(gitDir, ["commit-tree", EMPTY_TREE, "-m", `test commit ${n++} ${crypto.randomUUID()}`], { signal: signal(), identity: TEST_IDENTITY }),
              "commit-tree",
            ),
          comments: (pr) => gh.control.comments(pr),
          setChecks: (sha, checks) => gh.control.setChecks(sha, checks),
          setCiLog: (sha, check, log) => gh.control.setCiLog(sha, check, log),
          setMain: (files) => gh.control.setMain(files),
          setNow: (now) => gh.control.setNow(now),
          writeForeignLedger: (commit) => gh.control.writeForeignLedger(commit),
          trace: () => [...trace],
        },
        cleanup: async () => {
          await server?.stop();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    } catch (e) {
      await server?.stop();
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  },
});

// ------------------------------------------------------------ live

const LIVE_REPO = process.env.XARABOT_LIVE_GITHUB_REPO ?? "";
const LIVE_LOGIN = process.env.XARABOT_LIVE_GITHUB_LOGIN ?? "";
const liveEnabled = isLive && LIVE_REPO !== "" && LIVE_LOGIN !== "";

/** Test-only: deletes a scratch ledger branch. Not part of the adapter. */
const DELETE_REF: Operation = { name: "deleteRef (live test cleanup)", method: "DELETE", permission: "contents: write" };

function liveRepo(): { owner: string; name: string } {
  const [owner, name] = LIVE_REPO.split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "") {
    throw new Error("XARABOT_LIVE_GITHUB_REPO must be owner/name");
  }
  return { owner, name };
}

async function liveCredentials(): Promise<AppCredentials> {
  const r = await loadAppCredentials({ login: LIVE_LOGIN, env: process.env });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Test-only: lists a PR's comments. Not part of the adapter. */
const LIST_COMMENTS: Operation = { name: "listComments (live test)", method: "GET", permission: "pull_requests: write" };

const encodePath = (branch: string): string => branch.split("/").map(encodeURIComponent).join("/");

/**
 * Wraps a forge so every branch a case names gets `prefix`, and maps the
 * branches in its results back. `touched` collects the real branch names.
 */
function prefixed(forge: Forge, prefix: string, touched: Set<string>): Forge {
  const to = (branch: string): string => {
    touched.add(`${prefix}${branch}`);
    return `${prefix}${branch}`;
  };
  const back = (pr: ForgePr): ForgePr => ({ ...pr, branch: pr.branch.startsWith(prefix) ? pr.branch.slice(prefix.length) : pr.branch });
  const mapPr = (r: ForgeResult<ForgePr>): ForgeResult<ForgePr> => (r.ok ? { ok: true, value: back(r.value) } : r);
  return {
    ...forge,
    pushBranch: (lease, opts) => forge.pushBranch({ ...lease, branch: to(lease.branch) }, opts),
    openPr: async (req, opts) => mapPr(await forge.openPr({ ...req, branch: to(req.branch) }, opts)),
    updatePr: async (pr, req, opts) => mapPr(await forge.updatePr(pr, req, opts)),
    closePr: async (pr, opts) => mapPr(await forge.closePr(pr, opts)),
    listPrsByBranch: async (branch, opts) => {
      const r = await forge.listPrsByBranch(to(branch), opts);
      return r.ok ? { ok: true, value: r.value.map(back) } : r;
    },
  };
}

/**
 * A live scratch area: a ledger branch, a `runner.git`, a forge whose unit
 * branches are prefixed `xarabot-test/<uuid>/`, a raw API call for test setup,
 * a commit maker, and cleanup that closes the PRs and deletes the branches.
 */
async function liveScratch(): Promise<{
  branch: string;
  forge: Forge;
  raw: (op: Operation, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  makeCommit: () => Promise<GitSha>;
  cleanup: () => Promise<void>;
  trace: SnapshotPart[];
}> {
  const repo = liveRepo();
  const credentials = await liveCredentials();
  const branch = `xarabot/test-${crypto.randomUUID()}`;
  const prefix = `xarabot-test/${crypto.randomUUID()}/`;
  const dir = mkdtempSync(join(tmpdir(), "xarabot-gh-live-"));
  const gitDir = must(await openRunnerGit(join(dir, "lane"), { signal: signal() }));
  const trace: SnapshotPart[] = [];
  const inner = createGitHubForge({ repo, credentials, ledgerBranch: branch, onRead: (part) => trace.push(part), runnerGit: gitDir });
  const touched = new Set<string>();
  const forge = prefixed(inner, prefix, touched);
  const tokens = createTokenSource({ credentials, repo });
  const raw = async (op: Operation, path: string, body?: unknown) => {
    const s = signal();
    const token = must(await tokens.get(s));
    const r = must(await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token, signal: s, body }));
    return { status: r.status, body: r.body };
  };

  const repoUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
  let mainSha: string | null = null;
  let n = 0;
  const makeCommit = async (): Promise<GitSha> => {
    if (mainSha === null) {
      const s = signal();
      const token = must(await tokens.get(s));
      mustRun(
        await runGit(gitDir, ["fetch", "--quiet", "--no-tags", repoUrl, "+refs/heads/main:refs/remotes/live/main"], { signal: s, credential: { url: repoUrl, token } }),
        "fetch main",
      );
      mainSha = mustRun(await runGit(gitDir, ["rev-parse", "refs/remotes/live/main"], { signal: signal() }), "rev-parse main");
    }
    const message = `xarabot live test commit ${n++} ${crypto.randomUUID()} [skip ci]`;
    return mustRun(
      await runGit(gitDir, ["commit-tree", `${mainSha}^{tree}`, "-p", mainSha, "-m", message], { signal: signal(), identity: TEST_IDENTITY }),
      "commit-tree",
    );
  };

  const cleanup = async () => {
    const problems: string[] = [];
    for (const b of touched) {
      const listed = await inner.listPrsByBranch(b, { signal: signal() });
      if (listed.ok) {
        for (const pr of listed.value.filter((p) => p.state === "open")) {
          const closed = await inner.closePr(pr.number, { signal: signal() });
          if (!closed.ok) problems.push(`close #${pr.number}: ${closed.error.kind}`);
        }
      } else problems.push(`list ${b}: ${listed.error.kind}`);
      const r = await raw(DELETE_REF, `/git/refs/heads/${encodePath(b)}`);
      if (!isSuccess(r.status) && r.status !== 404 && r.status !== 422) problems.push(`delete ${b}: ${r.status}`);
    }
    const r = await raw(DELETE_REF, `/git/refs/heads/${encodePath(branch)}`);
    if (!isSuccess(r.status) && r.status !== 404 && r.status !== 422) problems.push(`delete ${branch}: ${r.status}`);
    rmSync(dir, { recursive: true, force: true });
    if (problems.length > 0) throw new Error(`live cleanup: ${problems.join("; ")}`);
  };
  return { branch, forge, raw, makeCommit, cleanup, trace };
}

forgeContract({
  name: "github (live)",
  enabled: liveEnabled,
  operations: IMPLEMENTED,
  controls: ["makeCommit", "comments", "writeForeignLedger", "trace"],
  make: async (): Promise<ForgeFixture> => {
    const s = await liveScratch();
    // A second adapter instance on the same branch writes as another lane would.
    const other = createGitHubForge({ repo: liveRepo(), credentials: await liveCredentials(), ledgerBranch: s.branch });
    return {
      forge: s.forge,
      control: {
        makeCommit: s.makeCommit,
        comments: async (pr) => {
          const r = await s.raw(LIST_COMMENTS, `/issues/${pr}/comments?per_page=100`);
          if (!isSuccess(r.status) || !Array.isArray(r.body)) throw new Error(`list comments of #${pr}: ${r.status}`);
          return r.body.map((c) => String((c as { body?: unknown }).body));
        },
        writeForeignLedger: async (commit) => {
          const tip = must(await other.snapshot({ signal: signal() })).ledger.tip;
          return must(await other.ledgerSwap(tip, commit, { signal: signal() })).tip;
        },
        trace: () => [...s.trace],
      },
      cleanup: s.cleanup,
    };
  },
});

test.skipIf(!liveEnabled)("live: a stale PATCH git/refs answers SWAP_CONFLICT_STATUS", async () => {
  const s = await liveScratch();
  try {
    const t0 = must(await s.forge.snapshot({ signal: signal() })).ledger.tip;
    must(await s.forge.ledgerSwap(t0, { message: "t1 [skip ci]", writes: { "units/a.json": "{}" }, deletes: [] }, { signal: signal() }));
    const root = await s.raw(GITHUB_OPERATIONS.getCommit, `/git/commits/${t0}`);
    const tree = (root.body as { tree: { sha: string } }).tree.sha;
    const stale = await s.raw(GITHUB_OPERATIONS.createCommit, "/git/commits", { message: "stale [skip ci]", tree, parents: [t0] });
    const sha = (stale.body as { sha: string }).sha;
    const patch = await s.raw(GITHUB_OPERATIONS.updateRef, `/git/refs/heads/${s.branch.split("/").map(encodeURIComponent).join("/")}`, {
      sha,
      force: false,
    });
    expect(patch.status).toBe(SWAP_CONFLICT_STATUS);
  } finally {
    await s.cleanup();
  }
});
