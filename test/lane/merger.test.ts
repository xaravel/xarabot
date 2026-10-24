import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "../../src/core/result.ts";
import { headRef, RUNNER_IDENTITY } from "../../src/lane/clone.ts";
import { createGitMerger, type MergeRequest } from "../../src/lane/merger.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { BOT, cleanup, commit, files, live, rg, setup, UNIT, value } from "./git-fixture.ts";

afterEach(cleanup);

const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const status = (s11: string, s12: string) => `development_status:\n  epic-1: in-progress\n  1-1-first: ${s11}\n  1-2-second: ${s12}\n`;

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

function req(headSha: string, mainSha: string, over: Partial<MergeRequest> = {}): MergeRequest {
  return { unit: UNIT, headSha, mainSha, message: "Merge main into story/1.15", statusPaths: [STATUS], ...live(), ...over };
}

describe("createGitMerger", () => {
  test("up-to-date when main is an ancestor of the head; no fetch", async () => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { a: "a\n" });
    const head = await commit(repo.gitDir, { a: "A\n" }, [main]);
    const f = recordingFetch();
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: f.fetch });
    expect(value(await m.merge(req(head, main)))).toEqual({ kind: "up-to-date" });
    expect(f.calls).toEqual([]);
  });

  test("clean when merge-tree finds no conflict", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n", b: "b\n" });
    const head = await commit(repo.gitDir, { a: "A\n", b: "b\n" }, [base]);
    const main = await commit(repo.gitDir, { a: "a\n", b: "B\n" }, [base]);
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: recordingFetch().fetch });
    expect(value(await m.merge(req(head, main)))).toEqual({ kind: "clean" });
  });

  test("a status conflict is merged: two parents, the bot author, main's lines plus the PR's entry", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { [STATUS]: status("backlog", "backlog"), src: "s\n" });
    const head = await commit(repo.gitDir, { [STATUS]: status("done", "backlog"), src: "S\n" }, [base]);
    const main = await commit(repo.gitDir, { [STATUS]: status("backlog", "done"), src: "s\n" }, [base]);
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: recordingFetch().fetch });
    const r = value(await m.merge(req(head, main)));
    if (r.kind !== "merged") throw new Error(JSON.stringify(r));
    expect(r.resolved).toEqual([STATUS]);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P", r.head_sha])).toBe(`${head} ${main}`);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", r.head_sha])).toBe(`${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>`);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%B", r.head_sha])).toBe("Merge main into story/1.15");
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ [STATUS]: status("done", "done").trim(), src: "S" });
    expect(await rg(repo.gitDir, ["rev-parse", headRef(UNIT)])).toBe(r.head_sha);
  });

  test("a lockfile conflict: a candidate with main's lockfile, then merged with the given text", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { "bun.lock": "lock base\n", [STATUS]: status("backlog", "backlog") });
    const head = await commit(repo.gitDir, { "bun.lock": "lock pr\n", [STATUS]: status("done", "backlog") }, [base]);
    const main = await commit(repo.gitDir, { "bun.lock": "lock main\n", [STATUS]: status("backlog", "done") }, [base]);
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: recordingFetch().fetch });
    const first = value(await m.merge(req(head, main)));
    if (first.kind !== "lockfile") throw new Error(JSON.stringify(first));
    expect(first.paths).toEqual(["bun.lock"]);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P|%an", first.candidate_sha])).toBe(`${head} ${main}|${RUNNER_IDENTITY.name}`);
    expect((await files(repo.gitDir, first.candidate_sha))["bun.lock"]).toBe("lock main");

    const second = value(await m.merge(req(head, main, { lockfiles: { "bun.lock": "lock regenerated\n" } })));
    if (second.kind !== "merged") throw new Error(JSON.stringify(second));
    expect([...second.resolved].sort()).toEqual([STATUS, "bun.lock"].sort());
    expect(await files(repo.gitDir, second.head_sha)).toEqual({ "bun.lock": "lock regenerated", [STATUS]: status("done", "done").trim() });
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P|%an", second.head_sha])).toBe(`${head} ${main}|${BOT.name}`);
  });

  test("any other conflict needs a session: a runner candidate keeping the conflict markers", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { src: "s\n", "bun.lock": "lock base\n", [STATUS]: status("backlog", "backlog") });
    const head = await commit(repo.gitDir, { src: "PR\n", "bun.lock": "lock pr\n", [STATUS]: status("done", "backlog") }, [base]);
    const main = await commit(repo.gitDir, { src: "MAIN\n", "bun.lock": "lock main\n", [STATUS]: status("backlog", "done") }, [base]);
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: recordingFetch().fetch });
    const r = value(await m.merge(req(head, main)));
    if (r.kind !== "needs-session") throw new Error(JSON.stringify(r));
    expect(r.paths).toEqual(["src"]);
    // The conflicted lockfile took main's blob, with no markers, and is reported as such.
    expect(r.lockfiles).toEqual(["bun.lock"]);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P|%an", r.candidate_sha])).toBe(`${head} ${main}|${RUNNER_IDENTITY.name}`);
    const tree = await files(repo.gitDir, r.candidate_sha);
    expect(tree["src"]).toContain("<<<<<<<");
    expect(tree["src"]).toContain("PR");
    expect(tree["src"]).toContain("MAIN");
    expect(tree[STATUS]).toBe(status("done", "done").trim());
    expect(tree["bun.lock"]).toBe("lock main");
  });

  test("a status file that cannot be merged needs a session", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { [STATUS]: "a: 1\nb: 1\n" });
    const head = await commit(repo.gitDir, { [STATUS]: "{a: 2, b: 1}\n" }, [base]);
    const main = await commit(repo.gitDir, { [STATUS]: "a: 1\nb: 3\n" }, [base]);
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: recordingFetch().fetch });
    const r = value(await m.merge(req(head, main)));
    expect(r.kind).toBe("needs-session");
    if (r.kind === "needs-session") expect(r).toMatchObject({ paths: [STATUS], lockfiles: [] });
  });

  test("fetches only the SHA runner.git lacks", async () => {
    const repo = await setup();
    const other = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    const head = await commit(repo.gitDir, { a: "A\n" }, [base]);
    // main exists only in the other repo; it shares base by content.
    const otherBase = await commit(other.gitDir, { a: "a\n" });
    expect(otherBase).not.toBe(""); // commit times may differ; main's own parent is fetched along.
    const main = await commit(other.gitDir, { a: "a\n", b: "b\n" }, [otherBase]);
    await rg(other.gitDir, ["update-ref", "refs/x/main", main]);
    const f = recordingFetch(async () => plainFetch(repo.gitDir, other.gitDir, "refs/x/main"));
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: f.fetch });
    const r = await m.merge(req(head, main));
    expect(f.calls).toEqual([[main]]);
    expect(r.ok).toBe(true);
  });

  test("a failed fetch is a fetch error, never a throw", async () => {
    const repo = await setup();
    const head = await commit(repo.gitDir, { a: "A\n" });
    const f = recordingFetch();
    const m = createGitMerger({ gitDir: repo.gitDir, bot: BOT, fetch: f.fetch });
    const r = await m.merge(req(head, "e".repeat(40)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fetch");
    expect(f.calls).toEqual([["e".repeat(40)]]);
  });
});
