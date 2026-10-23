import { expect, test } from "bun:test";
import { loadAppCredentials, type AppCredentials } from "../../src/adapters/forge/github/credentials.ts";
import { createGitHubForge, type SnapshotPart } from "../../src/adapters/forge/github/github-forge.ts";
import { GITHUB_OPERATIONS, isSuccess, request, SWAP_CONFLICT_STATUS, type Operation } from "../../src/adapters/forge/github/http.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import type { ForgeOperation, ForgeResult } from "../../src/ports/forge.ts";
import { createFakeGitHub, testKeys } from "../adapters/forge/github/fake-github.ts";
import { isLive } from "../support/live.ts";
import { forgeContract, type ForgeFixture } from "./forge.contract.ts";

/** The operations Story 1.8 implements; the rest are stubs until Stories 1.9 and 1.10. */
const IMPLEMENTED: readonly ForgeOperation[] = ["snapshot", "ledgerSwap"];

// ------------------------------------------------------------ emulator

forgeContract({
  name: "github (emulator)",
  operations: IMPLEMENTED,
  controls: ["setMain", "setNow", "writeForeignLedger", "trace"],
  make: () => {
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
    });
    return {
      forge,
      control: {
        setMain: (files) => gh.control.setMain(files),
        setNow: (now) => gh.control.setNow(now),
        writeForeignLedger: (commit) => gh.control.writeForeignLedger(commit),
        trace: () => [...trace],
      },
    };
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

function must<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

const signal = (): AbortSignal => AbortSignal.timeout(60_000);

/** A live scratch ledger branch: its forge, a raw API call for test setup, and cleanup. */
async function liveScratch(): Promise<{
  branch: string;
  forge: ReturnType<typeof createGitHubForge>;
  raw: (op: Operation, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  cleanup: () => Promise<void>;
  trace: SnapshotPart[];
}> {
  const repo = liveRepo();
  const credentials = await liveCredentials();
  const branch = `xarabot/test-${crypto.randomUUID()}`;
  const trace: SnapshotPart[] = [];
  const forge = createGitHubForge({ repo, credentials, ledgerBranch: branch, onRead: (part) => trace.push(part) });
  const tokens = createTokenSource({ credentials, repo });
  const raw = async (op: Operation, path: string, body?: unknown) => {
    const s = signal();
    const token = must(await tokens.get(s));
    const r = must(await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token, signal: s, body }));
    return { status: r.status, body: r.body };
  };
  const cleanup = async () => {
    const r = await raw(DELETE_REF, `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
    if (!isSuccess(r.status) && r.status !== 404 && r.status !== 422) throw new Error(`cleanup of ${branch}: ${r.status}`);
  };
  return { branch, forge, raw, cleanup, trace };
}

forgeContract({
  name: "github (live)",
  enabled: liveEnabled,
  operations: IMPLEMENTED,
  controls: ["writeForeignLedger", "trace"],
  make: async (): Promise<ForgeFixture> => {
    const s = await liveScratch();
    // A second adapter instance on the same branch writes as another lane would.
    const other = createGitHubForge({ repo: liveRepo(), credentials: await liveCredentials(), ledgerBranch: s.branch });
    return {
      forge: s.forge,
      control: {
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
