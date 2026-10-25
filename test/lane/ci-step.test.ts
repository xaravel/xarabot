import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { NextStory } from "../../src/core/next/next.ts";
import { err, ok, type Result } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { BuildResult } from "../../src/core/schemas/session-result.ts";
import {
  ciLogText,
  conflictLogText,
  createCiStep,
  mergeComment,
  type CiSessionDone,
  type CiSessionRequest,
  type CiStepDeps,
  type CiStepInput,
  type CiUnit,
  type RegenerateRequest,
} from "../../src/lane/ci-step.ts";
import type { CommitOutcome } from "../../src/lane/commit.ts";
import type { CommitRequest, Committer } from "../../src/lane/committer.ts";
import { CI_FIX_LOG, runLaneProcess, type PrStepInput, type PrStepOutput, type SessionLimits } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { MergeOutcome, MergeRequest, Merger } from "../../src/lane/merger.ts";
import { createPrStep } from "../../src/lane/pr-step.ts";
import type { PrepareParams, Workspace } from "../../src/lane/workspace.ts";
import type { Agent, AgentLaunchSpec, AgentUnit } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck, ForgeError, ForgeOperation } from "../../src/ports/forge.ts";
import type { LaunchSpec, Sandbox } from "../../src/ports/sandbox.ts";
import { ALICE, BOB, rec, tip } from "../core/ledger/fixtures.ts";

// ------------------------------------------------------------------ world

const AUTHORITY = "docs/standing-authority.md";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const STATUS = `${SPEC_DIR}/sprint-status.yaml`;
const RETRO = `${SPEC_DIR}/retro-gates.yaml`;
const UNIT = "story:1.1";
const BRANCH = "story/1.1";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const opts = () => ({ signal: AbortSignal.timeout(5000) });

type MainOpts = {
  readonly authority?: boolean;
  readonly expected?: readonly string[];
  readonly lockfileCommand?: readonly string[];
  readonly budgetHours?: number;
};

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const config = [
    "schema_version: 1",
    'runner_version: "0.1.0"',
    "maintainer: edanisko",
    `standing_authority_path: ${AUTHORITY}`,
    "manifests:",
    "  dir: stories",
    "proxy_hosts: [files.pythonhosted.org]",
  ];
  if (o.lockfileCommand !== undefined) config.push(`lockfile_command: ${JSON.stringify(o.lockfileCommand)}`);
  if (o.budgetHours !== undefined) config.push(`unit_budget_hours: ${o.budgetHours}`);
  const policy = ["schema_version: 1"];
  if (o.expected !== undefined) policy.push(`expected_checks: ${JSON.stringify(o.expected)}`);
  const files: Record<string, string> = {
    ".xarabot/config.yaml": `${config.join("\n")}\n`,
    ".xarabot/policy.yaml": `${policy.join("\n")}\n`,
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    "_bmad-output/planning-artifacts/epics.md": "# Epics\n\n## Epic 1: One\n\n### Story 1.1: Story 1.1\n\nBody.\n",
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    [STATUS]: "development_status:\n  epic-1: in-progress\n  1-1-first: backlog\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: Story 1.1\nglobs: ["src/s0/**"]\n---\n',
  };
  if (o.authority !== false) {
    files[AUTHORITY] = "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-09-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n";
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

/** The Story as the CI step names it. */
const CI_UNIT: CiUnit = { unit: UNIT, subject: "Story 1.1", branch: (c) => `${c.branches.story}1.1`, needsSpec: true };

function buildResult(outcome: BuildResult["outcome"] = "done"): BuildResult {
  const base = { kind: "build" as const, summary: "Fixed it", body: "", verification: ["bun test"], denied_actions: [] };
  if (outcome === "blocked") return { ...base, outcome, blocked: { kind: "verification", text: "tests cannot run" } };
  return { ...base, outcome };
}

const success = (name: string): ForgeCheck => ({ name, status: "completed", conclusion: "success" });
const failure = (name: string): ForgeCheck => ({ name, status: "completed", conclusion: "failure" });
const running = (name: string): ForgeCheck => ({ name, status: "in_progress", conclusion: null });

type Script = (readonly ForgeCheck[] | ForgeError)[];

/** The fake forge with `checks` answered from a script in call order (the last answer repeats), recording each SHA asked and each call. */
function scripted(fake: FakeForge, script: Script): { forge: Forge; asked: string[]; calls: ForgeOperation[] } {
  const asked: string[] = [];
  const calls: ForgeOperation[] = [];
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(fake.forge)) {
    out[name] = (...args: unknown[]) => {
      calls.push(name as ForgeOperation);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  out["checks"] = async (sha: string) => {
    calls.push("checks");
    asked.push(sha);
    const next = script.length > 1 ? script.shift() : script[0];
    if (next === undefined) return ok({ checks: [success("test")] });
    if ("kind" in next && !Array.isArray(next)) return { ok: false, error: next };
    // The fake's prefetch reads the same checks.
    fake.control.setChecks(sha, next as readonly ForgeCheck[]);
    return ok({ checks: next as readonly ForgeCheck[] });
  };
  return { forge: out as Forge, asked, calls };
}

type Clock = { now: () => number; sleeps: number[]; sleep: (ms: number, signal: AbortSignal) => Promise<void> };

/** A host clock that only moves when the step sleeps. */
function clock(): Clock {
  let t = T0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms) => {
      if (ms > 0) sleeps.push(ms);
      t += ms;
    },
  };
}

function stubMerger(outcomes: (MergeOutcome | "error")[]): Merger & { requests: MergeRequest[] } {
  const requests: MergeRequest[] = [];
  return {
    requests,
    async merge(r) {
      requests.push(r);
      const o = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
      if (o === undefined) return ok({ kind: "up-to-date" });
      if (o === "error") return err("git", "boom");
      return ok(o);
    },
  };
}

/** A committer giving a fresh head on `ontoSha`, after the scripted `first` outcomes in call order. */
function committer(fake: FakeForge, first: CommitOutcome[] = [], requests: CommitRequest[] = []): Committer {
  return {
    commit: async (r) => {
      requests.push(r);
      return ok(first.shift() ?? { kind: "committed", base_sha: r.ontoSha, head_sha: fake.control.makeCommit() });
    },
  };
}

type SessionReply = Result<CiSessionDone> | "throw";

type World = {
  readonly fake: FakeForge;
  readonly asked: string[];
  readonly calls: ForgeOperation[];
  readonly clock: Clock;
  readonly merger: ReturnType<typeof stubMerger>;
  readonly sessions: CiSessionRequest[];
  readonly regenerations: RegenerateRequest[];
  readonly prSteps: PrStepInput[];
  readonly record: UnitRecord;
  readonly head: string;
  readonly pr: number;
  readonly main: string;
  readonly logs: string[];
  run(input?: Partial<CiStepInput>, deps?: Partial<CiStepDeps>): Promise<PrStepOutput>;
  ledger(): Promise<UnitRecord | undefined>;
};

type WorldOpts = MainOpts & {
  readonly checks?: Script;
  readonly merges?: (MergeOutcome | "error")[];
  readonly sessions?: SessionReply[];
  readonly regenerate?: Result<Readonly<Record<string, string>>>;
  readonly record?: Partial<UnitRecord>;
  readonly scratch?: string;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xarabot-ci-"));
  dirs.push(d);
  return d;
}

async function world(o: WorldOpts = {}): Promise<World> {
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o) });
  const s = await fake.forge.snapshot(opts());
  if (!s.ok) throw new Error(s.error.message);
  const main = s.value.main.sha;
  const head = fake.control.makeCommit();
  expect((await fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts())).ok).toBe(true);
  const opened = await fake.forge.openPr({ branch: BRANCH, base: "main", title: "Story 1.1: Story 1.1", body: "Did it" }, opts());
  if (!opened.ok) throw new Error(opened.error.message);
  const pr = opened.value.number;
  const record = rec({ unit: UNIT, globs: ["src/s0/**"], pr, pr_owner: "alice", head_sha: head, base_sha: main, ...o.record });
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([record]), deletes: [] });

  const spied = scripted(fake, [...(o.checks ?? [[success("test")]])]);
  const c = clock();
  const merger = stubMerger([...(o.merges ?? [{ kind: "up-to-date" }])]);
  const sessions: CiSessionRequest[] = [];
  const regenerations: RegenerateRequest[] = [];
  const prSteps: PrStepInput[] = [];
  const replies = [...(o.sessions ?? [ok({ result: buildResult(), specPath: `${SPEC_DIR}/spec-1-1-first.md`, superseded: [] })])];
  const logs: string[] = [];
  const realPrStep = createPrStep({ forge: spied.forge, committer: committer(fake), identity: ALICE, repo: "xaravel/xarabot", sleep: async () => {}, random: () => 0 });
  const scratch = o.scratch ?? join(tempDir(), "scratch");

  const w: World = {
    fake,
    asked: spied.asked,
    calls: spied.calls,
    clock: c,
    merger,
    sessions,
    regenerations,
    prSteps,
    record,
    head,
    pr,
    main,
    logs,
    run: (input = {}, deps = {}) =>
      createCiStep({ forge: spied.forge, merger, identity: ALICE, repo: "xaravel/xarabot", now: c.now, sleep: c.sleep, random: () => 0, ...deps })({
        unit: CI_UNIT,
        record,
        clone: "/nonexistent/clone",
        signal: AbortSignal.timeout(60_000),
        log: (t) => logs.push(t),
        scratchDir: scratch,
        // The lane process's own: the fix through the Story's PR step.
        pushFix: async (f) => {
          const i: PrStepInput = {
            unit: STORY,
            record: f.record,
            result: f.result,
            specPath: f.specPath ?? "",
            superseded: f.superseded,
            clone: "/nonexistent/clone",
            signal: AbortSignal.timeout(60_000),
            log: (t) => logs.push(t),
            kind: "fix",
          };
          prSteps.push(i);
          return realPrStep(i);
        },
        session: async (r) => {
          sessions.push(r);
          const reply = replies.length > 1 ? replies.shift() : replies[0];
          if (reply === "throw") throw new Error("session blew up");
          return reply ?? err("session", "no reply");
        },
        regenerate: async (r) => {
          regenerations.push(r);
          return o.regenerate ?? ok({ "bun.lock": "regenerated\n" });
        },
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
  return w;
}

// -------------------------------------------------------------- texts

describe("ciLogText and conflictLogText", () => {
  test("the CI log names the failing checks, then each file under a header", () => {
    const text = ciLogText({ sha: "a".repeat(40), failing: ["lint", "test"], files: [{ path: "/x/lint.log", text: "lint broke\n" }] });
    expect(text).toContain("These checks failed unexpectedly: lint, test.");
    expect(text).toContain("## lint.log\n\n```text\nlint broke\n```");
    expect(text.indexOf("lint, test")).toBeLessThan(text.indexOf("## lint.log"));
  });

  test("the conflict log lists the paths and says the clone is main merged into the PR", () => {
    const text = conflictLogText({ mainSha: "m".repeat(40), headSha: "h".repeat(40), paths: ["src/a.ts", "src/b.ts"] });
    expect(text).toContain(`The clone is main (${"m".repeat(40)}) merged into this Story's PR`);
    expect(conflictLogText({ mainSha: "m".repeat(40), headSha: "h".repeat(40), paths: [], subject: "Story 1.1" })).toContain("merged into this Story's PR");
    expect(conflictLogText({ mainSha: "m".repeat(40), headSha: "h".repeat(40), paths: [], subject: "Unit retro-item:x" })).toContain("merged into this unit's PR");
    expect(text).toContain("conflict markers");
    expect(text).toContain("- src/a.ts\n- src/b.ts\n");
    expect(text).not.toContain("lockfiles conflicted");
  });

  test("the merge comment is capped at the comment limit", () => {
    const text = mergeComment({ subject: "Story 1.1", mainSha: "m".repeat(40), headSha: "h".repeat(40), resolved: Array.from({ length: 5000 }, (_, i) => `path/${i}/${"r".repeat(20)}`) });
    expect(text.length).toBe(65_536);
    expect(text.endsWith("\n\n[truncated by xarabot]")).toBe(true);
  });

  test("lockfiles are listed apart: main's version, no markers, regenerate them", () => {
    const text = conflictLogText({ mainSha: "m".repeat(40), headSha: "h".repeat(40), paths: [], lockfiles: ["bun.lock"] });
    expect(text).not.toContain("hold conflict markers");
    expect(text).toContain("Each now holds main's version, with no conflict markers, so the PR's changes to it were dropped:\n\n- bun.lock\n");
    expect(text).toContain("Regenerate each one");
  });
});

// -------------------------------------------------------------- the matrix

describe("createCiStep", () => {
  test("empty then pass: sleeps 30 s, then progress, claimed", async () => {
    const w = await world({ checks: [[], [success("lint"), success("test")]] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.clock.sleeps).toEqual([30_000]);
    expect(w.asked).toEqual([w.head, w.head]);
    expect(w.merger.requests).toHaveLength(1);
    expect(w.merger.requests[0]).toMatchObject({ unit: UNIT, headSha: w.head, mainSha: w.main, statusPaths: [STATUS, RETRO] });
    expect(w.sessions).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "claimed", head_sha: w.head, ci_fixes: 0 });
  });

  test("back-off: six pending polls sleep 30, 60, 120, 240, 300, 300 s", async () => {
    const pending = [running("test")];
    const w = await world({ checks: [pending, pending, pending, pending, pending, pending, [success("test")]] });
    const out = await w.run();
    expect(out.outcome).toBe("progress");
    expect(w.clock.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  test("an expected failure is ignored: passed", async () => {
    const w = await world({ expected: ["protected-paths"], checks: [[failure("protected-paths"), success("test")]] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.sessions).toEqual([]);
  });

  test("first unexpected failure: a CI fix at once; ci_fixes 1; the log names lint; the fix is pushed and the new head passes", async () => {
    const w = await world({ checks: [[failure("lint"), running("test")], [success("lint"), success("test")]] });
    w.fake.control.setChecks(w.head, [failure("lint"), running("test")]);
    w.fake.control.setCiLog(w.head, "lint", "src/a.ts:1 unused import\n");
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.clock.sleeps).toEqual([]);
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.start).toBe(w.head);
    expect(w.sessions[0]?.logText).toContain("These checks failed unexpectedly: lint.");
    expect(w.sessions[0]?.logText).toContain("## lint.log");
    expect(w.sessions[0]?.logText).toContain("src/a.ts:1 unused import");
    expect(w.prSteps).toHaveLength(1);
    expect(w.prSteps[0]?.kind).toBe("fix");
    expect(w.prSteps[0]?.record.ci_fixes).toBe(1);
    expect(w.prSteps[0]?.record.head_sha).toBe(w.head);
    const after = await w.ledger();
    expect(after).toMatchObject({ state: "claimed", ci_fixes: 1, attempts: 0, loopbacks: 0 });
    expect(after?.head_sha).not.toBe(w.head);
    // The next round polls the new head.
    expect(w.asked).toEqual([w.head, after?.head_sha as string]);
    expect(w.calls).not.toContain("updatePr");
    expect(w.merger.requests.map((r) => r.headSha)).toEqual([w.head, after?.head_sha as string]);
  });

  test("fix cap: ci_fixes 2 and CI fails: parked ci-fix-cap, no session", async () => {
    const w = await world({ record: { ci_fixes: 2 }, checks: [[failure("lint")]] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(w.sessions).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "ci-fix-cap" } });
  });

  test("max wait: pending past 60 min parks blocked ci-timeout", async () => {
    const w = await world({ checks: [[running("test")]] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(await w.ledger()).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "ci-timeout" } });
    const total = w.clock.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(60 * 60_000);
    expect(total - (w.clock.sleeps.at(-1) ?? 0)).toBeLessThan(60 * 60_000);
  });

  test("status conflict: merged is pushed leased on the old head, recorded, commented, and the new head polled", async () => {
    const fakeHead = "9".repeat(40);
    const w = await world({ merges: [{ kind: "merged", head_sha: fakeHead, resolved: [STATUS] }] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    const list = await w.fake.forge.listPrsByBranch(BRANCH, opts());
    if (!list.ok) throw new Error(list.error.message);
    expect(list.value[0]?.head_sha).toBe(fakeHead);
    expect(await w.ledger()).toMatchObject({ head_sha: fakeHead, base_sha: w.main, ci_fixes: 0 });
    const comments = w.fake.control.comments(w.pr);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.startsWith("🤖")).toBe(true);
    expect(comments[0]).toContain(`merged main ${w.main.slice(0, 7)}`);
    expect(w.asked).toEqual([fakeHead]);
  });

  test("lockfile with a command: regenerate at the candidate, merge again with the texts, push", async () => {
    const candidate = "c".repeat(40);
    const merged = "d".repeat(40);
    const w = await world({
      lockfileCommand: ["bun", "install"],
      merges: [
        { kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] },
        { kind: "merged", head_sha: merged, resolved: [STATUS, "bun.lock"] },
      ],
    });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.regenerations).toEqual([{ start: candidate, paths: ["bun.lock"], command: ["bun", "install"] }]);
    expect(w.merger.requests).toHaveLength(2);
    expect(w.merger.requests[1]?.lockfiles).toEqual({ "bun.lock": "regenerated\n" });
    expect(await w.ledger()).toMatchObject({ head_sha: merged, ci_fixes: 0 });
    expect(w.sessions).toEqual([]);
  });

  test("lockfile with a command whose regeneration fails: a conflict session", async () => {
    const candidate = "c".repeat(40);
    const w = await world({
      lockfileCommand: ["bun", "install"],
      merges: [{ kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] }, { kind: "up-to-date" }],
      regenerate: err("exit", "exited 1"),
    });
    const out = await w.run();
    expect(out.outcome).toBe("progress");
    expect(w.sessions[0]?.start).toBe(candidate);
    expect(w.sessions[0]?.logText).not.toContain("hold conflict markers");
    expect(w.sessions[0]?.logText).toContain("main's version, with no conflict markers");
    expect(await w.ledger()).toMatchObject({ ci_fixes: 1 });
  });

  test("lockfile with no command: a conflict session; ci_fixes + 1", async () => {
    const candidate = "c".repeat(40);
    const w = await world({ merges: [{ kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] }, { kind: "up-to-date" }] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.regenerations).toEqual([]);
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.start).toBe(candidate);
    expect(w.sessions[0]?.logText).toContain("- bun.lock");
    expect(w.sessions[0]?.logText).not.toContain("hold conflict markers");
    expect(w.sessions[0]?.logText).toContain("main's version, with no conflict markers");
    expect(await w.ledger()).toMatchObject({ ci_fixes: 1 });
  });

  test("other conflict: a session at the candidate; ci_fixes + 1; attempts and loopbacks unchanged", async () => {
    const candidate = "c".repeat(40);
    const w = await world({ merges: [{ kind: "needs-session", candidate_sha: candidate, paths: ["src/a.ts"], lockfiles: ["bun.lock"] }, { kind: "up-to-date" }] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.sessions[0]?.start).toBe(candidate);
    expect(w.sessions[0]?.logText).toContain("main (");
    expect(w.sessions[0]?.logText).toContain("hold conflict markers:\n\n- src/a.ts\n");
    expect(w.sessions[0]?.logText).toContain("main's version, with no conflict markers, so the PR's changes to it were dropped:\n\n- bun.lock\n");
    expect(w.prSteps[0]?.kind).toBe("fix");
    expect(await w.ledger()).toMatchObject({ state: "claimed", ci_fixes: 1, attempts: 0, loopbacks: 0 });
  });

  test("conflict at cap: parked ci-fix-cap", async () => {
    const w = await world({ record: { ci_fixes: 2 }, merges: [{ kind: "needs-session", candidate_sha: "c".repeat(40), paths: ["src/a.ts"], lockfiles: [] }] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(w.sessions).toEqual([]);
    expect(await w.ledger()).toMatchObject({ park: { reason: "ci-fix-cap" } });
  });

  test("poll transient and rate-limited replies count as pending", async () => {
    const w = await world({
      checks: [{ kind: "transient", message: "502" }, { kind: "rate-limited", message: "slow down", retry_after: 600 }, [success("test")]],
    });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.clock.sleeps).toEqual([30_000, 600_000]);
  });

  test("forge stop: checks forbidden alerts forge-forbidden and stops", async () => {
    const w = await world({ checks: [{ kind: "forbidden", message: "checks: read missing" }] });
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(w.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-forbidden"]);
    expect(await w.ledger()).toMatchObject({ state: "claimed" });
  });

  test("Standing Authority revoked on fresh main: stop with no merge, no poll, no ledger edit", async () => {
    const w = await world();
    w.fake.control.setMain(mainFiles({ authority: false }));
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "stop", state: "claimed" });
    expect(w.merger.requests).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(w.calls).not.toContain("pushBranch");
    expect(w.fake.control.ledgerLog()).toHaveLength(before);
  });

  test("session fails: released, attempts + 1", async () => {
    const w = await world({ checks: [[failure("lint")]], sessions: [err("session", "no result")] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1, ci_fixes: 1 });
  });

  test("a session that throws is a failed attempt", async () => {
    const w = await world({ checks: [[failure("lint")]], sessions: ["throw"] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
  });

  test("fix blocked: parked blocked verification", async () => {
    const w = await world({ checks: [[failure("lint")]], sessions: [ok({ result: buildResult("blocked"), specPath: null, superseded: [] })] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(await w.ledger()).toMatchObject({ park: { kind: "blocked", reason: "verification" } });
    expect(w.prSteps).toEqual([]);
  });

  test("a done fix hands its spec and superseded specs to the PR step", async () => {
    const old = `${SPEC_DIR}/spec-1-1-old.md`;
    const w = await world({
      checks: [[failure("lint")], [success("lint")]],
      sessions: [ok({ result: buildResult(), specPath: `${SPEC_DIR}/spec-1-1-first.md`, superseded: [old] })],
    });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.prSteps).toHaveLength(1);
    expect(w.prSteps[0]).toMatchObject({ kind: "fix", specPath: `${SPEC_DIR}/spec-1-1-first.md`, superseded: [old] });
  });

  test("a done fix with no spec file is a failed attempt, with no PR step", async () => {
    const w = await world({ checks: [[failure("lint")]], sessions: [ok({ result: buildResult(), specPath: null, superseded: [] })] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("no spec file");
    expect(w.prSteps).toEqual([]);
  });

  test("a unit that needs no spec file (a retro item): a done fix with none is pushed, and the merge names the unit", async () => {
    const unit: CiUnit = { unit: UNIT, subject: "Unit retro-item:epic-1-retro-item-1-x", branch: () => BRANCH, needsSpec: false };
    const w = await world({ checks: [[failure("lint")], [success("lint")]], sessions: [ok({ result: buildResult(), specPath: null, superseded: [] })] });
    const out = await w.run({ unit });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(w.prSteps).toHaveLength(1);
    expect(w.merger.requests[0]?.message).toBe(`Merge main ${w.main} into the PR for Unit retro-item:epic-1-retro-item-1-x`);
  });

  test("a conflict session's log names the unit's PR", async () => {
    const unit: CiUnit = { unit: UNIT, subject: "Unit retro-item:epic-1-retro-item-1-x", branch: () => BRANCH, needsSpec: false };
    const w = await world({ merges: [{ kind: "needs-session", candidate_sha: "c".repeat(40), paths: ["src/a.ts"], lockfiles: [] }, { kind: "up-to-date" }], sessions: [ok({ result: buildResult("no-op"), specPath: null, superseded: [] })] });
    await w.run({ unit });
    expect(w.sessions[0]?.logText).toContain("merged into this unit's PR");
  });

  test("fix no-op: parked blocked no-op", async () => {
    const w = await world({ checks: [[failure("lint")]], sessions: [ok({ result: buildResult("no-op"), specPath: null, superseded: [] })] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(await w.ledger()).toMatchObject({ park: { kind: "blocked", reason: "no-op" } });
  });

  test("merge push lease conflict: released, attempts + 1", async () => {
    const w = await world({ merges: [{ kind: "merged", head_sha: "9".repeat(40), resolved: [STATUS] }] });
    w.fake.control.injectError("pushBranch", { kind: "conflict", message: "moved" });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
    expect(w.asked).toEqual([]);
  });

  test("a merger error is a failed attempt", async () => {
    const w = await world({ merges: ["error"] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
  });

  test("a checks not-found is a failed attempt", async () => {
    const w = await world({ checks: [{ kind: "not-found", message: "no such sha" }] });
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
  });

  test("a lost fence ends failed with no further edit", async () => {
    const w = await world({ merges: [{ kind: "merged", head_sha: "9".repeat(40), resolved: [STATUS] }] });
    // Another writer bumps the generation before the fence.
    w.fake.control.writeForeignLedger({ message: "take [skip ci]", writes: tip([{ ...w.record, generation: 2 }]), deletes: [] });
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(w.fake.control.ledgerLog()).toHaveLength(before);
    expect(w.calls).not.toContain("pushBranch");
  });

  /** The PR branch's head on the fake. */
  const branchHead = async (w: World): Promise<string | undefined> => {
    const list = await w.fake.forge.listPrsByBranch(BRANCH, opts());
    if (!list.ok) throw new Error(list.error.message);
    return list.value.at(-1)?.head_sha;
  };

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

  test("another lane takes the record before the merge push's fence: no push, the branch unchanged, no further edit", async () => {
    const w = await world({ merges: [{ kind: "merged", head_sha: "9".repeat(40), resolved: [STATUS] }] });
    const taken = takenAt(w, 1);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(out.reason).toContain("unit lost");
    expect(w.calls).not.toContain("pushBranch");
    expect(await branchHead(w)).toBe(w.head);
    expect(await w.ledger()).toEqual(taken() ?? undefined);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("take [skip ci]");
  });

  test("another lane takes the record before a CI fix's push fence: no push, the branch unchanged, no updatePr", async () => {
    const w = await world({ checks: [[failure("lint")]] });
    w.fake.control.setCiLog(w.head, "lint", "lint failed\n");
    // Swap 1 is the ciFix, swap 2 the PR step's fence before its push.
    const taken = takenAt(w, 2);
    const out = await w.run();
    expect(out).toMatchObject({ outcome: "failed", state: null });
    expect(out.reason).toContain("unit lost");
    expect(w.prSteps).toHaveLength(1);
    expect(w.calls).not.toContain("pushBranch");
    expect(w.calls).not.toContain("updatePr");
    expect(w.calls).not.toContain("openPr");
    expect(await branchHead(w)).toBe(w.head);
    expect(await w.ledger()).toEqual(taken() ?? undefined);
  });

  test("an aborted signal ends failed and leaves the record claimed", async () => {
    const w = await world({ checks: [[running("test")]] });
    const ctl = new AbortController();
    let polls = 0;
    const out = await w.run(
      { signal: ctl.signal },
      {
        sleep: async () => {
          polls += 1;
          if (polls === 2) ctl.abort();
        },
      },
    );
    expect(out).toMatchObject({ outcome: "failed", state: "claimed" });
    expect(await w.ledger()).toMatchObject({ state: "claimed", attempts: 0 });
  });
});

// -------------------------------------------------------------- end to end

const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };
const SPEC_TEXT = "---\ntitle: 'Story'\nstatus: 'done'\n---\n\n# Story\n\n## Auto Run Result\n\nStatus: done\n";

function writeIn(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

type Run = { readonly unit: AgentUnit | undefined; readonly spec: LaunchSpec; readonly ciLog: string | null };

type EndToEndOpts = {
  readonly main?: MainOpts;
  readonly merges?: (MergeOutcome | "error")[];
  /** The lockfile command's exit code; default 0. */
  readonly lockExit?: number;
  /** The lockfile command waits for its signal instead of exiting. */
  readonly lockHangs?: boolean;
  readonly limits?: SessionLimits;
  /** The CI step's poll sleep; default the virtual clock's. */
  readonly ciSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The committer's first outcomes, in call order; then fresh commits. */
  readonly commits?: CommitOutcome[];
};

async function endToEnd(script: Script, o: EndToEndOpts = {}) {
  const root = tempDir();
  const laneDir = join(root, "lanes", "builder-1");
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles(o.main) });
  const runs: Run[] = [];
  const prepares: PrepareParams[] = [];
  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (unit, settings, resultPath) =>
      ok({
        argv: ["stub-agent", settings.effort, resultPath],
        stdin: unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`,
        vendor: "claude",
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
        unit,
      } as AgentLaunchSpec),
    parseUsage: () => ({ sessionId: null, model: "claude-opus-5-5", tokens: null, cost: null, usageLimit: null }),
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
    checkModel,
  };
  const sandbox: Sandbox = {
    async run(spec, profile, signal) {
      const logPath = join(profile.tempDir, CI_FIX_LOG);
      runs.push({ unit: (spec as LaunchSpec & { unit?: AgentUnit }).unit, spec, ciLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : null });
      if (spec.argv[0] === "bun" && o.lockHangs === true) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve());
        });
        return ok({ pid: 998, exitCode: null, signal: "SIGTERM", startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
      }
      if (spec.argv[0] === "bun") {
        writeIn(profile.clone, "bun.lock", "lock regenerated\n");
        return ok({ pid: 998, exitCode: o.lockExit ?? 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "installed\n", stderr: "" });
      }
      writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-first.md`, SPEC_TEXT);
      writeFileSync(profile.resultPath, JSON.stringify({ kind: "build", outcome: "done", summary: "Did it", body: "", verification: ["bun test"], denied_actions: [] }));
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };
  const workspace: Workspace = {
    async prepare(p) {
      prepares.push(p);
      const clone = join(laneDir, "clone");
      rmSync(clone, { recursive: true, force: true });
      writeIn(clone, "README.md", "hello\n");
      return ok({ sha: p.start, resumed: false });
    },
  };
  const spied = scripted(fake, [...script]);
  const commits: CommitRequest[] = [];
  const prStep = createPrStep({ forge: spied.forge, committer: committer(fake, [...(o.commits ?? [])], commits), identity: ALICE, repo: LANE.repo, sleep: async () => {}, random: () => 0 });
  const c = clock();
  const merger = stubMerger([...(o.merges ?? [{ kind: "up-to-date" }])]);
  const ciStep = createCiStep({ forge: spied.forge, merger, identity: ALICE, repo: LANE.repo, now: c.now, sleep: o.ciSleep ?? c.sleep, random: () => 0 });
  const r = await runLaneProcess({
    forge: spied.forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop: join(root, "home", ".xarabot", "STOP") }),
    workspace,
    prStep,
    ciStep,
    laneDir,
    identity: ALICE,
    lane: LANE,
    pid: 12345,
    sleep: async () => {},
    random: () => 0,
    waiter: { wait: async () => ({ end: "elapsed" as const }) },
    ...(o.limits === undefined ? {} : { limits: o.limits }),
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
  const snap = await fake.forge.snapshot(opts());
  if (!snap.ok) throw new Error(snap.error.message);
  const l = parseLedger(snap.value.ledger.files);
  if (!l.ok) throw new Error(l.error.message);
  return { fake, runs, outcome: r.outcome, journal: units[0] as UnitJournalRecord, record: l.value.units.get(UNIT), asked: spied.asked, merger, prepares, commits };
}

describe("runLaneProcess with createCiStep", () => {
  test("a commit conflict onto fresh main: the PR step commits onto the session's start and opens the PR with no attempt; the CI step's merge of main runs a conflict session counted 1 in ci_fixes (Story 2.11)", async () => {
    const start = "5".repeat(40);
    const candidate = "c".repeat(40);
    const e = await endToEnd([[success("test")]], {
      commits: [{ kind: "conflict", paths: ["src/s0/a.ts"], start }],
      merges: [{ kind: "needs-session", candidate_sha: candidate, paths: ["src/s0/a.ts"], lockfiles: [] }, { kind: "up-to-date" }],
    });
    expect(e.outcome).toBe("progress");
    const main = e.commits[0]?.ontoSha as string;
    // The build's commit onto main, its fallback onto the start, then the conflict session's fix onto main.
    expect(e.commits.map((r) => r.ontoSha)).toEqual([main, start, main]);
    expect(e.runs).toHaveLength(2);
    expect(e.prepares[1]?.start).toBe(candidate);
    expect(e.runs[1]?.ciLog).toContain("hold conflict markers:\n\n- src/s0/a.ts\n");
    expect(e.record).toMatchObject({ state: "claimed", pr: 1, attempts: 0, ci_fixes: 1 });
    expect(e.journal).toMatchObject({ outcome: "progress", state: "claimed", attempts: 0, ci_fixes: 1, sessions: 2 });
    expect(readFileSync(e.journal.log, "utf8")).toContain(`commit conflict onto ${main}: src/s0/a.ts; committing onto the session's start ${start}`);
  });

  test("CI passes after the PR step: progress, the record claimed with its PR, and no CI or poll instruction to the agent", async () => {
    const e = await endToEnd([[success("test")]]);
    expect(e.outcome).toBe("progress");
    expect(e.record).toMatchObject({ state: "claimed", pr: 1 });
    expect(e.journal).toMatchObject({ outcome: "progress", state: "claimed", ci_fixes: 0 });
    expect(e.runs).toHaveLength(1);
    const prompt = e.runs[0]?.unit?.kind === "fresh" ? e.runs[0].unit.prompt : "";
    expect(prompt).not.toMatch(/\bpoll/i);
    expect(prompt).not.toMatch(/\bCI\b/);
    expect(prompt).not.toContain(CI_FIX_LOG);
    expect(e.asked).toEqual([e.record?.head_sha as string]);
    // The lane process names the Story to the CI step.
    expect(e.merger.requests[0]?.message).toMatch(/ into the PR for Story 1\.1$/);
  });

  test("a failing check runs a real fix session through the sandbox: ci-fix mode, the prefetched log at log_path, ci_fixes 1", async () => {
    const e = await endToEnd([[failure("lint")], [success("lint")]]);
    expect(e.outcome).toBe("progress");
    expect(e.runs).toHaveLength(2);
    const fix = e.runs[1];
    const prompt = fix?.unit?.kind === "fresh" ? fix.unit.prompt : "";
    expect(prompt).toContain("CI log");
    expect(prompt).toContain(CI_FIX_LOG);
    expect(fix?.ciLog).toContain("These checks failed unexpectedly: lint.");
    expect(fix?.ciLog).toContain("## lint.log");
    expect(e.journal).toMatchObject({ outcome: "progress", state: "claimed", ci_fixes: 1, attempts: 0, sessions: 2 });
    expect(e.record).toMatchObject({ state: "claimed", ci_fixes: 1 });
    expect(e.asked).toHaveLength(2);
    expect(e.asked[0]).not.toBe(e.asked[1]);
  });

  test("a lockfile conflict with lockfile_command: the command runs in the sandbox with no stdin and no credential, and its lockfile text goes to the merge", async () => {
    const candidate = "c".repeat(40);
    const e = await endToEnd([[success("test")]], {
      main: { lockfileCommand: ["bun", "install"] },
      merges: [
        { kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] },
        { kind: "merged", head_sha: "d".repeat(40), resolved: ["bun.lock"] },
      ],
    });
    expect(e.outcome).toBe("progress");
    expect(e.runs).toHaveLength(2);
    const regen = e.runs[1]?.spec;
    expect(regen?.argv).toEqual(["bun", "install"]);
    expect(regen?.stdin).toBeUndefined();
    // A repo command the runner starts gets no vendor credential (AR19, A14).
    expect(regen?.credential).toBeUndefined();
    expect(regen).not.toHaveProperty("credential");
    expect(e.merger.requests[1]?.lockfiles).toEqual({ "bun.lock": "lock regenerated\n" });
    expect(e.record).toMatchObject({ state: "claimed", head_sha: "d".repeat(40), ci_fixes: 0 });
    expect(e.journal).toMatchObject({ sessions: 1 });
  });

  test("the fix session prepares the clone at the failing head, fetching only it", async () => {
    const e = await endToEnd([[failure("lint")], [success("lint")]]);
    expect(e.outcome).toBe("progress");
    const failing = e.asked[0] as string;
    expect(e.prepares).toHaveLength(2);
    expect(e.prepares[1]).toMatchObject({ start: failing, fetch: [failing] });
  });

  test("the lockfile command prepares the clone at the candidate, fetching only it", async () => {
    const candidate = "c".repeat(40);
    const e = await endToEnd([[success("test")]], {
      main: { lockfileCommand: ["bun", "install"] },
      merges: [
        { kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] },
        { kind: "merged", head_sha: "d".repeat(40), resolved: ["bun.lock"] },
      ],
    });
    expect(e.outcome).toBe("progress");
    expect(e.prepares).toHaveLength(2);
    expect(e.prepares[1]).toMatchObject({ start: candidate, fetch: [candidate] });
  });

  test("a lockfile command that exits non-zero: no lockfiles reach the merge, and a conflict session runs at the candidate", async () => {
    const candidate = "c".repeat(40);
    const e = await endToEnd([[success("test")]], {
      main: { lockfileCommand: ["bun", "install"] },
      merges: [{ kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] }, { kind: "up-to-date" }],
      lockExit: 1,
    });
    expect(e.outcome).toBe("progress");
    expect(e.merger.requests.every((r) => r.lockfiles === undefined)).toBe(true);
    // Build, the failed lockfile command, then the conflict session at the candidate.
    expect(e.runs.map((r) => r.spec.argv[0])).toEqual(["stub-agent", "bun", "stub-agent"]);
    expect(e.prepares.map((p) => p.start).slice(1)).toEqual([candidate, candidate]);
    expect(e.runs[2]?.ciLog).toContain("- bun.lock");
    expect(e.record).toMatchObject({ state: "claimed", ci_fixes: 1 });
  });

  test("a lockfile command past the session limit is killed: a conflict session runs instead", async () => {
    const candidate = "c".repeat(40);
    const e = await endToEnd([[success("test")]], {
      main: { lockfileCommand: ["bun", "install"] },
      merges: [{ kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] }, { kind: "up-to-date" }],
      lockHangs: true,
      limits: { sessionMs: 30 },
    });
    expect(e.runs.map((r) => r.spec.argv[0])).toEqual(["stub-agent", "bun", "stub-agent"]);
    expect(e.merger.requests.every((r) => r.lockfiles === undefined)).toBe(true);
    expect(readFileSync(e.journal.log, "utf8")).toContain(`the lockfile command ran past ${30 / 3_600_000} h`);
  });

  test("the budget passes mid-poll: the lane releases the unit with attempts 1 and a budget reason", async () => {
    const waitForAbort = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    // 0.0005 h = 1.8 s: enough for the stub session and PR step, then the poll waits it out.
    const e = await endToEnd([[running("test")]], { main: { budgetHours: 0.0005 }, ciSleep: waitForAbort });
    expect(e.outcome).toBe("failed");
    expect(e.record).toMatchObject({ state: "released", attempts: 1 });
    expect(e.journal).toMatchObject({ outcome: "failed", state: "released", attempts: 1 });
    expect(e.journal.reason).toContain("unit budget of 0.0005 h passed");
  });
});
