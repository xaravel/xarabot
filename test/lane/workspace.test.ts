import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "../../src/core/result.ts";
import { createGitWorkspace } from "../../src/lane/workspace.ts";
import { BRANCH, cleanup, commit, live, setup, UNIT } from "./git-fixture.ts";

afterEach(cleanup);

describe("createGitWorkspace", () => {
  test("fetches nothing when runner.git has the start SHA, and builds the clone there", async () => {
    const repo = await setup();
    const start = await commit(repo.gitDir, { "README.md": "start\n" });
    const fetched: string[][] = [];
    const ws = createGitWorkspace({
      gitDir: repo.gitDir,
      clone: repo.clone,
      fetch: async (shas) => {
        fetched.push([...shas]);
        return ok(undefined);
      },
    });
    const r = await ws.prepare({ unit: UNIT, branch: BRANCH, start, generation: 1, fetch: [start], ...live() });
    expect(r).toEqual({ ok: true, value: { sha: start, resumed: false } });
    expect(fetched).toEqual([]);
    expect(readFileSync(join(repo.clone, "README.md"), "utf8")).toBe("start\n");
  });

  test("fetches only the missing SHA, then builds the clone at the start SHA", async () => {
    const repo = await setup();
    const have = await commit(repo.gitDir, { "README.md": "have\n" });
    // A source repo holds the start commit; `fetch` copies it in, as the forge fetch would.
    const source = await setup();
    const start = await commit(source.gitDir, { "README.md": "fetched\n" });
    const fetched: string[][] = [];
    const ws = createGitWorkspace({
      gitDir: repo.gitDir,
      clone: repo.clone,
      fetch: async (shas, signal) => {
        fetched.push([...shas]);
        const p = Bun.spawnSync(["git", `--git-dir=${repo.gitDir}`, "fetch", "--quiet", source.gitDir, ...shas], {
          env: { PATH: process.env.PATH ?? "", HOME: repo.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          signal,
        });
        return p.exitCode === 0 ? ok(undefined) : err("fetch", p.stderr.toString());
      },
    });
    const r = await ws.prepare({ unit: UNIT, branch: BRANCH, start, generation: 1, fetch: [have, start], ...live() });
    expect(r).toEqual({ ok: true, value: { sha: start, resumed: false } });
    expect(fetched).toEqual([[start]]);
    expect(readFileSync(join(repo.clone, "README.md"), "utf8")).toBe("fetched\n");
  });

  test("a failed fetch is a fetch error and no clone is built", async () => {
    const repo = await setup();
    const ws = createGitWorkspace({ gitDir: repo.gitDir, clone: repo.clone, fetch: async () => err("x", "offline") });
    const start = "e".repeat(40);
    const r = await ws.prepare({ unit: UNIT, branch: BRANCH, start, generation: 1, fetch: [start], ...live() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("fetch");
      expect(r.error.message).toContain("offline");
    }
  });

  test("a SHA still missing after the fetch fails the rebuild", async () => {
    const repo = await setup();
    const ws = createGitWorkspace({ gitDir: repo.gitDir, clone: repo.clone, fetch: async () => ok(undefined) });
    const start = "e".repeat(40);
    const r = await ws.prepare({ unit: UNIT, branch: BRANCH, start, generation: 1, fetch: [start], ...live() });
    expect(r).toMatchObject({ ok: false, error: { kind: "missing-object" } });
  });

  test("a malformed SHA is invalid, never fetched", async () => {
    const repo = await setup();
    let calls = 0;
    const ws = createGitWorkspace({
      gitDir: repo.gitDir,
      clone: repo.clone,
      fetch: async () => {
        calls += 1;
        return ok(undefined);
      },
    });
    const r = await ws.prepare({ unit: UNIT, branch: BRANCH, start: "main", generation: 1, fetch: ["main"], ...live() });
    expect(r).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(calls).toBe(0);
  });
});
