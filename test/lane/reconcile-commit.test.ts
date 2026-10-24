import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "../../src/core/result.ts";
import { headRef } from "../../src/lane/clone.ts";
import { createGitReconcileCommitter, type ReconcileCommitRequest } from "../../src/lane/reconcile-commit.ts";
import type { FetchShas } from "../../src/lane/workspace.ts";
import { BOT, cleanup, commit, files, IDENTITY, live, rg, setup, value } from "./git-fixture.ts";

afterEach(cleanup);

const UNIT = "reconcile:5";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const BEFORE = "# kept\ndevelopment_status:\n  epic-2: in-progress\n  2-1-heartbeat: backlog\n";
const AFTER = "# kept\ndevelopment_status:\n  epic-2: in-progress\n  2-1-heartbeat: done\n";

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

const req = (ontoSha: string, over: Partial<ReconcileCommitRequest> = {}): ReconcileCommitRequest => ({
  unit: UNIT,
  ontoSha,
  message: "reconcile:5: sprint status for merged units\n\n- 2-1-heartbeat: backlog -> done",
  files: { [STATUS]: AFTER },
  ...live(),
  ...over,
});

describe("createGitReconcileCommitter", () => {
  test("one bot commit onto main, replacing only the given file, written to the unit's head ref; no fetch", async () => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { [STATUS]: BEFORE, "src/a.ts": "a\n", "docs/b.md": "b\n" });
    const f = recordingFetch();
    const c = createGitReconcileCommitter({ gitDir: repo.gitDir, bot: BOT, fetch: f.fetch });
    const r = value(await c.commit(req(main)));
    expect(r.base_sha).toBe(main);
    expect(f.calls).toEqual([]);
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ [STATUS]: AFTER.trimEnd(), "src/a.ts": "a", "docs/b.md": "b" });
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P|%an <%ae>|%cn <%ce>", r.head_sha])).toBe(`${main}|${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>`);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%B", r.head_sha])).toBe("reconcile:5: sprint status for merged units\n\n- 2-1-heartbeat: backlog -> done");
    expect(await rg(repo.gitDir, ["rev-parse", headRef(UNIT)])).toBe(r.head_sha);
    expect(await rg(repo.gitDir, ["diff", "--name-only", main, r.head_sha])).toBe(STATUS);
  });

  test("a file new on main is added", async () => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { "src/a.ts": "a\n" });
    const c = createGitReconcileCommitter({ gitDir: repo.gitDir, bot: BOT, fetch: recordingFetch().fetch });
    const r = value(await c.commit(req(main)));
    expect(await rg(repo.gitDir, ["diff", "--name-status", main, r.head_sha])).toBe(`A\t${STATUS}`);
  });

  test("main missing from runner.git is fetched first", async () => {
    const repo = await setup();
    const other = await setup();
    const main = await commit(other.gitDir, { [STATUS]: BEFORE });
    await rg(other.gitDir, ["update-ref", "refs/x/main", main]);
    const f = recordingFetch(async () => plainFetch(repo.gitDir, other.gitDir, "refs/x/main"));
    const c = createGitReconcileCommitter({ gitDir: repo.gitDir, bot: BOT, fetch: f.fetch });
    const r = value(await c.commit(req(main)));
    expect(f.calls).toEqual([[main]]);
    expect((await files(repo.gitDir, r.head_sha))[STATUS]).toBe(AFTER.trimEnd());
  });

  test.each([
    ["a failed fetch", "fetch"],
    ["nothing to change", "invalid"],
    ["a non-bot identity", "invalid"],
    ["an empty message", "invalid"],
    ["no files", "invalid"],
  ] as const)("%s: %s, never a throw", async (name, kind) => {
    const repo = await setup();
    const main = await commit(repo.gitDir, { [STATUS]: name === "nothing to change" ? AFTER : BEFORE });
    const bot = name === "a non-bot identity" ? IDENTITY : BOT;
    const c = createGitReconcileCommitter({ gitDir: repo.gitDir, bot, fetch: recordingFetch().fetch });
    const over: Partial<ReconcileCommitRequest> =
      name === "a failed fetch" ? { ontoSha: "e".repeat(40) } : name === "an empty message" ? { message: " " } : name === "no files" ? { files: {} } : {};
    const r = await c.commit(req(main, over));
    expect(r.ok ? "ok" : r.error.kind).toBe(kind);
  });
});
