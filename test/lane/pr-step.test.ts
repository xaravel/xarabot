import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { NextStory } from "../../src/core/next/next.ts";
import { err, ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { BuildResult } from "../../src/core/schemas/session-result.ts";
import type { CommitOutcome } from "../../src/lane/commit.ts";
import type { CommitRequest, Committer } from "../../src/lane/committer.ts";
import { runLaneProcess, type PrStepInput } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { createPrStep, prText, statusComment, type PrStepDeps } from "../../src/lane/pr-step.ts";
import type { Workspace } from "../../src/lane/workspace.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import { FORGE_ERROR_KINDS, isLaneStopKind, type Forge, type ForgeError, type ForgeOperation } from "../../src/ports/forge.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";
import { ALICE, BOB, rec, tip } from "../core/ledger/fixtures.ts";

// ------------------------------------------------------------------ world

const AUTHORITY = "docs/standing-authority.md";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const UNIT = "story:1.1";
const BRANCH = "story/1.1";
const opts = () => ({ signal: AbortSignal.timeout(5000) });

function mainFiles(o: { readonly authority?: "ok" | "missing" | "expired" } = {}): Record<string, string> {
  const files: Record<string, string> = {
    ".xarabot/config.yaml": [
      "schema_version: 1",
      'runner_version: "0.1.0"',
      "maintainer: edanisko",
      `standing_authority_path: ${AUTHORITY}`,
      "manifests:",
      "  dir: stories",
      "proxy_hosts: [files.pythonhosted.org]",
      "",
    ].join("\n"),
    ".xarabot/policy.yaml": "schema_version: 1\n",
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    "_bmad-output/planning-artifacts/epics.md": "# Epics\n\n## Epic 1: One\n\n### Story 1.1: Story 1.1\n\nBody.\n",
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    [`${SPEC_DIR}/sprint-status.yaml`]: "development_status:\n  epic-1: in-progress\n  1-1-first: backlog\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: Story 1.1\nglobs: ["src/s0/**"]\n---\n',
  };
  const a = o.authority ?? "ok";
  if (a !== "missing") {
    const expires = a === "expired" ? "expires: 2026-10-01\n" : "";
    files[AUTHORITY] = `---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-09-01\nrepo: xaravel/xarabot\n${expires}---\n\nGranted.\n`;
  }
  return files;
}

const STORY: NextStory = {
  unit: UNIT,
  story_id: "1.1",
  epic: 1,
  sprint_key: "1-1-first",
  title: "Story 1.1",
  manifest_path: "stories/1.1.md",
  manifest_sha: "f".repeat(40),
  globs: ["src/s0/**"],
  infrastructure: false,
  expect_generation: null,
  take_over: null,
};

function result(over: Partial<Pick<BuildResult, "summary" | "body" | "denied_actions">> = {}): BuildResult {
  return { kind: "build", outcome: "done", summary: "Did it", body: "", verification: ["bun test"], denied_actions: [], ...over };
}

/** A forge that records each operation called. */
function spied(forge: Forge): { forge: Forge; calls: ForgeOperation[] } {
  const calls: ForgeOperation[] = [];
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(forge)) {
    out[name] = (...args: unknown[]) => {
      calls.push(name as ForgeOperation);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { forge: out as Forge, calls };
}

/** A write-check refusal of an agent config path and the sprint status, with an Epic context revert. */
const REFUSED: CommitOutcome = {
  kind: "refused",
  refusals: [
    { path: ".claude/settings.json", class: "agent-config" },
    { path: `${SPEC_DIR}/sprint-status.yaml`, class: "coordinator-file" },
  ],
  reverted: [`${SPEC_DIR}/epic-1-context.md`],
};

type StubCommitter = Committer & { readonly requests: CommitRequest[] };

/** A committer returning `outcome`; `committed` gets a fresh head on `ontoSha`. */
function stubCommitter(fake: FakeForge, outcome: "committed" | CommitOutcome | "error" = "committed"): StubCommitter {
  const requests: CommitRequest[] = [];
  return {
    requests,
    async commit(r) {
      requests.push(r);
      if (outcome === "error") return err("git", "boom");
      if (outcome === "committed") return ok({ kind: "committed", base_sha: r.ontoSha, head_sha: fake.control.makeCommit() });
      return ok(outcome);
    },
  };
}

type World = {
  readonly fake: FakeForge;
  readonly calls: ForgeOperation[];
  readonly committer: StubCommitter;
  readonly record: UnitRecord;
  readonly main: string;
  readonly logs: string[];
  run(input?: Partial<PrStepInput>, deps?: Partial<PrStepDeps>): ReturnType<ReturnType<typeof createPrStep>>;
  ledger(): Promise<UnitRecord | undefined>;
};

async function world(
  o: { readonly authority?: "ok" | "missing" | "expired"; readonly record?: Partial<UnitRecord>; readonly commit?: "committed" | CommitOutcome | "error" } = {},
): Promise<World> {
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o) });
  const s = await fake.forge.snapshot(opts());
  if (!s.ok) throw new Error(s.error.message);
  const main = s.value.main.sha;
  const record = rec({ unit: UNIT, globs: ["src/s0/**"], base_sha: main, ...o.record });
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([record]), deletes: [] });
  const spy = spied(fake.forge);
  const committer = stubCommitter(fake, o.commit);
  const logs: string[] = [];
  return {
    fake,
    calls: spy.calls,
    committer,
    record,
    main,
    logs,
    run: (input = {}, deps = {}) =>
      createPrStep({ forge: spy.forge, committer, identity: ALICE, repo: "xaravel/xarabot", sleep: async () => {}, random: () => 0, ...deps })({
        unit: STORY,
        record,
        result: result(),
        specPath: `${SPEC_DIR}/spec-1-1-first.md`,
        superseded: [],
        clone: "/nonexistent/clone",
        signal: AbortSignal.timeout(60_000),
        log: (t) => logs.push(t),
        ...input,
      }),
    async ledger() {
      const snap = await fake.forge.snapshot(opts());
      if (!snap.ok) throw new Error(snap.error.message);
      const l = parseLedger(snap.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return l.value.units.get(UNIT);
    },
  };
}

async function prs(fake: FakeForge) {
  const l = await fake.forge.listPrsByBranch(BRANCH, opts());
  if (!l.ok) throw new Error(l.error.message);
  return l.value;
}

// -------------------------------------------------------------- pure parts

describe("prText and statusComment", () => {
  test("the body is the summary alone when the body is blank, else summary, blank line, body", () => {
    expect(prText(STORY, { summary: "S", body: "  \n" })).toEqual({ title: "Story 1.1: Story 1.1", body: "S" });
    expect(prText(STORY, { summary: "S", body: "B" })).toEqual({ title: "Story 1.1: Story 1.1", body: "S\n\nB" });
  });

  test("the comment names the Story, short head and lane, and lists denied actions or none", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    expect(statusComment({ storyId: "1.1", headSha: head, lane: "builder-1", deniedActions: [] })).toBe(
      "🤖 Story 1.1: pushed 0123456 from lane builder-1.\n\nDenied actions: none.\n",
    );
    expect(statusComment({ storyId: "1.1", headSha: head, lane: "builder-1", deniedActions: ["git push", "@bob rm", "two\nlines"] })).toBe(
      "🤖 Story 1.1: pushed 0123456 from lane builder-1.\n\nDenied actions:\n- git push\n- bob rm\n- two lines\n",
    );
  });

  test("prText redacts secrets and token shapes, and caps the title and body", () => {
    const t = prText({ story_id: "1.1", title: "x".repeat(300) }, { summary: `S ghp_${"a".repeat(36)}`, body: `key s3cr3t-value ${"y".repeat(70_000)}` }, ["s3cr3t-value"]);
    expect(t.title.length).toBe(256);
    expect(t.body.length).toBe(65_536);
    expect(t.body.startsWith("S [REDACTED]\n\nkey [REDACTED] y")).toBe(true);
    expect(t.body.endsWith("\n\n[truncated by xarabot]")).toBe(true);
  });

  test("the status comment redacts secrets and is capped at the comment limit", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const c = statusComment({ storyId: "1.1", headSha: head, lane: "builder-1", deniedActions: ["cat tok-12345", "z".repeat(70_000)], secrets: ["tok-12345"] });
    expect(c).toContain("- cat [REDACTED]");
    expect(c.length).toBeLessThanOrEqual(65_536);
    // A secret holding a newline or a double space is redacted before whitespace collapses.
    for (const secret of ["line-one\nline-two", "word  word-xyz"]) {
      const d = statusComment({ storyId: "1.1", headSha: head, lane: "builder-1", deniedActions: [`echo ${secret} done`], secrets: [secret] });
      expect(d).toContain("- echo [REDACTED] done");
      expect(d).not.toContain(secret.replace(/\s+/g, " "));
    }
    expect(c.endsWith("\n\n[truncated by xarabot]")).toBe(true);
  });

  test("line breaks collapse before sanitizing, and actions that sanitize to nothing are skipped", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const comment = (deniedActions: string[]) => statusComment({ storyId: "1.1", headSha: head, lane: "builder-1", deniedActions });
    expect(comment(["fixes\n#12", "closes\nowner/repo#3", "Co-Authored-By: X <x@y>"])).toBe(
      "🤖 Story 1.1: pushed 0123456 from lane builder-1.\n\nDenied actions: none.\n",
    );
    expect(comment(["rm -rf\n/tmp, fixes\n#12", "Co-Authored-By: X <x@y>"])).toBe(
      "🤖 Story 1.1: pushed 0123456 from lane builder-1.\n\nDenied actions:\n- rm -rf /tmp,\n",
    );
  });
});

// -------------------------------------------------------------- the matrix

describe("createPrStep", () => {
  test("happy path: commit onto fresh main, push with a null lease, open the PR, record it, comment", async () => {
    const w = await world();
    const out = await w.run();
    expect(out.outcome).toBe("progress");
    expect(out.state).toBe("claimed");
    expect(w.committer.requests).toHaveLength(1);
    expect(w.committer.requests[0]).toMatchObject({ unit: UNIT, ontoSha: w.main, message: "1.1: Did it" });

    const list = await prs(w.fake);
    expect(list).toHaveLength(1);
    const pr = list[0];
    if (pr === undefined) throw new Error("no PR");
    expect(pr).toMatchObject({ state: "open", base: "main", title: "Story 1.1: Story 1.1", body: "Did it" });

    const record = await w.ledger();
    expect(record).toMatchObject({ state: "claimed", generation: 1, pr: pr.number, pr_owner: "alice", head_sha: pr.head_sha, base_sha: w.main });
    expect(out.record).toEqual(record as UnitRecord);

    const comments = w.fake.control.comments(pr.number);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.startsWith("🤖")).toBe(true);
    expect(comments[0]).toContain("Story 1.1");
    expect(comments[0]).toContain(pr.head_sha.slice(0, 7));
    expect(comments[0]).toContain("builder-1");
    expect(comments[0]).toContain("Denied actions: none.");
    expect(w.fake.control.ledgerLog().map((c) => c.message)).toEqual([
      "root",
      "seed [skip ci]",
      // The fence before the push, the fence before openPr, then the record.
      "ledger: heartbeat story:1.1 [skip ci]",
      "ledger: heartbeat story:1.1 [skip ci]",
      "ledger: heartbeat story:1.1 [skip ci]",
    ]);
    expect(w.calls.filter((c) => c === "pushBranch" || c === "openPr" || c === "comment")).toEqual(["pushBranch", "openPr", "comment"]);
    expect(w.fake.control.alerts()).toEqual([]);
  });

  test("attribution and mentions never reach the title, body or comment", async () => {
    const w = await world();
    const out = await w.run({
      unit: { ...STORY, title: "Story with @carol" },
      result: result({
        summary: "Did it for @someone",
        body: "Details, fixes #12.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
        denied_actions: ["@someone push", "Co-Authored-By: X <x@y>"],
      }),
    });
    expect(out.outcome).toBe("progress");
    const pr = (await prs(w.fake))[0];
    if (pr === undefined) throw new Error("no PR");
    const comment = w.fake.control.comments(pr.number).join("\n");
    for (const text of [pr.title, pr.body, comment]) {
      expect(text).not.toContain("@");
      expect(text.toLowerCase()).not.toContain("co-authored-by");
    }
    expect(pr.body).toContain("Did it for someone");
  });

  test("adopted PR: push leased on the recorded head, update the PR, open none", async () => {
    const w = await world();
    // Put an open PR on the branch and record it as adopted.
    const h0 = w.fake.control.makeCommit();
    expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: h0 }, opts())).ok).toBe(true);
    const opened = await w.fake.forge.openPr({ branch: BRANCH, base: "main", title: "old", body: "old" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const number = opened.value.number;
    const adopted = rec({ unit: UNIT, globs: ["src/s0/**"], pr: number, pr_owner: "alice", head_sha: h0, base_sha: w.main });
    w.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([adopted]), deletes: [] });

    const out = await w.run({ record: adopted });
    expect(out.outcome).toBe("progress");
    const list = await prs(w.fake);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: number, title: "Story 1.1: Story 1.1", body: "Did it", state: "open" });
    expect(list[0]?.head_sha).not.toBe(h0);
    expect(w.calls).not.toContain("openPr");
    expect(w.calls).not.toContain("branchHead");
    expect(w.calls).toContain("updatePr");
    expect(await w.ledger()).toMatchObject({ pr: number, head_sha: list[0]?.head_sha, base_sha: w.main });
  });

  test("a fix (kind fix) on the open PR: push leased on the head, record it, comment, but no updatePr", async () => {
    const w = await world();
    const h0 = w.fake.control.makeCommit();
    expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: h0 }, opts())).ok).toBe(true);
    const opened = await w.fake.forge.openPr({ branch: BRANCH, base: "main", title: "old", body: "old" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const number = opened.value.number;
    const withPr = rec({ unit: UNIT, globs: ["src/s0/**"], pr: number, pr_owner: "alice", head_sha: h0, base_sha: w.main });
    w.fake.control.writeForeignLedger({ message: "pr [skip ci]", writes: tip([withPr]), deletes: [] });

    const out = await w.run({ record: withPr, kind: "fix", result: result({ summary: "Fixed lint" }) });
    expect(out.outcome).toBe("progress");
    expect(out.state).toBe("claimed");
    const list = await prs(w.fake);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number, title: "old", body: "old", state: "open" });
    expect(list[0]?.head_sha).not.toBe(h0);
    expect(w.calls).not.toContain("openPr");
    expect(w.calls).not.toContain("updatePr");
    expect(await w.ledger()).toMatchObject({ pr: number, head_sha: list[0]?.head_sha, base_sha: w.main });
    expect(w.fake.control.comments(number)).toHaveLength(1);
  });

  test.each(["missing", "expired"] as const)("Standing Authority %s: stop with no push, no PR, no ledger edit, no alert", async (authority) => {
    const w = await world({ authority });
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(out.state).toBe("claimed");
    expect(out.reason).toContain(authority === "missing" ? "missing" : "authority-expired");
    expect(w.calls).not.toContain("pushBranch");
    expect(await prs(w.fake)).toEqual([]);
    expect(w.fake.control.ledgerLog()).toHaveLength(before);
    expect(w.fake.control.alerts()).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "claimed", pr: null });
  });

  test("denied actions are listed in the comment, sanitized and in order", async () => {
    const w = await world();
    await w.run({ result: result({ denied_actions: ["git push", "@bob rm"] }) });
    const pr = (await prs(w.fake))[0];
    if (pr === undefined) throw new Error("no PR");
    expect(w.fake.control.comments(pr.number)[0]).toContain("Denied actions:\n- git push\n- bob rm\n");
  });

  test("lease conflict: the branch moves after branchHead, so no PR and the unit is released", async () => {
    const w = await world();
    const f = w.fake.forge;
    // Another writer pushes to the branch between the head read and the push.
    const forge: Forge = {
      ...f,
      branchHead: async (branch, o) => {
        const head = await f.branchHead(branch, o);
        if (!head.ok) return head;
        expect((await f.pushBranch({ branch, expected_sha: head.value, sha: w.fake.control.makeCommit() }, opts())).ok).toBe(true);
        return head;
      },
    };
    const out = await w.run({}, { forge });
    expect(out.outcome).toBe("failed");
    expect(out.state).toBe("released");
    expect(out.reason).toContain("pushBranch conflict");
    expect(await prs(w.fake)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("a stale branch with no PR: the push leases from its real head and the PR opens (Story 2.6b)", async () => {
    const w = await world();
    const stale = w.fake.control.makeCommit();
    expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: stale }, opts())).ok).toBe(true);
    const leases: (string | null)[] = [];
    const f = w.fake.forge;
    const forge: Forge = {
      ...f,
      pushBranch: (lease, o) => {
        leases.push(lease.expected_sha);
        return f.pushBranch(lease, o);
      },
    };
    const out = await w.run({}, { forge });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(leases).toEqual([stale]);
    const list = await prs(w.fake);
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("open");
    expect(list[0]?.head_sha).not.toBe(stale);
    expect(w.logs.some((l) => l.includes(`${BRANCH} is at ${stale}: the push leases from it`))).toBe(true);
  });

  test("a branchHead error is a failed attempt naming it; nothing is pushed", async () => {
    const w = await world();
    w.fake.control.injectError("branchHead", { kind: "transient", message: "branchHead: network down" });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("branchHead transient: branchHead: network down");
    expect(w.calls).not.toContain("pushBranch");
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("commit conflict: no push, released", async () => {
    const w = await world({ commit: { kind: "conflict", paths: ["a"] } });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(w.calls).not.toContain("pushBranch");
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("a committer error is a failed attempt", async () => {
    const w = await world({ commit: "error" });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("commit git: boom");
  });

  test("empty commit: parked blocked no-op, no push, progress", async () => {
    const w = await world({ commit: { kind: "empty" } });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(w.calls).not.toContain("pushBranch");
    expect(await w.ledger()).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "no-op" }, attempts: 0 });
  });

  test("write check refused: parked blocked write-check, no push, no PR, each path in the log and the reason", async () => {
    const w = await world({ commit: REFUSED });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(w.calls.filter((c) => c === "pushBranch" || c === "openPr" || c === "updatePr" || c === "comment")).toEqual([]);
    expect(await prs(w.fake)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "write-check" }, attempts: 0, pr: null });
    expect(w.logs).toContain("PR step: write-check: refused .claude/settings.json (agent-config)");
    expect(w.logs).toContain(`PR step: write-check: refused ${SPEC_DIR}/sprint-status.yaml (coordinator-file)`);
    expect(w.logs).toContain(`PR step: write-check: reverted ${SPEC_DIR}/epic-1-context.md (Epic context)`);
    expect(out.reason).toContain(`write-check: refused .claude/settings.json (agent-config), ${SPEC_DIR}/sprint-status.yaml (coordinator-file)`);
    expect(w.fake.control.alerts()).toEqual([]);
  });

  test("a refused path with a line break is quoted in the log", async () => {
    const w = await world({ commit: { kind: "refused", refusals: [{ path: "CLAUDE.md\nPR step: fake", class: "agent-config" }], reverted: [] } });
    await w.run();
    expect(w.logs).toContain('PR step: write-check: refused "CLAUDE.md\\nPR step: fake" (agent-config)');
  });

  test("line-separator and bidi characters in a refused path are quoted and escaped in the log", async () => {
    const w = await world({
      commit: {
        kind: "refused",
        refusals: [
          { path: "a\u2028b.md", class: "protected-path" },
          { path: "CLAUDE\u202edm.md", class: "agent-config" },
        ],
        reverted: [],
      },
    });
    await w.run();
    expect(w.logs).toContain('PR step: write-check: refused "a\\u2028b.md" (protected-path)');
    expect(w.logs).toContain('PR step: write-check: refused "CLAUDE\\u202edm.md" (agent-config)');
    expect(w.logs.some((l) => /[\u2028\u202e]/.test(l))).toBe(false);
  });

  test("a CI fix (kind fix) refused: parked write-check, no push, no updatePr, no comment", async () => {
    const w = await world({ commit: REFUSED });
    const h0 = w.fake.control.makeCommit();
    expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: h0 }, opts())).ok).toBe(true);
    const opened = await w.fake.forge.openPr({ branch: BRANCH, base: "main", title: "old", body: "old" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const withPr = rec({ unit: UNIT, globs: ["src/s0/**"], pr: opened.value.number, pr_owner: "alice", head_sha: h0, base_sha: w.main });
    w.fake.control.writeForeignLedger({ message: "pr [skip ci]", writes: tip([withPr]), deletes: [] });
    const calls = w.calls.length;
    const out = await w.run({ record: withPr, kind: "fix" });
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(w.calls.slice(calls).filter((c) => c === "pushBranch" || c === "updatePr" || c === "openPr" || c === "comment")).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "write-check" }, head_sha: h0 });
    expect((await prs(w.fake))[0]?.head_sha).toBe(h0);
    expect(w.fake.control.comments(opened.value.number)).toEqual([]);
  });

  test("a committed outcome with an Epic context revert: the revert is noted, then push and PR as usual", async () => {
    const w = await world();
    const path = `${SPEC_DIR}/epic-1-context.md`;
    const committer: Committer = {
      commit: async (r) => ok({ kind: "committed", base_sha: r.ontoSha, head_sha: w.fake.control.makeCommit(), reverted: [path] }),
    };
    const out = await w.run({}, { committer });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.logs).toContain(`PR step: write-check: reverted ${path} (Epic context)`);
    expect(w.calls.filter((c) => c === "pushBranch" || c === "openPr")).toEqual(["pushBranch", "openPr"]);
    expect(await prs(w.fake)).toHaveLength(1);
  });

  test("refused, but the unit was lost before the park: failed, no ledger write by this lane, no push", async () => {
    const w = await world({ commit: REFUSED });
    const theirs = rec({ unit: UNIT, globs: ["src/s0/**"], generation: 2, owner: BOB.owner, host: BOB.host, lane: BOB.lane });
    w.fake.control.writeForeignLedger({ message: "takeover [skip ci]", writes: tip([theirs]), deletes: [] });
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(out.reason).toContain("park: unit lost");
    expect(w.fake.control.ledgerLog()).toHaveLength(before);
    expect(w.calls).not.toContain("pushBranch");
    expect(await w.ledger()).toEqual(theirs);
  });

  test("Epic context reverts are noted; a revert-only commit parks no-op as before", async () => {
    const w = await world({ commit: { kind: "empty", reverted: [`${SPEC_DIR}/epic-1-context.md`] } });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(w.logs).toContain(`PR step: write-check: reverted ${SPEC_DIR}/epic-1-context.md (Epic context)`);
    expect(await w.ledger()).toMatchObject({ park: { kind: "blocked", reason: "no-op" } });
  });

  test("the commit request carries the rules from fresh main: coordinator files, manifests, authority, spec and Story file", async () => {
    const w = await world();
    await w.run();
    expect(w.committer.requests[0]?.rules).toEqual({
      role: "builder",
      coordinatorFiles: [`${SPEC_DIR}/sprint-status.yaml`, `${SPEC_DIR}/retro-gates.yaml`, "_bmad-output/planning-artifacts/epics.md"],
      manifestsDir: "stories",
      standingAuthorityPath: AUTHORITY,
      protectedPaths: [],
      epicContextPath: `${SPEC_DIR}/epic-<N>-context.md`,
      liveEvidenceGlob: "docs/maintainer/evidence/epic-*.md",
      specPath: `${SPEC_DIR}/spec-1-1-first.md`,
      superseded: [],
      storyFile: "stories/1.1.md",
      infrastructureApproved: false,
    });
  });

  test("a re-run's superseded specs reach the rules, and their revert is noted as a superseded spec", async () => {
    const w = await world();
    const old = `${SPEC_DIR}/spec-1-1-old.md`;
    const context = `${SPEC_DIR}/epic-1-context.md`;
    const requests: CommitRequest[] = [];
    const committer: Committer = {
      commit: async (r) => {
        requests.push(r);
        return ok({ kind: "committed", base_sha: r.ontoSha, head_sha: w.fake.control.makeCommit(), reverted: [context, old] });
      },
    };
    const out = await w.run({ superseded: [old] }, { committer });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    const rules = requests[0]?.rules;
    expect(rules?.role === "builder" ? rules.superseded : undefined).toEqual([old]);
    expect(w.logs).toContain(`PR step: write-check: reverted ${old} (superseded spec)`);
    expect(w.logs).toContain(`PR step: write-check: reverted ${context} (Epic context)`);
  });

  test("the lane's credential is redacted from the PR title and body and the comment, and handed to the commit", async () => {
    const secret = "cred-0123456789-abcdefghij";
    const token = `sk-ant-oat01-${"A".repeat(40)}`;
    const w = await world();
    const out = await w.run(
      {
        unit: { ...STORY, title: `Story with ${secret}` },
        result: result({ summary: `Did it with ${secret}`, body: `Body holds ${secret} and ${token}.`, denied_actions: [`cat ${secret}`] }),
      },
      { secrets: [secret] },
    );
    expect(out.outcome).toBe("progress");
    expect(w.committer.requests[0]?.secrets).toEqual([secret]);
    const pr = (await prs(w.fake))[0];
    if (pr === undefined) throw new Error("no PR");
    const comment = w.fake.control.comments(pr.number).join("\n");
    for (const text of [pr.title, pr.body, comment]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(token);
      expect(text).toContain("[REDACTED]");
    }
  });

  test("a huge body is capped at 65,536 and ends with the marker; a long title at 256", async () => {
    const w = await world();
    const out = await w.run({ unit: { ...STORY, title: "t".repeat(400) }, result: result({ body: "b".repeat(70_000) }) });
    expect(out.outcome).toBe("progress");
    const pr = (await prs(w.fake))[0];
    if (pr === undefined) throw new Error("no PR");
    expect(pr.body.length).toBeLessThanOrEqual(65_536);
    expect(pr.body.endsWith("\n\n[truncated by xarabot]")).toBe(true);
    expect(pr.title.length).toBeLessThanOrEqual(256);
    expect(pr.title.endsWith("[truncated by xarabot]")).toBe(true);
  });

  describe("Infrastructure approval on the fresh snapshot", () => {
    const manifestSha = async (w: World): Promise<string> => {
      const s = await w.fake.forge.snapshot(opts());
      if (!s.ok) throw new Error(s.error.message);
      return s.value.main.blob_shas["stories/1.1.md"] as string;
    };
    const approvedRun = async (o: { readonly infrastructure: boolean; readonly approval: "match" | "other" | "none"; readonly mainMoved?: boolean }) => {
      const probe = await world();
      const sha = await manifestSha(probe);
      const approval = o.approval === "none" ? null : { by: "edanisko", manifest_sha: o.approval === "match" ? sha : "e".repeat(40) };
      const w = await world({ record: { approval } });
      if (o.mainMoved === true) {
        const files = mainFiles();
        files["stories/1.1.md"] = `${files["stories/1.1.md"] as string}\nEdited on main.\n`;
        w.fake.control.setMain(files);
      }
      await w.run({ unit: { ...STORY, infrastructure: o.infrastructure, manifest_sha: sha } });
      const rules = w.committer.requests[0]?.rules;
      return rules?.role === "builder" ? rules.infrastructureApproved : undefined;
    };

    test("approved: Infrastructure, the record's approval and main's manifest all match", async () => {
      expect(await approvedRun({ infrastructure: true, approval: "match" })).toBe(true);
    });
    test("not Infrastructure: never approved", async () => {
      expect(await approvedRun({ infrastructure: false, approval: "match" })).toBe(false);
    });
    test("no approval, or one for another manifest SHA: not approved", async () => {
      expect(await approvedRun({ infrastructure: true, approval: "none" })).toBe(false);
      expect(await approvedRun({ infrastructure: true, approval: "other" })).toBe(false);
    });
    test("stale: the manifest changed on main since the approval", async () => {
      expect(await approvedRun({ infrastructure: true, approval: "match", mainMoved: true })).toBe(false);
    });
  });

  test("a config that does not load stops before the commit", async () => {
    const w = await world({ authority: "missing" });
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(w.committer.requests).toHaveLength(0);
  });

  test("lost claim: another lane bumped the generation, so no push and no ledger edit", async () => {
    const w = await world();
    const theirs = rec({ unit: UNIT, globs: ["src/s0/**"], generation: 2, owner: BOB.owner, host: BOB.host, lane: BOB.lane });
    w.fake.control.writeForeignLedger({ message: "takeover [skip ci]", writes: tip([theirs]), deletes: [] });
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(out.reason).toContain("unit lost");
    expect(w.calls).not.toContain("pushBranch");
    expect(w.fake.control.ledgerLog()).toHaveLength(before);
    expect(await w.ledger()).toMatchObject({ generation: 2, owner: "bob" });
    expect(await prs(w.fake)).toEqual([]);
  });

  /** Another lane takes the record at generation + 1 right before swap `at`. */
  const takenAt = (w: World, at: number): (() => UnitRecord | null) => {
    let taken: UnitRecord | null = null;
    w.fake.control.beforeSwap(({ n }) => {
      if (n !== at) return;
      taken = { ...w.record, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2 };
      w.fake.control.writeForeignLedger({ message: "take [skip ci]", writes: tip([taken]), deletes: [] });
    });
    return () => taken;
  };

  test("lost before the push fence: no push, the branch unchanged, no PR", async () => {
    const w = await world();
    const taken = takenAt(w, 1);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(out.reason).toContain("fence: unit lost");
    expect(w.calls.filter((c) => c === "pushBranch" || c === "openPr" || c === "updatePr")).toEqual([]);
    const branch = await w.fake.forge.listPrsByBranch(BRANCH, opts());
    expect(branch.ok && branch.value).toEqual([]);
    expect(await w.ledger()).toEqual(taken() ?? undefined);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("take [skip ci]");
  });

  test("lost before the PR fence: pushed, but no openPr and no further edit", async () => {
    const w = await world();
    const taken = takenAt(w, 2);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(out.reason).toContain("fence: unit lost");
    expect(w.calls.filter((c) => c === "pushBranch" || c === "openPr" || c === "updatePr" || c === "comment")).toEqual(["pushBranch"]);
    expect(await prs(w.fake)).toEqual([]);
    expect(await w.ledger()).toEqual(taken() ?? undefined);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("take [skip ci]");
  });

  test("lost before the PR fence of an adopted PR: no updatePr, its title and body stay", async () => {
    const w = await world();
    const h0 = w.fake.control.makeCommit();
    expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: h0 }, opts())).ok).toBe(true);
    const opened = await w.fake.forge.openPr({ branch: BRANCH, base: "main", title: "old", body: "old" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const adopted = rec({ unit: UNIT, globs: ["src/s0/**"], pr: opened.value.number, pr_owner: "alice", head_sha: h0, base_sha: w.main });
    w.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([adopted]), deletes: [] });
    let taken: UnitRecord | null = null;
    w.fake.control.beforeSwap(({ n }) => {
      if (n !== 2) return;
      taken = { ...adopted, owner: BOB.owner, host: BOB.host, lane: BOB.lane, generation: 2 };
      w.fake.control.writeForeignLedger({ message: "take [skip ci]", writes: tip([taken]), deletes: [] });
    });
    const out = await w.run({ record: adopted });
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(w.calls).not.toContain("updatePr");
    expect((await prs(w.fake))[0]).toMatchObject({ title: "old", body: "old" });
    expect(await w.ledger()).toEqual(taken ?? undefined);
  });

  test("a fix leaves the PR text alone, so it has no PR fence: one fence, then the record", async () => {
    const w = await world();
    const h0 = w.fake.control.makeCommit();
    expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: h0 }, opts())).ok).toBe(true);
    const opened = await w.fake.forge.openPr({ branch: BRANCH, base: "main", title: "old", body: "old" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const withPr = rec({ unit: UNIT, globs: ["src/s0/**"], pr: opened.value.number, pr_owner: "alice", head_sha: h0, base_sha: w.main });
    w.fake.control.writeForeignLedger({ message: "pr [skip ci]", writes: tip([withPr]), deletes: [] });
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run({ record: withPr, kind: "fix" });
    expect(out.outcome).toBe("progress");
    expect(w.fake.control.ledgerLog().slice(before).map((c) => c.message)).toEqual([
      "ledger: heartbeat story:1.1 [skip ci]",
      "ledger: heartbeat story:1.1 [skip ci]",
    ]);
  });

  test.each(FORGE_ERROR_KINDS.filter(isLaneStopKind))("forge %s on pushBranch: alert forge-<kind> on fresh main and stop", async (kind) => {
    const w = await world();
    w.fake.control.injectError("pushBranch", { kind, message: "nope" } as ForgeError);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "stop", state: "claimed" });
    expect(w.fake.control.alerts()).toEqual([{ condition: `forge-${kind}`, main_sha: w.main }]);
    expect(await prs(w.fake)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "claimed", attempts: 0 });
  });

  test.each(FORGE_ERROR_KINDS.filter((k) => !isLaneStopKind(k)))("forge %s on pushBranch: a failed attempt, released, attempts + 1, no alert", async (kind) => {
    const w = await world();
    const error = (kind === "rate-limited" ? { kind, message: "slow", retry_after: 1 } : { kind, message: "nope" }) as ForgeError;
    w.fake.control.injectError("pushBranch", error);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain(`pushBranch ${kind}`);
    expect(w.fake.control.alerts()).toEqual([]);
    expect(await prs(w.fake)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("a push a repository rule refuses is rejected: a failed attempt, released, attempts + 1", async () => {
    const w = await world();
    w.fake.control.refusePushes(BRANCH);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("pushBranch rejected");
    expect(w.fake.control.alerts()).toEqual([]);
    expect(await prs(w.fake)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("forge auth on the snapshot: alert with 40 zeros and stop", async () => {
    const w = await world();
    w.fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(w.fake.control.alerts()).toEqual([{ condition: "forge-auth", main_sha: "0".repeat(40) }]);
    expect(w.committer.requests).toHaveLength(0);
  });

  test("a failed status comment is noted; the PR stays recorded and the outcome is progress", async () => {
    const w = await world();
    w.fake.control.injectError("comment", { kind: "transient", message: "down" });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(out.reason).toContain("status comment");
    const pr = (await prs(w.fake))[0];
    if (pr === undefined) throw new Error("no PR");
    expect(w.fake.control.comments(pr.number)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ pr: pr.number, head_sha: pr.head_sha });
    expect(w.logs.some((l) => l.includes("status comment failed"))).toBe(true);
  });

  test("budget: a signal aborted before the push means no push and a release", async () => {
    const w = await world();
    const ctl = new AbortController();
    ctl.abort();
    const out = await w.run({ signal: ctl.signal });
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("budget");
    expect(w.committer.requests).toHaveLength(0);
    expect(w.calls).not.toContain("pushBranch");
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("ledger times are the forge's now plus the host time since the snapshot", async () => {
    const w = await world();
    let host = Date.parse("2001-01-01T00:00:00Z");
    const out = await w.run({}, { now: () => (host += 5000) });
    expect(out.outcome).toBe("progress");
    // Clock reads: the snapshot, the push fence, the PR fence, then the record heartbeat.
    expect((await w.ledger())?.heartbeat_at).toBe("2026-10-23T10:00:15.000Z");
  });

  test("an unknown schema_version found by the fence alerts ledger-schema-version and stops", async () => {
    const w = await world();
    const v2 = JSON.stringify({ ...w.record, schema_version: 5 });
    w.fake.control.writeForeignLedger({ message: "future [skip ci]", writes: { "units/story__1.1.json": v2 }, deletes: [] });
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(w.fake.control.alerts()).toEqual([{ condition: "ledger-schema-version", main_sha: w.main }]);
    expect(w.calls).not.toContain("pushBranch");
  });

  test("an openPr failure is a failed attempt", async () => {
    const w = await world();
    w.fake.control.injectError("openPr", { kind: "transient", message: "down" });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("openPr transient");
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("the attempts cap parks the unit on a failed attempt", async () => {
    const w = await world({ record: { attempts: 2 }, commit: { kind: "conflict", paths: ["a"] } });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "parked" });
    expect(await w.ledger()).toMatchObject({ state: "parked", attempts: 3, park: { reason: "attempts-cap" } });
  });
});

// -------------------------------------------------------------- end to end

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };

function writeIn(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

type EndToEndHooks = {
  /** Runs before the lane process starts. */
  readonly before?: (fake: FakeForge) => Promise<void> | void;
  /** Runs inside the session, after the claim and before the PR step. */
  readonly during?: (fake: FakeForge) => void;
  /** The stub committer's outcome; default a fresh commit. */
  readonly commit?: CommitOutcome;
};

async function endToEnd(
  deniedActions: readonly string[],
  hooks: EndToEndHooks = {},
): Promise<{ fake: FakeForge; journal: UnitJournalRecord; outcome: string }> {
  const root = mkdtempSync(join(tmpdir(), "xarabot-prstep-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles() });

  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (_unit, settings, resultPath) =>
      ok({
        argv: ["stub-agent", settings.effort, resultPath],
        stdin: "",
        vendor: "claude",
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
      } as AgentLaunchSpec),
    parseUsage: () => ({ sessionId: null, model: "claude-opus-5-5", tokens: null, cost: null, usageLimit: null }),
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
  };
  const sandbox: Sandbox = {
    async run(_spec, profile) {
      hooks.during?.(fake);
      writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-first.md`, "---\ntitle: 'Story'\nstatus: 'done'\n---\n\n# Story\n\n## Auto Run Result\n\nStatus: done\n");
      writeFileSync(
        profile.resultPath,
        JSON.stringify({ kind: "build", outcome: "done", summary: "Did it", body: "", verification: ["bun test"], denied_actions: deniedActions }),
      );
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };
  const workspace: Workspace = {
    async prepare(p) {
      const clone = join(laneDir, "clone");
      rmSync(clone, { recursive: true, force: true });
      writeIn(clone, "README.md", "hello\n");
      return ok({ sha: p.start, resumed: false });
    },
  };
  const prStep = createPrStep({
    forge: fake.forge,
    committer: stubCommitter(fake, hooks.commit),
    identity: ALICE,
    repo: LANE.repo,
    sleep: async () => {},
    random: () => 0,
  });
  await hooks.before?.(fake);
  const r = await runLaneProcess({
    forge: fake.forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop: join(root, "home", ".xarabot", "STOP") }),
    workspace,
    prStep,
    laneDir,
    identity: ALICE,
    lane: LANE,
    pid: 12345,
    sleep: async () => {},
    random: () => 0,
    waiter: { wait: async () => ({ end: "elapsed" as const }) },
  });
  const path = join(laneDir, "journal.jsonl");
  const records = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as JournalRecord)
    : [];
  const units = records.filter((x): x is UnitJournalRecord => x.type === "unit");
  expect(units).toHaveLength(1);
  return { fake, journal: units[0] as UnitJournalRecord, outcome: r.outcome };
}

async function ledgerRecord(fake: FakeForge): Promise<UnitRecord | undefined> {
  const snap = await fake.forge.snapshot(opts());
  if (!snap.ok) throw new Error(snap.error.message);
  const l = parseLedger(snap.value.ledger.files);
  if (!l.ok) throw new Error(l.error.message);
  return l.value.units.get(UNIT);
}

describe("runLaneProcess with createPrStep", () => {
  test("a lease conflict: the journal carries the step's record and reason", async () => {
    const { fake, journal, outcome } = await endToEnd([], {
      before: (f) => f.control.injectError("pushBranch", { kind: "conflict", message: `pushBranch: ${BRANCH} is at another SHA` }),
    });
    expect(outcome).toBe("failed");
    expect(journal).toMatchObject({ outcome: "failed", state: "released", attempts: 1 });
    expect(journal.reason).toContain("pushBranch conflict");
    expect(await prs(fake)).toEqual([]);
  });

  test("a re-claim with a stale branch and a closed PR: the push leases from the branch's head, the PR opens, no conflict (Story 2.6b)", async () => {
    let stale = "";
    let closed = 0;
    const { fake, journal, outcome } = await endToEnd([], {
      before: async (f) => {
        stale = f.control.makeCommit();
        expect((await f.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: stale }, opts())).ok).toBe(true);
        const opened = await f.forge.openPr({ branch: BRANCH, base: "main", title: "old", body: "old" }, opts());
        if (!opened.ok) throw new Error(opened.error.message);
        closed = opened.value.number;
        expect((await f.forge.closePr(closed, opts())).ok).toBe(true);
        const released = rec({ unit: UNIT, state: "released", attempts: 1, globs: ["src/s0/**"], pr: closed, pr_owner: "alice", head_sha: stale, owner: BOB.owner, host: BOB.host, lane: BOB.lane });
        f.control.writeForeignLedger({ message: "released [skip ci]", writes: tip([released]), deletes: [] });
      },
    });
    expect(outcome).toBe("progress");
    expect(journal).toMatchObject({ outcome: "progress", state: "claimed", generation: 2 });
    expect(journal.reason ?? "").not.toContain("conflict");
    const list = await prs(fake);
    expect(list.map((p) => [p.number, p.state])).toEqual([
      [closed, "closed"],
      [closed + 1, "open"],
    ]);
    const head = list[1]?.head_sha;
    expect(head).not.toBe(stale);
    const branch = await fake.forge.branchHead(BRANCH, opts());
    expect(branch).toEqual({ ok: true, value: head ?? null });
    expect(await ledgerRecord(fake)).toMatchObject({ state: "claimed", pr: closed + 1, head_sha: head });
    expect(readFileSync(journal.log, "utf8")).toContain(`${BRANCH} is at ${stale}: the push leases from it`);
  });

  test("a write-check refusal: the journal and unit log name each path; parked write-check, nothing pushed", async () => {
    const { fake, journal, outcome } = await endToEnd([], { commit: REFUSED });
    expect(outcome).toBe("progress");
    expect(journal).toMatchObject({ outcome: "progress", state: "parked" });
    expect(journal.reason).toContain(".claude/settings.json (agent-config)");
    expect(journal.reason).toContain(`${SPEC_DIR}/sprint-status.yaml (coordinator-file)`);
    const log = readFileSync(journal.log, "utf8");
    expect(log).toContain("write-check: refused .claude/settings.json (agent-config)");
    expect(log).toContain(`write-check: refused ${SPEC_DIR}/sprint-status.yaml (coordinator-file)`);
    expect(await prs(fake)).toEqual([]);
    expect(await ledgerRecord(fake)).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "write-check" }, pr: null, head_sha: null });
  });

  test("the Standing Authority removed after the claim: stop, no PR, the record still claimed", async () => {
    const { fake, journal, outcome } = await endToEnd([], {
      during: (f) => {
        const files = mainFiles();
        delete files[AUTHORITY];
        f.control.setMain(files);
      },
    });
    expect(outcome).toBe("stop");
    expect(journal).toMatchObject({ outcome: "stop", state: "claimed" });
    expect(await prs(fake)).toEqual([]);
    expect(await ledgerRecord(fake)).toMatchObject({ state: "claimed", pr: null });
  });

  test("happy path: one open PR on story/1.1 whose head is the commit, recorded in the ledger and journal", async () => {
    const { fake, journal, outcome } = await endToEnd([]);
    expect(outcome).toBe("progress");
    const list = await prs(fake);
    expect(list).toHaveLength(1);
    const pr = list[0];
    if (pr === undefined) throw new Error("no PR");
    expect(pr.state).toBe("open");
    const snap = await fake.forge.snapshot(opts());
    if (!snap.ok) throw new Error(snap.error.message);
    const l = parseLedger(snap.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    expect(l.value.units.get(UNIT)).toMatchObject({
      state: "claimed",
      pr: pr.number,
      pr_owner: "alice",
      head_sha: pr.head_sha,
      base_sha: snap.value.main.sha,
    });
    expect(journal).toMatchObject({ outcome: "progress", state: "claimed", result: "done", generation: 1 });
    expect(fake.control.comments(pr.number)[0]).toContain("Denied actions: none.");
    expect(readFileSync(journal.log, "utf8")).toContain("PR step: opened PR #");
  });

  test("denied actions land in both the journal and the status comment", async () => {
    const { fake, journal } = await endToEnd(["git push", "@bob rm"]);
    expect(journal.denied_actions).toEqual(["git push", "@bob rm"]);
    const pr = (await prs(fake))[0];
    if (pr === undefined) throw new Error("no PR");
    expect(fake.control.comments(pr.number)[0]).toContain("Denied actions:\n- git push\n- bob rm\n");
  });
});
