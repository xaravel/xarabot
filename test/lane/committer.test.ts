import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../src/core/result.ts";
import { headRef, rebuildClone, type RebuildParams } from "../../src/lane/clone.ts";
import { createGitCommitter } from "../../src/lane/committer.ts";
import { createGitMerger } from "../../src/lane/merger.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { BOT, BRANCH, cleanup, commit, files, live, rg, rules, setup, UNIT, value, type Repo } from "./git-fixture.ts";

afterEach(cleanup);

function rebuild(repo: Repo, sha: string, over: Partial<RebuildParams> = {}): RebuildParams {
  return { gitDir: repo.gitDir, clone: repo.clone, unit: UNIT, branch: BRANCH, sha, generation: 1, resumeWip: false, ...live(), ...over };
}

/** A fetch that records its calls and fails. */
function noFetch(): { calls: (readonly string[])[]; fetch: FetchShas } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    fetch: async (shas) => {
      calls.push([...shas]);
      return err("fetch", "offline");
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

describe("createGitCommitter", () => {
  test("commits the session onto a newer main as the bot, with no fetch when main is present", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nb2\nb3\n" });
    const onto = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nMAIN\nb3\n" }, [base]);
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "a"), "a1\nSESSION\na3\n");
    const f = noFetch();
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: f.fetch });
    const r = value(await committer.commit({ unit: UNIT, ontoSha: onto, message: "1.15: Did it\n\nCo-Authored-By: X <x@y>\n", rules: rules(), ...live() }));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(f.calls).toEqual([]);
    expect(r.base_sha).toBe(onto);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P", r.head_sha])).toBe(onto);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", r.head_sha])).toBe(`${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>`);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%B", r.head_sha])).toBe("1.15: Did it");
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ a: "a1\nSESSION\na3", b: "b1\nMAIN\nb3" });
  });

  test("forwards secrets to the commit: the message on the head ref has them redacted", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "a"), "SESSION\n");
    const secret = "lane-cred-0123456789";
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const r = value(await committer.commit({ unit: UNIT, ontoSha: base, message: `1.15: used ${secret}\n`, secrets: [secret], rules: rules(), ...live() }));
    if (r.kind !== "committed") throw new Error(r.kind);
    const body = await rg(repo.gitDir, ["log", "-1", "--format=%B", headRef(UNIT)]);
    expect(body).toBe("1.15: used [REDACTED]");
    expect(body).not.toContain(secret);
  });

  test("fetches ontoSha only when runner.git lacks it", async () => {
    const repo = await setup();
    const other = await setup();
    const base = await commit(other.gitDir, { a: "a\n", b: "b\n" });
    const onto = await commit(other.gitDir, { a: "a\n", b: "MAIN\n" }, [base]);
    await rg(other.gitDir, ["update-ref", "refs/x/base", base]);
    await rg(other.gitDir, ["update-ref", "refs/x/onto", onto]);
    value(plainFetch(repo.gitDir, other.gitDir, "refs/x/base"));
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "a"), "SESSION\n");

    const calls: (readonly string[])[] = [];
    const fetch: FetchShas = async (shas) => {
      calls.push([...shas]);
      return plainFetch(repo.gitDir, other.gitDir, "refs/x/onto");
    };
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch });
    const r = value(await committer.commit({ unit: UNIT, ontoSha: onto, message: "1.15: Did it", rules: rules(), ...live() }));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(calls).toEqual([[onto]]);
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ a: "SESSION", b: "MAIN" });

    // A second commit finds ontoSha present and fetches nothing.
    value(await committer.commit({ unit: UNIT, ontoSha: onto, message: "1.15: again", rules: rules(), ...live() }));
    expect(calls).toEqual([[onto]]);
  });

  test("a failed fetch of a missing ontoSha is a fetch error", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    value(await rebuildClone(rebuild(repo, base)));
    const f = noFetch();
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: f.fetch });
    const missing = "e".repeat(40);
    const r = await committer.commit({ unit: UNIT, ontoSha: missing, message: "m", rules: rules(), ...live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("fetch");
    expect(f.calls).toEqual([[missing]]);
  });

  test("an adopted PR head: the base is merge-base(start, main), so the whole PR lands on fresh main", async () => {
    const repo = await setup();
    const m0 = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nb2\nb3\n", c: "c\n" });
    const head = await commit(repo.gitDir, { a: "a1\nPR\na3\n", b: "b1\nb2\nb3\n", c: "c\n" }, [m0]);
    const m1 = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nMAIN\nb3\n", c: "c\n" }, [m0]);
    value(await rebuildClone(rebuild(repo, head)));
    writeFileSync(join(repo.clone, "c"), "SESSION\n");
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const r = value(await committer.commit({ unit: UNIT, ontoSha: m1, message: "1.15: more", rules: rules(), ...live() }));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(r.base_sha).toBe(m1);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P", r.head_sha])).toBe(m1);
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ a: "a1\nPR\na3", b: "b1\nMAIN\nb3", c: "SESSION" });
  });

  test("a conflict onto main carries the session's start; committing onto that start succeeds, and merging main into that head needs a session on the same paths (Story 2.11)", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nb2\nb3\n" });
    const onto = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nMAIN\nb3\n" }, [base]);
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "b"), "b1\nSESSION\nb3\n");
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const c = value(await committer.commit({ unit: UNIT, ontoSha: onto, message: "1.15: b", rules: rules(), ...live() }));
    expect(c).toEqual({ kind: "conflict", paths: ["b"], start: base });
    if (c.kind !== "conflict") throw new Error(c.kind);
    const r = value(await committer.commit({ unit: UNIT, ontoSha: c.start, message: "1.15: b", rules: rules(), ...live() }));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(r.base_sha).toBe(base);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P", r.head_sha])).toBe(base);
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ a: "a1\na2\na3", b: "b1\nSESSION\nb3" });

    // The CI step's merge of fresh main into that head conflicts on the same paths, so it needs a conflict session.
    const merger = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: noFetch().fetch });
    const m = value(await merger.merge({ unit: UNIT, headSha: r.head_sha, mainSha: onto, message: "Merge main into story/1.15", statusPaths: [], ...live() }));
    if (m.kind !== "needs-session") throw new Error(JSON.stringify(m));
    expect(m.paths).toEqual(c.paths);
  });

  test("a clone marker for another unit is refused as no-session", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    value(await rebuildClone(rebuild(repo, base, { unit: "story:9.9", branch: "story/9.9" })));
    writeFileSync(join(repo.clone, "a"), "b\n");
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const r = await committer.commit({ unit: UNIT, ontoSha: base, message: "m", rules: rules(), ...live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("no-session");
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");
  });

  test("commits with no merge base are invalid", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    const unrelated = await commit(repo.gitDir, { z: "z\n" });
    value(await rebuildClone(rebuild(repo, base)));
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const r = await committer.commit({ unit: UNIT, ontoSha: unrelated, message: "m", rules: rules(), ...live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });
});

describe("createGitCommitter: the write check", () => {
  const CI = ".github/workflows/ci.yml";
  const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
  const SPRINT = "_bmad-output/implementation-artifacts/sprint-status.yaml";

  test("main changed .github, retro-gates.yaml and sprint status after the start: a session that edited src commits, carrying main's versions", async () => {
    const repo = await setup();
    const start = { "src/a.ts": "a\n", [CI]: "on: push\n", [RETRO]: "verdicts: {}\n", [SPRINT]: "development_status: {}\n" };
    const base = await commit(repo.gitDir, start);
    const onto = await commit(repo.gitDir, { ...start, [CI]: "on: merge_group\n", [RETRO]: 'verdicts:\n  "1": accepted\n', [SPRINT]: "development_status:\n  epic-1: done\n" }, [base]);
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "src/a.ts"), "SESSION\n");
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const r = value(await committer.commit({ unit: UNIT, ontoSha: onto, message: "1.15: src", rules: rules(), ...live() }));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect(await files(repo.gitDir, r.head_sha)).toEqual({
      "src/a.ts": "SESSION",
      [CI]: "on: merge_group",
      [RETRO]: 'verdicts:\n  "1": accepted',
      [SPRINT]: "development_status:\n  epic-1: done",
    });
  });

  test("the request's rules reach the check: refused without approval, committed with it", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { "src/a.ts": "a\n", [CI]: "on: push\n" });
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, CI), "on: pull_request\n");
    const committer = createGitCommitter({ gitDir: repo.gitDir, clone: repo.clone, bot: BOT, fetch: noFetch().fetch });
    const refused = value(await committer.commit({ unit: UNIT, ontoSha: base, message: "1.15: ci", rules: rules(), ...live() }));
    expect(refused).toEqual({ kind: "refused", refusals: [{ path: CI, class: "github" }], reverted: [] });
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");
    const r = value(await committer.commit({ unit: UNIT, ontoSha: base, message: "1.15: ci", rules: rules({ infrastructureApproved: true }), ...live() }));
    expect(r.kind).toBe("committed");
  });
});
