import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../src/core/result.ts";
import { createGitGraphTrees } from "../../src/lane/graph-trees.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { cleanup, commit, live, rg, setup, value } from "./git-fixture.ts";
import { GRAPH_EPICS, GRAPH_STATUS, graphFiles, manifest } from "./graph-stub.ts";

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

const BASE: Record<string, string> = { ...graphFiles({ 1: ["1.1"], 2: ["2.1"] }), [GRAPH_STATUS]: "development_status:\n  epic-1: done\n", "src/app.ts": "app\n", "README.md": "hi\n" };

describe("createGitGraphTrees", () => {
  test("clean: main's tree and the merge tree, each listing whole and holding only the files the gate reads", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, BASE);
    const head = await commit(repo.gitDir, { ...BASE, "stories/2.2.md": manifest("2.2", 2), [GRAPH_EPICS]: graphFiles({ 1: ["1.1"], 2: ["2.1", "2.2"] })[GRAPH_EPICS] as string }, [base]);
    const main = await commit(repo.gitDir, { ...BASE, "src/app.ts": "app 2\n" }, [base]);
    const f = recordingFetch();
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: f.fetch });
    const r = value(await trees({ headSha: head, mainSha: main, ...live() }));
    if (r.kind !== "clean") throw new Error(r.kind);
    expect(f.calls).toEqual([]);
    expect(r.main.tree).toEqual(Object.keys(BASE).sort());
    expect(r.merged.tree).toEqual([...Object.keys(BASE), "stories/2.2.md"].sort());
    const read = [".xarabot/config.yaml", GRAPH_EPICS, GRAPH_STATUS, "stories/1.1.md", "stories/2.1.md"];
    expect(Object.keys(r.main.files).sort()).toEqual(read.sort());
    expect(Object.keys(r.merged.files).sort()).toEqual([...read, "stories/2.2.md"].sort());
    expect(r.merged.files["stories/2.2.md"]).toBe(manifest("2.2", 2));
    expect(r.merged.files[GRAPH_EPICS]).toContain("### Story 2.2:");
    expect(r.main.files[GRAPH_EPICS]).not.toContain("### Story 2.2:");
    expect(Object.hasOwn(r.merged.files, "src/app.ts")).toBe(false);
  });

  test("each side reads by its own config: a merge result that moves the manifests dir reads the new one", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, BASE);
    const moved = { ...BASE, ".xarabot/config.yaml": (BASE[".xarabot/config.yaml"] as string).replace("dir: stories", "dir: manifests"), "manifests/1.1.md": manifest("1.1", 1) };
    const head = await commit(repo.gitDir, moved, [base]);
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    const r = value(await trees({ headSha: head, mainSha: base, ...live() }));
    if (r.kind !== "clean") throw new Error(r.kind);
    expect(Object.hasOwn(r.main.files, "stories/1.1.md")).toBe(true);
    expect(Object.hasOwn(r.main.files, "manifests/1.1.md")).toBe(false);
    expect(Object.hasOwn(r.merged.files, "manifests/1.1.md")).toBe(true);
    expect(Object.hasOwn(r.merged.files, "stories/1.1.md")).toBe(false);
  });

  test("a clean merge holds both sides' changes: head adds a manifest, main adds epics.yaml", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, BASE);
    const head = await commit(repo.gitDir, { ...BASE, "stories/2.2.md": manifest("2.2", 2) }, [base]);
    const yaml = "version: 1\nepics:\n  2: {checkpoint: true}\n";
    const main = await commit(repo.gitDir, { ...BASE, ".xarabot/epics.yaml": yaml }, [base]);
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    const r = value(await trees({ headSha: head, mainSha: main, ...live() }));
    if (r.kind !== "clean") throw new Error(r.kind);
    expect(r.main.tree).toContain(".xarabot/epics.yaml");
    expect(r.main.tree).not.toContain("stories/2.2.md");
    expect(r.merged.tree).toEqual([...Object.keys(BASE), ".xarabot/epics.yaml", "stories/2.2.md"].sort());
    expect(r.merged.files[".xarabot/epics.yaml"]).toBe(yaml);
    expect(r.merged.files["stories/2.2.md"]).toBe(manifest("2.2", 2));
    expect(Object.hasOwn(r.main.files, "stories/2.2.md")).toBe(false);
  });

  test("a listed path whose blob cannot be read is a git error, not a left-out file", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, BASE);
    const main = await commit(repo.gitDir, { ...BASE, "README.md": "main\n" }, [base]);
    const blob = await rg(repo.gitDir, ["rev-parse", `${main}:stories/1.1.md`]);
    rmSync(join(repo.gitDir, "objects", blob.slice(0, 2), blob.slice(2)));
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    const r = await trees({ headSha: base, mainSha: main, ...live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("git");
    if (!r.ok) expect(r.error.message).toContain("cannot read stories/1.1.md");
  });

  test("a conflict: the conflicted paths, no trees", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, BASE);
    const head = await commit(repo.gitDir, { ...BASE, "stories/1.1.md": manifest("1.1", 1, "1-1-head") }, [base]);
    const main = await commit(repo.gitDir, { ...BASE, "stories/1.1.md": manifest("1.1", 1, "1-1-main") }, [base]);
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    expect(value(await trees({ headSha: head, mainSha: main, ...live() }))).toEqual({ kind: "conflict", paths: ["stories/1.1.md"] });
  });

  test("a missing SHA is fetched, then read", async () => {
    const repo = await setup();
    const other = await setup();
    // The base and the head exist only in another repo; runner.git gets the base, then makes main on it.
    const base = await commit(other.gitDir, BASE);
    const head = await commit(other.gitDir, { ...BASE, "src/app.ts": "head\n" }, [base]);
    await rg(other.gitDir, ["update-ref", "refs/x/base", base]);
    await rg(other.gitDir, ["update-ref", "refs/heads/pr", head]);
    value(plainFetch(repo.gitDir, other.gitDir, "refs/x/base"));
    const main = await commit(repo.gitDir, { ...BASE, "README.md": "main\n" }, [base]);
    const f = recordingFetch(async () => plainFetch(repo.gitDir, other.gitDir, "refs/heads/pr"));
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: f.fetch });
    const r = value(await trees({ headSha: head, mainSha: main, ...live() }));
    expect(f.calls).toEqual([[head]]);
    expect(r.kind).toBe("clean");
  });

  test("a failed fetch is a fetch error; a bad SHA is invalid; it never throws", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, BASE);
    const trees = createGitGraphTrees({ gitDir: repo.gitDir, fetch: recordingFetch().fetch });
    const fetchFail = await trees({ headSha: "e".repeat(40), mainSha: base, ...live() });
    expect(fetchFail.ok ? "ok" : fetchFail.error.kind).toBe("fetch");
    const bad = await trees({ headSha: "nope", mainSha: base, ...live() });
    expect(bad.ok ? "ok" : bad.error.kind).toBe("invalid");
    const throwing = createGitGraphTrees({ gitDir: repo.gitDir, fetch: () => { throw new Error("boom"); } });
    const thrown = await throwing({ headSha: "e".repeat(40), mainSha: base, ...live() });
    expect(thrown.ok ? "ok" : thrown.error.kind).toBe("fetch");
  });
});
