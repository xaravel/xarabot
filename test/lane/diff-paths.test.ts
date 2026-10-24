import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "../../src/core/result.ts";
import { createGitDiffPaths } from "../../src/lane/diff-paths.ts";
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

describe("createGitDiffPaths", () => {
  test("changed, added, deleted and renamed paths, sorted; no fetch when both SHAs are present", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { "src/a.ts": "a\n", "src/gone.ts": "g\n", "old/name.md": "same text\n", "keep.md": "k\n" });
    const head = await commit(repo.gitDir, { "src/a.ts": "A\n", "src/new.ts": "n\n", "new/name.md": "same text\n", "keep.md": "k\n" }, [base]);
    const f = recordingFetch();
    const diff = createGitDiffPaths({ gitDir: repo.gitDir, fetch: f.fetch });
    expect(value(await diff({ headSha: head, mainSha: base, ...live() }))).toEqual(["new/name.md", "old/name.md", "src/a.ts", "src/gone.ts", "src/new.ts"]);
    expect(f.calls).toEqual([]);
  });

  test("main moving after the branch adds none of main's paths", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n", b: "b\n" });
    const head = await commit(repo.gitDir, { a: "A\n", b: "b\n" }, [base]);
    const main = await commit(repo.gitDir, { a: "a\n", b: "B\n", c: "c\n" }, [base]);
    const diff = createGitDiffPaths({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    expect(value(await diff({ headSha: head, mainSha: main, ...live() }))).toEqual(["a"]);
  });

  test("main merged into the head: only the PR's own paths", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n", b: "b\n" });
    const pr = await commit(repo.gitDir, { a: "A\n", b: "b\n" }, [base]);
    const main = await commit(repo.gitDir, { a: "a\n", b: "B\n" }, [base]);
    const head = await commit(repo.gitDir, { a: "A\n", b: "B\n" }, [pr, main]);
    const diff = createGitDiffPaths({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    expect(value(await diff({ headSha: head, mainSha: main, ...live() }))).toEqual(["a"]);
  });

  test("no merge base diffs the empty tree: every head path", async () => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { a: "a\n" });
    const head = await commit(repo.gitDir, { a: "a\n", "z/y.txt": "y\n" });
    const diff = createGitDiffPaths({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    expect(value(await diff({ headSha: head, mainSha: main, ...live() }))).toEqual(["a", "z/y.txt"]);
  });

  test("fetches only the SHA runner.git lacks", async () => {
    const repo = await setup();
    const other = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    const head = await commit(repo.gitDir, { a: "A\n" }, [base]);
    const main = await commit(other.gitDir, { a: "a\n", b: "b\n" });
    await rg(other.gitDir, ["update-ref", "refs/x/main", main]);
    const f = recordingFetch(async () => plainFetch(repo.gitDir, other.gitDir, "refs/x/main"));
    const diff = createGitDiffPaths({ gitDir: repo.gitDir, fetch: f.fetch });
    expect(value(await diff({ headSha: head, mainSha: main, ...live() }))).toEqual(["a"]);
    expect(f.calls).toEqual([[main]]);
  });

  test("a failed fetch or a bad SHA is an error, never a throw", async () => {
    const repo = await setup();
    const head = await commit(repo.gitDir, { a: "A\n" });
    const f = recordingFetch();
    const diff = createGitDiffPaths({ gitDir: repo.gitDir, fetch: f.fetch });
    const r = await diff({ headSha: head, mainSha: "e".repeat(40), ...live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("fetch");
    expect(f.calls).toEqual([["e".repeat(40)]]);
    const bad = await diff({ headSha: "nope", mainSha: head, ...live() });
    expect(bad.ok ? "ok" : bad.error.kind).toBe("invalid");
    const thrown = createGitDiffPaths({ gitDir: repo.gitDir, fetch: () => { throw new Error("boom"); } });
    const t = await thrown({ headSha: head, mainSha: "e".repeat(40), ...live() });
    expect(t.ok ? "ok" : t.error.kind).toBe("fetch");
  });
});
