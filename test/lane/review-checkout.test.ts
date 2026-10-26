import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../src/core/result.ts";
import { MARKER_REF, rebuildClone, REVIEW_MAIN_REF, wipRef, writeReviewCheckout } from "../../src/lane/clone.ts";
import { laneLayout } from "../../src/lane/lane-store.ts";
import { checkoutFiles, createGitReviewCheckout, reviewWorkspace, type ReviewCheckout } from "../../src/lane/review-checkout.ts";
import { BRANCH, cleanup, commit, live, plainClone, rg, setup, UNIT, value, type Repo } from "./git-fixture.ts";

afterEach(cleanup);

/** The review folder beside the agent's clone, as `laneLayout` places them: the lane folder is `<root>/work`. */
const reviewDir = (repo: Repo): string => laneLayout(join(repo.root, "work")).review;

/** A refs listing of `runner.git`, for the no-change checks. */
const refs = (repo: Repo): Promise<string> => rg(repo.gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);

/** `main` with agent config, and a head that adds `CLAUDE.md`, changes `.claude/x` and drops `.agents/y` (matrix row "checkout"). */
async function world(repo: Repo): Promise<{ main: string; head: string }> {
  const main = await commit(repo.gitDir, {
    "src/a.ts": "a\n",
    ".claude/x": "main x\n",
    ".agents/y": "main y\n",
    "AGENTS.md": "main agents\n",
  });
  const head = await commit(
    repo.gitDir,
    {
      "src/a.ts": "a changed\n",
      "src/b.ts": "b\n",
      ".claude/x": "head x\n",
      ".claude/new": "head new\n",
      "CLAUDE.md": "head claude\n",
      "docs/.Codex/conf": "head codex\n",
      "AGENTS.md": "head agents\n",
      "_bmad-output/implementation-artifacts/spec-3-4-x.md": "---\nstatus: done\n---\n",
    },
    [main],
  );
  return { main, head };
}

describe("writeReviewCheckout", () => {
  test("the checkout row: head's tree with main's agent config, a detached HEAD at head, main's ref, hooks off", async () => {
    const repo = await setup();
    const { main, head } = await world(repo);
    const dir = reviewDir(repo);
    expect(value(await writeReviewCheckout({ gitDir: repo.gitDir, dir, head, main, ...live() }))).toEqual({ sha: head });

    // The working tree: head's files, agent config from main (or gone when main has none).
    expect(checkoutFiles(dir)).toEqual([".agents/y", ".claude/x", "AGENTS.md", "_bmad-output/implementation-artifacts/spec-3-4-x.md", "src/a.ts", "src/b.ts"]);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("a changed\n");
    expect(readFileSync(join(dir, ".claude/x"), "utf8")).toBe("main x\n");
    expect(readFileSync(join(dir, ".agents/y"), "utf8")).toBe("main y\n");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("main agents\n");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude/new"))).toBe(false);
    expect(existsSync(join(dir, "docs/.Codex"))).toBe(false);

    // The repo: HEAD detached at head, `main` at main, hooks off, a valid repo with both histories.
    expect(plainClone(dir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(head);
    expect(plainClone(dir, ["symbolic-ref", "-q", "HEAD"]).code).not.toBe(0);
    expect(plainClone(dir, ["rev-parse", REVIEW_MAIN_REF]).stdout.trim()).toBe(main);
    expect(plainClone(dir, ["config", "--get", "core.hooksPath"]).stdout.trim()).toBe("/dev/null");
    expect(plainClone(dir, ["fsck", "--strict"]).code).toBe(0);
    expect(plainClone(dir, ["diff", "--name-only", "main...HEAD"]).stdout.trim().split("\n").sort()).toEqual(
      [".agents/y", ".claude/new", ".claude/x", "AGENTS.md", "CLAUDE.md", "_bmad-output/implementation-artifacts/spec-3-4-x.md", "docs/.Codex/conf", "src/a.ts", "src/b.ts"].sort(),
    );

    // The index stays at head: the restored agent config shows as uncommitted changes, nothing else does.
    const status = plainClone(dir, ["status", "--porcelain", "--untracked-files=all"]).stdout.split("\n").filter((l) => l !== "").sort();
    expect(status).toEqual([" D .claude/new", " D CLAUDE.md", " D docs/.Codex/conf", " M .claude/x", " M AGENTS.md", "?? .agents/y"].sort());
  });

  test("reads and writes no marker, wip or clone state; rebuildClone of the clone is unaffected", async () => {
    const repo = await setup();
    const { main, head } = await world(repo);
    value(await rebuildClone({ gitDir: repo.gitDir, clone: repo.clone, unit: UNIT, branch: BRANCH, sha: main, generation: 1, resumeWip: false, ...live() }));
    writeFileSync(join(repo.clone, "src/a.ts"), "the builder's edit\n");
    const before = await refs(repo);
    expect(before).toContain(MARKER_REF);

    value(await writeReviewCheckout({ gitDir: repo.gitDir, dir: reviewDir(repo), head, main, ...live() }));
    expect(await refs(repo)).toBe(before);
    expect(readFileSync(join(repo.clone, "src/a.ts"), "utf8")).toBe("the builder's edit\n");
    expect(await rg(repo.gitDir, ["rev-parse", "--verify", "--quiet", wipRef(UNIT)]).catch(() => "none")).toBe("none");
  });

  test("each write starts fresh: a reviewer's edits never reach the next checkout", async () => {
    const repo = await setup();
    const { main, head } = await world(repo);
    const dir = reviewDir(repo);
    value(await writeReviewCheckout({ gitDir: repo.gitDir, dir, head, main, ...live() }));
    writeFileSync(join(dir, "src/a.ts"), "reviewer edit\n");
    writeFileSync(join(dir, "stray.txt"), "x\n");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    value(await writeReviewCheckout({ gitDir: repo.gitDir, dir, head, main, ...live() }));
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("a changed\n");
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
    expect(existsSync(join(dir, ".git", "hooks"))).toBe(false);
  });

  test("head with no agent config change: a clean checkout", async () => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { "a.txt": "a\n", "CLAUDE.md": "c\n" });
    const head = await commit(repo.gitDir, { "a.txt": "b\n", "CLAUDE.md": "c\n" }, [main]);
    const dir = reviewDir(repo);
    value(await writeReviewCheckout({ gitDir: repo.gitDir, dir, head, main, ...live() }));
    expect(plainClone(dir, ["status", "--porcelain"])).toEqual({ code: 0, stdout: "" });
  });

  test("main's agent config under a path that is a file at head: main's file replaces it", async () => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { "a.txt": "a\n", "tools/AGENTS.md": "main agents\n" });
    const head = await commit(repo.gitDir, { "a.txt": "b\n", tools: "a head file\n" }, [main]);
    const dir = reviewDir(repo);
    value(await writeReviewCheckout({ gitDir: repo.gitDir, dir, head, main, ...live() }));
    expect(checkoutFiles(dir)).toEqual(["a.txt", "tools/AGENTS.md"]);
    expect(readFileSync(join(dir, "tools/AGENTS.md"), "utf8")).toBe("main agents\n");
    expect(plainClone(dir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(head);
  });

  test("refused before anything changes: a relative or overlapping folder, a missing or bad SHA", async () => {
    const repo = await setup();
    const { main, head } = await world(repo);
    const kind = (r: Result<unknown, string>) => (r.ok ? "ok" : r.error.kind);
    expect(kind(await writeReviewCheckout({ gitDir: repo.gitDir, dir: "review", head, main, ...live() }))).toBe("invalid");
    expect(kind(await writeReviewCheckout({ gitDir: repo.gitDir, dir: join(repo.gitDir, "review"), head, main, ...live() }))).toBe("invalid");
    expect(kind(await writeReviewCheckout({ gitDir: repo.gitDir, dir: reviewDir(repo), head: "f".repeat(40), main, ...live() }))).toBe("missing-object");
    expect(kind(await writeReviewCheckout({ gitDir: repo.gitDir, dir: reviewDir(repo), head, main: "nope", ...live() }))).toBe("invalid");
    expect(existsSync(reviewDir(repo))).toBe(false);
  });
});

describe("createGitReviewCheckout", () => {
  test("fetches only the SHAs runner.git lacks, then writes the checkout", async () => {
    const repo = await setup();
    const source = await setup();
    const { main, head } = await world(source);
    const fetched: string[][] = [];
    const checkout = createGitReviewCheckout({
      gitDir: repo.gitDir,
      laneDir: join(repo.root, "work"),
      fetch: async (shas, signal) => {
        fetched.push([...shas]);
        // As the launcher's fetch does: copy the objects in from the remote (plain git: the hardened one allows no file transport).
        const p = Bun.spawnSync(["git", `--git-dir=${repo.gitDir}`, "fetch", "--quiet", source.gitDir, ...shas], {
          env: { PATH: process.env.PATH ?? "", HOME: repo.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          signal,
        });
        return p.exitCode === 0 ? ok(undefined) : err("fetch", p.stderr.toString());
      },
    });
    // The agent's clone in the same lane folder is never touched: the checkout is always `<lane>/review`.
    mkdirSync(repo.clone, { recursive: true });
    writeFileSync(join(repo.clone, "builder.txt"), "keep\n");
    expect(value(await checkout.prepare({ head, main, ...live() }))).toEqual({ sha: head });
    expect(readFileSync(join(repo.clone, "builder.txt"), "utf8")).toBe("keep\n");
    expect(fetched).toEqual([[head, main]]);
    expect(readFileSync(join(reviewDir(repo), ".claude/x"), "utf8")).toBe("main x\n");
    value(await checkout.prepare({ head, main, ...live() }));
    expect(fetched).toHaveLength(1);
  });

  test("a failed fetch is a fetch error, and nothing is written", async () => {
    const repo = await setup();
    const checkout = createGitReviewCheckout({ gitDir: repo.gitDir, laneDir: join(repo.root, "work"), fetch: async () => err("fetch", "offline") });
    const r = await checkout.prepare({ head: "a".repeat(40), main: "b".repeat(40), ...live() });
    expect(r.ok ? "ok" : `${r.error.kind}: ${r.error.message}`).toMatch(/^fetch: review checkout: fetching .*offline/);
    expect(existsSync(reviewDir(repo))).toBe(false);
  });
});

describe("reviewWorkspace", () => {
  test("prepares the checkout at the start SHA and main, ignoring branch, generation and wip", async () => {
    const calls: unknown[] = [];
    const checkout: ReviewCheckout = {
      prepare: async (r) => {
        calls.push({ head: r.head, main: r.main });
        return ok({ sha: r.head });
      },
    };
    const ws = reviewWorkspace(checkout, "m".repeat(40));
    const r = await ws.prepare({ unit: UNIT, branch: "anything", start: "h".repeat(40), generation: 9, fetch: ["x"], ...live() });
    expect(r).toEqual({ ok: true, value: { sha: "h".repeat(40), resumed: false } });
    expect(calls).toEqual([{ head: "h".repeat(40), main: "m".repeat(40) }]);
    const failing = reviewWorkspace({ prepare: async () => err("git", "boom") }, "m".repeat(40));
    expect(await failing.prepare({ unit: UNIT, branch: "b", start: "h".repeat(40), generation: 1, fetch: [], ...live() })).toEqual({ ok: false, error: { kind: "git", message: "boom" } });
  });
});
