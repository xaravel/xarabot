import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubForge, type SnapshotPart } from "../../src/adapters/forge/github/github-forge.ts";
import { GITHUB_OPERATIONS, isSuccess, request, SWAP_CONFLICT_STATUS, type Operation } from "../../src/adapters/forge/github/http.ts";
import { openRunnerGit, runGit, type GitIdentity } from "../../src/adapters/forge/github/runner-git.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import { FORGE_OPERATIONS, type Forge, type ForgeOperation, type ForgePr, type ForgeResult, type GitSha } from "../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "../adapters/forge/github/fake-github.ts";
import { startGitServer, type GitServer } from "../adapters/forge/github/git-server.ts";
import { cleanupScratch, LIVE_LOGIN, liveCredentials, liveGithubEnabled, liveRepo, prefixed } from "../support/live-github.ts";
import { isSandboxed } from "../support/sandbox.ts";
import { forgeContract, type ForgeFixture } from "./forge.contract.ts";

/** The operations the GitHub adapter implements: all of them (Stories 1.8 to 1.10). */
const IMPLEMENTED: readonly ForgeOperation[] = FORGE_OPERATIONS;

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

/**
 * The `addInboxCommentBeforeRead` control on the emulator: one hook on the
 * next list of issue `read`'s comments runs every comment queued for it.
 */
function beforeRead(gh: FakeGitHub): (read: number, issue: number, author: string, body: string) => void {
  const queued = new Map<number, (() => void)[]>();
  return (read, issue, author, body) => {
    const add = () => gh.control.addComment(issue, body, author);
    const list = queued.get(read);
    if (list !== undefined) {
      list.push(add);
      return;
    }
    const fresh = [add];
    queued.set(read, fresh);
    gh.control.before("GET", new RegExp(`^/repos/acme/widgets/issues/${read}/comments\\?`), () => {
      queued.delete(read);
      for (const f of fresh) f();
    });
  };
}

// ------------------------------------------------------------ emulator

// The emulator's git remote binds a socket, which a session's profile denies:
// inside a session (`XARABOT_SANDBOXED=1`) every emulator case reports skipped.
forgeContract({
  name: "github (emulator)",
  enabled: !isSandboxed,
  operations: IMPLEMENTED,
  controls: [
    "makeCommit",
    "comments",
    "setChecks",
    "setCiLog",
    "setMain",
    "setNow",
    "writeForeignLedger",
    "queue",
    "mergeQueueHead",
    "trace",
    "refusePushes",
    "addReview",
    "reviewBodies",
    "inboxes",
    "inboxComments",
    "addInboxComment",
    "addInboxCommentBeforeRead",
  ],
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
      const remote = server;
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
        maintainer: "alice",
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
          reviewBodies: (pr) => gh.control.reviewBodies(pr),
          inboxes: () =>
            gh.control.issues().map((i) => ({ number: i.number, title: i.title, owner: i.assignees[0] ?? null, body: i.body, open: i.state === "open" })),
          inboxComments: (issue) => gh.control.comments(issue),
          addInboxComment: (issue, author, body) => gh.control.addComment(issue, body, author),
          addInboxCommentBeforeRead: beforeRead(gh),
          setChecks: (sha, checks) => gh.control.setChecks(sha, checks),
          setCiLog: (sha, check, log) => gh.control.setCiLog(sha, check, log),
          setMain: (files) => gh.control.setMain(files),
          setNow: (now) => gh.control.setNow(now),
          writeForeignLedger: (commit) => gh.control.writeForeignLedger(commit),
          queue: () => gh.control.queue(),
          mergeQueueHead: () => gh.control.mergeQueueHead(),
          addReview: (pr, r) =>
            gh.control.addReview(pr, { login: r.author, state: r.state.toUpperCase(), commit_id: r.commit_sha, submitted_at: r.submitted_at }),
          trace: () => [...trace],
          // A pre-receive hook in the git server's bare repo refuses the listed refs.
          refusePushes: (branch) => remote.refuse(branch),
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

// The emulator with no git remote: nothing binds a socket, so it runs inside a
// session too. The cases that push (and so need `makeCommit`) report skipped.
forgeContract({
  name: "github (emulator, no git remote)",
  operations: FORGE_OPERATIONS.filter((op) => op !== "pushBranch"),
  controls: ["comments", "setChecks", "setCiLog", "setMain", "setNow", "writeForeignLedger", "trace", "inboxes", "inboxComments", "addInboxComment", "addInboxCommentBeforeRead"],
  make: (): ForgeFixture => {
    const { privateKey, publicKey } = testKeys();
    const gh = createFakeGitHub({ publicKey });
    const trace: SnapshotPart[] = [];
    const forge = createGitHubForge({
      repo: { owner: "acme", name: "widgets" },
      credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
      fetch: gh.fetch,
      apiUrl: gh.control.apiUrl,
      now: gh.control.clock,
      onRead: (part) => trace.push(part),
      maintainer: "alice",
    });
    return {
      forge,
      control: {
        comments: (pr) => gh.control.comments(pr),
        setChecks: (sha, checks) => gh.control.setChecks(sha, checks),
        setCiLog: (sha, check, log) => gh.control.setCiLog(sha, check, log),
        setMain: (files) => gh.control.setMain(files),
        setNow: (now) => gh.control.setNow(now),
        writeForeignLedger: (commit) => gh.control.writeForeignLedger(commit),
        trace: () => [...trace],
        inboxes: () => gh.control.issues().map((i) => ({ number: i.number, title: i.title, owner: i.assignees[0] ?? null, body: i.body, open: i.state === "open" })),
        inboxComments: (issue) => gh.control.comments(issue),
        addInboxComment: (issue, author, body) => gh.control.addComment(issue, body, author),
        addInboxCommentBeforeRead: beforeRead(gh),
      },
    };
  },
});

// ------------------------------------------------------------ live

/** Test-only: lists a PR's comments. Not part of the adapter. */
const LIST_COMMENTS: Operation = { name: "listComments (live test)", method: "GET", permission: "pull_requests: write" };
/** Test-only: lists a PR's reviews with their bodies. Not part of the adapter. */
const LIST_REVIEW_BODIES: Operation = { name: "listReviewBodies (live test)", method: "GET", permission: "pull_requests: write" };

/**
 * A live scratch area: a ledger branch, a `runner.git`, a forge whose unit
 * branches and alert conditions are prefixed `xarabot-test/<uuid>/` and whose
 * alerts go to `LIVE_LOGIN`'s inbox, a raw API call for test setup,
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
  const inner = createGitHubForge({ repo, credentials, ledgerBranch: branch, onRead: (part) => trace.push(part), runnerGit: gitDir, maintainer: LIVE_LOGIN });
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
    try {
      await cleanupScratch({ forge: inner, raw, touched, ledgerBranch: branch, signal });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { branch, forge, raw, makeCommit, cleanup, trace };
}

forgeContract({
  name: "github (live)",
  enabled: liveGithubEnabled,
  operations: IMPLEMENTED,
  controls: ["makeCommit", "comments", "reviewBodies", "writeForeignLedger", "trace", "inboxComments"],
  inboxOwner: LIVE_LOGIN,
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
        // An issue's comments list as a PR's do.
        inboxComments: async (issue) => {
          const r = await s.raw(LIST_COMMENTS, `/issues/${issue}/comments?per_page=100`);
          if (!isSuccess(r.status) || !Array.isArray(r.body)) throw new Error(`list comments of #${issue}: ${r.status}`);
          return r.body.map((c) => String((c as { body?: unknown }).body));
        },
        reviewBodies: async (pr) => {
          const r = await s.raw(LIST_REVIEW_BODIES, `/pulls/${pr}/reviews?per_page=100`);
          if (!isSuccess(r.status) || !Array.isArray(r.body)) throw new Error(`list reviews of #${pr}: ${r.status}`);
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

test.skipIf(!liveGithubEnabled)("live: a stale PATCH git/refs answers SWAP_CONFLICT_STATUS", async () => {
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

test.skipIf(!liveGithubEnabled)(
  "live AR38: enqueue at the head is ok or conflict, never forbidden",
  async () => {
    const s = await liveScratch();
    let pr: ForgePr | undefined;
    try {
      const sha = await s.makeCommit();
      must(await s.forge.pushBranch({ branch: "story/ar38", expected_sha: null, sha }, { signal: signal() }));
      pr = must(await s.forge.openPr({ branch: "story/ar38", base: "main", title: "xarabot live AR38 probe", body: "Closed by the test." }, { signal: signal() }));
      const r = await s.forge.enqueue(pr.number, sha, { signal: signal() });
      expect(r.ok ? "ok" : `${r.error.kind}: ${r.error.message}`).toMatch(/^(?:ok|conflict: )/);
    } finally {
      try {
        if (pr !== undefined) must(await s.forge.dequeue(pr.number, { signal: signal() }));
      } finally {
        await s.cleanup();
      }
    }
  },
  120_000,
);

test.skipIf(!liveGithubEnabled)("live: checks reads a pushed commit", async () => {
  const s = await liveScratch();
  try {
    const sha = await s.makeCommit();
    must(await s.forge.pushBranch({ branch: "story/checks", expected_sha: null, sha }, { signal: signal() }));
    const r = await s.forge.checks(sha, { signal: signal() });
    expect(r.ok ? "ok" : `${r.error.kind}: ${r.error.message}`).toBe("ok");
  } finally {
    await s.cleanup();
  }
});
