import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../src/core/result.ts";
import { createGitTreeFiles } from "../../src/lane/tree-files.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { cleanup, commit, live, rg, setup, value } from "./git-fixture.ts";

afterEach(cleanup);

function recordingFetch(impl?: FetchShas): { calls: (readonly string[])[]; fetch: FetchShas } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    fetch: async (shas, signal) => {
      calls.push([...shas]);
      return impl === undefined ? err("fetch", "offline") : impl(shas, signal);
    },
  };
}

/** Plain git fetch of `ref` from another repo (test only; the runner's git refuses file transport). */
function plainFetch(gitDir: string, from: string, ref: string): Result<void> {
  const p = Bun.spawnSync(["git", `--git-dir=${gitDir}`, "fetch", "-q", from, `${ref}:${ref}`], {
    env: { PATH: process.env.PATH ?? "", HOME: gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return p.exitCode === 0 ? ok(undefined) : err("fetch", p.stderr.toString());
}

const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const DOC = "_bmad-output/implementation-artifacts/epic-2-retro-2026-10-25.md";
const FILES: Record<string, string> = { [STATUS]: "development_status: {}\n", [DOC]: "---\nverdict: accepted\n---\n", "src/app.ts": "app\n", "README.md": "hi\n" };

describe("createGitTreeFiles", () => {
  test("the whole listing, sorted, and only the picked files' texts", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, FILES);
    const f = recordingFetch();
    const read = createGitTreeFiles({ gitDir: repo.gitDir, fetch: f.fetch });
    const r = value(await read({ sha, read: (p) => p === STATUS || (p.endsWith(".md") && p.startsWith("_bmad-output/")), ...live() }));
    expect(f.calls).toEqual([]);
    expect(r.tree).toEqual(Object.keys(FILES).sort());
    expect(r.files).toEqual({ [STATUS]: FILES[STATUS] as string, [DOC]: FILES[DOC] as string });
  });

  test("a filter that picks nothing reads no file", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, FILES);
    const r = value(await createGitTreeFiles({ gitDir: repo.gitDir, fetch: recordingFetch().fetch })({ sha, read: () => false, ...live() }));
    expect(r.files).toEqual({});
    expect(r.tree).toHaveLength(4);
  });

  test("a listed path whose blob cannot be read is a git error", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, FILES);
    const blob = await rg(repo.gitDir, ["rev-parse", `${sha}:${STATUS}`]);
    rmSync(join(repo.gitDir, "objects", blob.slice(0, 2), blob.slice(2)));
    const r = await createGitTreeFiles({ gitDir: repo.gitDir, fetch: recordingFetch().fetch })({ sha, read: (p) => p === STATUS, ...live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("git");
    if (!r.ok) expect(r.error.message).toContain(`cannot read ${STATUS}`);
  });

  test("a missing SHA is fetched, then read", async () => {
    const repo = await setup();
    const other = await setup();
    const sha = await commit(other.gitDir, FILES);
    await rg(other.gitDir, ["update-ref", "refs/heads/x", sha]);
    const f = recordingFetch(async () => plainFetch(repo.gitDir, other.gitDir, "refs/heads/x"));
    const r = value(await createGitTreeFiles({ gitDir: repo.gitDir, fetch: f.fetch })({ sha, read: (p) => p === "README.md", ...live() }));
    expect(f.calls).toEqual([[sha]]);
    expect(r.files).toEqual({ "README.md": "hi\n" });
  });

  test("a failed fetch is a fetch error; a bad SHA is invalid; a throwing fetch never throws", async () => {
    const repo = await setup();
    const read = createGitTreeFiles({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    const fetchFail = await read({ sha: "e".repeat(40), read: () => true, ...live() });
    expect(fetchFail.ok ? "ok" : fetchFail.error.kind).toBe("fetch");
    const bad = await read({ sha: "nope", read: () => true, ...live() });
    expect(bad.ok ? "ok" : bad.error.kind).toBe("invalid");
    const throwing = createGitTreeFiles({ gitDir: repo.gitDir, fetch: () => { throw new Error("boom"); } });
    const thrown = await throwing({ sha: "e".repeat(40), read: () => true, ...live() });
    expect(thrown.ok ? "ok" : thrown.error.kind).toBe("fetch");
  });
});
