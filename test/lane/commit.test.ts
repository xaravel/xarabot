import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "../../src/adapters/forge/github/runner-git.ts";
import { headRef, rebuildClone, saveWip, wipRef, type RebuildParams } from "../../src/lane/clone.ts";
import { coordinatorWriteRules } from "../../src/core/lane/write-check.ts";
import { coordinatorGlobs } from "../../src/core/next/coordinator.ts";
import { CONFIG_DEFAULTS } from "../../src/core/schemas/config.ts";
import { commitSession, type CommitParams } from "../../src/lane/commit.ts";
import { BOT, BRANCH, cleanup, commit, EPIC_CONTEXT, files, IDENTITY, live, plainClone, rg, rules, setup, SPEC_PATH, STORY_FILE, tempDir, UNIT, value, type Repo } from "./git-fixture.ts";

afterEach(cleanup);

function rebuild(repo: Repo, sha: string, over: Partial<RebuildParams> = {}): RebuildParams {
  return { gitDir: repo.gitDir, clone: repo.clone, unit: UNIT, branch: BRANCH, sha, generation: 1, resumeWip: false, ...live(), ...over };
}

function session(repo: Repo, baseSha: string, ontoSha: string, over: Partial<CommitParams> = {}): CommitParams {
  return { gitDir: repo.gitDir, clone: repo.clone, baseSha, ontoSha, bot: BOT, message: "Story 1.15: clone\n", rules: rules(), ...live(), ...over };
}

function kind(r: { ok: boolean; error?: { kind: string } }): string {
  return r.ok ? "ok" : (r.error?.kind ?? "?");
}

/** base: a and b; main changes b. */
async function diverged(repo: Repo): Promise<{ base: string; onto: string }> {
  const base = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nb2\nb3\n" });
  const onto = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nMAIN\nb3\n" }, [base]);
  return { base, onto };
}

describe("commitSession", () => {
  test("clean commit: one commit on ontoSha by the bot, both changes, sanitized message, no wip ancestor", async () => {
    const repo = await setup();
    const { base, onto } = await diverged(repo);
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "a"), "a1\nSESSION\na3\n");
    // A wip of this session, then resumed: the commit must not descend from it.
    value(await rebuildClone(rebuild(repo, base, { resumeWip: true })));
    const wip = await rg(repo.gitDir, ["rev-parse", wipRef(UNIT)]);

    const message = "Story 1.15: clone\n\nThanks @octocat, fixes #12.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n";
    const r = value(await commitSession(session(repo, base, onto, { message })));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(r.base_sha).toBe(onto);
    const head = r.head_sha;
    expect(await rg(repo.gitDir, ["rev-parse", headRef(UNIT)])).toBe(head);
    expect(headRef(UNIT)).toBe("refs/xarabot/head/story__1.15");
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P", head])).toBe(onto);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", head])).toBe(`${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>`);
    const body = await rg(repo.gitDir, ["log", "-1", "--format=%B", head]);
    expect(body).toBe("Story 1.15: clone\n\nThanks octocat,.");
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%(trailers)", head])).toBe("");
    expect(await files(repo.gitDir, head)).toEqual({ a: "a1\nSESSION\na3", b: "b1\nMAIN\nb3" });
    const ancestor = value(await runGit(repo.gitDir, ["merge-base", "--is-ancestor", wip, head], live()));
    expect(ancestor.code).toBe(1);
    expect(await rg(repo.gitDir, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).toBe("");
  });

  test("conflict: same lines changed on both sides -> conflict paths, nothing committed", async () => {
    const repo = await setup();
    const { base, onto } = await diverged(repo);
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "b"), "b1\nSESSION\nb3\n");
    writeFileSync(join(repo.clone, "a"), "a1\nfine\na3\n");
    expect(value(await commitSession(session(repo, base, onto)))).toEqual({ kind: "conflict", paths: ["b"] });
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");
  });

  test("no change, or only the change main already has -> empty", async () => {
    const repo = await setup();
    const { base, onto } = await diverged(repo);
    value(await rebuildClone(rebuild(repo, base)));
    expect(value(await commitSession(session(repo, base, onto)))).toEqual({ kind: "empty" });
    writeFileSync(join(repo.clone, "b"), "b1\nMAIN\nb3\n");
    expect(value(await commitSession(session(repo, base, onto)))).toEqual({ kind: "empty" });
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");
  });

  test("deletes and tracked-but-ignored files carry through", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { ".gitignore": "*.log\n", "keep.log": "kept\n", gone: "x\n", a: "a\n" });
    value(await rebuildClone(rebuild(repo, base)));
    rmSync(join(repo.clone, "gone"));
    writeFileSync(join(repo.clone, "untracked.log"), "no\n");
    writeFileSync(join(repo.clone, "a"), "b\n");
    const r = value(await commitSession(session(repo, base, base)));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ ".gitignore": "*.log", "keep.log": "kept", a: "b" });
  });

  test("loopback: clone at head H (base + first change), more edits, committed onto a newer main against base", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nb2\nb3\n", c: "c\n" });
    const head = await commit(repo.gitDir, { a: "a1\nFIRST\na3\n", b: "b1\nb2\nb3\n", c: "c\n" }, [base]);
    const onto = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nMAIN\nb3\n", c: "c\n" }, [base]);
    value(await rebuildClone(rebuild(repo, head, { generation: 2 })));
    writeFileSync(join(repo.clone, "c"), "LOOPBACK\n");
    const r = value(await commitSession(session(repo, base, onto)));
    if (r.kind !== "committed") throw new Error(r.kind);
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%P", r.head_sha])).toBe(onto);
    expect(await files(repo.gitDir, r.head_sha)).toEqual({ a: "a1\nFIRST\na3", b: "b1\nMAIN\nb3", c: "LOOPBACK" });
  });

  test("a baseSha that is not the session's start or its ancestor is invalid", async () => {
    const repo = await setup();
    const { base, onto } = await diverged(repo);
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "a"), "x\n");
    const r = await commitSession(session(repo, onto, onto));
    expect(kind(r)).toBe("invalid");
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");
  });

  test("a message empty after sanitizing is invalid and writes no head ref", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    value(await rebuildClone(rebuild(repo, base)));
    writeFileSync(join(repo.clone, "a"), "b\n");
    const r = await commitSession(session(repo, base, base, { message: "Co-Authored-By: X <x@y>\nfixes #1\n" }));
    expect(kind(r)).toBe("invalid");
    expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");
  });

  test("embedded repo: a planted sub/.git is refused, naming sub", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    value(await rebuildClone(rebuild(repo, base)));
    const sub = join(repo.clone, "sub");
    mkdirSync(sub);
    const env = { PATH: process.env.PATH ?? "", HOME: sub, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const sh = (args: string[]) => expect(Bun.spawnSync(["git", ...args], { cwd: sub, env }).exitCode).toBe(0);
    sh(["init", "-q"]);
    writeFileSync(join(sub, "f"), "f\n");
    sh(["add", "f"]);
    sh(["-c", `user.name=${IDENTITY.name}`, "-c", `user.email=${IDENTITY.email}`, "commit", "-q", "-m", "s"]);
    const r = await commitSession(session(repo, base, base));
    expect(kind(r)).toBe("invalid");
    expect(r.ok ? "" : r.error.message).toContain("sub");
  });

  test("no marker -> no-session; a non-bot identity or a bad SHA is refused", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { a: "a\n" });
    expect(kind(await commitSession(session(repo, base, base)))).toBe("no-session");
    value(await rebuildClone(rebuild(repo, base)));
    expect(kind(await commitSession(session(repo, base, base, { bot: IDENTITY })))).toBe("invalid");
    expect(kind(await commitSession(session(repo, "main", base)))).toBe("invalid");
    expect(kind(await commitSession(session(repo, base, "f".repeat(40))))).toBe("missing-object");
    value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }));
    expect(kind(await commitSession(session(repo, base, base)))).toBe("no-session");
  });
});

describe("commitSession: the write check", () => {
  const MANIFEST = '---\nstory_id: "1.15"\nepic: 1\nstatus: ready\nglobs: ["src/**"]\n---\n\nBody.\n';
  const SPRINT = "_bmad-output/implementation-artifacts/sprint-status.yaml";
  const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
  const write = (repo: Repo, path: string, text: string) => {
    mkdirSync(dirname(join(repo.clone, path)), { recursive: true });
    writeFileSync(join(repo.clone, path), text);
  };
  const baseFiles = {
    "src/a.ts": "a\n",
    "CLAUDE.md": "rules\n",
    ".github/workflows/ci.yml": "on: push\n",
    [STORY_FILE]: MANIFEST,
    "stories/1.1.md": MANIFEST.replace('"1.15"', '"1.1"'),
    [SPEC_PATH]: "---\nstatus: ready\n---\n",
    [EPIC_CONTEXT]: "# Epic 1 Context: One\n",
    [SPRINT]: "development_status: {}\n",
    [RETRO]: "verdicts: {}\n",
  };
  const noHead = async (repo: Repo) => expect(await rg(repo.gitDir, ["for-each-ref", "refs/xarabot/head/"])).toBe("");

  test("refused: nested agent config, CLAUDE.md and .github, in path order; nothing written to the head ref", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, "src/a.ts", "SESSION\n");
    write(repo, "pkg/.claude/settings.json", "{}\n");
    write(repo, "CLAUDE.md", "mine\n");
    write(repo, ".github/workflows/ci.yml", "on: pull_request\n");
    expect(value(await commitSession(session(repo, base, base)))).toEqual({
      kind: "refused",
      refusals: [
        { path: ".github/workflows/ci.yml", class: "github" },
        { path: "CLAUDE.md", class: "agent-config" },
        { path: "pkg/.claude/settings.json", class: "agent-config" },
      ],
      reverted: [],
    });
    await noHead(repo);
  });

  test("refused: a delete and a rename count, as a delete plus an add", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    rmSync(join(repo.clone, SPRINT));
    rmSync(join(repo.clone, "stories/1.1.md"));
    write(repo, "stories/1.1-moved.txt", MANIFEST);
    const r = value(await commitSession(session(repo, base, base)));
    expect(r).toEqual({
      kind: "refused",
      refusals: [
        { path: SPRINT, class: "coordinator-file" },
        { path: "stories/1.1.md", class: "manifest" },
      ],
      reverted: [],
    });
    await noHead(repo);
  });

  test("the own spec, the own manifest's status line and src are committed", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, SPEC_PATH, "---\nstatus: done\n---\n");
    write(repo, STORY_FILE, MANIFEST.replace("status: ready", "status: done"));
    write(repo, "src/a.ts", "SESSION\n");
    const r = value(await commitSession(session(repo, base, base)));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect(r.reverted).toBeUndefined();
    const out = await files(repo.gitDir, r.head_sha);
    expect(out[SPEC_PATH]).toBe("---\nstatus: done\n---");
    expect(out[STORY_FILE]).toBe(MANIFEST.replace("status: ready", "status: done").trimEnd());
    expect(out["src/a.ts"]).toBe("SESSION");
  });

  test("the own manifest: a non-status edit is refused; an executable bit loses the exception", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, STORY_FILE, MANIFEST.replace('globs: ["src/**"]', 'globs: ["**"]'));
    expect(value(await commitSession(session(repo, base, base)))).toEqual({ kind: "refused", refusals: [{ path: STORY_FILE, class: "manifest" }], reverted: [] });
    write(repo, STORY_FILE, MANIFEST.replace("status: ready", "status: done"));
    chmodSync(join(repo.clone, STORY_FILE), 0o755);
    expect(value(await commitSession(session(repo, base, base)))).toEqual({ kind: "refused", refusals: [{ path: STORY_FILE, class: "manifest" }], reverted: [] });
    await noHead(repo);
  });

  test("Epic context: an edit is set back to base and an added one removed, with the rest committed", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    const added = "_bmad-output/implementation-artifacts/epic-2-context.md";
    write(repo, EPIC_CONTEXT, "# Epic 1 Context: mine\n");
    write(repo, added, "# Epic 2 Context: new\n");
    write(repo, "src/a.ts", "SESSION\n");
    const r = value(await commitSession(session(repo, base, base)));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect(r.reverted).toEqual([EPIC_CONTEXT, added]);
    const out = await files(repo.gitDir, r.head_sha);
    expect(out[EPIC_CONTEXT]).toBe("# Epic 1 Context: One");
    expect(out[added]).toBeUndefined();
    expect(out["src/a.ts"]).toBe("SESSION");
  });

  test("Epic context: the revert alone leaves an empty commit; a deleted one is restored", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, EPIC_CONTEXT, "# Epic 1 Context: mine\n");
    expect(value(await commitSession(session(repo, base, base)))).toEqual({ kind: "empty", reverted: [EPIC_CONTEXT] });
    rmSync(join(repo.clone, EPIC_CONTEXT));
    expect(value(await commitSession(session(repo, base, base)))).toEqual({ kind: "empty", reverted: [EPIC_CONTEXT] });
    await noHead(repo);
  });

  test("Epic context reverts are reported with a refusal too", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, EPIC_CONTEXT, "# Epic 1 Context: mine\n");
    write(repo, RETRO, "verdicts:\n  \"1\": accepted\n");
    expect(value(await commitSession(session(repo, base, base)))).toEqual({
      kind: "refused",
      refusals: [{ path: RETRO, class: "coordinator-file" }],
      reverted: [EPIC_CONTEXT],
    });
  });

  test("a re-run: the superseded blocked spec is dropped from the squash and the Epic context reverted; the new done spec is committed", async () => {
    const repo = await setup();
    const old = "_bmad-output/implementation-artifacts/spec-1-15-first-try.md";
    const blocked = "---\nstatus: blocked\n---\n\n## Auto Run Result\n\nStatus: blocked\n";
    // main holds the blocked spec from the first run; a policy Protected Path covers it, so a change to it would be refused.
    const base = await commit(repo.gitDir, { ...baseFiles, [old]: blocked });
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, old, `${blocked}\nSuperseded by the re-run.\n`);
    write(repo, SPEC_PATH, "---\nstatus: done\n---\n\n## Auto Run Result\n\nStatus: done\n");
    write(repo, EPIC_CONTEXT, "# Epic 1 Context: mine\n");
    write(repo, "src/a.ts", "SESSION\n");
    const rerun = rules({ superseded: [old], protectedPaths: [old] });
    const r = value(await commitSession(session(repo, base, base, { rules: rerun })));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect(r.reverted).toEqual([EPIC_CONTEXT, old]);
    const out = await files(repo.gitDir, r.head_sha);
    expect(out[old]).toBe(blocked.trimEnd());
    expect(out[SPEC_PATH]).toBe("---\nstatus: done\n---\n\n## Auto Run Result\n\nStatus: done");
    expect(out[EPIC_CONTEXT]).toBe("# Epic 1 Context: One");
    expect(out["src/a.ts"]).toBe("SESSION");
    // The commit holds no change to the blocked spec.
    expect(await rg(repo.gitDir, ["diff-tree", "-r", "--name-only", "--no-commit-id", base, r.head_sha])).toBe(["src/a.ts", SPEC_PATH].sort().join("\n"));
  });

  test("a superseded spec main does not have is removed; a deleted one is restored", async () => {
    const repo = await setup();
    const onMain = "_bmad-output/implementation-artifacts/spec-1-15-on-main.md";
    const added = "_bmad-output/implementation-artifacts/spec-1-15-added.md";
    const base = await commit(repo.gitDir, { ...baseFiles, [onMain]: "---\nstatus: blocked\n---\n" });
    value(await rebuildClone(rebuild(repo, base)));
    rmSync(join(repo.clone, onMain));
    write(repo, added, "---\nstatus: blocked\n---\n");
    write(repo, "src/a.ts", "SESSION\n");
    const r = value(await commitSession(session(repo, base, base, { rules: rules({ superseded: [onMain, added] }) })));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect([...(r.reverted ?? [])].sort()).toEqual([added, onMain].sort());
    const out = await files(repo.gitDir, r.head_sha);
    expect(out[onMain]).toBe("---\nstatus: blocked\n---");
    expect(out[added]).toBeUndefined();
  });

  test("a superseded path is matched exactly, never case-folded", async () => {
    const repo = await setup();
    const old = "_bmad-output/implementation-artifacts/spec-1-15-old.md";
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, old, "---\nstatus: blocked\n---\n");
    const r = value(await commitSession(session(repo, base, base, { rules: rules({ superseded: [old.toUpperCase()] }) })));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect(r.reverted).toBeUndefined();
    expect((await files(repo.gitDir, r.head_sha))[old]).toBe("---\nstatus: blocked\n---");
  });

  test("the commit message has the given secrets and token shapes redacted", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, "src/a.ts", "SESSION\n");
    const token = `ghp_${"z".repeat(36)}`;
    const r = value(await commitSession(session(repo, base, base, { message: `1.15: used cred-xyz-123 and ${token}\n`, secrets: ["cred-xyz-123"] })));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect(await rg(repo.gitDir, ["log", "-1", "--format=%B", r.head_sha])).toBe("1.15: used [REDACTED] and [REDACTED]");
  });

  test("an approved Infrastructure Story commits .github and agent config, never .xarabot", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { ...baseFiles, ".xarabot/policy.yaml": "schema_version: 1\n" });
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, ".github/workflows/ci.yml", "on: pull_request\n");
    write(repo, "CLAUDE.md", "mine\n");
    const infra = rules({ infrastructureApproved: true });
    const r = value(await commitSession(session(repo, base, base, { rules: infra })));
    if (r.kind !== "committed") throw new Error(JSON.stringify(r));
    expect((await files(repo.gitDir, r.head_sha))[".github/workflows/ci.yml"]).toBe("on: pull_request");
    write(repo, ".xarabot/policy.yaml", "schema_version: 1\nprotected_paths: []\n");
    expect(value(await commitSession(session(repo, base, base, { rules: infra })))).toEqual({
      kind: "refused",
      refusals: [{ path: ".xarabot/policy.yaml", class: "xarabot" }],
      reverted: [],
    });
  });

  test("a .claude symlink to an unprotected folder is refused as agent-config", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, "src/conf/settings.json", "{}\n");
    symlinkSync("src/conf", join(repo.clone, ".claude"));
    expect(value(await commitSession(session(repo, base, base)))).toEqual({
      kind: "refused",
      refusals: [{ path: ".claude", class: "agent-config" }],
      reverted: [],
    });
    await noHead(repo);
  });

  test("an Epic context file replaced by a directory: the check and the commit see the same squashed tree", async () => {
    const repo = await setup();
    const base = await commit(repo.gitDir, baseFiles);
    value(await rebuildClone(rebuild(repo, base)));
    rmSync(join(repo.clone, EPIC_CONTEXT));
    write(repo, `${EPIC_CONTEXT}/CLAUDE.md`, "planted\n");
    const r = value(await commitSession(session(repo, base, base)));
    // The revert restores the file, which drops the directory's files from the squash: nothing is left to check or commit.
    expect(r).toEqual({ kind: "empty", reverted: [EPIC_CONTEXT] });
    await noHead(repo);
  });

  test.each([
    ["a retro verdict", "verdicts:\n  \"1\": rejected\nitems: {}\ngo: {}\n"],
    ["a retro item", "verdicts:\n  \"1\": accepted\nitems:\n  \"1\": [done]\ngo: {}\n"],
    ["a checkpoint go", "verdicts:\n  \"1\": accepted\nitems: {}\ngo:\n  \"1\": true\n"],
  ])("retro-gates.yaml: %s changed -> refused coordinator-file", async (_name, text) => {
    const repo = await setup();
    const base = await commit(repo.gitDir, { ...baseFiles, [RETRO]: "verdicts:\n  \"1\": accepted\nitems: {}\ngo: {}\n" });
    value(await rebuildClone(rebuild(repo, base)));
    write(repo, RETRO, text);
    write(repo, "src/a.ts", "SESSION\n");
    expect(value(await commitSession(session(repo, base, base)))).toEqual({
      kind: "refused",
      refusals: [{ path: RETRO, class: "coordinator-file" }],
      reverted: [],
    });
    await noHead(repo);
  });

  describe("coordinator rules", () => {
    const config = { ...CONFIG_DEFAULTS, manifests: { dir: "stories" } };
    const statusUnit = coordinatorWriteRules({ config, globs: coordinatorGlobs({ kind: "planning", planning: "status" }, config), graphUnit: false });

    test("a status unit's Epic context change is committed, not reverted", async () => {
      const repo = await setup();
      const base = await commit(repo.gitDir, baseFiles);
      value(await rebuildClone(rebuild(repo, base)));
      const added = "_bmad-output/implementation-artifacts/epic-2-context.md";
      write(repo, EPIC_CONTEXT, "# Epic 1 Context: recompiled\n");
      write(repo, added, "# Epic 2 Context: new\n");
      write(repo, SPRINT, "development_status:\n  epic-2: in-progress\n");
      const r = value(await commitSession(session(repo, base, base, { rules: statusUnit })));
      if (r.kind !== "committed") throw new Error(JSON.stringify(r));
      expect(r.reverted).toBeUndefined();
      const out = await files(repo.gitDir, r.head_sha);
      expect(out[EPIC_CONTEXT]).toBe("# Epic 1 Context: recompiled");
      expect(out[added]).toBe("# Epic 2 Context: new");
      expect(out[SPRINT]).toBe("development_status:\n  epic-2: in-progress");
    });

    test("a refused path writes nothing: outside the unit, a graph input, .xarabot", async () => {
      const repo = await setup();
      const base = await commit(repo.gitDir, baseFiles);
      value(await rebuildClone(rebuild(repo, base)));
      write(repo, SPRINT, "development_status:\n  epic-2: in-progress\n");
      write(repo, "src/a.ts", "SESSION\n");
      write(repo, STORY_FILE, MANIFEST.replace("status: ready", "status: done"));
      write(repo, ".xarabot/config.yaml", "schema_version: 1\n");
      expect(value(await commitSession(session(repo, base, base, { rules: statusUnit })))).toEqual({
        kind: "refused",
        refusals: [
          { path: ".xarabot/config.yaml", class: "xarabot" },
          { path: SPRINT, class: "graph-and-status" },
          { path: "src/a.ts", class: "outside-unit" },
          { path: STORY_FILE, class: "graph-input" },
        ],
        reverted: [],
      });
      await noHead(repo);
    });

    test("each change carries its new mode: a status file made executable, a symlink or deleted is refused mode", async () => {
      const repo = await setup();
      const base = await commit(repo.gitDir, baseFiles);
      value(await rebuildClone(rebuild(repo, base)));
      chmodSync(join(repo.clone, SPRINT), 0o755);
      rmSync(join(repo.clone, RETRO));
      expect(value(await commitSession(session(repo, base, base, { rules: statusUnit })))).toEqual({
        kind: "refused",
        refusals: [
          { path: RETRO, class: "mode" },
          { path: SPRINT, class: "mode" },
        ],
        reverted: [],
      });
      chmodSync(join(repo.clone, SPRINT), 0o644);
      write(repo, RETRO, "verdicts: {}\n");
      rmSync(join(repo.clone, SPRINT));
      symlinkSync("retro-gates.yaml", join(repo.clone, SPRINT));
      expect(value(await commitSession(session(repo, base, base, { rules: statusUnit })))).toEqual({
        kind: "refused",
        refusals: [{ path: SPRINT, class: "mode" }],
        reverted: [],
      });
      await noHead(repo);
    });

    // Story 2.9: the retro records in retro-gates.yaml are reconcile's alone; the check reads both sides' texts.
    const GATES = 'schema_version: 1\nepics:\n  "1":\n    retro:\n      verdict: accepted\n      unit: "retro:1"\n      recorded_at: "2026-10-20T00:00:00Z"\n';
    const retroUnit = coordinatorWriteRules({ config, globs: coordinatorGlobs({ kind: "retro", epic: 2 }, config), graphUnit: false });

    test.each([
      ["a verdict changed", GATES, GATES.replace("accepted", "rejected"), "retro-verdict"],
      ["a retro added to an absent file", null, GATES, "retro-verdict"],
      ["the file deleted (an earlier class, mode, wins)", GATES, null, "mode"],
      ["text that does not parse", GATES, "schema_version: 1\nepics: [\n", "retro-gates-invalid"],
    ] as const)("retro-gates.yaml under coordinator rules: %s", async (_name, before, after, cls) => {
      const repo = await setup();
      const { [RETRO]: _drop, ...rest } = baseFiles;
      const base = await commit(repo.gitDir, before === null ? rest : { ...rest, [RETRO]: before });
      value(await rebuildClone(rebuild(repo, base)));
      if (after === null) rmSync(join(repo.clone, RETRO));
      else write(repo, RETRO, after);
      const r = value(await commitSession(session(repo, base, base, { rules: retroUnit })));
      expect(r.kind === "refused" ? r.refusals.filter((x) => x.path === RETRO).map((x) => x.class) : r.kind).toContain(cls);
      await noHead(repo);
    });

    test("retro-gates.yaml under coordinator rules: a change with the same data (a comment) is committed", async () => {
      const repo = await setup();
      const base = await commit(repo.gitDir, { ...baseFiles, [RETRO]: GATES });
      value(await rebuildClone(rebuild(repo, base)));
      write(repo, RETRO, `# note\n${GATES}`);
      const r = value(await commitSession(session(repo, base, base, { rules: retroUnit })));
      expect(r.kind).toBe("committed");
    });
  });
});

describe("planted git config in the clone never runs", () => {
  test("hooks, fsmonitor, filter/diff/merge drivers, includeIf and .gitattributes: rebuild, wip and commit run none", async () => {
    const repo = await setup();
    const evil = tempDir();
    const sentinel = join(evil, "ran");
    const script = join(evil, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${sentinel}\ncat\n`);
    chmodSync(script, 0o755);

    const base = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nb2\nb3\n", ".gitattributes": "* filter=evil diff=evil merge=evil\n" });
    const onto = await commit(repo.gitDir, { a: "a1\na2\na3\n", b: "b1\nMAIN\nb3\n", ".gitattributes": "* filter=evil diff=evil merge=evil\n" }, [base]);
    value(await rebuildClone(rebuild(repo, base)));

    const dotGit = join(repo.clone, ".git");
    const hooks = join(dotGit, "hooks");
    const hooksPath = join(evil, "hooks");
    for (const d of [hooks, hooksPath]) {
      mkdirSync(d, { recursive: true });
      for (const h of ["pre-commit", "post-commit", "post-checkout", "post-index-change", "reference-transaction", "pre-auto-gc", "post-merge"]) {
        writeFileSync(join(d, h), `#!/bin/sh\n${script} hook-${h}\n`);
        chmodSync(join(d, h), 0o755);
      }
    }
    const include = join(evil, "include.cfg");
    writeFileSync(include, `[core]\n\tpager = ${script}\n\tsshCommand = ${script}\n`);
    const config = readFileSync(join(dotGit, "config"), "utf8");
    writeFileSync(
      join(dotGit, "config"),
      config +
        `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${hooksPath}\n` +
        `[filter "evil"]\n\tclean = ${script} clean\n\tsmudge = ${script} smudge\n\trequired = true\n` +
        `[diff "evil"]\n\tcommand = ${script} diff\n\ttextconv = ${script} textconv\n` +
        `[merge "evil"]\n\tdriver = ${script} merge %O %A %B\n` +
        `[includeIf "gitdir:/"]\n\tpath = ${include}\n`,
    );
    writeFileSync(join(repo.clone, ".gitattributes"), "* filter=evil diff=evil merge=evil\n");
    writeFileSync(join(repo.clone, "a"), "a1\nSESSION\na3\n");

    const r = value(await commitSession(session(repo, base, onto)));
    expect(r.kind).toBe("committed");
    expect(existsSync(sentinel)).toBe(false);
    // A conflicting merge too: the merge driver is named for every path.
    writeFileSync(join(repo.clone, "b"), "b1\nSESSION\nb3\n");
    expect(value(await commitSession(session(repo, base, onto))).kind).toBe("conflict");
    expect(existsSync(sentinel)).toBe(false);

    // The control: plain git in the clone runs the planted programs.
    writeFileSync(join(repo.clone, "c"), "c\n");
    plainClone(repo.clone, ["add", "-A"]);
    expect(existsSync(sentinel)).toBe(true);
    rmSync(sentinel);

    // Rebuild saves the wip (a snapshot of the planted clone) and rebuilds.
    value(await rebuildClone(rebuild(repo, onto, { generation: 2 })));
    writeFileSync(join(repo.clone, "a"), "a1\nGEN2\na3\n");
    expect(value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() })).saved).toBe(true);
    value(await rebuildClone(rebuild(repo, onto, { generation: 2, resumeWip: true })));
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("every git spawn names runner.git", () => {
  test("a PATH shim logs each git run: first argument --git-dir=<runner.git>, never the clone's .git", async () => {
    const repo = await setup();
    const { base, onto } = await diverged(repo);
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("no git on PATH");
    const shimDir = tempDir();
    const log = join(shimDir, "log");
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> ${log}\nprintf '\\036' >> ${log}\nexec ${realGit} "$@"\n`);
    chmodSync(join(shimDir, "git"), 0o755);

    const saved = process.env.PATH;
    process.env.PATH = `${shimDir}:${saved ?? ""}`;
    try {
      value(await rebuildClone(rebuild(repo, base)));
      writeFileSync(join(repo.clone, "a"), "a1\nSESSION\na3\n");
      value(await rebuildClone(rebuild(repo, base, { resumeWip: true })));
      expect(value(await commitSession(session(repo, base, onto))).kind).toBe("committed");
      value(await saveWip({ gitDir: repo.gitDir, clone: repo.clone, ...live() }));
    } finally {
      process.env.PATH = saved;
    }

    const runs = readFileSync(log, "utf8")
      .split("\x1e")
      .filter((r) => r !== "")
      .map((r) => r.split("\x1f").filter((a) => a !== ""));
    expect(runs.length).toBeGreaterThan(10);
    const cloneGit = join(repo.clone, ".git");
    for (const argv of runs) {
      expect([argv[0], argv]).toEqual([`--git-dir=${repo.gitDir}`, argv]);
      expect([argv.some((a) => a.includes(cloneGit)), argv]).toEqual([false, argv]);
    }
    expect(runs.some((a) => a.includes(`--work-tree=${repo.clone}`))).toBe(true);
  });
});
