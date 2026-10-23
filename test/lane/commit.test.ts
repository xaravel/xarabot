import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../../src/adapters/forge/github/runner-git.ts";
import { headRef, rebuildClone, saveWip, wipRef, type RebuildParams } from "../../src/lane/clone.ts";
import { commitSession, type CommitParams } from "../../src/lane/commit.ts";
import { BOT, BRANCH, cleanup, commit, files, IDENTITY, live, plainClone, rg, setup, tempDir, UNIT, value, type Repo } from "./git-fixture.ts";

afterEach(cleanup);

function rebuild(repo: Repo, sha: string, over: Partial<RebuildParams> = {}): RebuildParams {
  return { gitDir: repo.gitDir, clone: repo.clone, unit: UNIT, branch: BRANCH, sha, generation: 1, resumeWip: false, ...live(), ...over };
}

function session(repo: Repo, baseSha: string, ontoSha: string, over: Partial<CommitParams> = {}): CommitParams {
  return { gitDir: repo.gitDir, clone: repo.clone, baseSha, ontoSha, bot: BOT, message: "Story 1.15: clone\n", ...live(), ...over };
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
