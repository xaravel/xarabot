import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import type { NextStory } from "../../src/core/next/next.ts";
import { err, ok } from "../../src/core/result.ts";
import { unitPath, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { DiffPaths, DiffPathsRequest } from "../../src/lane/diff-paths.ts";
import { createMergeStep, gateComment, type MergeStep, type MergeStepDeps, type MergeStepInput, type MergeStepOutput } from "../../src/lane/merge-step.ts";
import { headPassedGate } from "../../src/lane/passed-gate.ts";
import type { Forge } from "../../src/ports/forge.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import { createCiStep } from "../../src/lane/ci-step.ts";
import type { Committer } from "../../src/lane/committer.ts";
import { runLaneProcess } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { MergeOutcome, Merger } from "../../src/lane/merger.ts";
import { createReviewGateStep } from "../../src/lane/review-gate.ts";
import { BLOCKER, NIT, reviewPass, reviewStub } from "./review-stub.ts";
import { createPrStep } from "../../src/lane/pr-step.ts";
import type { Workspace } from "../../src/lane/workspace.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";
import { ALICE, BOB, rec, tip } from "../core/ledger/fixtures.ts";
import { GRAPH_STATUS, graphFiles, stubGraphTrees, unchangedGraph } from "./graph-stub.ts";

// ------------------------------------------------------------------ world

const AUTHORITY = "docs/standing-authority.md";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const STATUS = `${SPEC_DIR}/sprint-status.yaml`;
const UNIT = "story:1.1";
const BRANCH = "story/1.1";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const opts = () => ({ signal: AbortSignal.timeout(5000) });

type MainOpts = { readonly authority?: boolean; readonly ownerPaths?: readonly string[]; readonly adapters?: readonly string[] };

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const policy = ["schema_version: 1", `unattended_adapters: [${(o.adapters ?? ["claude", "codex"]).join(", ")}]`];
  if (o.ownerPaths !== undefined) policy.push(`owner_approval_paths: ${JSON.stringify(o.ownerPaths)}`);
  const files: Record<string, string> = {
    ".xarabot/config.yaml": [
      "schema_version: 1",
      'runner_version: "0.1.0"',
      "maintainer: edanisko",
      `standing_authority_path: ${AUTHORITY}`,
      "manifests:",
      "  dir: stories",
      "",
    ].join("\n"),
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

/** Called inside the step's sleep: `i` counts sleeps from 0. */
type OnSleep = (i: number, ms: number, w: World) => void | Promise<void>;

type World = {
  readonly fake: FakeForge;
  /** Forge calls in order; a ledger swap is `ledgerSwap <edit name>`. */
  readonly events: string[];
  readonly sleeps: number[];
  readonly diffs: DiffPathsRequest[];
  readonly logs: string[];
  readonly record: UnitRecord;
  readonly head: string;
  readonly pr: number;
  readonly budget: AbortController;
  now(): number;
  run(input?: Partial<MergeStepInput>, deps?: Partial<MergeStepDeps>): Promise<MergeStepOutput>;
  ledger(): Promise<UnitRecord | undefined>;
};

type WorldOpts = MainOpts & {
  readonly diff?: readonly string[] | "error";
  readonly record?: Partial<UnitRecord>;
  readonly onSleep?: OnSleep;
};

/** The edit name in a ledger commit message, `ledger: <name> <unit> [skip ci]`. */
function editName(message: string): string {
  return /^ledger: (\S+)/.exec(message)?.[1] ?? message;
}

/** The fake forge, recording each call in order. */
function spied(fake: FakeForge, events: string[]): Forge {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(fake.forge)) {
    out[name] = (...args: unknown[]) => {
      if (name === "ledgerSwap") events.push(`ledgerSwap ${editName((args[1] as { message: string }).message)}`);
      else if (name !== "snapshot") events.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as Forge;
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
  // A record a review round passed at its head (Story 3.5), unless the case says otherwise.
  const record = rec({ unit: UNIT, globs: ["src/s0/**"], pr, pr_owner: "alice", head_sha: head, base_sha: main, passed_sha: head, builder_providers: ["anthropic"], ...o.record });
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([record]), deletes: [] });

  const events: string[] = [];
  const forge = spied(fake, events);
  const sleeps: number[] = [];
  const diffs: DiffPathsRequest[] = [];
  const logs: string[] = [];
  const budget = new AbortController();
  let t = T0;
  const diffPaths: DiffPaths = async (r) => {
    diffs.push(r);
    if (o.diff === "error") return err("git", "diff blew up");
    return ok(o.diff ?? ["src/s0/a.ts"]);
  };

  const w: World = {
    fake,
    events,
    sleeps,
    diffs,
    logs,
    record,
    head,
    pr,
    budget,
    now: () => t,
    run: (input = {}, deps = {}) =>
      createMergeStep({
        forge,
        diffPaths,
        graphTrees: unchangedGraph(),
        identity: ALICE,
        repo: "xaravel/xarabot",
        agent: "claude",
        passed: headPassedGate,
        now: () => t,
        sleep: async (ms) => {
          const i = sleeps.length;
          sleeps.push(ms);
          t += ms;
          await o.onSleep?.(i, ms, w);
        },
        random: () => 0,
        ...deps,
      })({ unit: { unit: STORY.unit, subject: `Story ${STORY.story_id}` }, record, signal: budget.signal, log: (text) => logs.push(text), ...input }),
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

/** The queue merges the PR at the first sleep. */
const mergeAtFirst: OnSleep = (i, _ms, w) => {
  if (i === 0) w.fake.control.mergeQueueHead();
};

/** `dequeue` comes before the edit leaving `merging`, with nothing else between. */
function dequeueBefore(events: readonly string[], edit: string): void {
  const swapAt = events.lastIndexOf(`ledgerSwap ${edit}`);
  expect(swapAt).toBeGreaterThan(0);
  expect(events[swapAt - 1]).toBe("dequeue");
}

// -------------------------------------------------------------- texts

describe("gateComment", () => {
  test("starts with 🤖, names the gated paths and says a coordinator lane running Story 2.6 queues it once the owner approves the current head", () => {
    const text = gateComment("Story 1.1", ["src/a.ts", ".github/x.yml"]);
    expect(text.startsWith("🤖 Story 1.1:")).toBe(true);
    expect(text).toContain("src/a.ts, .github/x.yml");
    expect(text).toContain("It is parked awaiting approval and was not queued. Once the owner approves the PR's current head, a coordinator lane running Story 2.6 adds it to the merge queue.");
  });

  test("sanitizes mentions and closing keywords out of path names", () => {
    const text = gateComment("Story 1.1", ["@someone/fixes #3.md"]);
    expect(text).not.toContain("@someone");
    expect(text).not.toMatch(/fixes #3/i);
  });

  test("is capped at the comment limit", () => {
    const text = gateComment("Unit reconcile:5", Array.from({ length: 5000 }, (_, i) => `src/${i}/${"p".repeat(20)}.ts`));
    expect(text.length).toBe(65_536);
    expect(text.endsWith("\n\n[truncated by xarabot]")).toBe(true);
  });
});

// -------------------------------------------------------------- gate

describe("the approval gate", () => {
  test("a gated PR parks awaiting-approval with every changed path held, comments once, and never enqueues", async () => {
    const w = await world({ ownerPaths: ["**"], diff: ["src/a.ts"] });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const after = await w.ledger();
    expect(after?.state).toBe("parked");
    expect(after?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["src/a.ts"] });
    const comments = w.fake.control.comments(w.pr);
    expect(comments.length).toBe(1);
    expect(comments[0]).toStartWith("🤖 Story 1.1:");
    expect(comments[0]).toContain("src/a.ts");
    expect(w.events).not.toContain("enqueue");
    expect(w.diffs.map((d) => d.headSha)).toEqual([w.head]);
  });

  test("a protected path parks with no owner paths set; only gated paths are named, every path is held", async () => {
    const w = await world({ diff: [".github/x.yml", "src/a.ts"] });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const after = await w.ledger();
    expect(after?.park?.kind).toBe("awaiting-approval");
    expect(after?.park?.globs_held).toEqual([".github/x.yml", "src/a.ts"]);
    const [comment] = w.fake.control.comments(w.pr);
    expect(comment).toContain(".github/x.yml");
    expect(comment).not.toContain("src/a.ts");
    expect(w.events).not.toContain("enqueue");
  });

  test("a failed comment still parks", async () => {
    const w = await world({ ownerPaths: ["**"] });
    w.fake.control.injectError("comment", { kind: "transient", message: "flaky" });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(out.reason).toContain("approval comment");
  });

  test("a failed diff is a failed attempt, with no enqueue", async () => {
    const w = await world({ diff: "error" });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await w.ledger())?.attempts).toBe(1);
    expect(w.events).not.toContain("enqueue");
  });
});

// -------------------------------------------------------------- the graph-change gate (Story 2.8)

describe("the graph-change gate", () => {
  const MAIN_GRAPH = graphFiles({ 1: ["1.1"], 2: ["2.1"] });
  const ADDED = graphFiles({ 1: ["1.1"], 2: ["2.1", "2.2"] });

  test("unchanged: the merge of the head with fresh main is checked before the approval gate, then queued as today", async () => {
    const w = await world({ onSleep: mergeAtFirst });
    const g = stubGraphTrees({ main: MAIN_GRAPH, merged: MAIN_GRAPH });
    const before = value(await w.fake.forge.snapshot(opts())).main.sha;
    const out = await w.run({}, { graphTrees: g.trees });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(g.calls.map((c) => [c.headSha, c.mainSha])).toEqual([[w.head, before]]);
    expect(w.diffs.map((d) => d.mainSha)).toEqual([before]);
    expect(w.fake.control.comments(w.pr)).toEqual([]);
  });

  test("a changed graph parks awaiting-approval for the Maintainer, one comment carrying the delta then the gated paths, and never enqueues", async () => {
    const w = await world({ ownerPaths: ["src/**"], diff: ["package.json", "src/a.ts"] });
    const out = await w.run({}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: ADDED }).trees });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const after = await w.ledger();
    expect(after?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: ["package.json", "src/a.ts"] });
    const comments = w.fake.control.comments(w.pr);
    expect(comments.length).toBe(1);
    expect(comments[0]).toStartWith("🤖 Story 1.1:");
    expect(comments[0]).toContain("(`edanisko`)");
    expect(comments[0]).toContain("- Stories added: Epic 2: +2.2");
    expect((comments[0] as string).indexOf("merge result's graph hash is")).toBeLessThan((comments[0] as string).indexOf("src/a.ts"));
    expect(comments[0]).not.toContain("package.json");
    expect(w.events).not.toContain("enqueue");
  });

  test("a changed graph with no gated path still parks for the Maintainer", async () => {
    const w = await world();
    const out = await w.run({}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: ADDED }).trees });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await w.ledger())?.park?.inbox_owner).toBe("edanisko");
    expect(w.fake.control.comments(w.pr)[0]).not.toContain("need approval");
  });

  test("a refused merge result parks blocked graph-invalid with a comment naming the refusal; nothing is enqueued", async () => {
    const w = await world();
    const used = { ...MAIN_GRAPH, [GRAPH_STATUS]: "development_status:\n  2-1-s: done\n" };
    const dropped = { ...graphFiles({ 1: ["1.1"], 2: [] }), [GRAPH_STATUS]: used[GRAPH_STATUS] as string };
    const out = await w.run({}, { graphTrees: stubGraphTrees({ main: used, merged: dropped }).trees });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await w.ledger())?.park).toMatchObject({ kind: "blocked", reason: "graph-invalid" });
    const [comment] = w.fake.control.comments(w.pr);
    expect(comment).toContain("graph-invalid");
    expect(comment).toContain("Story 2.1 is removed, but it is used: 2-1-s is done");
    expect(w.events).not.toContain("enqueue");
    expect(w.diffs).toEqual([]);
  });

  test("an invalid merge result (a cycle) parks graph-invalid", async () => {
    const w = await world();
    const cycle = { ...MAIN_GRAPH, ".xarabot/epics.yaml": "version: 1\nepics:\n  1: {depends_on: [2]}\n" };
    const out = await w.run({}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: cycle }).trees });
    expect((await w.ledger())?.park).toMatchObject({ kind: "blocked", reason: "graph-invalid" });
    expect(out.reason).toContain("cycle");
  });

  test("a removed Story with a PR on its branch is refused; with none it is only a change", async () => {
    const dropped = graphFiles({ 1: ["1.1"], 2: [] });
    const used = await world();
    value(await used.fake.forge.pushBranch({ branch: "story/2.1", expected_sha: null, sha: used.fake.control.makeCommit() }, opts()));
    value(await used.fake.forge.openPr({ branch: "story/2.1", base: "main", title: "t", body: "b" }, opts()));
    await used.run({}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: dropped }).trees });
    expect((await used.ledger())?.park).toMatchObject({ kind: "blocked", reason: "graph-invalid" });
    expect(used.events).toContain("listPrsByBranch");

    const unused = await world();
    await unused.run({}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: dropped }).trees });
    expect((await unused.ledger())?.park).toMatchObject({ kind: "awaiting-approval", inbox_owner: "edanisko" });
  });

  test("a failed branch PR lookup is a failed attempt", async () => {
    const w = await world();
    w.fake.control.injectError("listPrsByBranch", { kind: "transient", message: "flaky" });
    const out = await w.run({}, { graphTrees: stubGraphTrees({ main: MAIN_GRAPH, merged: graphFiles({ 1: ["1.1"], 2: [] }) }).trees });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("listPrsByBranch");
  });

  test.each([
    ["a conflicting merge", { conflict: ["stories/2.1.md"] }, "conflicts"],
    ["main not resolving", { main: { ...MAIN_GRAPH, ".xarabot/config.yaml": "schema_version: 1\n" }, merged: MAIN_GRAPH }, "main:"],
    ["a failed read", { error: "git broke" }, "git broke"],
  ] as const)("%s is a failed attempt, with no park, comment or enqueue", async (_name, answer, why) => {
    const w = await world();
    const out = await w.run({}, { graphTrees: stubGraphTrees(answer).trees });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain(why);
    expect((await w.ledger())?.attempts).toBe(1);
    expect(w.fake.control.comments(w.pr)).toEqual([]);
    expect(w.events).not.toContain("enqueue");
  });

  test("a merging takeover skips the graph gate", async () => {
    const w = await world({ onSleep: mergeAtFirst, record: { state: "merging", generation: 2 } });
    const record: UnitRecord = { ...w.record, passed_sha: w.head, enqueued_sha: w.head };
    w.fake.control.writeForeignLedger({ message: "seed passed [skip ci]", writes: tip([record]), deletes: [] });
    value(await w.fake.forge.enqueue(w.pr, w.head, opts()));
    const g = stubGraphTrees({ error: "never called" });
    const out = await w.run({ record }, { graphTrees: g.trees });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(g.calls).toEqual([]);
  });
});

// -------------------------------------------------------------- fresh main

describe("fresh main", () => {
  test("a revoked Standing Authority stops with no ledger edit, enqueue or comment", async () => {
    const w = await world({ authority: false });
    const before = w.fake.control.ledgerLog().length;
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(w.fake.control.ledgerLog().length).toBe(before);
    expect(w.events).toEqual([]);
    expect(w.diffs).toEqual([]);
  });

  test("a PR already merged is marked merged without the gate or queue", async () => {
    const w = await world();
    value(await w.fake.forge.enqueue(w.pr, w.head, opts()));
    w.fake.control.mergeQueueHead();
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect((await w.ledger())?.state).toBe("merged");
    expect(w.events).toEqual(["ledgerSwap markMerged"]);
  });

  test("a closed PR or a moved head is a failed attempt", async () => {
    const closed = await world();
    value(await closed.fake.forge.closePr(closed.pr, opts()));
    expect((await closed.run()).outcome).toBe("failed");
    expect((await closed.ledger())?.state).toBe("released");
    expect(closed.events).not.toContain("enqueue");

    const moved = await world();
    value(await moved.fake.forge.pushBranch({ branch: BRANCH, expected_sha: moved.head, sha: moved.fake.control.makeCommit() }, opts()));
    const out = await moved.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("head is");
    expect(moved.events).not.toContain("enqueue");
  });
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: { kind: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

// -------------------------------------------------------------- the passed gate and the allowance

describe("the passed gate and the allowance (Story 3.5)", () => {
  test("merge step unreviewed: passed_sha not the head and no clean merge: a failed attempt, no park, no enqueue, no diff", async () => {
    const w = await world({ ownerPaths: ["**"], record: { passed_sha: null } });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("passed gate: unreviewed");
    expect(w.diffs).toEqual([]);
    expect(w.events).not.toContain("enqueue");
    expect(w.events).not.toContain("ledgerSwap park");
    expect(w.fake.control.comments(w.pr)).toEqual([]);
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 1 });
  });

  test("passed_sha at an older head is unreviewed too", async () => {
    const w = await world({ record: { passed_sha: "a".repeat(40) } });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(w.events).not.toContain("enqueue");
  });

  test("the gate gets the head, the record's passed_sha and fresh main; a clean merge passes and is enqueued", async () => {
    const w = await world({ onSleep: mergeAtFirst, record: { passed_sha: "a".repeat(40) } });
    const asked: unknown[] = [];
    const out = await w.run({}, {
      passed: async (r) => {
        asked.push({ head: r.headSha, passed: r.passedSha, main: r.mainSha });
        return ok({ kind: "passed", how: "clean-merge" });
      },
    });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    // Fresh main as the step read it: the world's main, before the queue merged the PR.
    expect(asked).toEqual([{ head: w.head, passed: "a".repeat(40), main: w.record.base_sha }]);
  });

  test("a passed gate error is a failed attempt, with no enqueue", async () => {
    const w = await world();
    const out = await w.run({}, { passed: async () => err("fetch", "offline") });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("passed gate fetch: offline");
    expect(w.events).not.toContain("enqueue");
  });

  test("revoked allowance, enqueue: fresh main's policy drops the lane's adapter: a failed attempt naming it, no gate, no enqueue", async () => {
    const w = await world({ adapters: ["codex"], ownerPaths: ["**"] });
    let gated = 0;
    const out = await w.run({}, {
      passed: async () => {
        gated += 1;
        return ok({ kind: "passed", how: "head" });
      },
    });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
    expect(gated).toBe(0);
    expect(w.diffs).toEqual([]);
    expect(w.events).not.toContain("enqueue");
  });

  test("a merging takeover is watched with no allowance or passed gate", async () => {
    const w = await world({ adapters: ["codex"], onSleep: mergeAtFirst, record: { state: "merging", generation: 2 } });
    const record: UnitRecord = { ...w.record, passed_sha: null, enqueued_sha: w.head };
    w.fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([record]), deletes: [] });
    value(await w.fake.forge.enqueue(w.pr, w.head, opts()));
    const out = await w.run({ record }, { passed: async () => err("fetch", "never called") });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
  });
});

// -------------------------------------------------------------- enqueue

describe("enqueue", () => {
  test("an ungated PR: heartbeat enqueued_sha, startMerging, then enqueue at its head; merged when the queue merges it", async () => {
    const w = await world({ onSleep: mergeAtFirst });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.events.slice(0, 3)).toEqual(["ledgerSwap heartbeat", "ledgerSwap startMerging", "enqueue"]);
    expect(w.events.at(-1)).toBe("ledgerSwap markMerged");
    expect(w.events).not.toContain("dequeue");
    const after = await w.ledger();
    expect(after?.state).toBe("merged");
    expect(after?.passed_sha).toBe(w.head);
    expect(after?.enqueued_sha).toBe(w.head);
    expect(w.fake.control.comments(w.pr)).toEqual([]);
  });

  test("the enqueue fence records enqueued_sha and never sets passed_sha (Story 3.5)", async () => {
    const w = await world({ onSleep: mergeAtFirst });
    const fences: Record<string, unknown>[] = [];
    const forge: Forge = {
      ...w.fake.forge,
      ledgerSwap: (oldSha, commit, o) => {
        if (editName(commit.message) === "heartbeat") for (const t of Object.values(commit.writes)) fences.push(JSON.parse(t) as Record<string, unknown>);
        return w.fake.forge.ledgerSwap(oldSha, commit, o);
      },
    };
    // A head that passed through a clean merge: the gate says passed, but passed_sha stays the reviewed head.
    const reviewed = "a".repeat(40);
    const record: UnitRecord = { ...w.record, passed_sha: reviewed };
    w.fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([record]), deletes: [] });
    const out = await w.run({ record }, { forge, passed: async () => ok({ kind: "passed", how: "clean-merge" }) });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(fences[0]).toMatchObject({ enqueued_sha: w.head, passed_sha: reviewed });
  });

  test("a lost fence before startMerging: no enqueue and the record untouched by the lane", async () => {
    const w = await world();
    let bumped: UnitRecord | null = null;
    w.fake.control.beforeSwap(({ n }) => {
      if (n !== 1) return;
      bumped = { ...w.record, owner: "bob", host: "22222222-2222-4222-8222-222222222222", lane: "builder-2", generation: 2 };
      w.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(bumped) }, deletes: [] });
    });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect(w.events).not.toContain("enqueue");
    expect(await w.ledger()).toEqual(bumped ?? undefined);
  });

  test("enqueue conflict: dequeue, then released with attempts + 1", async () => {
    const w = await world();
    w.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await w.ledger())?.attempts).toBe(1);
    dequeueBefore(w.events, "failAttempt");
  });

  test("enqueue transient once: queued after one retry", async () => {
    const w = await world({ onSleep: (i, _ms, ww) => (i === 1 ? void ww.fake.control.mergeQueueHead() : undefined) });
    w.fake.control.injectError("enqueue", { kind: "transient", message: "502" });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.events.filter((e) => e === "enqueue")).toEqual(["enqueue", "enqueue"]);
    expect(w.sleeps[0]).toBe(30_000);
  });

  test("every enqueue retry is fenced: fence, startMerging, enqueue, then fence and enqueue again", async () => {
    const w = await world({ onSleep: (i, _ms, ww) => (i === 1 ? void ww.fake.control.mergeQueueHead() : undefined) });
    w.fake.control.injectError("enqueue", { kind: "transient", message: "502" });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.events.slice(0, 5)).toEqual(["ledgerSwap heartbeat", "ledgerSwap startMerging", "enqueue", "ledgerSwap heartbeat", "enqueue"]);
  });

  test("another lane takes the record before an enqueue retry's fence: no enqueue reaches the queue, no dequeue, no further edit", async () => {
    const w = await world();
    w.fake.control.injectError("enqueue", { kind: "transient", message: "502" });
    let bumped: UnitRecord | null = null;
    // Swap 1 is the fence, 2 startMerging, 3 the retry's fence.
    w.fake.control.beforeSwap(async ({ n }) => {
      if (n !== 3) return;
      const current = await w.ledger();
      if (current === undefined) throw new Error("no record");
      bumped = { ...current, owner: "bob", host: "22222222-2222-4222-8222-222222222222", lane: "builder-2", generation: 2 };
      w.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(bumped) }, deletes: [] });
    });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect(out.reason).toContain("unit lost");
    expect(w.events.filter((e) => e === "enqueue")).toEqual(["enqueue"]);
    expect(w.events).not.toContain("dequeue");
    expect(w.fake.control.queue()).toEqual([]);
    expect(await w.ledger()).toEqual(bumped ?? undefined);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("bump [skip ci]");
  });

  test("three back-off replies leave merging after dequeue and count a failed attempt; retry_after stretches the wait", async () => {
    const slow = { kind: "rate-limited", message: "slow down", retry_after: 90 } as const;
    const w = await world({ onSleep: (i, _ms, ww) => (i < 2 ? ww.fake.control.injectError("enqueue", slow) : undefined) });
    w.fake.control.injectError("enqueue", slow);
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    const calls = w.events.filter((e) => e === "enqueue").length;
    expect(calls).toBe(3);
    expect(w.sleeps).toEqual([90_000, 90_000]);
    dequeueBefore(w.events, "failAttempt");
  });
});

// -------------------------------------------------------------- watch

describe("watch: false (a coordinator unit, Story 2.10)", () => {
  const UNIT_SUBJECT = { unit: UNIT, subject: "Unit retro-item:epic-2-retro-item-1-x" };

  test("an ungated PR: fence, startMerging, enqueue at its head, then the step ends merging with no queue read", async () => {
    const w = await world();
    const out = await w.run({ unit: UNIT_SUBJECT, watch: false });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(w.events).toEqual(["ledgerSwap heartbeat", "ledgerSwap startMerging", "enqueue"]);
    expect(w.events).not.toContain("queueState");
    expect(w.sleeps).toEqual([]);
    expect(out.reason).toContain(`PR #${w.pr} enqueued at ${w.head}`);
    const after = await w.ledger();
    expect([after?.state, after?.passed_sha]).toEqual(["merging", w.head]);
  });

  test("a gated PR parks awaiting-approval with the gate comment naming the unit", async () => {
    const w = await world({ ownerPaths: ["**"], diff: ["src/a.ts"] });
    const out = await w.run({ unit: UNIT_SUBJECT, watch: false });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const comments = w.fake.control.comments(w.pr);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toStartWith("🤖 Unit retro-item:epic-2-retro-item-1-x: this PR changes paths that need the owner's approval: src/a.ts.");
    expect(w.events).not.toContain("enqueue");
  });

  test("an enqueue error is a failed attempt, after leaving merging", async () => {
    const w = await world();
    w.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    const out = await w.run({ unit: UNIT_SUBJECT, watch: false });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    dequeueBefore(w.events, "failAttempt");
  });
});

describe("a merging record (a stale takeover): watch only", () => {
  /**
   * A world whose record is already `merging` at generation 2 and whose PR is
   * queued at its head; the record's `enqueued_sha` is `enqueued` (default the head).
   */
  async function merging(onSleep: OnSleep, gate: Partial<WorldOpts> = {}, enqueued?: string): Promise<{ w: World; record: UnitRecord }> {
    const w = await world({ ...gate, onSleep, record: { state: "merging", generation: 2, attempts: 1 } });
    const record: UnitRecord = { ...w.record, enqueued_sha: enqueued ?? w.head };
    w.fake.control.writeForeignLedger({ message: "seed passed [skip ci]", writes: tip([record]), deletes: [] });
    await w.fake.forge.enqueue(w.pr, w.head, opts());
    return { w, record };
  }

  test("no gate, fence, startMerging or enqueue: the queue is watched until it merges the PR", async () => {
    const { w, record } = await merging(mergeAtFirst, { ownerPaths: ["**"] });
    const out = await w.run({ record });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.diffs).toEqual([]);
    expect(w.events).toEqual(["queueState", "queueState", "ledgerSwap markMerged"]);
    expect(w.fake.control.comments(w.pr)).toEqual([]);
    expect((await w.ledger())?.state).toBe("merged");
  });

  test("ejected while watched: fence and dequeue, then claimed with attempts + 1 and ejected", async () => {
    const { w, record } = await merging((i, _ms, ww) => void (i === 0 && ww.fake.control.eject(ww.pr)));
    const out = await w.run({ record });
    expect([out.outcome, out.state, out.ejected]).toEqual(["progress", "claimed", true]);
    expect(w.events).not.toContain("enqueue");
    expect(w.events).not.toContain("ledgerSwap startMerging");
    dequeueBefore(w.events, "ejected");
    expect(await w.ledger()).toMatchObject({ state: "claimed", attempts: 2, generation: 2, owner: "alice" });
  });

  test("queued at a head other than its enqueued_sha: fenced, dequeued and released with attempts + 1, never watched to merged", async () => {
    const enqueued = "a".repeat(40);
    const { w, record } = await merging(mergeAtFirst, {}, enqueued);
    const out = await w.run({ record });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain(enqueued);
    expect(out.reason).toContain(w.head);
    expect(w.fake.control.queue()).toEqual([]);
    dequeueBefore(w.events, "failAttempt");
    expect(w.events).not.toContain("ledgerSwap markMerged");
    expect(w.events).not.toContain("enqueue");
    expect(await w.ledger()).toMatchObject({ state: "released", attempts: 2, generation: 2 });
  });
});

describe("watching the queue", () => {
  test("ejected: dequeue, then claimed with attempts + 1 and ejected", async () => {
    const w = await world({ onSleep: (i, _ms, ww) => void (i === 0 && ww.fake.control.eject(ww.pr)) });
    const out = await w.run();
    expect([out.outcome, out.state, out.ejected]).toEqual(["progress", "claimed", true]);
    const after = await w.ledger();
    expect([after?.state, after?.attempts]).toEqual(["claimed", 1]);
    expect(out.record?.attempts).toBe(1);
    dequeueBefore(w.events, "ejected");
  });

  test("ejected at the cap: parked blocked attempts-cap", async () => {
    const w = await world({ record: { attempts: 2 }, onSleep: (i, _ms, ww) => void (i === 0 && ww.fake.control.eject(ww.pr)) });
    const out = await w.run();
    expect([out.outcome, out.state, out.ejected]).toEqual(["progress", "parked", undefined]);
    const after = await w.ledger();
    expect(after?.park?.reason).toBe("attempts-cap");
    expect(after?.attempts).toBe(3);
    dequeueBefore(w.events, "ejected");
  });

  test("closed while queued: dequeue, then released", async () => {
    const w = await world({ onSleep: async (i, _ms, ww) => void (i === 0 && (await ww.fake.forge.closePr(ww.pr, opts()))) });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    dequeueBefore(w.events, "failAttempt");
  });

  test("a head moved while queued: dequeue, then released", async () => {
    const w = await world({
      onSleep: async (i, _ms, ww) => {
        if (i === 0) await ww.fake.forge.pushBranch({ branch: BRANCH, expected_sha: ww.head, sha: ww.fake.control.makeCommit() }, opts());
      },
    });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("moved");
    dequeueBefore(w.events, "failAttempt");
  });

  test("the budget passes while queued: dequeue, then released with attempts + 1", async () => {
    const w = await world({ onSleep: (i, _ms, ww) => (i === 1 ? ww.budget.abort() : undefined) });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await w.ledger())?.attempts).toBe(1);
    expect(w.fake.control.queue()).toEqual([]);
    dequeueBefore(w.events, "failAttempt");
  });

  test("a dequeue that fails on leaving keeps the record merging", async () => {
    const w = await world({
      onSleep: (i, _ms, ww) => {
        if (i !== 0) return;
        ww.fake.control.eject(ww.pr);
        ww.fake.control.injectError("dequeue", { kind: "transient", message: "502" });
      },
    });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "merging"]);
    expect((await w.ledger())?.state).toBe("merging");
    expect(w.events.at(-1)).toBe("dequeue");
  });

  test("another lane takes the record before the dequeue's fence: no dequeue, the PR stays queued, no further edit", async () => {
    let bumped: UnitRecord | null = null;
    const w = await world({
      onSleep: async (i, _ms, ww) => {
        if (i !== 1) return;
        const current = await ww.ledger();
        if (current === undefined) throw new Error("no record");
        bumped = { ...current, owner: "bob", host: "22222222-2222-4222-8222-222222222222", lane: "builder-2", generation: 2 };
        ww.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(bumped) }, deletes: [] });
        // The budget passes too, so the step leaves merging.
        ww.budget.abort();
      },
    });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect(out.reason).toContain("dequeue fence: unit lost");
    expect(w.events).not.toContain("dequeue");
    expect(w.fake.control.queue()).toEqual([w.pr]);
    expect(await w.ledger()).toEqual(bumped ?? undefined);
    expect(w.fake.control.ledgerLog().at(-1)?.message).toBe("bump [skip ci]");
  });

  test("a dequeue fence that fails otherwise keeps the record merging and the PR queued", async () => {
    const w = await world({
      onSleep: (i, _ms, ww) => {
        if (i !== 1) return;
        ww.fake.control.injectError("ledgerSwap", { kind: "not-fast-forward", message: "ledger rewound" });
        ww.budget.abort();
      },
    });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "merging"]);
    expect(out.reason).toContain("dequeue fence");
    expect(w.events).not.toContain("dequeue");
    expect(w.fake.control.queue()).toEqual([w.pr]);
    expect((await w.ledger())?.state).toBe("merging");
  });

  test.each(["not-found", "conflict"] as const)("a %s queue read: dequeue, then released with attempts + 1", async (kind) => {
    const w = await world();
    w.fake.control.injectError("queueState", { kind, message: "gone" });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await w.ledger())?.attempts).toBe(1);
    dequeueBefore(w.events, "failAttempt");
  });

  test("merged on the ledger by another writer before the watch sees the merge: ends merged", async () => {
    const w = await world({
      onSleep: async (i, _ms, ww) => {
        if (i !== 0) return;
        const current = await ww.ledger();
        if (current === undefined) throw new Error("no record");
        const done = { ...current, state: "merged" as const, owner: "bob", host: "22222222-2222-4222-8222-222222222222", lane: "builder-2" };
        ww.fake.control.writeForeignLedger({ message: "merged [skip ci]", writes: { [unitPath(UNIT)]: serializeUnitRecord(done) }, deletes: [] });
        ww.fake.control.mergeQueueHead();
      },
    });
    const out = await w.run();
    expect([out.outcome, out.state, out.record?.state]).toEqual(["progress", "merged", "merged"]);
    expect((await w.ledger())?.owner).toBe("bob");
  });

  test("a forbidden queue read alerts forge-forbidden and stops", async () => {
    const w = await world();
    w.fake.control.injectError("queueState", { kind: "forbidden", message: "needs pull_requests: write" });
    const out = await w.run();
    expect(out.outcome).toBe("stop");
    expect(w.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-forbidden"]);
    expect((await w.ledger())?.state).toBe("merging");
  });

  test("a transient or rate-limited read counts as pending", async () => {
    const w = await world({ onSleep: (i, _ms, ww) => (i === 2 ? void ww.fake.control.mergeQueueHead() : undefined) });
    w.fake.control.injectError("queueState", { kind: "rate-limited", message: "slow", retry_after: 600 });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.sleeps.slice(0, 2)).toEqual([600_000, 60_000]);
  });

  test("polls with back-off and heartbeats once 5 minutes of host time pass", async () => {
    const w = await world({ onSleep: (i, _ms, ww) => (i === 5 ? void ww.fake.control.mergeQueueHead() : undefined) });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    // The fence, then at 450 s, 750 s and 1050 s after it: each at least 5 min after the last.
    expect(w.events.filter((e) => e === "ledgerSwap heartbeat").length).toBe(4);
    expect(w.events.filter((e) => e === "queueState").length).toBe(7);
  });
});

// -------------------------------------------------------------- through runLaneProcess

const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" };
const SPEC_TEXT = "---\ntitle: 'Story'\nstatus: 'done'\n---\n\n# Story\n\n## Auto Run Result\n\nStatus: done\n";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeIn(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

type LaneRun = {
  readonly outcome: string;
  readonly fake: FakeForge;
  readonly events: string[];
  readonly checksAsked: string[];
  readonly journal: JournalRecord[];
  readonly record: UnitRecord | undefined;
  /** Each builder session's prompt, in order. */
  readonly prompts: string[];
  /** The review findings file each builder session found in its temp folder, or `null`. */
  readonly findings: (string | null)[];
  /** Each review pass's prompt, in order. */
  readonly reviewPrompts: string[];
  /** The merge step's inputs' heads, in order. */
  readonly enqueuedAt: string[];
  /** The run's lane stop, if it ended in one. */
  readonly laneStop: string | undefined;
};

type LaneRunOpts = {
  readonly prepare?: (fake: FakeForge) => Promise<void>;
  readonly onQueueSleep?: (fake: FakeForge) => void;
  /** Each review run's result, in order; past the end, a clean pass. */
  readonly reviews?: readonly ((head: string) => string)[];
  /** Runs after each review run; `n` counts from 0. */
  readonly onReview?: (n: number, fake: FakeForge) => void;
  /** CI fails on the `n`th checks read (from 0) when this says so; default every head passes. */
  readonly ciFails?: (n: number) => boolean;
  /** The merger's outcome per call, in order; past the end, `up-to-date`. */
  readonly merges?: readonly ((fake: FakeForge) => MergeOutcome)[];
  /** Before each builder session; `n` counts from 0. */
  readonly onSession?: (n: number, fake: FakeForge) => void;
  /** The builder run (from 0) that reports a usage limit and writes no result; default none. */
  readonly limitAt?: number;
  /** How each wait ends, in order; default `elapsed`. */
  readonly waitEnds?: readonly ("elapsed" | "stopped")[];
};

/**
 * One lane process with a stub agent, the real PR, CI, review gate and
 * merge steps on the fake forge, and `prepare` run before it (to seed
 * state). Every head passes CI and every review passes unless the options
 * say otherwise; `onQueueSleep` runs at each of the merge step's sleeps.
 */
async function laneRun(o: LaneRunOpts = {}): Promise<LaneRun> {
  const root = mkdtempSync(join(tmpdir(), "xarabot-merge-lane-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles() });
  await o.prepare?.(fake);
  const events: string[] = [];
  const forge = spied(fake, events);
  const checksAsked: string[] = [];
  const realChecks = forge.checks;
  (forge as { checks: Forge["checks"] }).checks = async (sha, callOpts) => {
    const n = checksAsked.length;
    checksAsked.push(sha);
    fake.control.setChecks(sha, [{ name: "test", status: "completed", conclusion: o.ciFails?.(n) === true ? "failure" : "success" }]);
    return realChecks(sha, callOpts);
  };
  const prompts: string[] = [];
  const findings: (string | null)[] = [];
  let usageCalls = 0;
  let waits = 0;
  const enqueuedAt: string[] = [];
  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (unit, settings, resultPath) =>
      ok({ argv: ["stub-agent", settings.effort, resultPath], stdin: unit.kind === "fresh" ? unit.prompt : "resume", vendor: "claude", vendorHomeEnv: "STUB_HOME", credential: { file: "token", env: "STUB_TOKEN" }, apiHosts: ["api.example.com"] } as AgentLaunchSpec),
    parseUsage: () => ({ sessionId: null, model: "claude-opus-5-5", tokens: null, cost: null, usageLimit: usageCalls++ === o.limitAt ? { resetAt: null } : null }),
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
    checkModel,
  };
  const sandbox: Sandbox = {
    async run(spec, profile) {
      o.onSession?.(prompts.length, fake);
      const n = prompts.length;
      prompts.push(spec.stdin ?? "");
      const path = join(profile.tempDir, "review-findings.md");
      findings.push(existsSync(path) ? readFileSync(path, "utf8") : null);
      if (n === o.limitAt) return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
      writeIn(profile.clone, `${SPEC_DIR}/spec-1-1-first.md`, SPEC_TEXT);
      writeFileSync(profile.resultPath, JSON.stringify({ kind: "build", outcome: "done", summary: "Did it", body: "", verification: ["bun test"], denied_actions: [] }));
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
  const committer: Committer = { commit: async (r) => ok({ kind: "committed", base_sha: r.ontoSha, head_sha: fake.control.makeCommit() }) };
  let merges = 0;
  const merger: Merger = { merge: async () => ok(o.merges?.[merges++]?.(fake) ?? { kind: "up-to-date" }) };
  let t = T0;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const prStep = createPrStep({ forge, committer, identity: ALICE, repo: LANE.repo, provider: "anthropic", sleep: async () => {}, random: () => 0 });
  const ciStep = createCiStep({ forge, merger, identity: ALICE, repo: LANE.repo, now, sleep, random: () => 0 });
  const realMergeStep = createMergeStep({
    forge,
    diffPaths: async () => ok(["src/s0/a.ts"]),
    graphTrees: unchangedGraph(),
    identity: ALICE,
    repo: LANE.repo,
    agent: LANE.agent,
    passed: headPassedGate,
    now,
    sleep: async (ms) => {
      t += ms;
      o.onQueueSleep?.(fake);
    },
    random: () => 0,
  });
  const mergeStep: MergeStep = (input) => {
    enqueuedAt.push(input.record.head_sha ?? "none");
    return realMergeStep(input);
  };
  const stub = reviewStub({
    forge,
    laneDir,
    hostStop,
    lane: LANE,
    identity: ALICE,
    results: o.reviews ?? [],
    files: () => ({ [`${SPEC_DIR}/spec-1-1-first.md`]: SPEC_TEXT }),
    now,
    onRun: (n) => o.onReview?.(n, fake),
  });
  const reviewGate = createReviewGateStep({ forge, identity: ALICE, repo: LANE.repo, review: stub.review, passed: headPassedGate, now, sleep: async () => {}, random: () => 0 });
  const r = await runLaneProcess({
    forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    workspace,
    prStep,
    ciStep,
    reviewGate,
    mergeStep,
    laneDir,
    identity: ALICE,
    lane: LANE,
    pid: 12345,
    now,
    sleep: async () => {},
    random: () => 0,
    waiter: { wait: async () => ({ end: o.waitEnds?.[waits++] ?? ("elapsed" as const) }) },
  });
  const path = join(laneDir, "journal.jsonl");
  const journal = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as JournalRecord)
    : [];
  const snap = await fake.forge.snapshot(opts());
  if (!snap.ok) throw new Error(snap.error.message);
  const l = parseLedger(snap.value.ledger.files);
  if (!l.ok) throw new Error(l.error.message);
  return { outcome: r.outcome, fake, events, checksAsked, journal, record: l.value.units.get(UNIT), prompts, findings, reviewPrompts: stub.prompts, enqueuedAt, laneStop: r.laneStop };
}

/** Seeds a `state` record for UNIT whose PR then merges (the Maintainer queued it by hand); its PR number. */
async function seedMerged(fake: FakeForge, state: "parked" | "merging"): Promise<number> {
  const head = fake.control.makeCommit();
  value(await fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts()));
  const number = value(await fake.forge.openPr({ branch: BRANCH, base: "main", title: "t", body: "b" }, opts())).number;
  const seeded = rec({
    unit: UNIT,
    state,
    globs: ["src/s0/**"],
    pr: number,
    pr_owner: "alice",
    head_sha: head,
    passed_sha: head,
    park: state === "parked" ? { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["src/s0/a.ts"] } : null,
  });
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([seeded]), deletes: [] });
  value(await fake.forge.enqueue(number, head, opts()));
  fake.control.mergeQueueHead();
  return number;
}

describe("runLaneProcess with createMergeStep", () => {
  test("a passing ungated PR: heartbeat, startMerging, then enqueue; merged when the queue merges it", async () => {
    const e = await laneRun({ onQueueSleep: (fake) => void fake.control.mergeQueueHead() });
    expect(e.outcome).toBe("progress");
    const swaps = e.fake.control.ledgerLog().map((c) => editName(c.message));
    const fence = swaps.lastIndexOf("heartbeat");
    expect(swaps.slice(fence)).toEqual(["heartbeat", "startMerging", "markMerged"]);
    const at = e.events.indexOf("ledgerSwap startMerging");
    expect(e.events.indexOf("enqueue")).toBe(at + 1);
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ outcome: "progress", state: "merged", attempts: 0 });
    expect(e.record?.state).toBe("merged");
  });

  test("ejected once, then merged: the CI step runs twice, enqueue twice, merged with attempts 1", async () => {
    let ejectedOnce = false;
    const e = await laneRun({
      onQueueSleep: (fake) => {
        const [pr] = fake.control.queue();
        if (pr === undefined) return;
        if (!ejectedOnce) {
          ejectedOnce = true;
          fake.control.eject(pr);
        } else {
          fake.control.mergeQueueHead();
        }
      },
    });
    expect(e.outcome).toBe("progress");
    expect(e.checksAsked).toHaveLength(2);
    expect(e.events.filter((x) => x === "enqueue")).toHaveLength(2);
    const ejectedAt = e.events.indexOf("ledgerSwap ejected");
    expect(e.events[ejectedAt - 1]).toBe("dequeue");
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ outcome: "progress", state: "merged", attempts: 1 });
    expect(e.record).toMatchObject({ state: "merged", attempts: 1 });
  });

  test("the sweep marks a parked record whose PR merged by hand merged before next, with one journal record", async () => {
    let number = 0;
    const e = await laneRun({ prepare: async (fake) => void (number = await seedMerged(fake, "parked")) });
    const swaps = e.fake.control.ledgerLog().map((c) => editName(c.message));
    expect(swaps).toEqual(["root", "seed [skip ci]", "markMerged"]);
    expect(e.record?.state).toBe("merged");
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ unit: UNIT, outcome: "progress", state: "merged", reason: `PR #${number} merged`, sessions: 0 });
    expect(existsSync(units[0]?.log as string)).toBe(true);
    // Merged before next: the lane then finds nothing to do.
    expect(e.outcome).toBe("idle");
  });

  test("the sweep marks a merging record whose PR merged before next, with one journal record", async () => {
    let number = 0;
    const e = await laneRun({ prepare: async (fake) => void (number = await seedMerged(fake, "merging")) });
    const swaps = e.fake.control.ledgerLog().map((c) => editName(c.message));
    expect(swaps).toEqual(["root", "seed [skip ci]", "markMerged"]);
    expect(e.record?.state).toBe("merged");
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ unit: UNIT, outcome: "progress", state: "merged", reason: `PR #${number} merged` });
    expect(e.outcome).toBe("idle");
  });

  test("a lost sweep swap is skipped and the run goes on", async () => {
    let fired = false;
    const e = await laneRun({
      prepare: async (fake) => {
        await seedMerged(fake, "parked");
        // Another writer deletes the record before the sweep's swap lands.
        fake.control.beforeSwap(() => {
          if (fired) return;
          fired = true;
          fake.control.writeForeignLedger({ message: "delete [skip ci]", writes: {}, deletes: [unitPath(UNIT)] });
        });
      },
    });
    expect(fired).toBe(true);
    const swaps = e.fake.control.ledgerLog().map((c) => editName(c.message));
    expect(swaps).toEqual(["root", "seed [skip ci]", "delete [skip ci]"]);
    // The run goes on to next, which reads the round's snapshot (the unit still parked) and idles.
    expect(e.outcome).toBe("idle");
    expect(e.journal.filter((x) => x.type === "unit")).toEqual([]);
    expect(e.journal.filter((x) => x.type === "span")).toHaveLength(1);
  });

  test("a sweep swap that fails for another reason ends the run failed", async () => {
    const e = await laneRun({
      prepare: async (fake) => {
        await seedMerged(fake, "parked");
        // Every swap loses its race, so the CAS loop runs out of tries.
        fake.control.beforeSwap(() => void fake.control.writeForeignLedger({ message: "noise [skip ci]", writes: {}, deletes: [] }));
      },
    });
    expect(e.outcome).toBe("failed");
    expect(e.record?.state).toBe("parked");
    expect(e.journal.filter((x) => x.type === "unit")).toEqual([]);
  });
});

describe("runLaneProcess with the review gate (Story 3.5)", () => {
  const swapsOf = (e: LaneRun) => e.fake.control.ledgerLog().map((c) => editName(c.message));
  const mergeOnce = (fake: FakeForge) => void fake.control.mergeQueueHead();
  const reviewedHeads = (e: LaneRun) => e.events.filter((x) => x === "postReview").length;

  test("review passes: CI, one review round, passed_sha the head, then the merge step enqueues with enqueued_sha the head", async () => {
    const e = await laneRun({ onQueueSleep: mergeOnce });
    expect(e.outcome).toBe("progress");
    expect(e.reviewPrompts).toHaveLength(1);
    expect(reviewedHeads(e)).toBe(1);
    // CI before the review, the review before the enqueue.
    expect(e.events.indexOf("checks")).toBeLessThan(e.events.indexOf("postReview"));
    expect(e.events.indexOf("postReview")).toBeLessThan(e.events.indexOf("enqueue"));
    expect(e.record).toMatchObject({ state: "merged", loopbacks: 0, ci_fixes: 0 });
    expect(e.record?.passed_sha).toBe(e.record?.head_sha ?? "none");
    expect(e.record?.enqueued_sha).toBe(e.record?.head_sha ?? "none");
    expect(e.enqueuedAt).toEqual([e.record?.head_sha ?? "none"]);
  });

  test("loopback: a blocking round: loopbacks 1, the loopback session's prompt names findings_path holding the finding; the fix pushed, then CI and review again", async () => {
    const e = await laneRun({ reviews: [reviewPass([BLOCKER, NIT]), reviewPass()], onQueueSleep: mergeOnce });
    expect(e.outcome).toBe("progress");
    expect(e.prompts).toHaveLength(2);
    expect(e.prompts[1]).toContain("Revise Story 1.1");
    expect(e.prompts[1]).toMatch(/review-findings\.md`/);
    expect(e.findings[0]).toBeNull();
    expect(e.findings[1]).toContain("- high, blocking, `src/a.ts`: the loop never ends.");
    expect(e.findings[1]).toMatch(/^# Review findings for Story 1\.1 at [0-9a-f]{40}\n/);
    expect(e.checksAsked).toHaveLength(2);
    expect(e.reviewPrompts).toHaveLength(2);
    expect(e.enqueuedAt).toHaveLength(1);
    expect(e.record).toMatchObject({ state: "merged", loopbacks: 1, ci_fixes: 0 });
    expect(e.enqueuedAt[0]).toBe(e.checksAsked[1] ?? "none");
    expect(swapsOf(e)).toContain("loopback");
  });

  test.each([
    ["blocking", reviewPass([BLOCKER])],
    ["passing", reviewPass()],
  ] as const)("loopback cap: after 2 loopbacks the next round (%s) parks blocked review-cap in the owner's inbox; no enqueue", async (_name, third) => {
    const e = await laneRun({ reviews: [reviewPass([BLOCKER]), reviewPass([BLOCKER]), third] });
    expect(e.outcome).toBe("progress");
    expect(e.reviewPrompts).toHaveLength(3);
    expect(e.prompts).toHaveLength(3);
    expect(e.record).toMatchObject({ state: "parked", loopbacks: 2, park: { kind: "blocked", reason: "review-cap", inbox_owner: ALICE.owner } });
    expect(e.enqueuedAt).toEqual([]);
    expect(e.events).not.toContain("enqueue");
  });

  test("CI fix: CI fails once, the fix pushed: ci_fixes 1, loopbacks 0; the review runs on the new head", async () => {
    const e = await laneRun({ ciFails: (n) => n === 0, onQueueSleep: mergeOnce });
    expect(e.outcome).toBe("progress");
    expect(e.prompts).toHaveLength(2);
    expect(e.prompts[1]).toContain("Repair Story 1.1");
    expect(e.reviewPrompts).toHaveLength(1);
    const [first, second] = e.checksAsked;
    expect(first).not.toBe(second);
    expect(e.record).toMatchObject({ state: "merged", ci_fixes: 1, loopbacks: 0, reviewed_sha: second, passed_sha: second, enqueued_sha: second });
  });

  test("conflict session: a merge that needs a session: ci_fixes 1, loopbacks 0; the review runs on the new head", async () => {
    const e = await laneRun({
      merges: [(fake) => ({ kind: "needs-session", candidate_sha: fake.control.makeCommit(), paths: ["src/s0/a.ts"], lockfiles: [] })],
      onQueueSleep: mergeOnce,
    });
    expect(e.outcome).toBe("progress");
    expect(e.prompts).toHaveLength(2);
    expect(e.reviewPrompts).toHaveLength(1);
    expect(e.record).toMatchObject({ state: "merged", ci_fixes: 1, loopbacks: 0 });
    expect(e.record?.passed_sha).toBe(e.record?.head_sha ?? "none");
  });

  test("ejection, same head: CI again, no review, enqueued again", async () => {
    let ejectedOnce = false;
    const e = await laneRun({
      onQueueSleep: (fake) => {
        const [pr] = fake.control.queue();
        if (pr === undefined) return;
        if (!ejectedOnce) {
          ejectedOnce = true;
          fake.control.eject(pr);
        } else fake.control.mergeQueueHead();
      },
    });
    expect(e.outcome).toBe("progress");
    expect(e.checksAsked).toHaveLength(2);
    expect(e.reviewPrompts).toHaveLength(1);
    expect(e.events.filter((x) => x === "enqueue")).toHaveLength(2);
    expect(e.record).toMatchObject({ state: "merged", attempts: 1 });
  });

  test("takeover: a stale claimed record whose review blocked: the review SHAs cleared, so a new review passes before any enqueue", async () => {
    let head = "";
    const e = await laneRun({
      prepare: async (fake) => {
        head = fake.control.makeCommit();
        value(await fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts()));
        const number = value(await fake.forge.openPr({ branch: BRANCH, base: "main", title: "t", body: "b" }, opts())).number;
        const stale = rec({
          unit: UNIT,
          globs: ["src/s0/**"],
          owner: BOB.owner,
          host: BOB.host,
          lane: BOB.lane,
          generation: 2,
          heartbeat_at: "2026-10-23T09:00:00Z",
          pr: number,
          pr_owner: BOB.owner,
          head_sha: head,
          reviewed_sha: head,
          passed_sha: null,
          loopbacks: 1,
          builder_providers: ["anthropic"],
        });
        fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([stale]), deletes: [] });
      },
      onQueueSleep: mergeOnce,
    });
    expect(e.outcome).toBe("progress");
    const swaps = swapsOf(e);
    expect(swaps).toContain("takeOverStale");
    expect(e.reviewPrompts.length).toBeGreaterThanOrEqual(1);
    expect(e.events.indexOf("postReview")).toBeGreaterThan(-1);
    expect(e.events.indexOf("postReview")).toBeLessThan(e.events.indexOf("enqueue"));
    expect(e.record).toMatchObject({ state: "merged", owner: ALICE.owner, generation: 3, loopbacks: 1 });
  });

  test("a STOP during the loopback session's usage-limit sleep: outcome stop, released with attempts unchanged, no lane stop", async () => {
    const e = await laneRun({ reviews: [reviewPass([BLOCKER])], limitAt: 1, waitEnds: ["stopped"] });
    expect(e.outcome).toBe("stop");
    expect(e.laneStop).toBeUndefined();
    expect(e.prompts).toHaveLength(2);
    expect(e.prompts[1]).toContain("Revise Story 1.1");
    expect(e.record).toMatchObject({ state: "released", attempts: 0, loopbacks: 1 });
    expect(e.events).not.toContain("enqueue");
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units[0]?.reason).toContain("STOP during a usage-limit sleep");
  });

  test("revoked allowance, session: fresh main's policy drops the lane's adapter before the session: no sandbox run, a failed attempt naming it", async () => {
    const e = await laneRun({ prepare: async (fake) => void fake.control.setMain(mainFiles({ adapters: ["codex"] })) });
    expect(e.outcome).toBe("failed");
    expect(e.prompts).toEqual([]);
    expect(e.record).toMatchObject({ state: "released", attempts: 1 });
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units[0]?.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
  });

  test("revoked allowance, enqueue: the policy drops the adapter after the review and before the merge step: no enqueue, a failed attempt", async () => {
    const e = await laneRun({ onReview: (_n, fake) => void fake.control.setMain(mainFiles({ adapters: ["codex"] })) });
    expect(e.outcome).toBe("failed");
    expect(e.reviewPrompts).toHaveLength(1);
    expect(e.events).not.toContain("enqueue");
    expect(e.record).toMatchObject({ state: "released", attempts: 1 });
    const units = e.journal.filter((x): x is UnitJournalRecord => x.type === "unit");
    expect(units[0]?.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml");
  });
});
