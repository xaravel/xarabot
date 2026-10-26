import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { err, ok, type Result } from "../../src/core/result.ts";
import { createGitPassedGate, headPassedGate } from "../../src/lane/passed-gate.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { cleanup, commit, live, rg, setup, tempDir, value } from "./git-fixture.ts";

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

const BASE: Record<string, string> = { "src/a.ts": "a\n", "src/b.ts": "b\n", "README.md": "hi\n" };
/** The reviewed head: the PR's change to `src/a.ts`. */
const PASSED: Record<string, string> = { ...BASE, "src/a.ts": "a reviewed\n" };
/** `main`'s change to `src/b.ts`, apart from the PR's. */
const MAIN: Record<string, string> = { ...BASE, "src/b.ts": "b on main\n" };
/** The clean merge of the two. */
const MERGED: Record<string, string> = { ...PASSED, "src/b.ts": "b on main\n" };

type World = { readonly gitDir: string; readonly base: string; readonly passed: string; readonly main: string };

async function world(): Promise<World> {
  const repo = await setup();
  const base = await commit(repo.gitDir, BASE);
  const passed = await commit(repo.gitDir, PASSED, [base]);
  const main = await commit(repo.gitDir, MAIN, [base]);
  return { gitDir: repo.gitDir, base, passed, main };
}

describe("createGitPassedGate (Story 3.5)", () => {
  test("gate: head = passed_sha is passed head, with no git call", async () => {
    const f = recordingFetch();
    // A runner.git that does not exist: any git call would fail.
    const gate = createGitPassedGate({ gitDir: join(tempDir(), "no-such.git"), fetch: f.fetch });
    const sha = "a".repeat(40);
    expect(value(await gate({ headSha: sha, passedSha: sha, mainSha: "b".repeat(40), ...live() }))).toEqual({ kind: "passed", how: "head" });
    expect(f.calls).toEqual([]);
  });

  test("gate: passed_sha null is unreviewed, with no git call", async () => {
    const gate = createGitPassedGate({ gitDir: join(tempDir(), "no-such.git"), fetch: recordingFetch().fetch });
    const r = value(await gate({ headSha: "a".repeat(40), passedSha: null, mainSha: "b".repeat(40), ...live() }));
    expect(r.kind).toBe("unreviewed");
  });

  test("gate: a clean merge of passed_sha and main, its tree the recomputed merge's, is passed clean-merge", async () => {
    const w = await world();
    const head = await commit(w.gitDir, MERGED, [w.passed, w.main]);
    const f = recordingFetch();
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: f.fetch });
    expect(value(await gate({ headSha: head, passedSha: w.passed, mainSha: w.main, ...live() }))).toEqual({ kind: "passed", how: "clean-merge" });
    expect(f.calls).toEqual([]);
  });

  test("gate: the parents in either order, and the other parent an ancestor of main, pass", async () => {
    const w = await world();
    const head = await commit(w.gitDir, MERGED, [w.main, w.passed]);
    const later = await commit(w.gitDir, { ...MAIN, "docs/x.md": "x\n" }, [w.main]);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    expect(value(await gate({ headSha: head, passedSha: w.passed, mainSha: w.main, ...live() }))).toEqual({ kind: "passed", how: "clean-merge" });
    expect(value(await gate({ headSha: head, passedSha: w.passed, mainSha: later, ...live() }))).toEqual({ kind: "passed", how: "clean-merge" });
  });

  test("gate: a later change, a single-parent commit on passed_sha, is unreviewed", async () => {
    const w = await world();
    const head = await commit(w.gitDir, { ...PASSED, "src/c.ts": "c\n" }, [w.passed]);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    const r = value(await gate({ headSha: head, passedSha: w.passed, mainSha: w.main, ...live() }));
    expect(r.kind).toBe("unreviewed");
    if (r.kind === "unreviewed") expect(r.why).toContain("1 parent(s)");
  });

  test("gate: a merge whose other parent is not on main is unreviewed", async () => {
    const w = await world();
    const side = await commit(w.gitDir, { ...BASE, "src/b.ts": "b on a side branch\n" }, [w.base]);
    const head = await commit(w.gitDir, { ...PASSED, "src/b.ts": "b on a side branch\n" }, [w.passed, side]);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    const r = value(await gate({ headSha: head, passedSha: w.passed, mainSha: w.main, ...live() }));
    expect(r.kind).toBe("unreviewed");
    if (r.kind === "unreviewed") expect(r.why).toContain(`its other parent ${side} is not on main`);
  });

  test("gate: a merge whose recomputed merge-tree conflicts is unreviewed, whatever the head's resolution", async () => {
    const w = await world();
    const clash = await commit(w.gitDir, { ...BASE, "src/a.ts": "a on main\n" }, [w.base]);
    const head = await commit(w.gitDir, { ...PASSED, "src/a.ts": "a resolved by someone\n" }, [w.passed, clash]);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    const r = value(await gate({ headSha: head, passedSha: w.passed, mainSha: clash, ...live() }));
    expect(r.kind).toBe("unreviewed");
    if (r.kind === "unreviewed") expect(r.why).toContain("conflicts");
  });

  test("gate: a merge whose tree differs from the clean merge (a change smuggled into it) is unreviewed", async () => {
    const w = await world();
    const head = await commit(w.gitDir, { ...MERGED, "src/evil.ts": "x\n" }, [w.passed, w.main]);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    const r = value(await gate({ headSha: head, passedSha: w.passed, mainSha: w.main, ...live() }));
    expect(r.kind).toBe("unreviewed");
    if (r.kind === "unreviewed") expect(r.why).toContain("tree differs");
  });

  test("gate: a merge of main with a commit that is not passed_sha, and an octopus, are unreviewed", async () => {
    const w = await world();
    const other = await commit(w.gitDir, { ...BASE, "src/a.ts": "a unreviewed\n" }, [w.base]);
    const notPassed = await commit(w.gitDir, { ...MAIN, "src/a.ts": "a unreviewed\n" }, [other, w.main]);
    const docs = await commit(w.gitDir, { ...BASE, "docs/x.md": "x\n" }, [w.base]);
    const octopus = await commit(w.gitDir, { ...MERGED, "docs/x.md": "x\n" }, [w.passed, w.main, docs]);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    const a = value(await gate({ headSha: notPassed, passedSha: w.passed, mainSha: w.main, ...live() }));
    expect(a.kind).toBe("unreviewed");
    if (a.kind === "unreviewed") expect(a.why).toContain("neither of its parents is the passed head");
    const b = value(await gate({ headSha: octopus, passedSha: w.passed, mainSha: w.main, ...live() }));
    expect(b.kind).toBe("unreviewed");
    if (b.kind === "unreviewed") expect(b.why).toContain("3 parent(s)");
  });

  test("a missing SHA is fetched, then checked", async () => {
    const other = await setup();
    const base = await commit(other.gitDir, BASE);
    const passed = await commit(other.gitDir, PASSED, [base]);
    const main = await commit(other.gitDir, MAIN, [base]);
    const head = await commit(other.gitDir, MERGED, [passed, main]);
    await rg(other.gitDir, ["update-ref", "refs/heads/pr", head]);
    const repo = await setup();
    const f = recordingFetch(async () => plainFetch(repo.gitDir, other.gitDir, "refs/heads/pr"));
    const gate = createGitPassedGate({ gitDir: repo.gitDir, fetch: f.fetch });
    expect(value(await gate({ headSha: head, passedSha: passed, mainSha: main, ...live() }))).toEqual({ kind: "passed", how: "clean-merge" });
    expect(f.calls).toEqual([[head, passed, main]]);
  });

  test("a failed fetch is a fetch error, a bad SHA invalid, a fetch that throws an error; it never throws", async () => {
    const w = await world();
    const missing = "e".repeat(40);
    const gate = createGitPassedGate({ gitDir: w.gitDir, fetch: recordingFetch().fetch });
    const r = await gate({ headSha: missing, passedSha: w.passed, mainSha: w.main, ...live() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fetch");
    const bad = await gate({ headSha: "zz", passedSha: w.passed, mainSha: w.main, ...live() });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("invalid");
    const throwing = createGitPassedGate({
      gitDir: w.gitDir,
      fetch: async () => {
        throw new Error("boom");
      },
    });
    const t = await throwing({ headSha: missing, passedSha: w.passed, mainSha: w.main, ...live() });
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error.message).toContain("boom");
  });
});

describe("headPassedGate", () => {
  test("only a head equal to passed_sha passes", async () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(value(await headPassedGate({ headSha: a, passedSha: a, mainSha: b, ...live() }))).toEqual({ kind: "passed", how: "head" });
    expect(value(await headPassedGate({ headSha: a, passedSha: b, mainSha: b, ...live() })).kind).toBe("unreviewed");
    expect(value(await headPassedGate({ headSha: a, passedSha: null, mainSha: b, ...live() })).kind).toBe("unreviewed");
  });
});
