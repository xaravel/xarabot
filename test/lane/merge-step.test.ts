import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import type { NextStory } from "../../src/core/next/next.ts";
import { err, ok } from "../../src/core/result.ts";
import { unitPath, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { DiffPaths, DiffPathsRequest } from "../../src/lane/diff-paths.ts";
import { approvalComment, createMergeStep, type MergeStepDeps, type MergeStepInput, type MergeStepOutput } from "../../src/lane/merge-step.ts";
import type { Forge } from "../../src/ports/forge.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import { createCiStep } from "../../src/lane/ci-step.ts";
import type { Committer } from "../../src/lane/committer.ts";
import { runLaneProcess } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { Merger } from "../../src/lane/merger.ts";
import { createPrStep } from "../../src/lane/pr-step.ts";
import type { Workspace } from "../../src/lane/workspace.ts";
import type { Agent } from "../../src/ports/agent.ts";
import type { LaunchSpec, Sandbox } from "../../src/ports/sandbox.ts";
import { ALICE, rec, tip } from "../core/ledger/fixtures.ts";

// ------------------------------------------------------------------ world

const AUTHORITY = "docs/standing-authority.md";
const SPEC_DIR = "_bmad-output/implementation-artifacts";
const STATUS = `${SPEC_DIR}/sprint-status.yaml`;
const UNIT = "story:1.1";
const BRANCH = "story/1.1";
const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const opts = () => ({ signal: AbortSignal.timeout(5000) });

type MainOpts = { readonly authority?: boolean; readonly ownerPaths?: readonly string[] };

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const policy = ["schema_version: 1"];
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
  const record = rec({ unit: UNIT, globs: ["src/s0/**"], pr, pr_owner: "alice", head_sha: head, base_sha: main, ...o.record });
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
        identity: ALICE,
        repo: "xaravel/xarabot",
        now: () => t,
        sleep: async (ms) => {
          const i = sleeps.length;
          sleeps.push(ms);
          t += ms;
          await o.onSleep?.(i, ms, w);
        },
        random: () => 0,
        ...deps,
      })({ unit: STORY, record, signal: budget.signal, log: (text) => logs.push(text), ...input }),
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

describe("approvalComment", () => {
  test("starts with 🤖, names the gated paths and the Maintainer's hand-queue", () => {
    const text = approvalComment({ storyId: "1.1", paths: ["src/a.ts", ".github/x.yml"] });
    expect(text.startsWith("🤖 Story 1.1:")).toBe(true);
    expect(text).toContain("src/a.ts, .github/x.yml");
    expect(text).toContain("The Maintainer approves it and queues it by hand.");
  });

  test("sanitizes mentions and closing keywords out of path names", () => {
    const text = approvalComment({ storyId: "1.1", paths: ["@someone/fixes #3.md"] });
    expect(text).not.toContain("@someone");
    expect(text).not.toMatch(/fixes #3/i);
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

// -------------------------------------------------------------- enqueue

describe("enqueue", () => {
  test("an ungated PR: heartbeat passed_sha, startMerging, then enqueue at its head; merged when the queue merges it", async () => {
    const w = await world({ onSleep: mergeAtFirst });
    const out = await w.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(w.events.slice(0, 3)).toEqual(["ledgerSwap heartbeat", "ledgerSwap startMerging", "enqueue"]);
    expect(w.events.at(-1)).toBe("ledgerSwap markMerged");
    expect(w.events).not.toContain("dequeue");
    const after = await w.ledger();
    expect(after?.state).toBe("merged");
    expect(after?.passed_sha).toBe(w.head);
    expect(w.fake.control.comments(w.pr)).toEqual([]);
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
};

/**
 * One lane process with a stub agent, the real PR, CI and merge steps on the
 * fake forge, and `prepare` run before it (to seed state). Every head passes
 * CI; `onQueueSleep` runs at each of the merge step's sleeps.
 */
async function laneRun(o: { readonly prepare?: (fake: FakeForge) => Promise<void>; readonly onQueueSleep?: (fake: FakeForge) => void } = {}): Promise<LaneRun> {
  const root = mkdtempSync(join(tmpdir(), "xarabot-merge-lane-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: mainFiles() });
  await o.prepare?.(fake);
  const events: string[] = [];
  const forge = spied(fake, events);
  const checksAsked: string[] = [];
  const realChecks = forge.checks;
  (forge as { checks: Forge["checks"] }).checks = async (sha, callOpts) => {
    checksAsked.push(sha);
    fake.control.setChecks(sha, [{ name: "test", status: "completed", conclusion: "success" }]);
    return realChecks(sha, callOpts);
  };
  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (unit, settings, resultPath) =>
      ok({ argv: ["stub-agent", settings.effort, resultPath], stdin: unit.kind === "fresh" ? unit.prompt : "resume", vendor: "claude", vendorHomeEnv: "STUB_HOME", credential: { file: "token", env: "STUB_TOKEN" }, apiHosts: ["api.example.com"] } as LaunchSpec),
    parseUsage: () => ({ sessionId: null, model: "m", tokens: null, cost: null, usageLimit: null }),
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
  };
  const sandbox: Sandbox = {
    async run(_spec, profile) {
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
  const merger: Merger = { merge: async () => ok({ kind: "up-to-date" }) };
  let t = T0;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const prStep = createPrStep({ forge, committer, identity: ALICE, repo: LANE.repo, sleep: async () => {}, random: () => 0 });
  const ciStep = createCiStep({ forge, merger, identity: ALICE, repo: LANE.repo, now, sleep, random: () => 0 });
  const mergeStep = createMergeStep({
    forge,
    diffPaths: async () => ok(["src/s0/a.ts"]),
    identity: ALICE,
    repo: LANE.repo,
    now,
    sleep: async (ms) => {
      t += ms;
      o.onQueueSleep?.(fake);
    },
    random: () => 0,
  });
  const r = await runLaneProcess({
    forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop: join(root, "home", ".xarabot", "STOP") }),
    workspace,
    prStep,
    ciStep,
    mergeStep,
    laneDir,
    identity: ALICE,
    lane: LANE,
    pid: 12345,
    now,
    sleep: async () => {},
    random: () => 0,
    waiter: { wait: async () => ({ end: "elapsed" as const }) },
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
  return { outcome: r.outcome, fake, events, checksAsked, journal, record: l.value.units.get(UNIT) };
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
