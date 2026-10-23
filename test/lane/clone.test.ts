import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER_REF, readMarker, readWip, rebuildClone, saveWip, sessionStartSha, wipRef, type RebuildParams } from "../../src/lane/clone.ts";
import { BRANCH, cleanup, commit, files, live, plainClone, rg, setup, tempDir, UNIT, value, type Repo } from "./git-fixture.ts";

afterEach(cleanup);

function params(repo: Repo, sha: string, over: Partial<RebuildParams> = {}): RebuildParams {
  return { gitDir: repo.gitDir, clone: repo.clone, unit: UNIT, branch: BRANCH, sha, generation: 1, resumeWip: false, ...live(), ...over };
}

function kind(r: { ok: boolean; error?: { kind: string } }): string {
  return r.ok ? "ok" : (r.error?.kind ?? "?");
}

describe("rebuildClone", () => {
  test("first build: clone on the branch at sha, clean status, full history, valid repo", async () => {
    const repo = await setup();
    const c1 = await commit(repo.gitDir, { "a.txt": "one\n" });
    const c2 = await commit(repo.gitDir, { "a.txt": "two\n", "d/b.txt": "b\n" }, [c1]);
    const r = value(await rebuildClone(params(repo, c2)));
    expect(r).toEqual({ sha: c2, branch: BRANCH, resumed: false });
    expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(repo.clone, "d/b.txt"), "utf8")).toBe("b\n");
    expect(plainClone(repo.clone, ["symbolic-ref", "HEAD"]).stdout.trim()).toBe(`refs/heads/${BRANCH}`);
    expect(plainClone(repo.clone, ["rev-parse", "HEAD"]).stdout.trim()).toBe(c2);
    expect(plainClone(repo.clone, ["status", "--porcelain"])).toEqual({ code: 0, stdout: "" });
    expect(plainClone(repo.clone, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2");
    expect(plainClone(repo.clone, ["fsck", "--strict"]).code).toBe(0);
    expect(plainClone(repo.clone, ["config", "--get", "core.filemode"]).stdout.trim()).toBe("true");
    expect(plainClone(repo.clone, ["config", "--get", "core.logallrefupdates"]).stdout.trim()).toBe("true");
    for (const key of ["core.ignorecase", "core.precomposeunicode"]) {
      const runner = Bun.spawnSync(["git", `--git-dir=${repo.gitDir}`, "config", "--type=bool", "--get", key], {
        env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect([key, plainClone(repo.clone, ["config", "--type=bool", "--get", key]).stdout.trim()]).toEqual([key, runner.stdout.toString().trim()]);
    }
    const marker = value(await readMarker(repo.gitDir, live().signal));
    expect(marker).toEqual({ unit: UNIT, generation: 1, branch: BRANCH, start: c2 });
    expect(await rg(repo.gitDir, ["rev-parse", `${MARKER_REF}^{tree}`])).toBe(await rg(repo.gitDir, ["rev-parse", `${c2}^{tree}`]));
  });

  test("a sha256 runner.git gives a sha256 clone", async () => {
    const root = tempDir();
    const gitDir = join(root, "runner.git");
    await rg(gitDir, ["init", "--quiet", "--bare", "--object-format=sha256"]);
    const repo = { root, gitDir, clone: join(root, "clone") };
    const sha = await commit(gitDir, { "a.txt": "one\n" });
    expect(sha).toHaveLength(64);
    value(await rebuildClone(params(repo, sha)));
    expect(plainClone(repo.clone, ["rev-parse", "--show-object-format"]).stdout.trim()).toBe("sha256");
    expect(plainClone(repo.clone, ["rev-parse", "HEAD"]).stdout.trim()).toBe(sha);
    expect(plainClone(repo.clone, ["status", "--porcelain"])).toEqual({ code: 0, stdout: "" });
    expect(plainClone(repo.clone, ["fsck", "--strict"]).code).toBe(0);
  });

  test("loopback: the clone's edits are saved as a wip first, then the clone is at head", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { "a.txt": "base\n" });
    const head = await commit(repo.gitDir, { "a.txt": "head\n" }, [base]);
    value(await rebuildClone(params(repo, base, { generation: 2 })));
    writeFileSync(join(repo.clone, "a.txt"), "edited\n");
    writeFileSync(join(repo.clone, "new.txt"), "new\n");

    const r = value(await rebuildClone(params(repo, head, { generation: 2 })));
    expect(r.resumed).toBe(false);
    expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("head\n");
    expect(existsSync(join(repo.clone, "new.txt"))).toBe(false);
    const wip = value(await readWip({ gitDir: repo.gitDir, unit: UNIT, ...live() }));
    expect(wip?.parent).toBe(base);
    expect(wip?.generation).toBe(2);
    expect(await files(repo.gitDir, wipRef(UNIT))).toEqual({ "a.txt": "edited", "new.txt": "new" });
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%B", wipRef(UNIT)])).toBe("wip story:1.15\n\ngeneration: 2");
    expect(value(await readMarker(repo.gitDir, live().signal))?.start).toBe(head);
  });

  test("resume: a wip of the same generation on sha becomes the working tree, as uncommitted changes", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n", "gone.txt": "x\n" });
    value(await rebuildClone(params(repo, sha, { generation: 3 })));
    writeFileSync(join(repo.clone, "a.txt"), "wip\n");
    writeFileSync(join(repo.clone, "new.txt"), "new\n");
    Bun.spawnSync(["rm", join(repo.clone, "gone.txt")]);

    const r = value(await rebuildClone(params(repo, sha, { generation: 3, resumeWip: true })));
    expect(r).toEqual({ sha, branch: BRANCH, resumed: true });
    expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("wip\n");
    expect(readFileSync(join(repo.clone, "new.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(repo.clone, "gone.txt"))).toBe(false);
    expect(plainClone(repo.clone, ["rev-parse", "HEAD"]).stdout.trim()).toBe(sha);
    expect(plainClone(repo.clone, ["status", "--porcelain"]).stdout.split("\n").filter((l) => l !== "").sort()).toEqual([
      " D gone.txt",
      " M a.txt",
      "?? new.txt",
    ]);
  });

  test("resume: another generation or another parent builds fresh", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    const other = await commit(repo.gitDir, { "a.txt": "other\n" }, [sha]);

    value(await rebuildClone(params(repo, sha, { generation: 3 })));
    writeFileSync(join(repo.clone, "a.txt"), "wip\n");
    const gen4 = value(await rebuildClone(params(repo, sha, { generation: 4, resumeWip: true })));
    expect(gen4.resumed).toBe(false);
    expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("base\n");

    // The wip saved now is generation 4 on sha; resuming at `other` is fresh.
    writeFileSync(join(repo.clone, "a.txt"), "wip4\n");
    const moved = value(await rebuildClone(params(repo, other, { generation: 4, resumeWip: true })));
    expect(moved.resumed).toBe(false);
    expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("other\n");
    expect(value(await readWip({ gitDir: repo.gitDir, unit: UNIT, ...live() }))?.parent).toBe(sha);
  });

  test("missing object: err missing-object, clone and marker untouched", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    value(await rebuildClone(params(repo, sha)));
    writeFileSync(join(repo.clone, "a.txt"), "edited\n");
    const marker = await rg(repo.gitDir, ["rev-parse", MARKER_REF]);
    const r = await rebuildClone(params(repo, "0123456789abcdef0123456789abcdef01234567"));
    expect(kind(r)).toBe("missing-object");
    expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("edited\n");
    expect(await rg(repo.gitDir, ["rev-parse", MARKER_REF])).toBe(marker);
    expect(value(await readWip({ gitDir: repo.gitDir, unit: UNIT, ...live() }))).toBeNull();
  });

  test("invalid inputs are refused before anything changes", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    value(await rebuildClone(params(repo, sha)));
    writeFileSync(join(repo.clone, "a.txt"), "edited\n");
    value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }));
    value(await rebuildClone(params(repo, sha, { resumeWip: true })));
    writeFileSync(join(repo.clone, "a.txt"), "edited again\n");
    const marker = await rg(repo.gitDir, ["rev-parse", MARKER_REF]);
    const wip = await rg(repo.gitDir, ["rev-parse", wipRef(UNIT)]);
    const cases: Partial<RebuildParams>[] = [
      { unit: "story-1.15" },
      { unit: "story:x" },
      { sha: "HEAD" },
      { sha: sha.slice(0, 12) },
      { branch: "a..b" },
      { branch: "" },
      { branch: "a b" },
      { clone: "relative/clone" },
      { clone: join(repo.gitDir, "clone") },
      { clone: repo.gitDir },
      { clone: repo.root },
      { generation: 0 },
    ];
    for (const over of cases) {
      expect([over, kind(await rebuildClone(params(repo, sha, over)))]).toEqual([over, "invalid"]);
      expect(readFileSync(join(repo.clone, "a.txt"), "utf8")).toBe("edited again\n");
      expect(await rg(repo.gitDir, ["rev-parse", MARKER_REF])).toBe(marker);
      expect(await rg(repo.gitDir, ["rev-parse", wipRef(UNIT)])).toBe(wip);
    }
  });

  test("read-only folders the session left are removed", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    value(await rebuildClone(params(repo, sha)));
    mkdirSync(join(repo.clone, "locked"));
    writeFileSync(join(repo.clone, "locked", "f"), "f\n");
    Bun.spawnSync(["chmod", "555", join(repo.clone, "locked")]);
    value(await rebuildClone(params(repo, sha)));
    expect(existsSync(join(repo.clone, "locked"))).toBe(false);
  });

  test("mode-000 files and folders the session left: rebuild still saves them in the wip", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    value(await rebuildClone(params(repo, sha)));
    writeFileSync(join(repo.clone, "secret.txt"), "s\n");
    mkdirSync(join(repo.clone, "shut"));
    writeFileSync(join(repo.clone, "shut", "f"), "f\n");
    chmodSync(join(repo.clone, "secret.txt"), 0o000);
    chmodSync(join(repo.clone, "shut"), 0o000);
    value(await rebuildClone(params(repo, sha)));
    expect(await files(repo.gitDir, wipRef(UNIT))).toEqual({ "a.txt": "base", "secret.txt": "s", "shut/f": "f" });
    expect(existsSync(join(repo.clone, "shut"))).toBe(false);
  });

  test("an aborted signal is transient", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    expect(kind(await rebuildClone(params(repo, sha, { signal: AbortSignal.abort() })))).toBe("transient");
  });
});

describe("saveWip", () => {
  test("no marker (a clone the runner did not finish building): saved false, nothing written", async () => {
    const repo = await setup();
    mkdirSync(repo.clone, { recursive: true });
    writeFileSync(join(repo.clone, "a.txt"), "half\n");
    expect(value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }))).toEqual({ saved: false });
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/wip/"])).toBe("");
  });

  test("with a marker: saves the wip and deletes the marker; a second save finds none", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    value(await rebuildClone(params(repo, sha, { generation: 5 })));
    writeFileSync(join(repo.clone, "a.txt"), "w\n");
    expect(value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }))).toEqual({ saved: true });
    expect(value(await readMarker(repo.gitDir, live().signal))).toBeNull();
    const wip = value(await readWip({ gitDir: repo.gitDir, unit: UNIT, ...live() }));
    expect(wip).toMatchObject({ parent: sha, generation: 5 });
    expect(await rg(repo.gitDir, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).toBe("");
    expect(value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }))).toEqual({ saved: false });
  });

  test("a clean clone saves nothing and keeps the earlier wip", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { "a.txt": "base\n" });
    value(await rebuildClone(params(repo, sha)));
    writeFileSync(join(repo.clone, "a.txt"), "w\n");
    value(await rebuildClone(params(repo, sha)));
    const wip = await rg(repo.gitDir, ["rev-parse", wipRef(UNIT)]);
    expect(value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }))).toEqual({ saved: false });
    expect(value(await readMarker(repo.gitDir, live().signal))).toBeNull();
    expect(await rg(repo.gitDir, ["rev-parse", wipRef(UNIT)])).toBe(wip);
  });

  test("tracked files that match .gitignore stay in the wip; ignored untracked files stay out", async () => {
    const repo = await setup();
    const sha = await commit(repo.gitDir, { ".gitignore": "*.log\n", "keep.log": "kept\n", "a.txt": "a\n" });
    value(await rebuildClone(params(repo, sha)));
    writeFileSync(join(repo.clone, "other.log"), "ignored\n");
    writeFileSync(join(repo.clone, "a.txt"), "b\n");
    value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }));
    expect(Object.keys(await files(repo.gitDir, wipRef(UNIT))).sort()).toEqual([".gitignore", "a.txt", "keep.log"]);
  });
});

describe("sessionStartSha", () => {
  const rec = { base_sha: "a".repeat(40), head_sha: "b".repeat(40) };
  test("build -> base_sha; loopback and ci-fix -> head_sha", () => {
    expect(sessionStartSha("build", rec)).toEqual({ ok: true, value: "a".repeat(40) });
    expect(sessionStartSha("loopback", rec)).toEqual({ ok: true, value: "b".repeat(40) });
    expect(sessionStartSha("ci-fix", rec)).toEqual({ ok: true, value: "b".repeat(40) });
  });
  test("a null SHA is invalid", () => {
    expect(kind(sessionStartSha("build", { ...rec, base_sha: null }))).toBe("invalid");
    expect(kind(sessionStartSha("loopback", { ...rec, head_sha: null }))).toBe("invalid");
    expect(kind(sessionStartSha("ci-fix", { ...rec, head_sha: null }))).toBe("invalid");
    expect(kind(sessionStartSha("build", { ...rec, head_sha: null }))).toBe("ok");
  });
});
