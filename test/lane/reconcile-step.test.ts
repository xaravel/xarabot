import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import { assembleSnapshot } from "../../src/core/next/snapshot.ts";
import { parseSprintStatus } from "../../src/core/next/sprint-status.ts";
import { err, ok, type Result } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord } from "../../src/core/schemas/journal.ts";
import { unitPath, type CoordinatorRecord, type LaneIdentity, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck, ForgeReview } from "../../src/ports/forge.ts";
import { runCoordinatorProcess, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import { readsPath, type PrStepOutput } from "../../src/lane/lane-process.ts";
import { fenceForge, newTrack } from "../../src/lane/session.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { ReconcileCommit, ReconcileCommitRequest, ReconcileCommitter } from "../../src/lane/reconcile-commit.ts";
import { createReconcileStep, reconcileBranch, reconcilePrText, reparkComment, type ReconcileStepDeps } from "../../src/lane/reconcile-step.ts";
import type { WorkspaceErrorKind } from "../../src/lane/workspace.ts";
import { COORD, rec, tip } from "../core/ledger/fixtures.ts";
import { checkGraphChange } from "../../src/core/graph/graph-gate.ts";
import { parseRetroGates } from "../../src/core/graph/retro-gates.ts";
import { graphFiles, GRAPH_STATUS, stubGraphTrees, treeOf, unchangedGraph, type StubAnswer } from "./graph-stub.ts";
import { headPassedGate } from "../../src/lane/passed-gate.ts";

// ------------------------------------------------------------------ world

const FORGE_NOW = "2026-10-23T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const MIN = 60_000;
const AUTHORITY = "docs/standing-authority.md";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const EPICS = "_bmad-output/planning-artifacts/epics.md";
const U = "reconcile:5";
const BRANCH = "xarabot/reconcile-5";
const PASS: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "success" }];
const FAIL: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "failure" }];
const opts = () => ({ signal: AbortSignal.timeout(5000) });
const minutesBefore = (m: number) => new Date(T0 - m * MIN).toISOString();

type MainOpts = {
  /** `sprint-status.yaml`'s text; `null` leaves it out. */
  readonly status?: string | null;
  readonly policy?: readonly string[];
  /** Story 1.2 in `epics.md` with a manifest. */
  readonly story12?: boolean;
  /** More `main` files, by path. */
  readonly extra?: Readonly<Record<string, string>>;
};

const STATUS_BACKLOG = "# sprint status\ndevelopment_status:\n  epic-1: in-progress\n  1-1-first: backlog\n";
const STATUS_DONE = "# sprint status\ndevelopment_status:\n  epic-1: in-progress\n  1-1-first: done\n";
/** `STATUS_BACKLOG` once reconcile sets Epic 1's last Story done: the Epic's key goes done in the same edit. */
const STATUS_EPIC_DONE = "# sprint status\ndevelopment_status:\n  epic-1: done\n  1-1-first: done\n";

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const stories = o.story12 === true ? "### Story 1.1: Story 1.1\n\nBody.\n\n### Story 1.2: Story 1.2\n\nBody.\n" : "### Story 1.1: Story 1.1\n\nBody.\n";
  const files: Record<string, string> = {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "v1"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "manifests:", "  dir: stories", ""].join("\n"),
    ".xarabot/policy.yaml": ["schema_version: 1", "unattended_adapters: [claude]", ...(o.policy ?? []), ""].join("\n"),
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    [EPICS]: `# Epics\n\n## Epic 1: One\n\n${stories}`,
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: Story 1.1\nglobs: ["src/a/**"]\n---\n',
  };
  if (o.story12 === true) files["stories/1.2.md"] = '---\nstory_id: "1.2"\nepic: 1\nsprint_key: 1-2-second\ntitle: Story 1.2\nglobs: ["src/b/**"]\n---\n';
  const status = o.status === undefined ? STATUS_BACKLOG : o.status;
  if (status !== null) files[STATUS] = status;
  Object.assign(files, o.extra ?? {});
  return files;
}

/** A coordinator-held record. */
const coord = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: FORGE_NOW, ...over });

/** This run's claimed record, as the coordinator process claims it. */
const OWN = coord(U, { state: "claimed" });

/** The coordinator claim, with today's digest already posted (so only the Story 4.2 cases see a digest due). */
function claimRec(over: Partial<CoordinatorRecord> = {}): CoordinatorRecord {
  return { schema_version: 2, ...COORD, lane: "coordinator", generation: 1, heartbeat_at: FORGE_NOW, digest_posted_at: FORGE_NOW, rulings_cursor: null, ...over };
}

/** The edit name in a ledger commit message, `ledger: <name> <unit> [skip ci]`. */
const editName = (message: string) => /^ledger: (\S+ \S+)/.exec(message)?.[1] ?? message;

/**
 * The fake forge, recording each call in order; a ledger swap is
 * `ledgerSwap <edit> <unit>`. A snapshot reading `main` files (the fresh-main
 * re-check, not a swap's tip read) is recorded only when `mainReads`. The
 * inbox step's calls (Story 4.2) and the rulings step's read (Story 4.5) are
 * recorded only when `inboxCalls`: their own cases cover them.
 */
const INBOX_CALLS: readonly string[] = ["inboxes", "openInbox", "setInboxBody", "inboxComment", "readRulings"];
function spied(fake: FakeForge, events: string[], mainReads = false, inboxCalls = false): Forge {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(fake.forge)) {
    out[name] = (...args: unknown[]) => {
      if (name === "ledgerSwap") events.push(`ledgerSwap ${editName((args[1] as { message: string }).message)}`);
      else if (INBOX_CALLS.includes(name) && !inboxCalls) {
        // Left out: the inbox step's own cases record its calls.
      } else if (name !== "snapshot" || (mainReads && (args[0] as { read?: unknown }).read !== undefined)) events.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as Forge;
}

/** A PR on `branch` at a fresh head; merged through the queue when `merge`. */
async function prOn(fake: FakeForge, branch: string, merge = false): Promise<{ number: number; head: string }> {
  const head = fake.control.makeCommit();
  expect((await fake.forge.pushBranch({ branch, expected_sha: null, sha: head }, opts())).ok).toBe(true);
  const opened = await fake.forge.openPr({ branch, base: "main", title: "t", body: "b" }, opts());
  if (!opened.ok) throw new Error(opened.error.message);
  if (merge) {
    expect((await fake.forge.enqueue(opened.value.number, head, opts())).ok).toBe(true);
    expect(fake.control.mergeQueueHead()?.number).toBe(opened.value.number);
  }
  return { number: opened.value.number, head };
}

type Fake = {
  readonly fake: FakeForge;
  readonly events: string[];
  readonly logs: string[];
  readonly sleeps: number[];
  readonly commits: ReconcileCommitRequest[];
  /** The head the fake committer returns; its checks are set to pass unless a test says otherwise. */
  readonly head: string;
  now(): number;
  input(): Promise<CoordinatorStepInput>;
  run(deps?: Partial<ReconcileStepDeps>): Promise<PrStepOutput>;
  ledger(): Promise<Map<string, UnitRecord>>;
  messages(): string[];
};

type FakeOpts = MainOpts & {
  /** The seeded `coordinator.json` fields; default today's digest already posted. */
  readonly coordinator?: Partial<CoordinatorRecord>;
  readonly committer?: (r: ReconcileCommitRequest) => Result<ReconcileCommit, WorkspaceErrorKind>;
  readonly onSleep?: (i: number, f: Fake) => void | Promise<void>;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake forge with `main` and the ledger seeded with `records` (this run's own record first) by `seed`. */
async function setup(o: FakeOpts = {}, seed: (fake: FakeForge) => Promise<readonly UnitRecord[]> = async () => []): Promise<Fake> {
  const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles(o) });
  const records = await seed(fake);
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([OWN, ...records], { [COORDINATOR_PATH]: serializeCoordinator(claimRec(o.coordinator)) }), deletes: [] });
  const events: string[] = [];
  const forge = spied(fake, events);
  const logs: string[] = [];
  const sleeps: number[] = [];
  const commits: ReconcileCommitRequest[] = [];
  const head = fake.control.makeCommit();
  fake.control.setChecks(head, PASS);
  let t = T0;
  const committer: ReconcileCommitter = {
    async commit(r) {
      commits.push(r);
      return o.committer?.(r) ?? ok({ head_sha: head, base_sha: r.ontoSha });
    },
  };
  const f: Fake = {
    fake,
    events,
    logs,
    sleeps,
    commits,
    head,
    now: () => t,
    async input() {
      const s = await fake.forge.snapshot({ ...opts(), read: readsPath });
      if (!s.ok) throw new Error(s.error.message);
      const a = assembleSnapshot({
        repo: "xaravel/xarabot",
        now: s.value.now,
        tree: [...s.value.main.tree],
        files: { ...s.value.main.files },
        main_sha: s.value.main.sha,
        blob_shas: s.value.main.blob_shas,
        ledger_tip: s.value.ledger.tip,
        ledger_files: s.value.ledger.files,
        prs: s.value.prs,
        escalations: null,
        lane: COORD,
        role: "coordinator",
      });
      if (!a.ok) throw new Error(a.error.message);
      const record = a.value.ledger.units.find((r) => r.unit === U) as UnitRecord;
      return {
        unit: { unit: U, kind: "reconcile", globs: [], expect_generation: null, take_over: null, pr: null, why: "test" },
        record,
        snapshot: a.value,
        files: s.value.main.files,
        signal: new AbortController().signal,
        log: (text) => logs.push(text),
        track: newTrack({ unit: U, startedMs: T0, logName: "reconcile.log", state: "claimed" }),
      };
    },
    async run(deps = {}) {
      const input = await f.input();
      events.length = 0;
      return createReconcileStep({
        forge,
        committer,
        graphTrees: unchangedGraph(),
        identity: COORD,
        repo: "xaravel/xarabot",
        agent: "claude",
        passed: headPassedGate,
        now: () => t,
        sleep: async (ms) => {
          const i = sleeps.length;
          sleeps.push(ms);
          t += ms;
          await o.onSleep?.(i, f);
        },
        random: () => 0,
        ...deps,
      })(input);
    },
    async ledger() {
      const s = await fake.forge.snapshot(opts());
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return new Map(l.value.units);
    },
    messages: () => fake.control.ledgerLog().map((c) => c.message),
  };
  return f;
}

const swaps = (events: readonly string[]) => events.filter((e) => e.startsWith("ledgerSwap ")).map((e) => e.slice("ledgerSwap ".length));
const stateOf = async (f: Fake, unit: string) => (await f.ledger()).get(unit)?.state ?? "none";

/** The one PR on `branch`, or `null`. */
async function prOnBranch(f: Fake, branch: string) {
  const r = await f.fake.forge.listPrsByBranch(branch, opts());
  if (!r.ok) throw new Error(r.error.message);
  return r.value.at(-1) ?? null;
}

/** `branch`'s head on the forge, or `null` once it is deleted. */
async function branchHead(f: Fake, branch: string) {
  const r = await f.fake.forge.branchHead(branch, opts());
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

// ------------------------------------------------------------------ texts

describe("reconcile texts", () => {
  test("the branch is <branches.xarabot>reconcile-<n>", () => {
    expect(reconcileBranch("xarabot/", "reconcile:12")).toBe("xarabot/reconcile-12");
  });

  test("the PR text names the unit and each change, sanitized, and says no agent wrote it", () => {
    const t = reconcilePrText(U, [{ path: STATUS, summary: ["1-1-first: backlog -> done", "@someone fixes #3: added as done"] }]);
    expect(t.title).toBe("reconcile:5: sprint status for merged units");
    expect(t.body.startsWith("🤖 reconcile:5:")).toBe(true);
    expect(t.body).toContain("no agent session");
    expect(t.body).toContain("- 1-1-first: backlog -> done");
    expect(t.body).not.toContain("@someone");
    expect(t.body).toContain("the runner queues this PR once its checks pass, unless a Protected Path gates it.");
    expect(t.message.startsWith(`${t.title}\n\n- 1-1-first: backlog -> done\n`)).toBe(true);
  });

  test.each([
    [
      "not-queued",
      "🤖 Unit story:1.1: this PR is not in the merge queue and is parked awaiting approval again.\n\nA new approving review of its current head from its owner re-queues it.\n",
    ],
    [
      "conflict",
      "🤖 Unit story:1.1: the merge queue refused this PR, and it is parked awaiting approval again.\n\n" +
        "Once it can merge, a new approving review of its current head from its owner re-queues it. A pushed fix moves its head: then queue it by hand or run `xarabot rule rebuild`.\n",
    ],
    [
      "head-moved",
      "🤖 Unit story:1.1: this PR's head moved after it was approved, and it is parked awaiting approval again.\n\nA moved head is never queued automatically: queue it by hand or run `xarabot rule rebuild`.\n",
    ],
    ["closed", "🤖 Unit story:1.1: this PR is closed and is parked awaiting approval again.\n\nReopen it, then approve its current head again, or run `xarabot rule rebuild`.\n"],
  ] as const)("the re-park comment for cause %s", (cause, text) => {
    expect(reparkComment("story:1.1", cause)).toBe(text);
  });

  test("the re-park comment sanitizes the unit", () => {
    expect(reparkComment("@someone", "closed")).not.toContain("@someone");
  });

  test("the PR body and title are capped at the forge's limits", () => {
    const t = reconcilePrText(`reconcile:${"9".repeat(300)}`, [{ path: STATUS, summary: Array.from({ length: 3000 }, (_, i) => `k-${i}-${"x".repeat(20)}: backlog -> done`) }]);
    expect(t.title.length).toBe(256);
    expect(t.body.length).toBe(65_536);
    expect(t.body.endsWith("\n\n[truncated by xarabot]")).toBe(true);
  });
});

// ------------------------------------------------------------------ the matrix

describe("createReconcileStep: the matrix", () => {
  test("Story merged: merged; a PR from xarabot/reconcile-<n> setting the key, and its Epic's as the last Story, done; enqueued after CI with no approval; U merging", async () => {
    let story = 0;
    const f = await setup({}, async (fake) => {
      story = (await prOn(fake, "story/1.1", true)).number;
      return [rec({ unit: "story:1.1", globs: [], state: "parked", pr: story, park: { kind: "blocked", reason: "other", inbox_owner: "alice", globs_held: [] } })];
    });
    const main = (await f.input()).snapshot.main_sha;
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(await stateOf(f, "story:1.1")).toBe("merged");
    // The commit: only sprint-status.yaml, onto the snapshot's main, 1-1-first and epic-1 done, the comment kept.
    expect(f.commits).toHaveLength(1);
    const c = f.commits[0] as ReconcileCommitRequest;
    expect(c.ontoSha).toBe(main);
    expect(c.unit).toBe(U);
    expect(Object.keys(c.files)).toEqual([STATUS]);
    expect(c.files[STATUS]).toBe(STATUS_EPIC_DONE);
    // The PR, its record and the queue.
    const pr = await prOnBranch(f, BRANCH);
    expect(pr).toMatchObject({ state: "open", head_sha: f.head, base: "main", title: "reconcile:5: sprint status for merged units" });
    expect(f.fake.control.queue()).toEqual([pr?.number ?? -1]);
    expect(f.fake.control.comments(pr?.number ?? 0)).toEqual([]);
    const own = (await f.ledger()).get(U);
    // No review for a reconcile PR: its enqueue is recorded in enqueued_sha, and passed_sha stays unset (Story 3.5).
    expect(own).toMatchObject({ state: "merging", pr: pr?.number, pr_owner: COORD.owner, head_sha: f.head, base_sha: main, passed_sha: null, enqueued_sha: f.head, attempts: 0 });
    // Fenced: a heartbeat before the push, the PR, and the enqueue.
    expect(f.events).toEqual([
      "ledgerSwap markMerged story:1.1",
      "ledgerSwap heartbeat reconcile:5",
      "pushBranch",
      "ledgerSwap heartbeat reconcile:5",
      "openPr",
      "ledgerSwap heartbeat reconcile:5",
      "checks",
      "ledgerSwap heartbeat reconcile:5",
      "ledgerSwap startMerging reconcile:5",
      "enqueue",
    ]);
    expect(out.reason).toContain(`PR #${pr?.number} enqueued`);
  });

  test("Nothing to do: U merged with no PR; the older merged reconcile records are deleted", async () => {
    const f = await setup({ status: STATUS_DONE }, async () => [
      coord("reconcile:3", { state: "merged", heartbeat_at: minutesBefore(30) }),
      coord("reconcile:4", { state: "merged", heartbeat_at: minutesBefore(12) }),
    ]);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(out.reason).toContain("no status change");
    const l = await f.ledger();
    expect([...l.keys()]).toEqual([U]);
    expect(l.get(U)).toMatchObject({ state: "merged", pr: null });
    expect(f.commits).toEqual([]);
    expect(swaps(f.events)).toEqual(["deleteMerged reconcile:3", "finishRecurring reconcile:5", "deleteMerged reconcile:4"]);
    expect(f.events.filter((e) => !e.startsWith("ledgerSwap"))).toEqual([]);
  });

  test("Done on main: the Story's record is deleted; U merged with no PR", async () => {
    const f = await setup({ status: STATUS_DONE }, async () => [rec({ unit: "story:1.1", globs: [], state: "merged", pr: null })]);
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect((await f.ledger()).has("story:1.1")).toBe(false);
    expect(f.commits).toEqual([]);
  });

  test("Earlier PR open: markMerged only; no PR; U merged; the parked run is left", async () => {
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      const r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [
        rec({ unit: "story:1.1", globs: [], state: "released", pr: story }),
        coord("reconcile:3", { state: "parked", pr: r3, park: { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] } }),
      ];
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(out.reason).toContain("no new reconcile PR this run");
    expect(await stateOf(f, "story:1.1")).toBe("merged");
    expect(await stateOf(f, "reconcile:3")).toBe("parked");
    expect(f.commits).toEqual([]);
    expect(await prOnBranch(f, BRANCH)).toBeNull();
  });

  test("Earlier PR queued: unchanged; no new PR", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      r3 = await prOn(fake, "xarabot/reconcile-3");
      expect((await fake.forge.enqueue(r3.number, r3.head, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head }), rec({ unit: "story:1.1", globs: [], state: "parked", pr: story, park: { kind: "blocked", reason: "other", inbox_owner: "alice", globs_held: [] } })];
    });
    const before = (await f.ledger()).get("reconcile:3");
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect((await f.ledger()).get("reconcile:3")).toEqual(before);
    expect(f.fake.control.queue()).toEqual([r3.number]);
    expect(f.events).toContain("queueState");
    expect(f.commits).toEqual([]);
  });

  test("Earlier PR merged: the record becomes merged, then is deleted as superseded; U is the only merged reconcile record", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      const r3 = await prOn(fake, "xarabot/reconcile-3", true);
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head, heartbeat_at: minutesBefore(40) })];
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(swaps(f.events)).toEqual(["markMerged reconcile:3", "finishRecurring reconcile:5", "deleteMerged reconcile:3"]);
    expect([...(await f.ledger()).keys()]).toEqual([U]);
  });

  test("Earlier PR ejected (just closed): the PR is closed, the record released with attempts unchanged; it no longer stops this run's own PR", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      const story = (await prOn(fake, "story/1.1", true)).number;
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head, attempts: 1 }), rec({ unit: "story:1.1", globs: [], state: "released", pr: story })];
    });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "released", attempts: 1, pr: r3.number, owner: COORD.owner });
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect(f.events.slice(0, 6)).toEqual([
      "ledgerSwap markMerged story:1.1",
      "queueState",
      "ledgerSwap heartbeat reconcile:5",
      "closePr",
      "ledgerSwap releaseDisposable reconcile:3",
      "deleteBranch",
    ]);
    // Epic 2 retro item 21: the closed PR's branch is deleted once its record is released.
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
    expect(f.commits).toHaveLength(1);
    expect(await prOnBranch(f, BRANCH)).toMatchObject({ state: "open", head_sha: f.head });
  });

  test("an open PR the ledger work could not close still stops a new PR", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      const story = (await prOn(fake, "story/1.1", true)).number;
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head }), rec({ unit: "story:1.1", globs: [], state: "released", pr: story })];
    });
    f.fake.control.injectError("closePr", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(out.reason).toContain(`reconcile:3's PR #${r3.number} is open: no new reconcile PR this run`);
    expect(await stateOf(f, "reconcile:3")).toBe("merging");
    expect(f.commits).toEqual([]);
    expect(await prOnBranch(f, BRANCH)).toBeNull();
  });

  test("Earlier PR closed: released with attempts unchanged; no closePr sent", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      const r3 = await prOn(fake, "xarabot/reconcile-3");
      expect((await fake.forge.closePr(r3.number, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head, attempts: 1 })];
    });
    await f.run();
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "released", attempts: 1 });
    expect(f.events).toContain("queueState");
    expect(f.events).not.toContain("closePr");
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
  });

  test("Earlier PR unknown to the queue (not-found): released", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      const r3 = await prOn(fake, "xarabot/reconcile-3");
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head })];
    });
    f.fake.control.injectError("queueState", { kind: "not-found", message: "no such PR" });
    await f.run();
    expect(await stateOf(f, "reconcile:3")).toBe("released");
  });

  test("Earlier PR merged after the snapshot: queueState says merged, so merged, not released", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      const r3 = await prOn(fake, "xarabot/reconcile-3");
      expect((await fake.forge.enqueue(r3.number, r3.head, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head })];
    });
    const forge: Forge = {
      ...f.fake.forge,
      queueState: (pr, o) => {
        f.fake.control.mergeQueueHead();
        return f.fake.forge.queueState(pr, o);
      },
    };
    await f.run({ forge });
    expect(await stateOf(f, "reconcile:3")).toBe("merged");
    expect(f.messages()).toContain("ledger: markMerged reconcile:3 [skip ci]");
    expect(f.messages()).not.toContain("ledger: releaseDisposable reconcile:3 [skip ci]");
  });

  test("Earlier PR queued at another head: dequeued, closed and released", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      expect((await fake.forge.enqueue(r3.number, r3.head, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: "d".repeat(40), passed_sha: "d".repeat(40) })];
    });
    await f.run();
    expect(f.events.slice(0, 6)).toEqual(["queueState", "ledgerSwap heartbeat reconcile:5", "dequeue", "ledgerSwap heartbeat reconcile:5", "closePr", "ledgerSwap releaseDisposable reconcile:3"]);
    expect(f.fake.control.queue()).toEqual([]);
    expect(await stateOf(f, "reconcile:3")).toBe("released");
  });

  test.each([
    ["with its PR open: closed, then deleted", true],
    ["with its PR closed: deleted", false],
  ] as const)("Released record %s", async (_name, keepOpen) => {
    let r3 = 0;
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      if (!keepOpen) expect((await fake.forge.closePr(r3, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "released", pr: r3 })];
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect((await f.ledger()).has("reconcile:3")).toBe(false);
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect(swaps(f.events)).toContain("deleteReleasedRecurring reconcile:3");
    expect(f.events.includes("closePr")).toBe(keepOpen);
    // The branch goes first, fenced, then the record (Epic 2 retro item 37).
    const at = f.events.indexOf("deleteBranch");
    expect(f.events.slice(at - 1, at + 2)).toEqual(["ledgerSwap heartbeat reconcile:5", "deleteBranch", "ledgerSwap deleteReleasedRecurring reconcile:3"]);
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
  });

  test("Dead run: a stale claimed reconcile record is released with attempts + 1; its open PR closed", async () => {
    let r3 = 0;
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [coord("reconcile:3", { state: "claimed", pr: r3, heartbeat_at: minutesBefore(30) })];
    });
    await f.run();
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "released", attempts: 1 });
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
  });

  test.each([
    // A released record's branch is deleted, fenced, before the record (Epic 2 retro item 37); a dead run's after its release.
    ["a released record", "released", ["ledgerSwap heartbeat reconcile:5", "deleteBranch", "ledgerSwap deleteReleasedRecurring reconcile:3"]],
    ["a dead run's record", "claimed", ["ledgerSwap releaseDeadReconcile reconcile:3", "deleteBranch"]],
  ] as const)("Orphan PR: %s with no pr, a PR open on its branch: found by listing the branch, closed, then the record acted on", async (_name, state, after) => {
    let orphan = 0;
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      orphan = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [coord("reconcile:3", { state, pr: null, heartbeat_at: minutesBefore(30) })];
    });
    await f.run();
    expect((await prOnBranch(f, "xarabot/reconcile-3"))).toMatchObject({ number: orphan, state: "closed" });
    expect(f.events.slice(0, 3 + after.length)).toEqual(["listPrsByBranch", "ledgerSwap heartbeat reconcile:5", "closePr", ...after]);
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
    if (state === "released") expect((await f.ledger()).has("reconcile:3")).toBe(false);
    else expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "released", attempts: 1 });
  });

  test("Orphan PR: every open PR on the branch is closed, plus the record's own open PR the listing missed", async () => {
    const prs: number[] = [];
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      prs.push((await prOn(fake, "xarabot/reconcile-3")).number);
      prs.push((await prOn(fake, "xarabot/elsewhere")).number);
      return [coord("reconcile:3", { state: "released", pr: prs[1] as number })];
    });
    await f.run();
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect((await prOnBranch(f, "xarabot/elsewhere"))?.state).toBe("closed");
    expect(f.events.filter((e) => e === "closePr")).toHaveLength(2);
    expect((await f.ledger()).has("reconcile:3")).toBe(false);
  });

  test.each([
    ["a released record", "released"],
    ["a dead run's record", "claimed"],
  ] as const)("Orphan PR: a listing failure leaves %s for a later run", async (_name, state) => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      await prOn(fake, "xarabot/reconcile-3");
      return [coord("reconcile:3", { state, pr: null, heartbeat_at: minutesBefore(30) })];
    });
    const before = (await f.ledger()).get("reconcile:3");
    f.fake.control.injectError("listPrsByBranch", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(out.reason).toContain("listPrsByBranch xarabot/reconcile-3 transient: 502; reconcile:3 left for a later run");
    expect((await f.ledger()).get("reconcile:3")).toEqual(before);
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("open");
    expect(f.events).not.toContain("closePr");
  });

  test("Orphan PR: a failed close leaves the record for a later run", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      await prOn(fake, "xarabot/reconcile-3");
      return [coord("reconcile:3", { state: "released", pr: null })];
    });
    f.fake.control.injectError("closePr", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.reason).toContain("left for a later run");
    expect(await stateOf(f, "reconcile:3")).toBe("released");
    expect(swaps(f.events)).not.toContain("deleteReleasedRecurring reconcile:3");
  });

  test("Orphan PR: two open PRs for one target, the second close fails: the target is left and the run opens no new PR", async () => {
    const nums: number[] = [];
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      // The fake allows one open PR per branch: the second is the record's own open PR, which the listing misses.
      nums.push((await prOn(fake, "xarabot/reconcile-3")).number);
      nums.push((await prOn(fake, "xarabot/elsewhere")).number);
      return [rec({ unit: "story:1.1", globs: [], state: "released", pr: story }), coord("reconcile:3", { state: "released", pr: nums[1] as number })];
    });
    let closes = 0;
    const forge: Forge = {
      ...f.fake.forge,
      closePr: (pr, o) => {
        closes += 1;
        if (closes === 2) return Promise.resolve({ ok: false as const, error: { kind: "transient" as const, message: "502" } });
        return f.fake.forge.closePr(pr, o);
      },
    };
    const out = await f.run({ forge });
    expect(closes).toBe(2);
    expect(out.state).toBe("merged");
    expect(out.reason).toContain("left for a later run");
    expect(out.reason).toContain("not every open PR on xarabot/reconcile-3 was closed: no new reconcile PR this run");
    expect(await stateOf(f, "reconcile:3")).toBe("released");
    expect(f.events).not.toContain("deleteBranch");
    expect(f.commits).toEqual([]);
    expect(await prOnBranch(f, BRANCH)).toBeNull();
  });

  test.each([
    ["the listing fails", "listPrsByBranch"],
    ["the close fails", "closePr"],
  ] as const)("2.5 F1: an orphan PR no record carries, %s, while a status change is due: the run finishes merged with no new PR", async (_name, failing) => {
    let orphan = 0;
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      orphan = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [rec({ unit: "story:1.1", globs: [], state: "released", pr: story }), coord("reconcile:3", { state: "released", pr: null })];
    });
    f.fake.control.injectError(failing, { kind: "transient", message: "502" });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(out.reason).toContain("not every open PR on xarabot/reconcile-3 was closed: no new reconcile PR this run");
    expect(await stateOf(f, "reconcile:3")).toBe("released");
    expect(await stateOf(f, "story:1.1")).toBe("merged");
    expect(await prOnBranch(f, "xarabot/reconcile-3")).toMatchObject({ number: orphan, state: "open" });
    expect(await branchHead(f, "xarabot/reconcile-3")).not.toBeNull();
    expect(f.commits).toEqual([]);
    expect(await prOnBranch(f, BRANCH)).toBeNull();
    expect(f.events).not.toContain("deleteBranch");
  });

  test.each([
    ["transient", "502"],
    ["conflict", "an open PR on it"],
  ] as const)("a failed branch delete (%s) is noted and leaves the branch and the released record for a later run; the run still opens its own PR", async (kind, message) => {
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      const r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [rec({ unit: "story:1.1", globs: [], state: "released", pr: story }), coord("reconcile:3", { state: "released", pr: r3 })];
    });
    const before = (await f.ledger()).get("reconcile:3");
    f.fake.control.injectError("deleteBranch", { kind, message });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(out.reason).toContain(`reconcile:3: deleteBranch xarabot/reconcile-3 ${kind}: ${message}; the branch is left`);
    expect((await f.ledger()).get("reconcile:3")).toEqual(before);
    expect(swaps(f.events)).not.toContain("deleteReleasedRecurring reconcile:3");
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect(await branchHead(f, "xarabot/reconcile-3")).not.toBeNull();
    expect(await prOnBranch(f, BRANCH)).toMatchObject({ state: "open" });
  });

  test("a released record a failed delete left, its PR closed and its branch still there: a later run deletes the branch, then the record", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      const r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      expect((await fake.forge.closePr(r3, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "released", pr: r3 })];
    });
    expect(await branchHead(f, "xarabot/reconcile-3")).not.toBeNull();
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
    expect((await f.ledger()).has("reconcile:3")).toBe(false);
    expect(f.events.indexOf("deleteBranch")).toBeLessThan(f.events.indexOf("ledgerSwap deleteReleasedRecurring reconcile:3"));
  });

  test("a released record whose orphan PR the run closed no longer stops this run's own PR", async () => {
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      const r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [rec({ unit: "story:1.1", globs: [], state: "released", pr: story }), coord("reconcile:3", { state: "released", pr: r3 })];
    });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect((await f.ledger()).has("reconcile:3")).toBe(false);
    expect(await prOnBranch(f, BRANCH)).toMatchObject({ state: "open" });
  });

  test.each([
    ["CI fails", FAIL, "verification"],
    ["CI pending past the max wait", [] as ForgeCheck[], "ci-timeout"],
  ] as const)("%s: U parked blocked %s; no fix session; not enqueued", async (_name, checks, reason) => {
    const f = await setup({}, async (fake) => [rec({ unit: "story:1.1", globs: [], state: "merged", pr: (await prOn(fake, "story/1.1", true)).number })]);
    f.fake.control.setChecks(f.head, checks);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await f.ledger()).get(U)?.park).toMatchObject({ kind: "blocked", reason });
    expect(f.fake.control.queue()).toEqual([]);
    expect(f.events).not.toContain("prefetch");
    if (reason === "ci-timeout") expect(f.now() - T0).toBeGreaterThanOrEqual(60 * MIN);
  });

  test("Enqueue conflict: the PR is closed, U released with attempts unchanged", async () => {
    const f = await setup({}, async (fake) => [rec({ unit: "story:1.1", globs: [], state: "merged", pr: (await prOn(fake, "story/1.1", true)).number })]);
    f.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "released"]);
    expect((await f.ledger()).get(U)).toMatchObject({ state: "released", attempts: 0 });
    expect((await prOnBranch(f, BRANCH))?.state).toBe("closed");
    expect(f.events.slice(-5)).toEqual(["enqueue", "ledgerSwap heartbeat reconcile:5", "closePr", "ledgerSwap releaseDisposable reconcile:5", "deleteBranch"]);
    expect(await branchHead(f, BRANCH)).toBeNull();
  });

  test("Graph unit merged: the missing Story key is added as backlog after its Epic's last key", async () => {
    const f = await setup({ story12: true }, async () => [coord("planning:graph.1", { state: "merged", globs: [EPICS, "xarabot:graph"] })]);
    const out = await f.run();
    expect(out.state).toBe("merging");
    expect(f.commits[0]?.files[STATUS]).toBe(`${STATUS_BACKLOG}  1-2-second: backlog\n`);
    expect(await stateOf(f, "planning:graph.1")).toBe("merged");
  });

  test("Unparseable status: U released by failAttempt, the reason logged, no PR", async () => {
    const f = await setup({ status: "development_status: {epic-1: in-progress, 1-1-first: backlog}\n" }, async () => [rec({ unit: "story:1.1", globs: [], state: "merged" })]);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("cannot be edited");
    expect((await f.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1 });
    expect(f.commits).toEqual([]);
    expect(f.logs.join("\n")).toContain("not a block mapping");
  });
});

// ------------------------------------------------------------------ more paths

describe("createReconcileStep: the gate, the re-check and failures", () => {
  const storyMerged = async (fake: FakeForge) => [rec({ unit: "story:1.1", globs: [], state: "merged", pr: (await prOn(fake, "story/1.1", true)).number })];

  test("owner_approval_paths covering sprint-status.yaml does not gate a reconcile PR", async () => {
    const f = await setup({ policy: ['owner_approval_paths: ["**"]'] }, storyMerged);
    const out = await f.run();
    expect(out.state).toBe("merging");
    expect(f.fake.control.queue()).toHaveLength(1);
  });

  test("a Protected Path covering sprint-status.yaml parks awaiting-approval with the gate comment", async () => {
    const f = await setup({ policy: ['protected_paths: ["_bmad-output/**"]'] }, storyMerged);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await f.ledger()).get(U)?.park).toMatchObject({ kind: "awaiting-approval", globs_held: [STATUS] });
    const pr = await prOnBranch(f, BRANCH);
    const comments = f.fake.control.comments(pr?.number ?? 0);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.startsWith(`🤖 Unit ${U}: this PR changes paths that need the owner's approval: ${STATUS}.`)).toBe(true);
    expect(f.fake.control.queue()).toEqual([]);
  });

  /** CI pending at the first poll; during the first sleep `act` runs and CI passes. */
  const duringCi = (act: (f: Fake) => Promise<void> | void) => ({
    onSleep: async (i: number, f: Fake) => {
      if (i !== 0) return;
      await act(f);
      f.fake.control.setChecks(f.head, PASS);
    },
  });

  test("the PR merged before the re-check: U merged", async () => {
    const f = await setup(
      duringCi(async (w) => {
        const pr = await prOnBranch(w, BRANCH);
        if (pr === null) throw new Error("no PR");
        expect((await w.fake.forge.enqueue(pr.number, pr.head_sha, opts())).ok).toBe(true);
        w.fake.control.mergeQueueHead();
      }),
      storyMerged,
    );
    f.fake.control.setChecks(f.head, []);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect(await stateOf(f, U)).toBe("merged");
    expect(f.events).not.toContain("enqueue");
  });

  test.each([
    ["the PR closed", "closed"],
    ["the PR head moved", "moved"],
  ] as const)("%s before the re-check: a failed attempt", async (_name, how) => {
    const f = await setup(
      duringCi(async (w) => {
        const pr = await prOnBranch(w, BRANCH);
        if (pr === null) throw new Error("no PR");
        if (how === "closed") expect((await w.fake.forge.closePr(pr.number, opts())).ok).toBe(true);
        else expect((await w.fake.forge.pushBranch({ branch: BRANCH, expected_sha: pr.head_sha, sha: w.fake.control.makeCommit() }, opts())).ok).toBe(true);
      }),
      storyMerged,
    );
    f.fake.control.setChecks(f.head, []);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await f.ledger()).get(U)?.attempts).toBe(1);
  });

  test("a Standing Authority that no longer loads on fresh main stops, the record left claimed", async () => {
    const f = await setup(
      duringCi((w) => {
        w.fake.control.setMain({ ...mainFiles(), [AUTHORITY]: "no frontmatter\n" });
      }),
      storyMerged,
    );
    f.fake.control.setChecks(f.head, []);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["stop", "claimed"]);
    expect(out.reason).toContain("config");
    expect(f.fake.control.queue()).toEqual([]);
  });

  test("an enqueue back-off is retried, fenced again", async () => {
    const f = await setup({}, storyMerged);
    f.fake.control.injectError("enqueue", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.state).toBe("merging");
    expect(f.events.slice(-4)).toEqual(["ledgerSwap startMerging reconcile:5", "enqueue", "ledgerSwap heartbeat reconcile:5", "enqueue"]);
  });

  test("a forbidden enqueue stops the lane with an alert", async () => {
    const f = await setup({}, storyMerged);
    f.fake.control.injectError("enqueue", { kind: "forbidden", message: "the ruleset needs a review" });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["stop", "merging"]);
    expect(f.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-forbidden"]);
  });

  test("a leftover reconcile-<n> branch: the null-lease push conflicts, a failed attempt", async () => {
    const f = await setup({}, async (fake) => {
      expect((await fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: fake.control.makeCommit() }, opts())).ok).toBe(true);
      return storyMerged(fake);
    });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await f.ledger()).get(U)).toMatchObject({ attempts: 1 });
    expect(out.reason).toContain("pushBranch");
  });

  test("a failed commit is a failed attempt; nothing pushed", async () => {
    const f = await setup({ committer: () => err("git", "boom") }, storyMerged);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(f.events).not.toContain("pushBranch");
  });

  test("openPr fails after the forge opened the PR: the orphan on the branch is closed, fenced, then a failed attempt", async () => {
    const f = await setup({}, storyMerged);
    const events: string[] = [];
    const base = spied(f.fake, events);
    const forge: Forge = {
      ...base,
      openPr: async (r, o) => {
        expect((await base.openPr(r, o)).ok).toBe(true);
        return { ok: false, error: { kind: "transient", message: "timeout" } };
      },
    };
    const out = await f.run({ forge });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await f.ledger()).get(U)).toMatchObject({ attempts: 1, pr: null });
    expect((await prOnBranch(f, BRANCH))?.state).toBe("closed");
    expect(events.slice(events.indexOf("openPr"))).toEqual(["openPr", "listPrsByBranch", "ledgerSwap heartbeat reconcile:5", "closePr", "ledgerSwap failAttempt reconcile:5"]);
    expect(out.reason).toContain("which no record carries");
  });

  test.each([
    ["lost", "failed", null],
    ["failed", "failed", "released"],
  ] as const)("the PR's record swap %s after openPr: the PR is closed, then the step ends %s (%s)", async (how, outcome, state) => {
    const f = await setup({}, storyMerged);
    const forge: Forge = {
      ...f.fake.forge,
      openPr: async (r, o) => {
        const opened = await f.fake.forge.openPr(r, o);
        if (how === "lost") f.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: tip([coord(U, { state: "claimed", generation: 2 })]), deletes: [] });
        else f.fake.control.injectError("ledgerSwap", { kind: "not-fast-forward", message: "refused" });
        return opened;
      },
    };
    const out = await f.run({ forge });
    expect([out.outcome, out.state]).toEqual([outcome, state]);
    expect((await prOnBranch(f, BRANCH))?.state).toBe("closed");
    expect(f.fake.control.queue()).toEqual([]);
    if (state === "released") expect((await f.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1, pr: null });
  });

  test("the unit lost before the push: failed, state null, nothing pushed", async () => {
    const f = await setup(
      {
        committer: (r) => {
          f.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: tip([coord(U, { state: "claimed", generation: 2 })]), deletes: [] });
          return ok({ head_sha: f.head, base_sha: r.ontoSha });
        },
      },
      storyMerged,
    );
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect(out.reason).toContain("unit lost");
    expect(f.events).not.toContain("pushBranch");
  });

  test("the unit lost during the ledger work: the refused item is re-fenced, and the run ends failed, state null", async () => {
    const f = await setup({ status: STATUS_DONE }, async () => [rec({ unit: "story:1.1", globs: [], state: "merged" })]);
    f.fake.control.beforeSwap(({ n }) => {
      if (n === 1) f.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: tip([coord(U, { state: "claimed", generation: 2 })]), deletes: [] });
    });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect((await f.ledger()).has("story:1.1")).toBe(true);
  });

  test("an item whose record moved on is skipped, and the run goes on", async () => {
    const f = await setup({ status: STATUS_DONE }, async () => [rec({ unit: "story:1.1", globs: [], state: "merged" })]);
    f.fake.control.beforeSwap(({ n }) => {
      if (n === 1) f.fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: tip([rec({ unit: "story:1.1", globs: [], state: "released" })]), deletes: [] });
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(out.reason).toContain("deleteMerged story:1.1 skipped");
    expect(await stateOf(f, "story:1.1")).toBe("released");
  });

  test("an aborted signal ends the step failed with no edit", async () => {
    const f = await setup({}, storyMerged);
    const input = await f.input();
    const ac = new AbortController();
    ac.abort();
    const before = f.messages().length;
    const out = await createReconcileStep({ forge: f.fake.forge, committer: { commit: async () => err("git", "unused") }, graphTrees: unchangedGraph(), identity: COORD, repo: "xaravel/xarabot", agent: "claude", passed: headPassedGate })({ ...input, signal: ac.signal });
    expect([out.outcome, out.state]).toEqual(["failed", "claimed"]);
    expect(f.messages()).toHaveLength(before);
  });

  test("an absent sprint-status.yaml: U merged with no PR", async () => {
    const f = await setup({ status: null }, storyMerged);
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(out.reason).toContain("is absent");
    expect(f.commits).toEqual([]);
  });
});

// ------------------------------------------------------------------ approval-gated PRs (Story 2.6)

describe("createReconcileStep: approved PRs are taken and queued (Story 2.6)", () => {
  const S = "story:1.1";
  const PARKED_AT = minutesBefore(20);
  const DIFF = ["src/a/x.ts", "src/a/y.ts"];

  /** A Story parked awaiting-approval by a builder: PR open at `head`, owned by alice. */
  const parkedRec = (pr: { number: number; head: string }, over: Partial<UnitRecord> = {}): UnitRecord =>
    rec({
      unit: S,
      globs: ["src/a/**"],
      state: "parked",
      pr: pr.number,
      pr_owner: "alice",
      head_sha: pr.head,
      base_sha: "c".repeat(40),
      passed_sha: pr.head,
      heartbeat_at: PARKED_AT,
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: DIFF },
      ...over,
    });

  /** The Story as the coordinator took it: merging at generation 2, held by the coordinator. */
  const gatedRec = (pr: { number: number; head: string }, over: Partial<UnitRecord> = {}): UnitRecord =>
    coord(S, {
      state: "merging",
      generation: 2,
      globs: DIFF,
      pr: pr.number,
      pr_owner: "alice",
      head_sha: pr.head,
      base_sha: "c".repeat(40),
      passed_sha: pr.head,
      enqueued_sha: pr.head,
      approved_sha: pr.head,
      ...over,
    });

  const review = (head: string, minutesAgo: number, over: Partial<ForgeReview> = {}): ForgeReview => ({
    author: "alice",
    state: "approved",
    commit_sha: head,
    submitted_at: minutesBefore(minutesAgo),
    ...over,
  });

  /** A world with story:1.1 parked awaiting-approval on PR `pr`; `reviews` are added to the PR. */
  async function parkedWorld(reviews: (head: string) => readonly ForgeReview[], over: Partial<UnitRecord> = {}, o: FakeOpts = {}) {
    let pr = { number: 0, head: "" };
    const f = await setup(o, async (fake) => {
      pr = await prOn(fake, "story/1.1");
      for (const r of reviews(pr.head)) fake.control.addReview(pr.number, r);
      return [parkedRec(pr, over)];
    });
    return { f, pr };
  }

  /** A world with story:1.1 merging under the coordinator on PR `pr`, queued when `queued`. */
  async function gatedWorld(queued: boolean, over: Partial<UnitRecord> = {}) {
    let pr = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      pr = await prOn(fake, "story/1.1");
      if (queued) expect((await fake.forge.enqueue(pr.number, pr.head, opts())).ok).toBe(true);
      return [gatedRec(pr, over)];
    });
    return { f, pr };
  }

  /** story:1.1 back to parked awaiting-approval, `approved_sha` cleared, holding the diff's paths, in alice's inbox. */
  async function expectReparked(f: Fake, generation: number): Promise<void> {
    const r = (await f.ledger()).get(S);
    expect(r).toMatchObject({ state: "parked", generation, approved_sha: null, owner: COORD.owner, lane: "coordinator" });
    // The park stamps heartbeat_at, so only a review submitted after it re-takes the PR.
    expect(Date.parse(r?.heartbeat_at ?? "")).toBe(T0);
    expect(r?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: DIFF });
  }

  test("Approved: merging at generation + 1, approved_sha = enqueued_sha = H, passed_sha kept, coordinator-held; queued at H; reviews → snapshot → take → fence → enqueue → the enqueue recorded", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    const out = await f.run({ forge: spied(f.fake, f.events, true) });
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect((await f.ledger()).get(S)).toMatchObject({
      state: "merging",
      generation: 2,
      approved_sha: pr.head,
      passed_sha: pr.head,
      enqueued_sha: pr.head,
      head_sha: pr.head,
      pr: pr.number,
      pr_owner: "alice",
      globs: DIFF,
      park: null,
      owner: COORD.owner,
      host: COORD.host,
      lane: "coordinator",
      attempts: 0,
    });
    expect(f.fake.control.queue()).toEqual([pr.number]);
    expect(f.fake.control.comments(pr.number)).toEqual([]);
    expect(f.events).toEqual([
      "reviews",
      "snapshot",
      "ledgerSwap takeApproved story:1.1",
      "ledgerSwap heartbeat story:1.1",
      "enqueue",
      "ledgerSwap heartbeat story:1.1",
      "ledgerSwap finishRecurring reconcile:5",
    ]);
    expect(out.reason).toContain(`story:1.1: PR #${pr.number} approved by alice, enqueued at ${pr.head}`);
    expect(f.commits).toEqual([]);
  });

  test.each([
    ["Older head: the approval is of H0", (h: string) => [review("f".repeat(40), 5), review(h, 30, { state: "commented" })]],
    ["Dismissed: the approval's own state turned dismissed", (h: string) => [review(h, 5, { state: "dismissed" })]],
    ["Not the owner: another login approves", (h: string) => [review(h, 5, { author: "bob" })]],
    ["Superseded: the owner approves H, then requests changes", (h: string) => [review(h, 5), review(h, 3, { state: "changes_requested" })]],
    ["No reviews", () => []],
  ] as const)("%s: not taken; stays parked; no fresh snapshot", async (_name, reviews) => {
    const { f, pr } = await parkedWorld(reviews);
    const before = (await f.ledger()).get(S);
    const out = await f.run({ forge: spied(f.fake, f.events, true) });
    expect(out.state).toBe("merged");
    expect((await f.ledger()).get(S)).toEqual(before);
    expect(f.fake.control.queue()).toEqual([]);
    expect(f.events).toEqual(["reviews", "ledgerSwap finishRecurring reconcile:5"]);
    expect(f.logs.join("\n")).toContain(`story:1.1: no standing approval of ${pr.head} on PR #${pr.number}`);
  });

  describe("the passed gate and the allowance before a take (Story 3.5)", () => {
    test("reconcile unreviewed: approved, passed_sha null: not taken, left parked, the reason noted; no graph gate", async () => {
      const { f, pr } = await parkedWorld((h) => [review(h, 5)], { passed_sha: null });
      const g = stubGraphTrees({ error: "never called" });
      const out = await f.run({ graphTrees: g.trees });
      expect(out.state).toBe("merged");
      expect(await stateOf(f, S)).toBe("parked");
      expect(f.fake.control.queue()).toEqual([]);
      expect(g.calls).toEqual([]);
      expect(out.reason).toContain(`story:1.1: PR #${pr.number} is unreviewed at ${pr.head}`);
      expect(out.reason).toContain("not taken, left parked");
    });

    test("passed_sha at an older head is unreviewed too; a clean merge the gate passes is taken", async () => {
      const { f } = await parkedWorld((h) => [review(h, 5)], { passed_sha: "a".repeat(40) });
      await f.run();
      expect(await stateOf(f, S)).toBe("parked");
      const w = await parkedWorld((h) => [review(h, 5)], { passed_sha: "a".repeat(40) });
      const asked: unknown[] = [];
      await w.f.run({
        passed: async (r) => {
          asked.push([r.headSha, r.passedSha]);
          return ok({ kind: "passed", how: "clean-merge" });
        },
      });
      expect(asked).toEqual([[w.pr.head, "a".repeat(40)]]);
      expect((await w.f.ledger()).get(S)).toMatchObject({ state: "merging", approved_sha: w.pr.head, enqueued_sha: w.pr.head, passed_sha: "a".repeat(40) });
    });

    test("a passed gate error: not taken, noted", async () => {
      const { f } = await parkedWorld((h) => [review(h, 5)]);
      const out = await f.run({ passed: async () => err("fetch", "offline") });
      expect(await stateOf(f, S)).toBe("parked");
      expect(out.reason).toContain("story:1.1: passed gate fetch: offline; not taken");
    });

    test("a legacy parked record (v4, passed_sha the enqueue marker) reads as unreviewed: not taken until a claim reviews it", async () => {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        fake.control.addReview(pr.number, review(pr.head, 5));
        return [];
      });
      const legacy = JSON.parse(serializeUnitRecord(parkedRec(pr))) as Record<string, unknown>;
      legacy["schema_version"] = 4;
      delete legacy["enqueued_sha"];
      f.fake.control.writeForeignLedger({ message: "legacy [skip ci]", writes: { [unitPath(S)]: JSON.stringify(legacy) }, deletes: [] });
      const out = await f.run();
      expect(await stateOf(f, S)).toBe("parked");
      expect((await f.ledger()).get(S)).toMatchObject({ passed_sha: null, enqueued_sha: pr.head });
      expect(out.reason).toContain("is unreviewed");
    });

    test("an allowance the policy refuses: no take this run, with the reason; a reconcile PR's take skips both checks", async () => {
      let r3 = { number: 0, head: "" };
      let pr = { number: 0, head: "" };
      const f = await setup({ policy: [] }, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        fake.control.addReview(pr.number, review(pr.head, 5));
        r3 = await prOn(fake, "xarabot/reconcile-3");
        fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(5) });
        return [
          parkedRec(pr),
          coord("reconcile:3", { state: "parked", pr: r3.number, pr_owner: COORD.owner, head_sha: r3.head, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } }),
        ];
      });
      const out = await f.run({ agent: "codex", passed: async () => err("fetch", "never for a reconcile take") });
      expect(await stateOf(f, S)).toBe("parked");
      expect(out.reason).toContain("allowance: agent codex is not in .xarabot/policy.yaml unattended_adapters (allowed: claude): no approved PR taken this run");
      expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "merging", approved_sha: r3.head, enqueued_sha: r3.head, passed_sha: null });
      expect(f.fake.control.queue()).toEqual([r3.number]);
    });
  });

  test("First park, approved during CI: a builder-parked Story whose owner approved H before the park is taken and queued at H", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 30)]);
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect((await f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 2, approved_sha: pr.head, passed_sha: pr.head, lane: "coordinator" });
    expect(f.fake.control.queue()).toEqual([pr.number]);
  });

  test("an approval at the builder park's own heartbeat_at counts too", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 20)]);
    await f.run();
    expect(await stateOf(f, S)).toBe("merging");
    expect(f.fake.control.queue()).toEqual([pr.number]);
  });

  test("Two approved: one fresh snapshot; both taken and queued", async () => {
    let prs: { number: number; head: string }[] = [];
    const f = await setup({}, async (fake) => {
      prs = [await prOn(fake, "story/1.1"), await prOn(fake, "story/1.2")];
      for (const p of prs) fake.control.addReview(p.number, review(p.head, 5));
      return [parkedRec(prs[0] as { number: number; head: string }), parkedRec(prs[1] as { number: number; head: string }, { unit: "story:1.2", globs: ["src/b/**"], park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["src/b/z.ts"] } })];
    });
    const out = await f.run({ forge: spied(f.fake, f.events, true) });
    expect(out.state).toBe("merged");
    expect(f.events.filter((e) => e === "snapshot")).toHaveLength(1);
    expect(f.events.filter((e) => e === "reviews")).toHaveLength(2);
    expect((await f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 2, approved_sha: prs[0]?.head });
    expect((await f.ledger()).get("story:1.2")).toMatchObject({ state: "merging", generation: 2, approved_sha: prs[1]?.head, globs: ["src/b/z.ts"] });
    expect(f.fake.control.queue()).toEqual(prs.map((p) => p.number));
  });

  test("Taken record fence lost: the heartbeat on the taken record is refused; no enqueue; merging left for the queue check", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    let bumped: UnitRecord | null = null;
    // Swap 1 is takeApproved (fenced on reconcile:5), 2 the fence on the taken record.
    f.fake.control.beforeSwap(async ({ n }) => {
      if (n !== 2) return;
      const current = (await f.ledger()).get(S);
      if (current === undefined) throw new Error("no record");
      bumped = { ...current, generation: 3 };
      f.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: { [unitPath(S)]: serializeUnitRecord(bumped) }, deletes: [] });
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.events).not.toContain("enqueue");
    expect(f.fake.control.queue()).toEqual([]);
    expect((await f.ledger()).get(S)).toEqual(bumped ?? undefined);
    expect(out.reason).toContain("heartbeat story:1.1 skipped");
    expect(f.logs.join("\n")).toContain(`story:1.1: the fence on the taken record was refused; PR #${pr.number} not enqueued, left for the queue check`);
  });

  test("Head moved since the park: not a candidate, so no reviews are read; stays parked", async () => {
    let pr = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      pr = await prOn(fake, "story/1.1");
      fake.control.addReview(pr.number, review(pr.head, 5));
      return [parkedRec({ number: pr.number, head: "d".repeat(40) })];
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(await stateOf(f, S)).toBe("parked");
    expect(f.events).not.toContain("reviews");
    expect(f.fake.control.queue()).toEqual([]);
  });

  test("the head moves after the review read: the fresh snapshot shows it, so it is not taken", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    const base = spied(f.fake, f.events, true);
    const forge: Forge = {
      ...base,
      reviews: async (n, o) => {
        expect((await f.fake.forge.pushBranch({ branch: "story/1.1", expected_sha: pr.head, sha: f.fake.control.makeCommit() }, opts())).ok).toBe(true);
        return base.reviews(n, o);
      },
    };
    const out = await f.run({ forge });
    expect(out.state).toBe("merged");
    expect(await stateOf(f, S)).toBe("parked");
    expect(swaps(f.events)).toEqual(["finishRecurring reconcile:5"]);
    expect(out.reason).toContain("on fresh main, not open at");
  });

  test("Invalid authority: the approval stands but fresh main's Standing Authority is invalid; the step ends stop; story:1.1 stays parked; no enqueue", async () => {
    const { f } = await parkedWorld((h) => [review(h, 5)]);
    const base = spied(f.fake, f.events, true);
    const forge: Forge = {
      ...base,
      reviews: (n, o) => {
        f.fake.control.setMain({ ...mainFiles(), [AUTHORITY]: "no frontmatter\n" });
        return base.reviews(n, o);
      },
    };
    const out = await f.run({ forge });
    expect([out.outcome, out.state]).toEqual(["stop", "claimed"]);
    expect(out.reason).toContain("config");
    expect(await stateOf(f, S)).toBe("parked");
    expect(f.fake.control.queue()).toEqual([]);
    expect(f.events).toEqual(["reviews", "snapshot"]);
  });

  test("Missing authority: the approval stands but fresh main has no Standing Authority; the step ends stop; story:1.1 stays parked; no enqueue", async () => {
    const { f } = await parkedWorld((h) => [review(h, 5)]);
    const base = spied(f.fake, f.events, true);
    const { [AUTHORITY]: _gone, ...withoutAuthority } = mainFiles();
    const forge: Forge = {
      ...base,
      reviews: (n, o) => {
        f.fake.control.setMain(withoutAuthority);
        return base.reviews(n, o);
      },
    };
    const out = await f.run({ forge });
    expect([out.outcome, out.state]).toEqual(["stop", "claimed"]);
    expect(out.reason).toContain("config missing");
    expect(out.reason).toContain(AUTHORITY);
    expect(await stateOf(f, S)).toBe("parked");
    expect(f.fake.control.queue()).toEqual([]);
    expect(f.events).toEqual(["reviews", "snapshot"]);
  });

  test("a failed fresh snapshot skips every take this run, with a note", async () => {
    let prs: { number: number; head: string }[] = [];
    const f = await setup({}, async (fake) => {
      prs = [await prOn(fake, "story/1.1"), await prOn(fake, "story/1.2")];
      for (const p of prs) fake.control.addReview(p.number, review(p.head, 5));
      return [parkedRec(prs[0] as { number: number; head: string }), parkedRec(prs[1] as { number: number; head: string }, { unit: "story:1.2", globs: ["src/b/**"], park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["src/b/z.ts"] } })];
    });
    const base = spied(f.fake, f.events, true);
    // Only the fresh-main read fails; the swaps' tip reads go through.
    const forge: Forge = { ...base, snapshot: async (o) => (o.read === undefined ? base.snapshot(o) : { ok: false, error: { kind: "transient", message: "502" } }) };
    const out = await f.run({ forge });
    expect(out.state).toBe("merged");
    expect(out.reason).toContain("snapshot transient: 502: no approved PR taken this run");
    expect(await stateOf(f, S)).toBe("parked");
    expect(await stateOf(f, "story:1.2")).toBe("parked");
    expect(f.events.filter((e) => e === "reviews")).toHaveLength(1);
  });

  test("a failed review read leaves the candidate parked for a later run", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    f.fake.control.injectError("reviews", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.reason).toContain(`story:1.1: reviews PR #${pr.number} transient: 502; left for a later run`);
    expect(await stateOf(f, S)).toBe("parked");
  });

  test("Enqueue conflict: parked awaiting-approval again, globs = diff paths, approved_sha null; the re-park comment", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    f.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    const out = await f.run();
    expect(out.state).toBe("merged");
    await expectReparked(f, 2);
    expect(f.fake.control.queue()).toEqual([]);
    expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "conflict")]);
    expect(swaps(f.events).slice(0, 3)).toEqual(["takeApproved story:1.1", "heartbeat story:1.1", "park story:1.1"]);
    expect(out.reason).toContain("parked awaiting approval again");
  });

  test("an enqueue back-off is retried, each retry fenced on the taken record", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    f.fake.control.injectError("enqueue", { kind: "transient", message: "502" });
    await f.run();
    expect(f.events.slice(0, 6)).toEqual(["reviews", "ledgerSwap takeApproved story:1.1", "ledgerSwap heartbeat story:1.1", "enqueue", "ledgerSwap heartbeat story:1.1", "enqueue"]);
    expect(f.fake.control.queue()).toEqual([pr.number]);
    expect(await stateOf(f, S)).toBe("merging");
  });

  test("an enqueue failure that is neither a conflict nor a lane stop leaves the record merging for the next run's queue check, its enqueue unrecorded", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    f.fake.control.injectError("enqueue", { kind: "rejected", message: "422" });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect((await f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 2, approved_sha: pr.head, passed_sha: pr.head, enqueued_sha: null });
    expect(out.reason).toContain("left merging for the next run's queue check");
  });

  test("an enqueue whose record is refused is still queued; the run notes it", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 5)]);
    let bumped: UnitRecord | null = null;
    // Swap 1 is takeApproved, 2 the fence on the taken record, 3 the record of the enqueue.
    f.fake.control.beforeSwap(async ({ n }) => {
      if (n !== 3) return;
      const current = (await f.ledger()).get(S);
      if (current === undefined) throw new Error("no record");
      bumped = { ...current, generation: 3 };
      f.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: { [unitPath(S)]: serializeUnitRecord(bumped) }, deletes: [] });
    });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.fake.control.queue()).toEqual([pr.number]);
    expect((await f.ledger()).get(S)).toEqual(bumped ?? undefined);
    expect(f.logs.join("\n")).toContain(`story:1.1: the enqueue of PR #${pr.number} at ${pr.head} is not recorded on the taken record`);
  });

  describe("a taken record the runner never enqueued keeps its approval (no enqueued_sha)", () => {
    /** story:1.1 taken at generation 2 and left merging, never enqueued; the PR open, out of the queue, with `reviews`. */
    async function untakenWorld(reviews: (head: string) => readonly ForgeReview[], over: Partial<UnitRecord> = {}) {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        for (const r of reviews(pr.head)) fake.control.addReview(pr.number, r);
        return [gatedRec(pr, { enqueued_sha: null, heartbeat_at: minutesBefore(15), ...over })];
      });
      return { f, pr };
    }

    test("its owner's approval standing, given before the take: parked on it, taken again and queued in the same run, with no comment", async () => {
      const { f, pr } = await untakenWorld((h) => [review(h, 30)]);
      const out = await f.run();
      expect(out.state).toBe("merged");
      expect((await f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 3, approved_sha: pr.head, passed_sha: pr.head, enqueued_sha: pr.head, globs: DIFF, lane: "coordinator" });
      expect(f.fake.control.queue()).toEqual([pr.number]);
      expect(f.fake.control.comments(pr.number)).toEqual([]);
      expect(swaps(f.events)).toEqual(["park story:1.1", "takeApproved story:1.1", "heartbeat story:1.1", "heartbeat story:1.1", "finishRecurring reconcile:5"]);
      expect(out.reason).toContain(`story:1.1: PR #${pr.number} was never enqueued after its take: parked on its standing approval, to be taken again`);
      expect(out.reason).toContain(`story:1.1: PR #${pr.number} approved by alice, enqueued at ${pr.head}`);
    });

    test("its owner's approval since superseded: parked awaiting approval with enqueued_sha unset, not queued, no comment", async () => {
      const { f, pr } = await untakenWorld((h) => [review(h, 30), review(h, 3, { state: "changes_requested" })]);
      await f.run();
      const r = (await f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", generation: 2, approved_sha: null, passed_sha: pr.head, enqueued_sha: null, park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: DIFF } });
      expect(f.fake.control.queue()).toEqual([]);
      expect(f.fake.control.comments(pr.number)).toEqual([]);
    });

    test("closed: re-parked with the closed comment and enqueued_sha set at its approved head, so a fresh approval is needed", async () => {
      const { f, pr } = await untakenWorld((h) => [review(h, 30)]);
      expect((await f.fake.forge.closePr(pr.number, opts())).ok).toBe(true);
      await f.run();
      expect((await f.ledger()).get(S)).toMatchObject({ state: "parked", enqueued_sha: pr.head, approved_sha: null });
      expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "closed")]);
    });

    test("its head moved: re-parked with the head-moved comment and enqueued_sha set", async () => {
      const { f, pr } = await untakenWorld((h) => [review(h, 30)]);
      const moved = f.fake.control.makeCommit();
      expect((await f.fake.forge.pushBranch({ branch: "story/1.1", expected_sha: pr.head, sha: moved }, opts())).ok).toBe(true);
      await f.run();
      expect((await f.ledger()).get(S)).toMatchObject({ state: "parked", enqueued_sha: pr.head });
      expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "head-moved")]);
    });

    test("still queued at its approved head (the enqueue landed, its record did not): left as it is", async () => {
      const { f, pr } = await untakenWorld((h) => [review(h, 30)]);
      expect((await f.fake.forge.enqueue(pr.number, pr.head, opts())).ok).toBe(true);
      const before = (await f.ledger()).get(S);
      await f.run();
      expect((await f.ledger()).get(S)).toEqual(before);
      expect(f.fake.control.queue()).toEqual([pr.number]);
    });

    test("an enqueue it recorded, then an ejection: parked for a fresh approval, as before", async () => {
      const { f, pr } = await untakenWorld((h) => [review(h, 30)], { enqueued_sha: "f".repeat(40) });
      await f.run();
      expect((await f.ledger()).get(S)).toMatchObject({ state: "parked", enqueued_sha: "f".repeat(40) });
      expect(f.fake.control.queue()).toEqual([]);
      expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "not-queued")]);
    });
  });

  test("a forbidden enqueue stops the lane with an alert", async () => {
    const { f } = await parkedWorld((h) => [review(h, 5)]);
    f.fake.control.injectError("enqueue", { kind: "forbidden", message: "the ruleset needs a review" });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["stop", "claimed"]);
    expect(f.fake.control.alerts().map((a) => a.condition)).toEqual(["forge-forbidden"]);
  });

  test("Still queued: a coordinator-held merging record queued at approved_sha is unchanged", async () => {
    const { f, pr } = await gatedWorld(true);
    const before = (await f.ledger()).get(S);
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect((await f.ledger()).get(S)).toEqual(before);
    expect(f.fake.control.queue()).toEqual([pr.number]);
    expect(f.events.slice(0, 2)).toEqual(["queueState", "ledgerSwap finishRecurring reconcile:5"]);
  });

  test("a gated record with no approved_sha is checked against head_sha", async () => {
    const { f } = await gatedWorld(true, { approved_sha: null });
    const before = (await f.ledger()).get(S);
    await f.run();
    expect((await f.ledger()).get(S)).toEqual(before);
  });

  test.each([
    ["Ejected (open, not queued)", "ejected", "not-queued", "is not in the merge queue"],
    ["Closed", "closed", "closed", "is closed"],
    ["Unknown to the queue (not-found)", "not-found", null, "is not known to the forge"],
  ] as const)("%s: parked awaiting-approval, approved_sha null; never claimed", async (_name, how, cause, why) => {
    const { f, pr } = await gatedWorld(how === "ejected");
    if (how === "ejected") expect(f.fake.control.eject(pr.number)).toBe(true);
    if (how === "closed") expect((await f.fake.forge.closePr(pr.number, opts())).ok).toBe(true);
    if (how === "not-found") f.fake.control.injectError("queueState", { kind: "not-found", message: "no such PR" });
    const out = await f.run();
    expect(out.state).toBe("merged");
    await expectReparked(f, 2);
    expect(f.messages().some((m) => m.includes(`ejected ${S}`) || m.includes(`claim ${S}`))).toBe(false);
    expect(f.fake.control.comments(pr.number)).toEqual(cause !== null ? [reparkComment(S, cause)] : []);
    expect(out.reason).toContain(`story:1.1: PR #${pr.number} ${why}: parked awaiting approval again`);
    expect(f.events.slice(0, 2)).toEqual(["queueState", "ledgerSwap park story:1.1"]);
  });

  test("Queued at another head: dequeued behind a fence, then parked", async () => {
    const { f, pr } = await gatedWorld(true, { approved_sha: "d".repeat(40) });
    await f.run();
    expect(f.events.slice(0, 5)).toEqual(["queueState", "ledgerSwap heartbeat reconcile:5", "dequeue", "ledgerSwap park story:1.1", "comment"]);
    expect(f.fake.control.queue()).toEqual([]);
    await expectReparked(f, 2);
    expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "head-moved")]);
  });

  test("Queued at another head, the dequeue failing: left merging and queued", async () => {
    const { f, pr } = await gatedWorld(true, { approved_sha: "d".repeat(40) });
    f.fake.control.injectError("dequeue", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.reason).toContain(`story:1.1: dequeue PR #${pr.number} transient: 502; left for a later run`);
    expect((await f.ledger()).get(S)).toMatchObject({ state: "merging", approved_sha: "d".repeat(40) });
    expect(f.fake.control.queue()).toEqual([pr.number]);
  });

  test("a queueState error other than not-found leaves the record, with a note", async () => {
    const { f, pr } = await gatedWorld(false);
    const before = (await f.ledger()).get(S);
    f.fake.control.injectError("queueState", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.reason).toContain(`story:1.1: queueState PR #${pr.number} transient: 502; left for a later run`);
    expect((await f.ledger()).get(S)).toEqual(before);
  });

  test("a failed re-park comment is noted with the unit, and the record stays parked", async () => {
    const { f, pr } = await gatedWorld(true);
    expect(f.fake.control.eject(pr.number)).toBe(true);
    f.fake.control.injectError("comment", { kind: "transient", message: "502" });
    const out = await f.run();
    await expectReparked(f, 2);
    expect(out.reason).toContain(`story:1.1: re-park comment on PR #${pr.number} failed: transient: 502`);
  });

  test("Ejected, then its head moved: re-parked with the head-moved comment, not the not-queued one", async () => {
    const { f, pr } = await gatedWorld(true);
    expect(f.fake.control.eject(pr.number)).toBe(true);
    const moved = f.fake.control.makeCommit();
    expect((await f.fake.forge.pushBranch({ branch: "story/1.1", expected_sha: pr.head, sha: moved }, opts())).ok).toBe(true);
    const out = await f.run();
    await expectReparked(f, 2);
    expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "head-moved")]);
    expect(out.reason).toContain(`story:1.1: PR #${pr.number} head moved to ${moved}: parked awaiting approval again`);
  });

  test("Coordinator moved: a gated merging record held by another coordinator, its PR ejected, is re-parked by this one", async () => {
    const COORD_2: LaneIdentity = { owner: "dave", host: "44444444-4444-4444-8444-444444444444", lane: "coordinator" };
    const { f, pr } = await gatedWorld(true, { owner: COORD_2.owner, host: COORD_2.host, lane: COORD_2.lane });
    expect(f.fake.control.eject(pr.number)).toBe(true);
    const out = await f.run();
    expect(out.state).toBe("merged");
    await expectReparked(f, 2);
    expect((await f.ledger()).get(S)).toMatchObject({ owner: COORD.owner, host: COORD.host, lane: "coordinator", globs: DIFF });
    expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "not-queued")]);
  });

  test("Merged: a coordinator-held merging record whose PR merged becomes merged", async () => {
    const { f } = await gatedWorld(true);
    f.fake.control.mergeQueueHead();
    await f.run();
    expect(await stateOf(f, S)).toBe("merged");
    expect(f.events).not.toContain("queueState");
  });

  test("Merged after the snapshot: queueState says merged, so markMerged, not a park", async () => {
    const { f } = await gatedWorld(true);
    const forge: Forge = {
      ...f.fake.forge,
      queueState: (pr, o) => {
        f.fake.control.mergeQueueHead();
        return f.fake.forge.queueState(pr, o);
      },
    };
    await f.run({ forge });
    expect(await stateOf(f, S)).toBe("merged");
    expect(f.messages()).toContain("ledger: markMerged story:1.1 [skip ci]");
    expect(f.messages()).not.toContain("ledger: park story:1.1 [skip ci]");
  });

  test("Re-approval needed: parked after an ejection, the old approval predating the re-park: not taken", async () => {
    const { f } = await parkedWorld((h) => [review(h, 10)], { heartbeat_at: minutesBefore(5), owner: COORD.owner, host: COORD.host, lane: "coordinator", generation: 2, enqueued_sha: "e".repeat(40) });
    await f.run();
    expect(await stateOf(f, S)).toBe("parked");
    expect(f.fake.control.queue()).toEqual([]);
  });

  test("Fresh approval: the same, plus a new owner approval of the head after the re-park: taken again", async () => {
    const { f, pr } = await parkedWorld((h) => [review(h, 10), review(h, 1)], { heartbeat_at: minutesBefore(5), owner: COORD.owner, host: COORD.host, lane: "coordinator", generation: 2, enqueued_sha: "e".repeat(40) });
    await f.run();
    expect((await f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 3, approved_sha: pr.head });
    expect(f.fake.control.queue()).toEqual([pr.number]);
  });

  test("Reconcile PR approved: reconcile:3 parked awaiting-approval (protected path) is taken and enqueued", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(5) });
      return [coord("reconcile:3", { state: "parked", pr: r3.number, pr_owner: COORD.owner, head_sha: r3.head, passed_sha: r3.head, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } })];
    });
    const out = await f.run();
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "merging", generation: 2, approved_sha: r3.head, passed_sha: r3.head, globs: [STATUS] });
    expect(f.fake.control.queue()).toEqual([r3.number]);
    // Its PR is still open, so this run opens no PR of its own.
    expect(out.reason).toContain(`reconcile:3's PR #${r3.number} is open: no new reconcile PR this run`);
  });

  test("Reconcile PR approved, enqueue conflict: its PR is closed and the record released", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(5) });
      return [coord("reconcile:3", { state: "parked", pr: r3.number, pr_owner: COORD.owner, head_sha: r3.head, passed_sha: r3.head, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } })];
    });
    f.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    const out = await f.run();
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "released", generation: 2, attempts: 0 });
    expect(out.reason).toContain(`reconcile:3: enqueue PR #${r3.number} conflict: head moved: closed, released`);
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect(swaps(f.events).slice(0, 4)).toEqual(["takeApproved reconcile:3", "heartbeat reconcile:3", "heartbeat reconcile:5", "releaseDisposable reconcile:3"]);
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
  });

  test("Reconcile PR approved, enqueue conflict, the release refused: no closed-and-released reason; the record left as the bump wrote it", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(5) });
      return [coord("reconcile:3", { state: "parked", pr: r3.number, pr_owner: COORD.owner, head_sha: r3.head, passed_sha: r3.head, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } })];
    });
    f.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    let bumped: UnitRecord | null = null;
    // Swaps: 1 takeApproved, 2 the taken record's fence, 3 the fence before closePr, 4 releaseDisposable.
    f.fake.control.beforeSwap(async ({ n }) => {
      if (n !== 4) return;
      const current = (await f.ledger()).get("reconcile:3");
      if (current === undefined) throw new Error("no record");
      bumped = { ...current, generation: 3 };
      f.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: { [unitPath("reconcile:3")]: serializeUnitRecord(bumped) }, deletes: [] });
    });
    const out = await f.run();
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect(out.reason).not.toContain("closed, released");
    expect(out.reason).toContain("releaseDisposable reconcile:3 skipped");
    expect((await f.ledger()).get("reconcile:3")).toEqual(bumped ?? undefined);
    expect(await branchHead(f, "xarabot/reconcile-3")).toBe(r3.head);
  });

  test("Reconcile PR approved, enqueue conflict, the close failing: no closed-and-released reason; left merging", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(5) });
      return [coord("reconcile:3", { state: "parked", pr: r3.number, pr_owner: COORD.owner, head_sha: r3.head, passed_sha: r3.head, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } })];
    });
    f.fake.control.injectError("enqueue", { kind: "conflict", message: "head moved" });
    f.fake.control.injectError("closePr", { kind: "transient", message: "502" });
    const out = await f.run();
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "merging", generation: 2 });
    expect(out.reason).toContain(`reconcile:3: closePr PR #${r3.number} transient: 502; left for a later run`);
    expect(out.reason).not.toContain("closed, released");
  });

  test("Q4: a reconcile PR approved and taken, then never enqueued (no enqueued_sha), is closed and replaced on the next run, never taken or enqueued again", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      const story = (await prOn(fake, "story/1.1", true)).number;
      r3 = await prOn(fake, "xarabot/reconcile-3");
      // The owner's approval still stands: a Story in this position is taken again on it (C2), a reconcile PR is not.
      fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(30) });
      return [
        rec({ unit: "story:1.1", globs: [], state: "released", pr: story }),
        coord("reconcile:3", {
          state: "merging",
          generation: 2,
          globs: [STATUS],
          pr: r3.number,
          pr_owner: COORD.owner,
          head_sha: r3.head,
          passed_sha: r3.head,
          approved_sha: r3.head,
          enqueued_sha: null,
          heartbeat_at: minutesBefore(15),
        }),
      ];
    });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "released", generation: 2, attempts: 0 });
    expect((await prOnBranch(f, "xarabot/reconcile-3"))?.state).toBe("closed");
    expect(await branchHead(f, "xarabot/reconcile-3")).toBeNull();
    expect(swaps(f.events)).not.toContain("takeApproved reconcile:3");
    expect(swaps(f.events)).not.toContain("park reconcile:3");
    expect(f.events).not.toContain("reviews");
    // The one enqueue is the replacement PR's.
    const own = await prOnBranch(f, BRANCH);
    expect(own).toMatchObject({ state: "open", head_sha: f.head });
    expect(f.events.filter((e) => e === "enqueue")).toHaveLength(1);
    expect(f.fake.control.queue()).toEqual([own?.number as number]);
  });

  test("the ledger work runs markMerged, the reconcile queue check, the gated queue check, then the takes", async () => {
    let parked = { number: 0, head: "" };
    let gated = { number: 0, head: "" };
    let r3 = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      const merged = (await prOn(fake, "story/1.9", true)).number;
      r3 = await prOn(fake, "xarabot/reconcile-3");
      expect((await fake.forge.enqueue(r3.number, r3.head, opts())).ok).toBe(true);
      gated = await prOn(fake, "story/1.2");
      expect((await fake.forge.enqueue(gated.number, gated.head, opts())).ok).toBe(true);
      parked = await prOn(fake, "story/1.1");
      fake.control.addReview(parked.number, review(parked.head, 5));
      return [
        parkedRec(parked),
        coord("story:1.2", { state: "merging", generation: 2, globs: ["src/b/z.ts"], pr: gated.number, pr_owner: "alice", head_sha: gated.head, passed_sha: gated.head, approved_sha: gated.head }),
        coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: r3.head, passed_sha: r3.head }),
        rec({ unit: "story:1.9", globs: [], state: "released", pr: merged }),
      ];
    });
    await f.run();
    expect(f.events.slice(0, 6)).toEqual(["ledgerSwap markMerged story:1.9", "queueState", "queueState", "reviews", "ledgerSwap takeApproved story:1.1", "ledgerSwap heartbeat story:1.1"]);
  });

  describe("the graph-change gate (Story 2.8)", () => {
    const MAIN_GRAPH = graphFiles({ 1: ["1.1"], 2: ["2.1"] });
    const ADDED = graphFiles({ 1: ["1.1"], 2: ["2.1", "2.2"] });
    const ADDED_MORE = graphFiles({ 1: ["1.1"], 2: ["2.1", "2.2", "2.3"] });
    const CHANGE = { main: MAIN_GRAPH, merged: ADDED } as const;
    const byMaintainer = (h: string) => [review(h, 5, { author: "edanisko" })];

    /** This run's own record claimed again, so the next run holds its fence. */
    const reclaim = (f: Fake): void => {
      f.fake.control.writeForeignLedger({ message: "reclaim [skip ci]", writes: tip([OWN]), deletes: [] });
    };

    /** The merge result's graph hash, as the gate computes it. */
    function hashOf(main: Record<string, string>, merged: Record<string, string>): string {
      const c = checkGraphChange({ main: treeOf(main), merged: treeOf(merged), ledgerUnits: [] });
      if (c.kind !== "checked") throw new Error("the graph change does not check");
      return c.mergedHash;
    }
    const HASH = hashOf(MAIN_GRAPH, ADDED);
    const OTHER_HASH = hashOf(MAIN_GRAPH, ADDED_MORE);

    /** story:1.1 parked again by the coordinator at PARKED_AT after posting the graph delta at `hash` (retro item 24). */
    const postedRec = (pr: { number: number; head: string }, hash: string, over: Partial<UnitRecord> = {}): UnitRecord =>
      parkedRec(pr, {
        owner: COORD.owner,
        host: COORD.host,
        lane: COORD.lane,
        enqueued_sha: pr.head,
        park: { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF, graph_posted: hash },
        ...over,
      });

    /**
     * A parked world whose take runs `answer` through a stub port: a builder's
     * park with no graph delta posted, or with `posted`, a coordinator re-park
     * whose posted delta hashes `posted`.
     */
    async function gated(
      reviews: (head: string) => readonly ForgeReview[],
      answer: StubAnswer | ((r: { headSha: string; mainSha: string }, i: number) => StubAnswer),
      extra: readonly UnitRecord[] = [],
      posted: string | null = null,
    ) {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        for (const r of reviews(pr.head)) fake.control.addReview(pr.number, r);
        return [posted === null ? parkedRec(pr) : postedRec(pr, posted), ...extra];
      });
      const g = stubGraphTrees(answer);
      return { f, pr, g, run: () => f.run({ graphTrees: g.trees }) };
    }

    test("AC: an approved graph-changing PR is taken merging with xarabot:graph in globs and approved_graph the merge result's hash, and enqueued at its head", async () => {
      const w = await gated(byMaintainer, CHANGE, [], HASH);
      const out = await w.run();
      expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
      const r = (await w.f.ledger()).get(S);
      expect(r).toMatchObject({ state: "merging", generation: 2, approved_sha: w.pr.head, passed_sha: w.pr.head, lane: "coordinator", approved_graph: HASH });
      expect(r?.globs).toEqual([...DIFF, "xarabot:graph"].sort());
      expect(w.f.fake.control.queue()).toEqual([w.pr.number]);
      expect(w.g.calls.map((c) => c.headSha)).toEqual([w.pr.head]);
      expect(out.reason).toContain("approved by edanisko");
    });

    /** story:1.1 as `repostGraph` leaves it: parked again in the Maintainer's inbox with the delta at `hash` posted, stamped `at`. */
    async function expectReposted(f: Fake, pr: { number: number; head: string }, hash: string, at: string, generation = 1): Promise<void> {
      const r = (await f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", generation, lane: "coordinator", owner: COORD.owner, passed_sha: pr.head, enqueued_sha: pr.head, approved_sha: null, approved_graph: null });
      expect(r?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF, graph_posted: hash });
      expect(r?.heartbeat_at).toBe(at);
    }

    test("AC: a graph-changing PR approved only by its owner, who is not the Maintainer, is not queued: parked again for the Maintainer with the delta", async () => {
      const w = await gated((h) => [review(h, 5)], CHANGE);
      const out = await w.run();
      expect(w.f.fake.control.queue()).toEqual([]);
      expect(swaps(w.f.events)).not.toContain("takeApproved story:1.1");
      await expectReposted(w.f, w.pr, HASH, FORGE_NOW);
      expect(out.reason).toContain(`changes the Epic graph to ${HASH}, but no delta was posted`);
      const comments = w.f.fake.control.comments(w.pr.number);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("- Stories added: Epic 2: +2.2");
      expect(comments[0]).toContain("(`edanisko`)");
      expect(comments[0]).toContain("An approval submitted before this comment does not count.");
      // The re-park needs an approval after it: the owner's old one never re-takes it.
      reclaim(w.f);
      await w.run();
      expect(w.f.logs.join("\n")).toContain("no standing approval");
      expect(swaps(w.f.events)).not.toContain("takeApproved story:1.1");
      expect(await stateOf(w.f, S)).toBe("parked");
    });

    test("at the posted hash, only the owner's approval: left parked for the Maintainer, with no new comment or park", async () => {
      const w = await gated((h) => [review(h, 5)], CHANGE, [], HASH);
      const before = (await w.f.ledger()).get(S);
      await w.run();
      expect(swaps(w.f.events).filter((e) => e.endsWith(S))).toEqual([]);
      expect((await w.f.ledger()).get(S)).toEqual(before);
      expect(w.f.fake.control.comments(w.pr.number)).toEqual([]);
      expect(w.f.logs.join("\n")).toContain("left parked for the Maintainer");
    });

    describe("the approval is bound to the posted delta (retro item 24)", () => {
      test("an approval submitted before the delta was posted does not take it", async () => {
        const w = await gated((h) => [review(h, 25, { author: "edanisko" })], CHANGE, [], HASH);
        const before = (await w.f.ledger()).get(S);
        await w.run();
        expect(swaps(w.f.events)).not.toContain("takeApproved story:1.1");
        expect((await w.f.ledger()).get(S)).toEqual(before);
        expect(w.f.fake.control.queue()).toEqual([]);
        expect(w.f.fake.control.comments(w.pr.number)).toEqual([]);
      });

      test("an approval submitted after the delta was posted takes it at the posted hash", async () => {
        const w = await gated((h) => [review(h, 25, { author: "edanisko", state: "changes_requested" }), review(h, 5, { author: "edanisko" })], CHANGE, [], HASH);
        await w.run();
        expect((await w.f.ledger()).get(S)).toMatchObject({ state: "merging", approved_graph: HASH, enqueued_sha: w.pr.head });
        expect(w.f.fake.control.queue()).toEqual([w.pr.number]);
      });

      test("no delta posted (a builder's park): the Maintainer's approval does not take it; the delta is posted, the record parked again, and a later approval takes it", async () => {
        const w = await gated(byMaintainer, CHANGE);
        const out = await w.run();
        expect(swaps(w.f.events)).toEqual(expect.arrayContaining(["reparkGraph story:1.1"]));
        expect(swaps(w.f.events)).not.toContain("takeApproved story:1.1");
        expect(w.f.events.indexOf("comment")).toBeLessThan(w.f.events.indexOf("ledgerSwap reparkGraph story:1.1"));
        await expectReposted(w.f, w.pr, HASH, FORGE_NOW);
        expect(w.f.fake.control.queue()).toEqual([]);
        expect(out.reason).toContain("no delta was posted");
        const comments = w.f.fake.control.comments(w.pr.number);
        expect(comments).toHaveLength(1);
        expect(comments[0]).not.toContain("no longer counts");
        // The approval given before the delta never takes it.
        reclaim(w.f);
        await w.run();
        expect(await stateOf(w.f, S)).toBe("parked");
        expect(w.f.fake.control.comments(w.pr.number)).toHaveLength(1);
        // One given after it does.
        w.f.fake.control.setNow(new Date(T0 + 10 * MIN).toISOString());
        w.f.fake.control.addReview(w.pr.number, { author: "edanisko", state: "approved", commit_sha: w.pr.head, submitted_at: new Date(T0 + 5 * MIN).toISOString() });
        reclaim(w.f);
        await w.run();
        expect((await w.f.ledger()).get(S)).toMatchObject({ state: "merging", approved_graph: HASH });
        expect(w.f.fake.control.queue()).toEqual([w.pr.number]);
      });

      test("the hash changed between the park and the take: not taken, the new delta posted and parked again at its hash; the old approval is void", async () => {
        const w = await gated(byMaintainer, CHANGE, [], OTHER_HASH);
        const out = await w.run();
        expect(swaps(w.f.events)).not.toContain("takeApproved story:1.1");
        await expectReposted(w.f, w.pr, HASH, FORGE_NOW);
        expect(out.reason).toContain(`but the posted delta is ${OTHER_HASH}`);
        const [comment] = w.f.fake.control.comments(w.pr.number);
        expect(comment).toContain("no longer counts");
        expect(comment).toContain(HASH);
        reclaim(w.f);
        await w.run();
        expect(await stateOf(w.f, S)).toBe("parked");
        expect(w.f.fake.control.comments(w.pr.number)).toHaveLength(1);
      });

      test("an approval in the gap between the review read and the re-park counts: the re-park is stamped with the snapshot time before the read", async () => {
        const w = await gated(byMaintainer, CHANGE);
        const base = spied(w.f.fake, w.f.events);
        const gap = new Date(T0 + 1 * MIN).toISOString();
        let read = false;
        const forge: Forge = {
          ...base,
          reviews: async (pr, o) => {
            const r = await base.reviews(pr, o);
            if (!read) {
              read = true;
              // After the read: the forge's clock moves on, and the Maintainer approves before the re-park lands.
              w.f.fake.control.setNow(new Date(T0 + 2 * MIN).toISOString());
              w.f.fake.control.addReview(w.pr.number, { author: "edanisko", state: "approved", commit_sha: w.pr.head, submitted_at: gap });
            }
            return r;
          },
        };
        await w.f.run({ forge, graphTrees: w.g.trees });
        await expectReposted(w.f, w.pr, HASH, FORGE_NOW);
        expect(Date.parse(FORGE_NOW)).toBeLessThan(Date.parse(gap));
        // The gap approval, after the stamp, takes it on the next run.
        reclaim(w.f);
        await w.run();
        expect((await w.f.ledger()).get(S)).toMatchObject({ state: "merging", approved_graph: HASH, approved_sha: w.pr.head });
        expect(w.f.fake.control.queue()).toEqual([w.pr.number]);
      });

      test("a later target's re-park is stamped with fresh main's time, read before its reviews", async () => {
        const w = await gated(byMaintainer, CHANGE, [], HASH);
        const extra = await prOn(w.f.fake, "story/1.2");
        w.f.fake.control.addReview(extra.number, review(extra.head, 5, { author: "edanisko" }));
        const other = parkedRec(extra, { unit: "story:1.2", globs: ["src/b/**"], park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["src/b/z.ts"] } });
        w.f.fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([other]), deletes: [] });
        const fresh = new Date(T0 + 3 * MIN).toISOString();
        const base = spied(w.f.fake, w.f.events);
        const forge: Forge = {
          ...base,
          snapshot: async (o) => {
            // Fresh main, read after story:1.1's reviews: the forge's clock has moved on.
            if (o.read !== undefined) w.f.fake.control.setNow(fresh);
            return base.snapshot(o);
          },
        };
        await w.f.run({ forge, graphTrees: w.g.trees });
        // story:1.1 is taken at its posted hash; story:1.2, with none posted, is parked again, stamped no later than its reviews read.
        expect((await w.f.ledger()).get(S)?.state).toBe("merging");
        const r = (await w.f.ledger()).get("story:1.2");
        expect(r?.state).toBe("parked");
        expect(r?.park?.graph_posted).toBe(HASH);
        expect(r?.heartbeat_at).toBe(fresh);
      });

      test("a failed delta comment leaves the record as it was: not parked again, not taken", async () => {
        const w = await gated(byMaintainer, CHANGE);
        const before = (await w.f.ledger()).get(S);
        w.f.fake.control.injectError("comment", { kind: "transient", message: "502" });
        const out = await w.run();
        expect((await w.f.ledger()).get(S)).toEqual(before);
        expect(swaps(w.f.events)).not.toContain("reparkGraph story:1.1");
        expect(out.reason).toContain("graph delta comment on PR");
        expect(out.reason).toContain("not taken, left parked");
      });
    });

    test("an unchanged graph keeps the owner rule: the Maintainer's approval alone does not take it", async () => {
      const w = await gated(byMaintainer, { main: MAIN_GRAPH, merged: MAIN_GRAPH });
      await w.run();
      expect(await stateOf(w.f, S)).toBe("parked");
      expect(w.f.logs.join("\n")).toContain("from its owner");
    });

    test("a re-park needs the Maintainer's approval after it, as the owner's does", async () => {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        fake.control.addReview(pr.number, review(pr.head, 30, { author: "edanisko" }));
        return [coord(S, { state: "parked", generation: 3, pr: pr.number, pr_owner: "alice", head_sha: pr.head, passed_sha: pr.head, enqueued_sha: pr.head, heartbeat_at: minutesBefore(10), park: { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF } })];
      });
      await f.run({ graphTrees: stubGraphTrees(CHANGE).trees });
      expect(await stateOf(f, S)).toBe("parked");
    });

    test("a second graph PR: with another record holding xarabot:graph the take is refused and the PR stays parked", async () => {
      const holder = coord("story:1.2", { state: "merging", generation: 2, globs: ["xarabot:graph", "src/b/**"], approved_graph: `sha256:${"b".repeat(64)}` });
      const w = await gated(byMaintainer, CHANGE, [holder], HASH);
      const out = await w.run();
      expect(await stateOf(w.f, S)).toBe("parked");
      expect(w.f.fake.control.queue()).toEqual([]);
      expect(out.reason).toContain("overlaps \"xarabot:graph\"");
    });

    test("a refused merge result: taken, then parked blocked graph-invalid with the refusal named; not enqueued", async () => {
      const used = { ...MAIN_GRAPH, [GRAPH_STATUS]: "development_status:\n  2-1-s: done\n" };
      const w = await gated((h) => [review(h, 5)], { main: used, merged: { ...graphFiles({ 1: ["1.1"], 2: [] }), [GRAPH_STATUS]: used[GRAPH_STATUS] as string } });
      await w.run();
      const r = (await w.f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", generation: 2, approved_sha: null, approved_graph: null, park: { kind: "blocked", reason: "graph-invalid", inbox_owner: "alice" } });
      expect(w.f.fake.control.queue()).toEqual([]);
      const [comment] = w.f.fake.control.comments(w.pr.number);
      expect(comment).toContain("Story 2.1 is removed, but it is used");
    });

    test("a conflicting merge: taken, then parked awaiting approval again with the conflict comment", async () => {
      const w = await gated((h) => [review(h, 5)], { conflict: ["stories/1.1.md"] });
      await w.run();
      await expectReparked(w.f, 2);
      expect(w.f.fake.control.comments(w.pr.number)).toEqual([reparkComment(S, "conflict")]);
      expect(w.f.fake.control.queue()).toEqual([]);
    });

    test("a conflicting merge with no enqueued_sha on the park: the fence sets it, so the same approval never re-takes it", async () => {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        fake.control.addReview(pr.number, review(pr.head, 5));
        return [parkedRec(pr, { enqueued_sha: null })];
      });
      const g = stubGraphTrees({ conflict: ["stories/1.1.md"] });
      await f.run({ graphTrees: g.trees });
      expect((await f.ledger()).get(S)).toMatchObject({ state: "parked", enqueued_sha: pr.head, lane: "coordinator" });
      const again = await f.run({ graphTrees: g.trees });
      expect(again.reason ?? "").not.toContain("takeApproved");
      expect(swaps(f.events)).not.toContain("takeApproved story:1.1");
      expect(g.calls).toHaveLength(1);
    });

    test.each([
      ["main not resolving", { main: { ...MAIN_GRAPH, ".xarabot/config.yaml": "x: [" }, merged: MAIN_GRAPH }],
      ["a failed read", { error: "git broke" }],
    ] as const)("%s skips the take; the PR stays parked", async (_name, answer) => {
      const w = await gated((h) => [review(h, 5)], answer);
      const before = (await w.f.ledger()).get(S);
      const out = await w.run();
      expect((await w.f.ledger()).get(S)).toEqual(before);
      expect(out.reason).toContain("not taken");
    });

    test("a failed branch PR lookup skips the take", async () => {
      const w = await gated(byMaintainer, { main: MAIN_GRAPH, merged: graphFiles({ 1: ["1.1"], 2: [] }) });
      w.f.fake.control.injectError("listPrsByBranch", { kind: "transient", message: "flaky" });
      const out = await w.run();
      expect(await stateOf(w.f, S)).toBe("parked");
      expect(out.reason).toContain("listPrsByBranch story/2.1");
    });

    test("main moved at enqueue, a different hash: the approval is void, the new delta posted, then parked again for the Maintainer at its hash", async () => {
      let f!: Fake;
      const w = await gated(
        byMaintainer,
        (_r, i) => {
          if (i === 0) {
            f.fake.control.setMain({ ...mainFiles(), "README.md": "moved\n" });
            return CHANGE;
          }
          return { main: MAIN_GRAPH, merged: ADDED_MORE };
        },
        [],
        HASH,
      );
      f = w.f;
      await w.run();
      expect(w.g.calls).toHaveLength(2);
      expect(w.g.calls[1]?.mainSha).not.toBe(w.g.calls[0]?.mainSha);
      const r = (await w.f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", generation: 2, approved_sha: null, approved_graph: null, passed_sha: w.pr.head, enqueued_sha: w.pr.head });
      expect(r?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF, graph_posted: OTHER_HASH });
      expect(w.f.events.lastIndexOf("comment")).toBeLessThan(w.f.events.indexOf("ledgerSwap park story:1.1"));
      expect(w.f.fake.control.queue()).toEqual([]);
      const [comment] = w.f.fake.control.comments(w.pr.number);
      expect(comment).toContain("no longer counts");
      expect(comment).toContain("+2.3");
      // The voided approval never takes it again at the new hash.
      reclaim(w.f);
      await w.run();
      expect(w.f.logs.join("\n")).toContain("no standing approval");
      expect(await stateOf(w.f, S)).toBe("parked");
    });

    test("main moved at enqueue, a different hash, the delta comment failing: parked again with no delta posted", async () => {
      let f!: Fake;
      const w = await gated(
        byMaintainer,
        (_r, i) => {
          if (i === 0) {
            f.fake.control.setMain({ ...mainFiles(), "README.md": "moved\n" });
            return CHANGE;
          }
          return { main: MAIN_GRAPH, merged: ADDED_MORE };
        },
        [],
        HASH,
      );
      f = w.f;
      w.f.fake.control.injectError("comment", { kind: "transient", message: "502" });
      const out = await w.run();
      const r = (await w.f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", approved_graph: null, enqueued_sha: w.pr.head });
      expect(r?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF });
      expect(out.reason).toContain("graph delta comment on PR");
    });

    test("main moved at enqueue, an equal hash: enqueued", async () => {
      let f!: Fake;
      const w = await gated(
        byMaintainer,
        (_r, i) => {
          if (i === 0) f.fake.control.setMain({ ...mainFiles(), "README.md": "moved\n" });
          return CHANGE;
        },
        [],
        HASH,
      );
      f = w.f;
      await w.run();
      expect(w.g.calls).toHaveLength(2);
      expect(w.f.fake.control.queue()).toEqual([w.pr.number]);
      expect((await w.f.ledger()).get(S)?.state).toBe("merging");
    });

    test("main moved at enqueue, now refused: the coordinator-held merging record parks blocked graph-invalid", async () => {
      let f!: Fake;
      const used = { ...MAIN_GRAPH, [GRAPH_STATUS]: "development_status:\n  2-1-s: done\n" };
      const w = await gated(
        byMaintainer,
        (_r, i) => {
          if (i === 0) {
            f.fake.control.setMain({ ...mainFiles(), "README.md": "moved\n" });
            return CHANGE;
          }
          return { main: used, merged: { ...graphFiles({ 1: ["1.1"], 2: [] }), [GRAPH_STATUS]: used[GRAPH_STATUS] as string } };
        },
        [],
        HASH,
      );
      f = w.f;
      await w.run();
      expect((await w.f.ledger()).get(S)).toMatchObject({ state: "parked", approved_graph: null, park: { kind: "blocked", reason: "graph-invalid" } });
      expect(w.f.fake.control.queue()).toEqual([]);
    });

    /** A world whose `main` moves during the first gate call; the second call returns `second`. */
    async function movedWorld(second: StubAnswer) {
      let f!: Fake;
      const w = await gated(
        byMaintainer,
        (_r, i) => {
          if (i > 0) return second;
          f.fake.control.setMain({ ...mainFiles(), "README.md": "moved\n" });
          return CHANGE;
        },
        [],
        HASH,
      );
      f = w.f;
      return w;
    }

    test("main moved at enqueue, the second gate run fails: left merging, not enqueued, its enqueue unrecorded", async () => {
      const w = await movedWorld({ error: "git broke" });
      const out = await w.run();
      expect(w.g.calls).toHaveLength(2);
      expect((await w.f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 2, enqueued_sha: null });
      expect(w.f.fake.control.queue()).toEqual([]);
      expect(out.reason).toContain("left merging for the next run's queue check");
    });

    test("main moved at enqueue, the merge now conflicts: parked again with the conflict comment, not enqueued", async () => {
      const w = await movedWorld({ conflict: ["stories/2.2.md"] });
      await w.run();
      const r = (await w.f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", generation: 2, approved_sha: null, approved_graph: null, park: { kind: "awaiting-approval", inbox_owner: "edanisko", globs_held: DIFF } });
      expect(w.f.fake.control.comments(w.pr.number)).toEqual([reparkComment(S, "conflict")]);
      expect(w.f.fake.control.queue()).toEqual([]);
    });

    test("the snapshot after the fence fails: left merging, not enqueued, no second gate run", async () => {
      const w = await gated(byMaintainer, CHANGE, [], HASH);
      const base = spied(w.f.fake, w.f.events);
      let reads = 0;
      const forge: Forge = {
        ...base,
        snapshot: async (o) => {
          if (o.read !== undefined && ++reads === 2) return { ok: false, error: { kind: "transient", message: "502" } };
          return base.snapshot(o);
        },
      };
      const out = await w.f.run({ forge, graphTrees: w.g.trees });
      expect(w.g.calls).toHaveLength(1);
      expect((await w.f.ledger()).get(S)).toMatchObject({ state: "merging", generation: 2, enqueued_sha: null });
      expect(w.f.fake.control.queue()).toEqual([]);
      expect(out.reason).toContain("before the enqueue");
    });

    test("a checkGated record holding xarabot:graph parks again in the Maintainer's inbox, the pseudo-glob dropped from globs_held", async () => {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        return [gatedRec(pr, { globs: [...DIFF, "xarabot:graph"], approved_graph: `sha256:${"b".repeat(64)}` })];
      });
      await f.run();
      const r = (await f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", approved_sha: null, approved_graph: null });
      // The delta its approval was given after stays posted: a later Maintainer approval takes it at that hash.
      expect(r?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF, graph_posted: `sha256:${"b".repeat(64)}` });
      expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(S, "not-queued")]);
    });

    test.each([
      ["a failing port", { error: "never called" }],
      ["a conflicting port", { conflict: [STATUS] }],
    ] as const)("an approved reconcile PR skips the gate (%s): taken and enqueued, no gate call", async (_name, answer) => {
      let r3 = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        r3 = await prOn(fake, "xarabot/reconcile-3");
        fake.control.addReview(r3.number, { author: COORD.owner, state: "approved", commit_sha: r3.head, submitted_at: minutesBefore(5) });
        return [coord("reconcile:3", { state: "parked", pr: r3.number, pr_owner: COORD.owner, head_sha: r3.head, passed_sha: r3.head, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } })];
      });
      const g = stubGraphTrees(answer);
      await f.run({ graphTrees: g.trees });
      expect(g.calls).toEqual([]);
      expect((await f.ledger()).get("reconcile:3")).toMatchObject({ state: "merging", generation: 2, approved_sha: r3.head, approved_graph: null, globs: [STATUS] });
      expect(f.fake.control.queue()).toEqual([r3.number]);
    });

    /** story:1.1 taken on the Maintainer's approval with `approvedGraph`, never enqueued; the PR open, out of the queue. */
    async function untakenGraph(approvedGraph: string) {
      let pr = { number: 0, head: "" };
      const f = await setup({}, async (fake) => {
        pr = await prOn(fake, "story/1.1");
        fake.control.addReview(pr.number, review(pr.head, 30, { author: "edanisko" }));
        return [gatedRec(pr, { globs: [...DIFF, "xarabot:graph"].sort(), approved_graph: approvedGraph, enqueued_sha: null })];
      });
      return { f, pr };
    }

    test("a graph change the runner never enqueued, its merge result's hash unchanged: parked on the Maintainer's standing approval, the gate run again, taken and queued with the graph", async () => {
      const expected = checkGraphChange({ main: treeOf(MAIN_GRAPH), merged: treeOf(ADDED), ledgerUnits: [] });
      if (expected.kind !== "checked") throw new Error("the graph change does not check");
      const { f, pr } = await untakenGraph(expected.mergedHash);
      const g = stubGraphTrees(CHANGE);
      const out = await f.run({ graphTrees: g.trees });
      expect(out.state).toBe("merged");
      expect(g.calls).toHaveLength(1);
      const r = (await f.ledger()).get(S);
      expect(r).toMatchObject({ state: "merging", generation: 3, approved_sha: pr.head, approved_graph: expected.mergedHash, passed_sha: pr.head, enqueued_sha: pr.head });
      expect(r?.globs).toEqual([...DIFF, "xarabot:graph"].sort());
      expect(f.fake.control.queue()).toEqual([pr.number]);
      expect(f.fake.control.comments(pr.number)).toEqual([]);
    });

    test("a graph change the runner never enqueued, re-taken at a different hash: the approval is void, parked again for the Maintainer with the new delta, not queued", async () => {
      const stale = `sha256:${"b".repeat(64)}`;
      const { f, pr } = await untakenGraph(stale);
      const g = stubGraphTrees(CHANGE);
      const out = await f.run({ graphTrees: g.trees });
      expect(g.calls).toHaveLength(1);
      expect(f.fake.control.queue()).toEqual([]);
      expect(swaps(f.events)).not.toContain("takeApproved story:1.1");
      const r = (await f.ledger()).get(S);
      expect(r).toMatchObject({ state: "parked", generation: 2, lane: "coordinator", approved_sha: null, approved_graph: null, passed_sha: pr.head, enqueued_sha: pr.head, heartbeat_at: FORGE_NOW });
      expect(r?.park).toEqual({ kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: DIFF, graph_posted: HASH });
      expect(out.reason).toContain(`but the posted delta is ${stale}`);
      const comments = f.fake.control.comments(pr.number);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("no longer counts");
      expect(comments[0]).toContain("+2.2");
      // The re-park makes the next take need a Maintainer approval after it: the voided one never re-takes it.
      reclaim(f);
      await f.run({ graphTrees: g.trees });
      expect(swaps(f.events)).not.toContain("takeApproved story:1.1");
      expect(f.logs.join("\n")).toContain("no standing approval");
      expect(await stateOf(f, S)).toBe("parked");
    });

    test("main unmoved at enqueue: no second gate run", async () => {
      const w = await gated(byMaintainer, CHANGE, [], HASH);
      await w.run();
      expect(w.g.calls).toHaveLength(1);
      expect(w.f.fake.control.queue()).toEqual([w.pr.number]);
    });
  });
});

// ------------------------------------------------------------------ acceptance

describe("createReconcileStep: planning records (Story 2.7)", () => {
  const STATUS_GLOBS = [STATUS, "_bmad-output/implementation-artifacts/retro-gates.yaml", "_bmad-output/implementation-artifacts/epic-*-context.md"];
  const GRAPH_GLOBS = [EPICS, ".xarabot/epics.yaml", "stories/*.md", "xarabot:graph"];

  test("the matrix: an ungated status PR out of the queue is closed and released, no attempt counted", async () => {
    let pr = { number: 0, head: "" };
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      pr = await prOn(fake, "xarabot/planning-status.2");
      return [coord("planning:status.2", { state: "merging", globs: STATUS_GLOBS, pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, passed_sha: pr.head, attempts: 1 })];
    });
    await f.run();
    expect((await f.ledger()).get("planning:status.2")).toMatchObject({ state: "released", attempts: 1, pr: pr.number });
    expect((await prOnBranch(f, "xarabot/planning-status.2"))?.state).toBe("closed");
    expect(swaps(f.events)).toContain("releaseDisposable planning:status.2");
    expect(await branchHead(f, "xarabot/planning-status.2")).toBeNull();
  });

  test("an ungated status PR still queued at its head is left merging", async () => {
    let pr = { number: 0, head: "" };
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      pr = await prOn(fake, "xarabot/planning-status.2");
      expect((await fake.forge.enqueue(pr.number, pr.head, opts())).ok).toBe(true);
      return [coord("planning:status.2", { state: "merging", globs: STATUS_GLOBS, pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, passed_sha: pr.head })];
    });
    await f.run();
    expect(await stateOf(f, "planning:status.2")).toBe("merging");
    expect(f.fake.control.queue()).toEqual([pr.number]);
  });

  test("the matrix: a gated graph PR out of the queue is parked awaiting approval again (Story 2.6)", async () => {
    let pr = { number: 0, head: "" };
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      pr = await prOn(fake, "xarabot/planning-graph.1");
      return [coord("planning:graph.1", { state: "merging", generation: 2, globs: [EPICS, "stories/1.2.md"], pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, passed_sha: pr.head, approved_sha: pr.head })];
    });
    await f.run();
    expect((await f.ledger()).get("planning:graph.1")).toMatchObject({ state: "parked", approved_sha: null, park: { kind: "awaiting-approval", globs_held: [EPICS, "stories/1.2.md"] } });
    expect((await prOnBranch(f, "xarabot/planning-graph.1"))?.state).toBe("open");
    expect(await branchHead(f, "xarabot/planning-graph.1")).toBe(pr.head);
  });

  test.each([
    ["status, its PR closed (disposable: its branch deleted too)", "planning:status.2", "xarabot/planning-status.2", STATUS_GLOBS, true],
    ["graph, with no PR (not disposable: its branch kept)", "planning:graph.1", "xarabot/planning-graph.1", GRAPH_GLOBS, false],
  ] as const)("the matrix: a released planning record, %s: the open PRs on its branch closed, then deleted", async (_name, unit, branch, globs, closedPr) => {
    let orphan = 0;
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      const own = await prOn(fake, branch);
      orphan = own.number;
      if (closedPr) {
        // Its own PR closed, and an orphan opened since on the same branch.
        expect((await fake.forge.closePr(own.number, opts())).ok).toBe(true);
        expect((await fake.forge.pushBranch({ branch, expected_sha: own.head, sha: fake.control.makeCommit() }, opts())).ok).toBe(true);
        const opened = await fake.forge.openPr({ branch, base: "main", title: "t", body: "b" }, opts());
        if (!opened.ok) throw new Error(opened.error.message);
        orphan = opened.value.number;
      }
      return [coord(unit, { state: "released", globs, pr: closedPr ? own.number : null })];
    });
    await f.run();
    expect((await f.ledger()).has(unit)).toBe(false);
    expect(await prOnBranch(f, branch)).toMatchObject({ number: orphan, state: "closed" });
    expect(swaps(f.events)).toContain(`deleteReleasedRecurring ${unit}`);
    if (closedPr) expect(await branchHead(f, branch)).toBeNull();
    else expect(await branchHead(f, branch)).not.toBeNull();
    expect(f.events.includes("deleteBranch")).toBe(closedPr);
  });

  test("the matrix: a released planning record whose PR is open is left for the open-PR position", async () => {
    let pr = { number: 0, head: "" };
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      pr = await prOn(fake, "xarabot/planning-status.2");
      return [coord("planning:status.2", { state: "released", globs: STATUS_GLOBS, pr: pr.number, head_sha: pr.head })];
    });
    await f.run();
    expect(await stateOf(f, "planning:status.2")).toBe("released");
    expect((await prOnBranch(f, "xarabot/planning-status.2"))?.state).toBe("open");
    expect(f.events).not.toContain("closePr");
  });
});

describe("reconcile through the coordinator process", () => {
  const LANE: Lane = { repo: "xaravel/xarabot", role: "coordinator", owner: COORD.owner, agent: "claude", effort: "high" };
  const AGENT = { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent;

  async function round(fake: FakeForge, committer: ReconcileCommitter, laneDir: string, startMs: number) {
    const sessions: string[] = [];
    let clock = startMs;
    const result = await runCoordinatorProcess({
      forge: fake.forge,
      agent: { ...AGENT, launchSpec: () => { sessions.push("launch"); return err("refused", "no sessions"); } } as unknown as Agent,
      store: createFsLaneStore({ laneDir, hostStop: join(laneDir, "..", "STOP") }),
      laneDir,
      identity: COORD,
      lane: LANE,
      claim: claimRec(),
      steps: { reconcile: createReconcileStep({ forge: fake.forge, committer, graphTrees: unchangedGraph(), identity: COORD, repo: "xaravel/xarabot", agent: "claude", passed: headPassedGate, now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0 }) },
      pid: 4242,
      now: () => (clock += 1000),
      sleep: async () => {},
      random: () => 0,
      heartbeat: { sleep: async (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))) },
      waiter: { wait: async () => ({ end: "elapsed" }) },
    });
    return { result, sessions };
  }

  const journalUnits = (laneDir: string) =>
    (existsSync(join(laneDir, "journal.jsonl")) ? readFileSync(join(laneDir, "journal.jsonl"), "utf8") : "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as JournalRecord)
      .filter((j) => j.type === "unit");

  test("AC: a parked story:2.1-like Story whose PR merged → merged, a reconcile PR enqueued with no approval, reconcile:<n> merging; then, once that PR merges, the next run deletes both and is the only merged reconcile record", async () => {
    const root = mkdtempSync(join(tmpdir(), "xarabot-reconcile-"));
    dirs.push(root);
    const laneDir = join(root, "coordinator");
    const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles() });
    const story = await prOn(fake, "story/1.1", true);
    const last = coord("reconcile:4", { state: "merged", heartbeat_at: minutesBefore(12) });
    const parked = rec({ unit: "story:1.1", globs: [], state: "parked", pr: story.number, park: { kind: "blocked", reason: "other", inbox_owner: "alice", globs_held: [] } });
    fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([last, parked], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }), deletes: [] });
    const commits: ReconcileCommitRequest[] = [];
    const committer: ReconcileCommitter = {
      async commit(r) {
        commits.push(r);
        const head = fake.control.makeCommit();
        fake.control.setChecks(head, PASS);
        return ok({ head_sha: head, base_sha: r.ontoSha });
      },
    };

    // Round 1.
    const one = await round(fake, committer, laneDir, T0);
    expect(one.result.outcome).toBe("progress");
    expect(one.sessions).toEqual([]);
    const pr = await fake.forge.listPrsByBranch(BRANCH, opts());
    const reconcilePr = pr.ok ? pr.value[0] : undefined;
    expect(reconcilePr?.state).toBe("open");
    expect(fake.control.queue()).toEqual([reconcilePr?.number ?? -1]);
    expect(commits.map((c) => Object.keys(c.files))).toEqual([[STATUS]]);
    const status = parseSprintStatus(STATUS, commits[0]?.files[STATUS] ?? "");
    expect(status.ok && status.value.development_status).toEqual({ "epic-1": "done", "1-1-first": "done" });
    let l = parseLedger((await snapshotFiles(fake)).ledger);
    if (!l.ok) throw new Error(l.error.message);
    expect(l.value.units.get("story:1.1")?.state).toBe("merged");
    expect(l.value.units.get(U)).toMatchObject({ state: "merging", pr: reconcilePr?.number });
    expect(journalUnits(laneDir)).toEqual([expect.objectContaining({ unit: U, outcome: "progress", state: "merging", sessions: 0 })]);

    // The queue merges the PR; main now has the new status.
    expect(fake.control.mergeQueueHead()?.number).toBe(reconcilePr?.number);
    fake.control.setMain({ ...mainFiles(), [STATUS]: commits[0]?.files[STATUS] ?? "" });
    fake.control.setNow(new Date(T0 + 11 * MIN).toISOString());

    // Round 2.
    const two = await round(fake, committer, laneDir, T0 + 11 * MIN);
    expect(two.result.outcome).toBe("progress");
    expect(commits).toHaveLength(1);
    l = parseLedger((await snapshotFiles(fake)).ledger);
    if (!l.ok) throw new Error(l.error.message);
    expect([...l.value.units.keys()]).toEqual(["reconcile:6"]);
    expect(l.value.units.get("reconcile:6")).toMatchObject({ state: "merged", pr: null });
  });

  test("AC (Story 2.6): story:1.1 parked awaiting-approval, its owner approves the head → merging at generation + 1, queued, no session; ejected → parked again; taken again only after a fresh approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "xarabot-reconcile-"));
    dirs.push(root);
    const laneDir = join(root, "coordinator");
    const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles() });
    const pr = await prOn(fake, "story/1.1");
    const diff = ["src/a/x.ts"];
    const last = coord("reconcile:4", { state: "merged", heartbeat_at: minutesBefore(12) });
    const parked = rec({
      unit: "story:1.1",
      globs: ["src/a/**"],
      state: "parked",
      pr: pr.number,
      pr_owner: "alice",
      head_sha: pr.head,
      passed_sha: pr.head,
      heartbeat_at: minutesBefore(20),
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: diff },
    });
    fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([last, parked], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }), deletes: [] });
    fake.control.addReview(pr.number, { author: "alice", state: "approved", commit_sha: pr.head, submitted_at: minutesBefore(5) });
    const committer: ReconcileCommitter = { commit: async () => err("git", "no status change expected") };
    const story = async () => {
      const l = parseLedger((await snapshotFiles(fake)).ledger);
      if (!l.ok) throw new Error(l.error.message);
      return l.value.units.get("story:1.1");
    };
    const at = (m: number) => {
      fake.control.setNow(new Date(T0 + m * MIN).toISOString());
      return T0 + m * MIN;
    };

    // Round 1: taken and queued, with no agent session.
    const one = await round(fake, committer, laneDir, T0);
    expect(one.result.outcome).toBe("progress");
    expect(one.sessions).toEqual([]);
    expect(await story()).toMatchObject({ state: "merging", generation: 2, approved_sha: pr.head, passed_sha: pr.head, enqueued_sha: pr.head, lane: "coordinator" });
    expect(fake.control.queue()).toEqual([pr.number]);

    // Ejected; round 2 parks it again with approved_sha cleared and its diff's paths held.
    expect(fake.control.eject(pr.number)).toBe(true);
    const two = await round(fake, committer, laneDir, at(11));
    expect(two.sessions).toEqual([]);
    expect(await story()).toMatchObject({ state: "parked", generation: 2, approved_sha: null, park: { kind: "awaiting-approval", inbox_owner: "alice", globs_held: diff } });
    expect(fake.control.comments(pr.number)).toEqual([reparkComment("story:1.1", "not-queued")]);

    // Round 3: the old approval predates the re-park, so it is not taken.
    await round(fake, committer, laneDir, at(22));
    expect((await story())?.state).toBe("parked");
    expect(fake.control.queue()).toEqual([]);

    // A fresh approval of the head after the re-park: round 4 takes it again.
    fake.control.addReview(pr.number, { author: "alice", state: "approved", commit_sha: pr.head, submitted_at: new Date(T0 + 25 * MIN).toISOString() });
    const four = await round(fake, committer, laneDir, at(33));
    expect(four.sessions).toEqual([]);
    expect(await story()).toMatchObject({ state: "merging", generation: 3, approved_sha: pr.head });
    expect(fake.control.queue()).toEqual([pr.number]);
  });

  test("AC (C2): the runner's own enqueue failure leaves story:1.1 merging; the next run enqueues it on the same approval, no fresh review; once ejected, only a fresh approval re-takes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "xarabot-reconcile-"));
    dirs.push(root);
    const laneDir = join(root, "coordinator");
    const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles() });
    const pr = await prOn(fake, "story/1.1");
    const diff = ["src/a/x.ts"];
    const last = coord("reconcile:4", { state: "merged", heartbeat_at: minutesBefore(12) });
    const parked = rec({
      unit: "story:1.1",
      globs: ["src/a/**"],
      state: "parked",
      pr: pr.number,
      pr_owner: "alice",
      head_sha: pr.head,
      passed_sha: pr.head,
      heartbeat_at: minutesBefore(20),
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: diff },
    });
    fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([last, parked], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }), deletes: [] });
    fake.control.addReview(pr.number, { author: "alice", state: "approved", commit_sha: pr.head, submitted_at: minutesBefore(5) });
    const committer: ReconcileCommitter = { commit: async () => err("git", "no status change expected") };
    const story = async () => {
      const l = parseLedger((await snapshotFiles(fake)).ledger);
      if (!l.ok) throw new Error(l.error.message);
      return l.value.units.get("story:1.1");
    };
    const at = (m: number) => {
      fake.control.setNow(new Date(T0 + m * MIN).toISOString());
      return T0 + m * MIN;
    };

    // Round 1: taken, the enqueue refused by the forge: left merging, its enqueue unrecorded.
    fake.control.injectError("enqueue", { kind: "rejected", message: "422" });
    await round(fake, committer, laneDir, T0);
    expect(await story()).toMatchObject({ state: "merging", generation: 2, approved_sha: pr.head, passed_sha: pr.head, enqueued_sha: null });
    expect(fake.control.queue()).toEqual([]);

    // Round 2: the same approval stands, so it is taken again and queued, with no comment asking for a review.
    const two = await round(fake, committer, laneDir, at(11));
    expect(two.sessions).toEqual([]);
    expect(await story()).toMatchObject({ state: "merging", generation: 3, approved_sha: pr.head, passed_sha: pr.head, enqueued_sha: pr.head });
    expect(fake.control.queue()).toEqual([pr.number]);
    expect(fake.control.comments(pr.number)).toEqual([]);

    // Ejected by the queue: round 3 parks it for a fresh approval, and round 4 does not take it on the old one.
    expect(fake.control.eject(pr.number)).toBe(true);
    await round(fake, committer, laneDir, at(22));
    expect(await story()).toMatchObject({ state: "parked", generation: 3, approved_sha: null, enqueued_sha: pr.head });
    expect(fake.control.comments(pr.number)).toEqual([reparkComment("story:1.1", "not-queued")]);
    await round(fake, committer, laneDir, at(33));
    expect((await story())?.state).toBe("parked");
    expect(fake.control.queue()).toEqual([]);
  });

  async function snapshotFiles(fake: FakeForge) {
    const s = await fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    return { ledger: s.value.ledger.files };
  }
});

// ------------------------------------------------------------------ retro-gates.yaml (Story 2.9)

describe("createReconcileStep: retro-gates.yaml (Story 2.9)", () => {
  const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
  const RESULT = {
    verdict: "accepted-with-open-items" as const,
    items: [
      { id: "epic-1-retro-item-1-wire-it", text: "Wire it", route: "lane" as const, blocking: true, globs: ["src/x/**"] },
      { id: "epic-1-retro-item-2-ask", text: "Ask", route: "maintainer" as const, blocking: false, globs: [] },
    ],
  };
  /** retro:1's PR merged through the queue; its record merging, with its result. */
  const retroMerged =
    (over: Partial<UnitRecord> = {}) =>
    async (fake: FakeForge) => {
      const pr = await prOn(fake, "xarabot/retro-1", true);
      return [coord("retro:1", { state: "merging", pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, passed_sha: pr.head, retro_result: RESULT, ...over })];
    };

  test("AC: retro:1 merged with a result, the file absent: the run's one runner-written PR creates retro-gates.yaml at schema_version 1 with the verdict, the lane item open and the Maintainer item waiting (Story 4.3)", async () => {
    const f = await setup({ status: STATUS_DONE }, retroMerged());
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(await stateOf(f, "retro:1")).toBe("merged");
    expect(f.commits).toHaveLength(1);
    const c = f.commits[0] as ReconcileCommitRequest;
    expect(Object.keys(c.files)).toEqual([RETRO]);
    const parsed = parseRetroGates(RETRO, c.files[RETRO] as string);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value).toEqual({
      schema_version: 1,
      epics: {
        "1": {
          retro: { verdict: "accepted-with-open-items", unit: "retro:1", recorded_at: FORGE_NOW },
          items: RESULT.items.map((i) => ({ ...i, status: i.route === "maintainer" ? "waiting" : "open" })),
        },
      },
    });
    const pr = await prOnBranch(f, BRANCH);
    expect(pr?.title).toBe("reconcile:5: retro gates for merged units");
    expect(pr?.body).toContain(`Changes to \`${RETRO}\`:`);
    expect(pr?.body).toContain("- epics.1.retro: accepted-with-open-items (retro:1)");
    expect(pr?.body).toContain("- epics.1.items: epic-1-retro-item-1-wire-it added as open");
    expect(pr?.body).toContain("- epics.1.items: epic-1-retro-item-2-ask added as waiting");
    expect(pr?.body).toContain("no agent session");
    const onBranch = await f.fake.forge.listPrsByBranch(BRANCH, opts());
    expect(onBranch.ok && onBranch.value.length).toBe(1);
    expect(f.fake.control.queue()).toEqual([pr?.number ?? -1]);
  });

  test("AC: once that PR merges, retro:1 is done on main and the next run deletes its record, writing nothing", async () => {
    const f = await setup({ status: STATUS_DONE }, retroMerged());
    await f.run();
    const text = (f.commits[0] as ReconcileCommitRequest).files[RETRO] as string;
    // The reconcile PR merges: main now holds the new file; the next run starts.
    f.fake.control.setMain({ ...mainFiles({ status: STATUS_DONE }), [RETRO]: text });
    const merged = (await f.ledger()).get(U) as UnitRecord;
    f.fake.control.writeForeignLedger({
      message: "next run [skip ci]",
      writes: tip([coord("reconcile:5", { ...merged, state: "merged" }), coord("reconcile:6", { state: "claimed" })]),
      deletes: [],
    });
    const next = await f.input();
    const record = next.snapshot.ledger.units.find((r) => r.unit === "reconcile:6") as UnitRecord;
    f.events.length = 0;
    const out = await createReconcileStep({ forge: spied(f.fake, f.events), committer: { commit: async () => err("invalid", "no commit expected") }, graphTrees: unchangedGraph(), identity: COORD, repo: "xaravel/xarabot", agent: "claude", passed: headPassedGate, now: () => T0, sleep: async () => {}, random: () => 0 })({
      ...next,
      unit: { ...next.unit, unit: "reconcile:6" },
      record,
    });
    expect(out.state).toBe("merged");
    expect((await f.ledger()).has("retro:1")).toBe(false);
    expect(swaps(f.events)).toContain("deleteMerged retro:1");
  });

  test("a Story and a retro merged in one run: one PR carries both files", async () => {
    const f = await setup({}, async (fake) => [
      rec({ unit: "story:1.1", globs: [], state: "merged", pr: (await prOn(fake, "story/1.1", true)).number }),
      ...(await retroMerged({ state: "merged" })(fake)),
    ]);
    await f.run();
    expect(Object.keys((f.commits[0] as ReconcileCommitRequest).files).sort()).toEqual([RETRO, STATUS].sort());
    const pr = await prOnBranch(f, BRANCH);
    expect(pr?.title).toBe("reconcile:5: sprint status and retro gates for merged units");
    expect(pr?.body).toContain(`Changes to \`${STATUS}\`:`);
    expect(pr?.body).toContain(`Changes to \`${RETRO}\`:`);
  });

  test("the protected-path gate covers retro-gates.yaml", async () => {
    const f = await setup({ status: STATUS_DONE, policy: [`protected_paths: ["${RETRO}"]`] }, retroMerged());
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await f.ledger()).get(U)?.park).toMatchObject({ kind: "awaiting-approval", globs_held: [RETRO] });
    expect(f.fake.control.queue()).toEqual([]);
  });

  test("an invalid retro-gates.yaml on main fails the run; nothing committed", async () => {
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      fake.control.setMain({ ...mainFiles({ status: STATUS_DONE }), [RETRO]: "schema_version: 1\nepics: [\n" });
      return retroMerged()(fake);
    });
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain(`${RETRO} cannot be written`);
    expect(f.commits).toEqual([]);
  });

  test("a merged retro record with no retro_result is logged and skipped: no PR", async () => {
    const f = await setup({ status: STATUS_DONE }, retroMerged({ state: "merged", retro_result: null }));
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.commits).toEqual([]);
    expect(out.reason).toContain("retro:1 merged with no retro_result: skipped");
    expect(f.logs.join("\n")).toContain("retro:1 merged with no retro_result: no verdict to record, skipped");
    expect(await stateOf(f, "retro:1")).toBe("merged");
  });
});

// ------------------------------------------------------------------ retro items done (Story 2.10)

describe("createReconcileStep: retro items done (Story 2.10)", () => {
  const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
  const X = "epic-1-retro-item-1-wire-it";
  const UNIT_X = `retro-item:${X}`;
  const GATES = [
    "schema_version: 1",
    "epics:",
    '  "1":',
    "    retro:",
    "      verdict: accepted-with-open-items",
    '      unit: "retro:1"',
    "      recorded_at: 2026-10-20T00:00:00Z",
    "    items:",
    `      - id: ${X}`,
    "        text: Wire it",
    "        route: lane",
    "        blocking: false",
    '        globs: ["src/x/**"]',
    "        status: open",
    "",
  ].join("\n");
  /** The item's PR merged through the queue; its record merging, held by the coordinator. */
  const itemMerged = (gates: string | null) => async (fake: FakeForge) => {
    if (gates !== null) fake.control.setMain({ ...mainFiles({ status: STATUS_DONE }), [RETRO]: gates });
    const pr = await prOn(fake, `xarabot/retro-item-${X}`, true);
    return [coord(UNIT_X, { state: "merging", globs: ["src/x/**"], pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, passed_sha: pr.head })];
  };

  test("AC: the merged item's unit is marked merged and the run's PR sets the item done", async () => {
    const f = await setup({ status: STATUS_DONE }, itemMerged(GATES));
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(await stateOf(f, UNIT_X)).toBe("merged");
    expect(f.commits).toHaveLength(1);
    const c = f.commits[0] as ReconcileCommitRequest;
    expect(Object.keys(c.files)).toEqual([RETRO]);
    const parsed = parseRetroGates(RETRO, c.files[RETRO] as string);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.epics["1"]?.items?.map((i) => [i.id, i.status])).toEqual([[X, "done"]]);
    expect(f.logs.join("\n")).toContain(`retro gates: epics.1.items: ${X} open -> done`);
  });

  test("the item absent from retro-gates.yaml: logged and skipped, no PR", async () => {
    const f = await setup({ status: STATUS_DONE }, itemMerged(null));
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.commits).toEqual([]);
    expect(out.reason).toContain(`${UNIT_X} merged but its item is not listed: skipped`);
    expect(await stateOf(f, UNIT_X)).toBe("merged");
  });
});

// ------------------------------------------------------------------ ungated retro and retro-item PRs out of the queue

describe("createReconcileStep: an ungated retro or retro-item PR out of the queue follows a Story's path", () => {
  const X = "epic-1-retro-item-1-wire-it";
  const UNIT_X = `retro-item:${X}`;
  const BRANCH_X = `xarabot/retro-item-${X}`;

  /** The item's PR open, queued by its own step when `queued`; the record merging under the coordinator with no approved_sha. */
  async function ungatedWorld(queued: boolean, over: Partial<UnitRecord> = {}, unit = UNIT_X, branch = BRANCH_X) {
    let pr = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      pr = await prOn(fake, branch);
      if (queued) expect((await fake.forge.enqueue(pr.number, pr.head, opts())).ok).toBe(true);
      return [coord(unit, { state: "merging", globs: ["src/x/**"], pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, passed_sha: pr.head, attempts: 1, ...over })];
    });
    return { f, pr };
  }

  test.each([
    ["Ejected (open, not queued)", "ejected", "is not in the merge queue"],
    ["Closed", "closed", "is closed"],
    ["Unknown to the queue (not-found)", "not-found", "is not known to the forge"],
  ] as const)("%s: released with an attempt, its PR kept; never parked awaiting approval, no comment", async (_name, how, why) => {
    const { f, pr } = await ungatedWorld(how === "ejected");
    if (how === "ejected") expect(f.fake.control.eject(pr.number)).toBe(true);
    if (how === "closed") expect((await f.fake.forge.closePr(pr.number, opts())).ok).toBe(true);
    if (how === "not-found") f.fake.control.injectError("queueState", { kind: "not-found", message: "no such PR" });
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect((await f.ledger()).get(UNIT_X)).toMatchObject({ state: "released", attempts: 2, pr: pr.number, head_sha: pr.head, park: null, approved_sha: null });
    expect(f.fake.control.comments(pr.number)).toEqual([]);
    expect(swaps(f.events).slice(0, 1)).toEqual([`releaseEjected ${UNIT_X}`]);
    expect(out.reason).toContain(`${UNIT_X}: PR #${pr.number} ${why}: released with an attempt, to be taken through CI again`);
  });

  test("an ungated retro, ejected: released with an attempt, never parked awaiting approval", async () => {
    const { f, pr } = await ungatedWorld(true, { globs: [] }, "retro:1", "xarabot/retro-1");
    expect(f.fake.control.eject(pr.number)).toBe(true);
    await f.run();
    expect((await f.ledger()).get("retro:1")).toMatchObject({ state: "released", attempts: 2, pr: pr.number });
    expect(f.fake.control.comments(pr.number)).toEqual([]);
  });

  test("at the attempts cap: parked blocked attempts-cap", async () => {
    const { f, pr } = await ungatedWorld(true, { attempts: 2 });
    expect(f.fake.control.eject(pr.number)).toBe(true);
    await f.run();
    expect((await f.ledger()).get(UNIT_X)).toMatchObject({ state: "parked", attempts: 3, park: { kind: "blocked", reason: "attempts-cap" } });
  });

  test("still queued at its head: left merging", async () => {
    const { f, pr } = await ungatedWorld(true);
    const before = (await f.ledger()).get(UNIT_X);
    await f.run();
    expect((await f.ledger()).get(UNIT_X)).toEqual(before);
    expect(f.fake.control.queue()).toEqual([pr.number]);
  });

  test("queued at another head: dequeued behind a fence, then released", async () => {
    const { f } = await ungatedWorld(true, { head_sha: "d".repeat(40) });
    await f.run();
    expect(f.events.slice(0, 4)).toEqual(["queueState", "ledgerSwap heartbeat reconcile:5", "dequeue", `ledgerSwap releaseEjected ${UNIT_X}`]);
    expect(f.fake.control.queue()).toEqual([]);
    expect(await stateOf(f, UNIT_X)).toBe("released");
  });

  test("merged after the snapshot: queueState says merged, so markMerged", async () => {
    const { f } = await ungatedWorld(true);
    const forge: Forge = {
      ...f.fake.forge,
      queueState: (n, o) => {
        f.fake.control.mergeQueueHead();
        return f.fake.forge.queueState(n, o);
      },
    };
    await f.run({ forge });
    expect(await stateOf(f, UNIT_X)).toBe("merged");
  });

  test("a queueState error other than not-found leaves the record, with a note", async () => {
    const { f, pr } = await ungatedWorld(false);
    const before = (await f.ledger()).get(UNIT_X);
    f.fake.control.injectError("queueState", { kind: "transient", message: "502" });
    const out = await f.run();
    expect(out.reason).toContain(`${UNIT_X}: queueState PR #${pr.number} transient: 502; left for a later run`);
    expect((await f.ledger()).get(UNIT_X)).toEqual(before);
  });
});

// ------------------------------------------------------------------ a gated retro-item PR (Story 2.10's "Story 2.6's enqueue")

describe("createReconcileStep: a retro-item PR parked awaiting approval takes Story 2.6's enqueue (Story 2.10)", () => {
  const X = "epic-1-retro-item-1-wire-it";
  const UNIT_X = `retro-item:${X}`;
  const BRANCH_X = `xarabot/retro-item-${X}`;
  const PARKED_AT = minutesBefore(20);
  const DIFF = ["src/x/a.ts"];

  /** The item's PR open at its head; the record parked awaiting-approval by its own step, in the coordinator owner's inbox; `reviews` added to the PR. */
  async function parkedItem(reviews: (head: string) => readonly ForgeReview[]) {
    let pr = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      pr = await prOn(fake, BRANCH_X);
      for (const r of reviews(pr.head)) fake.control.addReview(pr.number, r);
      return [
        coord(UNIT_X, {
          state: "parked",
          globs: DIFF,
          pr: pr.number,
          pr_owner: COORD.owner,
          head_sha: pr.head,
          base_sha: "c".repeat(40),
          passed_sha: pr.head,
          heartbeat_at: PARKED_AT,
          park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: DIFF },
        }),
      ];
    });
    return { f, pr };
  }

  const approval = (head: string, minutesAgo: number): ForgeReview => ({ author: COORD.owner, state: "approved", commit_sha: head, submitted_at: minutesBefore(minutesAgo) });

  test("approved by its owner at the parked head: taken merging at generation + 1, approved_sha = enqueued_sha = H, passed_sha kept, and enqueued at H", async () => {
    const { f, pr } = await parkedItem((h) => [approval(h, 5)]);
    const out = await f.run({ forge: spied(f.fake, f.events, true) });
    expect(out.state).toBe("merged");
    expect((await f.ledger()).get(UNIT_X)).toMatchObject({
      state: "merging",
      generation: 2,
      approved_sha: pr.head,
      passed_sha: pr.head,
      enqueued_sha: pr.head,
      head_sha: pr.head,
      globs: DIFF,
      park: null,
      lane: "coordinator",
      attempts: 0,
    });
    expect(f.fake.control.queue()).toEqual([pr.number]);
    expect(f.events).toEqual([
      "reviews",
      "snapshot",
      `ledgerSwap takeApproved ${UNIT_X}`,
      `ledgerSwap heartbeat ${UNIT_X}`,
      "enqueue",
      `ledgerSwap heartbeat ${UNIT_X}`,
      "ledgerSwap finishRecurring reconcile:5",
    ]);
    expect(out.reason).toContain(`${UNIT_X}: PR #${pr.number} approved by ${COORD.owner}, enqueued at ${pr.head}`);
  });

  test("no standing approval: not taken; stays parked; no fresh snapshot", async () => {
    const { f, pr } = await parkedItem(() => []);
    const before = (await f.ledger()).get(UNIT_X);
    await f.run({ forge: spied(f.fake, f.events, true) });
    expect((await f.ledger()).get(UNIT_X)).toEqual(before);
    expect(f.fake.control.queue()).toEqual([]);
    expect(f.events).toEqual(["reviews", "ledgerSwap finishRecurring reconcile:5"]);
    expect(f.logs.join("\n")).toContain(`${UNIT_X}: no standing approval of ${pr.head} on PR #${pr.number}`);
  });

  test("taken on that approval, then ejected: parked awaiting approval again with the not-queued comment; no attempt, never released", async () => {
    let pr = { number: 0, head: "" };
    const f = await setup({}, async (fake) => {
      pr = await prOn(fake, BRANCH_X);
      expect((await fake.forge.enqueue(pr.number, pr.head, opts())).ok).toBe(true);
      return [coord(UNIT_X, { state: "merging", generation: 2, globs: DIFF, pr: pr.number, pr_owner: COORD.owner, head_sha: pr.head, base_sha: "c".repeat(40), passed_sha: pr.head, enqueued_sha: pr.head, approved_sha: pr.head })];
    });
    expect(f.fake.control.eject(pr.number)).toBe(true);
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(out.reason).toContain(`${UNIT_X}: PR #${pr.number} is not in the merge queue: parked awaiting approval again`);
    const r = (await f.ledger()).get(UNIT_X);
    expect(r).toMatchObject({ state: "parked", generation: 2, approved_sha: null, attempts: 0, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: DIFF } });
    expect(Date.parse(r?.heartbeat_at ?? "")).toBe(T0);
    expect(swaps(f.events).slice(0, 1)).toEqual([`park ${UNIT_X}`]);
    expect(f.fake.control.comments(pr.number)).toEqual([reparkComment(UNIT_X, "not-queued")]);
  });
});

// ------------------------------------------------------------------ Story 4.2

describe("createReconcileStep: through a forge fenced on the coordinator claim (Q5)", () => {
  test("the claim's holder and generation at the tip: the run goes as before", async () => {
    const f = await setup({ coordinator: { digest_posted_at: "2026-10-22T08:00:00Z" } });
    const out = await f.run({ forge: fenceForge(spied(f.fake, f.events), { by: COORD, generation: 1 }) });
    expect(out.state).toBe("merged");
    expect(f.messages()).toContain(`ledger: finishRecurring ${U} [skip ci]`);
    expect(f.messages()).toContain("ledger: stampDigest coordinator [skip ci]");
  });

  test.each([
    ["taken over by another identity", { owner: "dave", host: "44444444-4444-4444-8444-444444444444", generation: 2 }],
    ["at another generation", { generation: 2 }],
  ] as const)("coordinator.json %s since the claim: no unit edit lands and nothing is stamped", async (_name, coordinator) => {
    const f = await setup({ coordinator: { ...coordinator, digest_posted_at: "2026-10-22T08:00:00Z" } });
    const before = f.messages();
    const out = await f.run({ forge: fenceForge(spied(f.fake, f.events), { by: COORD, generation: 1 }) });
    expect(out.outcome).toBe("failed");
    expect(f.messages()).toEqual(before);
    expect(await stateOf(f, U)).toBe("claimed");
  });
});

describe("createReconcileStep: owners' inboxes and the daily digest (Story 4.2)", () => {
  const REPO_URL = "https://github.com/xaravel/xarabot";
  const TWO_DAYS = minutesBefore(2 * 24 * 60);
  const ALICE_ID: LaneIdentity = { owner: "alice", host: "11111111-1111-4111-8111-111111111111", lane: "builder-1" };
  const BOB_ID: LaneIdentity = { owner: "bob", host: "22222222-2222-4222-8222-222222222222", lane: "builder-2" };
  const DUE = { digest_posted_at: "2026-10-22T08:00:00Z" };

  /** alice's Story 1.1 parked blocked with its text and no PR; bob's Story 1.2 parked awaiting approval on an open PR. */
  const seedTwo = async (fake: FakeForge): Promise<readonly UnitRecord[]> => {
    const pr = await prOn(fake, "story/1.2");
    return [
      rec({
        ...ALICE_ID,
        unit: "story:1.1",
        state: "parked",
        globs: ["src/a/**"],
        heartbeat_at: TWO_DAYS,
        park: { kind: "blocked", reason: "intent-gap", inbox_owner: "alice", globs_held: [], text: "Which inbox owns graph PRs? Ask @carol." },
      }),
      rec({
        ...BOB_ID,
        unit: "story:1.2",
        state: "parked",
        globs: ["src/b/**"],
        heartbeat_at: TWO_DAYS,
        pr: pr.number,
        pr_owner: "bob",
        head_sha: pr.head,
        passed_sha: pr.head,
        park: { kind: "awaiting-approval", reason: null, inbox_owner: "bob", globs_held: ["src/b/x.ts"] },
      }),
    ];
  };

  /** The run's own record claimed again, as the next `reconcile` run's claim would leave it. */
  const reclaim = (f: Fake, more: Record<string, string> = {}, deletes: string[] = []) =>
    f.fake.control.writeForeignLedger({ message: "next run [skip ci]", writes: { ...tip([OWN]), ...more }, deletes });

  const inboxOf = (f: Fake, owner: string) => f.fake.control.inboxes().find((i) => i.owner === owner);
  const coordinatorRecord = async (f: Fake) => {
    const s = await f.fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.coordinator;
  };

  test("parked records of two owners: one labelled, assigned inbox each, listing the unit with its link, age and park text; a second run writes no body", async () => {
    const f = await setup({}, seedTwo);
    const out = await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(out.state).toBe("merged");
    const pr = (await f.ledger()).get("story:1.2")?.pr as number;
    expect(f.fake.control.inboxes().map((i) => [i.owner, i.title, i.open])).toEqual([
      ["alice", "🤖 Xarabot inbox", true],
      ["bob", "🤖 Xarabot inbox", true],
    ]);
    const alice = inboxOf(f, "alice")?.body ?? "";
    expect(alice).toContain(`- [story:1.1](${REPO_URL}/blob/xarabot/claims/units/story__1.1.json) · blocked \`intent-gap\` · 2d\n  > Which inbox owns graph PRs? Ask carol.\n`);
    expect(inboxOf(f, "bob")?.body).toContain(`- [story:1.2](${REPO_URL}/pull/${pr}) · awaiting approval · 2d\n`);
    expect(alice).not.toContain("story:1.2");
    // Today's digest is posted already: no stamp and no mention.
    expect(f.events.filter((e) => e.startsWith("inbox") || e.startsWith("openInbox") || e.startsWith("setInboxBody") || e.includes("stampDigest"))).toEqual([
      "inboxes",
      "openInbox",
      "setInboxBody",
      "openInbox",
      "setInboxBody",
    ]);
    reclaim(f);
    f.events.length = 0;
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(f.events.filter((e) => ["inboxes", "openInbox", "setInboxBody", "inboxComment"].includes(e))).toEqual(["inboxes"]);
  });

  test("an owner whose records all cleared: their inbox body becomes the empty text", async () => {
    const f = await setup({}, seedTwo);
    await f.run();
    expect(inboxOf(f, "bob")?.body).toContain("story:1.2");
    reclaim(f, {}, [unitPath("story:1.2")]);
    await f.run();
    expect(inboxOf(f, "bob")?.body).toBe("🤖 Xarabot inbox: nothing waits on you.\n");
    expect(inboxOf(f, "alice")?.body).toContain("story:1.1");
  });

  test("the digest slot passed: the first run stamps digest_posted_at before one mention per non-empty inbox; a second run that day posts nothing", async () => {
    const f = await setup({ coordinator: DUE }, seedTwo);
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    const order = f.events.filter((e) => e === "ledgerSwap stampDigest coordinator" || e === "inboxComment");
    expect(order).toEqual(["ledgerSwap stampDigest coordinator", "inboxComment", "inboxComment"]);
    expect(Date.parse((await coordinatorRecord(f))?.digest_posted_at ?? "")).toBe(T0);
    const [alice, bob] = [inboxOf(f, "alice"), inboxOf(f, "bob")];
    expect(f.fake.control.inboxComments(alice?.number as number)).toEqual([`🤖 @alice Xarabot daily digest: 1 item waits on you in https://github.com/fake/repo/issues/${alice?.number}.`]);
    expect(f.fake.control.inboxComments(bob?.number as number)).toHaveLength(1);
    // The second run of the day.
    reclaim(f);
    f.events.length = 0;
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(f.events.filter((e) => e === "inboxComment" || e.includes("stampDigest"))).toEqual([]);
    expect(f.fake.control.inboxComments(alice?.number as number)).toHaveLength(1);
  });

  test("a refused stamp (another coordinator holds coordinator.json) posts no mention", async () => {
    const f = await setup({ coordinator: { ...DUE, owner: "dave", host: "44444444-4444-4444-8444-444444444444" } }, seedTwo);
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.fake.control.inboxes()).toHaveLength(2);
    for (const i of f.fake.control.inboxes()) expect(f.fake.control.inboxComments(i.number)).toEqual([]);
    expect(f.logs.some((l) => l.includes("stampDigest refused or failed"))).toBe(true);
  });

  test("forge errors in the inbox step are logged and never fail the run", async () => {
    const f = await setup({ coordinator: DUE }, seedTwo);
    f.fake.control.injectError("inboxes", { kind: "forbidden", message: "no issues: write" });
    const out = await f.run();
    expect(out.outcome).toBe("progress");
    expect(out.state).toBe("merged");
    expect(f.fake.control.inboxes()).toEqual([]);
    expect(f.logs.some((l) => l.includes("inbox step: inboxes failed: forbidden"))).toBe(true);
    // Nothing was stamped, so the next run still owes today's digest.
    expect((await coordinatorRecord(f))?.digest_posted_at).toBe(DUE.digest_posted_at);
  });

  test("a Story spec on main whose frontmatter does not parse is logged and skipped; its neighbours' deferred entries still list", async () => {
    const bad = "_bmad-output/implementation-artifacts/spec-1-2-broken.md";
    const good = "_bmad-output/implementation-artifacts/spec-1-1-first.md";
    const f = await setup({ extra: { [bad]: "---\ndeferred: [unclosed\n---\n", [good]: "---\ncreated: '2026-10-22'\ndeferred:\n  - summary: Left for later.\n---\n" } });
    await f.run();
    expect(f.logs.some((l) => l.includes(`deferred entries: ${bad}`) && l.includes("skipped"))).toBe(true);
    expect(inboxOf(f, "edanisko")?.body).toContain(`- [1.1-d1](${REPO_URL}/blob/main/${good}) · deferred: Left for later. · 1d`);
  });
});

// ------------------------------------------------------------------ Story 4.5

describe("createReconcileStep: rulings on the inboxes (Story 4.5)", () => {
  const ALICE_ID: LaneIdentity = { owner: "alice", host: "11111111-1111-4111-8111-111111111111", lane: "builder-1" };
  /** Story 1.1 parked needs-approval: the Maintainer's to approve. */
  const NEEDS = rec({ ...ALICE_ID, unit: "story:1.1", state: "parked", globs: ["src/a/**"], heartbeat_at: FORGE_NOW, park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } });

  type Seeded = { inbox: number; ruling: string; thanks: string };
  /** The Maintainer's inbox with their approve ruling and a plain comment on it. */
  const seeded = (out: Partial<Seeded>) => async (fake: FakeForge): Promise<readonly UnitRecord[]> => {
    const opened = await fake.forge.openInbox("edanisko", opts());
    if (!opened.ok) throw new Error(opened.error.message);
    out.inbox = opened.value.number;
    out.ruling = fake.control.addInboxComment(opened.value.number, "edanisko", "/xarabot approve story:1.1");
    out.thanks = fake.control.addInboxComment(opened.value.number, "bob", "thanks");
    return [NEEDS];
  };

  const reclaim = (f: Fake) => f.fake.control.writeForeignLedger({ message: "next run [skip ci]", writes: tip([OWN]), deletes: [] });
  const coordinatorRecord = async (f: Fake) => {
    const s = await f.fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.coordinator;
  };
  const RULING_EVENTS = ["readRulings", "ledgerSwap recordRulings coordinator", "inboxComment", "inboxes"];

  test("the Maintainer's ruling: one fenced swap advances coordinator.json's cursor and applies it, then one ack is posted; a second run posts nothing new", async () => {
    const s: Partial<Seeded> = {};
    const f = await setup({}, seeded(s));
    const inbox = s.inbox as number;
    const spy = spied(f.fake, f.events, false, true);
    const sent: { message: string; writes: Readonly<Record<string, string>> }[] = [];
    const out = await f.run({ forge: { ...spy, ledgerSwap: (old, commit, o) => (sent.push(commit), spy.ledgerSwap(old, commit, o)) } });
    expect(out.state).toBe("merged");
    // Right after the ledger work, before the inbox step: read, swap, reply.
    expect(f.events.filter((e) => RULING_EVENTS.includes(e))).toEqual(["readRulings", "ledgerSwap recordRulings coordinator", "inboxComment", "inboxes"]);
    expect((await coordinatorRecord(f))?.rulings_cursor).toBe(s.thanks as string);
    // The swap is fenced on the run's own record: one commit carries the cursor, the fence and the approval (Story 4.6).
    const swap = sent.find((c) => c.message === "ledger: recordRulings coordinator [skip ci]");
    expect(Object.keys(swap?.writes ?? {}).sort()).toEqual([COORDINATOR_PATH, unitPath(U), unitPath("story:1.1")].sort());
    expect(f.fake.control.ledgerLog().some((c) => c.message === swap?.message)).toBe(true);
    const comments = f.fake.control.inboxComments(inbox);
    expect(comments).toEqual([
      "/xarabot approve story:1.1",
      "thanks",
      `🤖 Ruling acknowledged: \`/xarabot approve story:1.1\` from edanisko ([comment](https://github.com/fake/repo/issues/${inbox}#issuecomment-${s.ruling})).`,
    ]);
    // Story 4.6: the approval is applied in that swap, with the manifest's sha on main.
    const manifestSha = (await f.input()).snapshot.manifests.find((m) => m.story_id === "1.1")?.sha;
    expect((await f.ledger()).get("story:1.1")).toMatchObject({ state: "released", park: null, approval: { by: "edanisko", manifest_sha: manifestSha } });

    // The second run reads only the bot's own ack, which is no ruling: the cursor moves past it, and nothing is posted.
    reclaim(f);
    f.events.length = 0;
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(f.events.filter((e) => e === "inboxComment")).toEqual([]);
    expect(f.fake.control.inboxComments(inbox)).toHaveLength(3);
    const cursor = (await coordinatorRecord(f))?.rulings_cursor;
    expect(Number(cursor)).toBeGreaterThan(Number(s.thanks));

    // A third run finds no new comment: no swap, no reply.
    reclaim(f);
    f.events.length = 0;
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(f.events.filter((e) => RULING_EVENTS.includes(e))).toEqual(["readRulings", "inboxes"]);
    expect((await coordinatorRecord(f))?.rulings_cursor).toBe(cursor as string);
  });

  test("a refused swap (another coordinator holds coordinator.json): no reply, logged, and the run still finishes", async () => {
    const s: Partial<Seeded> = {};
    const f = await setup({ coordinator: { owner: "dave", host: "44444444-4444-4444-8444-444444444444" } }, seeded(s));
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.fake.control.inboxComments(s.inbox as number)).toHaveLength(2);
    expect((await coordinatorRecord(f))?.rulings_cursor).toBeNull();
    expect(f.logs.some((l) => l.includes("rulings: recordRulings refused or failed"))).toBe(true);
    expect(f.logs.some((l) => l.includes("rulings step: rulings_cursor not advanced"))).toBe(true);
  });

  test("a read error is logged and nothing is written; the run goes on to the inbox step", async () => {
    const s: Partial<Seeded> = {};
    const f = await setup({}, seeded(s));
    f.fake.control.injectError("readRulings", { kind: "forbidden", message: "no issues: write" });
    const out = await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(out.outcome).toBe("progress");
    expect(out.state).toBe("merged");
    expect(swaps(f.events).filter((e) => e.includes("advanceRulingsCursor"))).toEqual([]);
    expect(f.events).toContain("inboxes");
    expect(f.fake.control.inboxComments(s.inbox as number)).toHaveLength(2);
    expect(f.logs.some((l) => l.includes("rulings step: readRulings failed: forbidden"))).toBe(true);
  });

  test("with no coordinator.json the step is skipped and logged", async () => {
    const s: Partial<Seeded> = {};
    const f = await setup({}, seeded(s));
    f.fake.control.writeForeignLedger({ message: "drop the claim [skip ci]", writes: {}, deletes: [COORDINATOR_PATH] });
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(f.events).not.toContain("readRulings");
    expect(f.fake.control.inboxComments(s.inbox as number)).toHaveLength(2);
    expect(f.logs.some((l) => l.includes("rulings step: no coordinator.json in the snapshot; skipped"))).toBe(true);
  });
});

// ------------------------------------------------------------------ Story 4.6

describe("createReconcileStep: what each verb does (Story 4.6)", () => {
  const GATES = "_bmad-output/implementation-artifacts/retro-gates.yaml";
  const A = "epic-1-retro-item-1-a";
  const B = "epic-1-retro-item-2-b";
  const RECORDED = "2026-10-20T00:00:00Z";
  const itemLines = (id: string, text: string, blocking: boolean, status: string) => [
    `      - id: "${id}"`,
    `        text: "${text}"`,
    "        route: maintainer",
    `        blocking: ${blocking}`,
    "        globs: []",
    `        status: ${status}`,
  ];
  /** Epic 1: a checkpoint whose retro is rejected with no go; item A waiting and not blocking, item B open and blocking, both the Maintainer's. */
  const gatesText = (checkpointGo = false) =>
    [
      "schema_version: 1",
      "epics:",
      '  "1":',
      "    retro:",
      "      verdict: rejected",
      '      unit: "retro:1"',
      `      recorded_at: "${RECORDED}"`,
      "    items:",
      ...itemLines(A, "Do A.", false, "waiting"),
      ...itemLines(B, "Do B.", true, "open"),
      ...(checkpointGo ? ["    checkpoint:", "      go:", '        by: "edanisko"', `        at: "${FORGE_NOW}"`, '        ruling: "77"'] : []),
      "",
    ].join("\n");
  const world = (checkpointGo = false): MainOpts => ({ extra: { [GATES]: gatesText(checkpointGo), ".xarabot/epics.yaml": "version: 1\nepics:\n  1:\n    checkpoint: true\n" } });

  type Ruled = { inbox: number; ids: string[] };
  /** The Maintainer's inbox with `bodies` posted on it by `author`, after `records` are seeded. */
  const ruling =
    (bodies: readonly string[], out: Partial<Ruled>, records: (fake: FakeForge) => Promise<readonly UnitRecord[]> = async () => [], author = "edanisko") =>
    async (fake: FakeForge): Promise<readonly UnitRecord[]> => {
      const seeded = await records(fake);
      const opened = await fake.forge.openInbox("edanisko", opts());
      if (!opened.ok) throw new Error(opened.error.message);
      out.inbox = opened.value.number;
      out.ids = bodies.map((b) => fake.control.addInboxComment(opened.value.number, author, b));
      return seeded;
    };
  const coordinatorRecord = async (f: Fake) => {
    const s = await f.fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.coordinator;
  };
  const gatesOf = (f: Fake, i = 0) => {
    const text = f.commits[i]?.files[GATES];
    if (text === undefined) throw new Error("no retro-gates.yaml in the commit");
    const parsed = parseRetroGates(GATES, text);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value.epics["1"];
  };
  const inboxBody = (f: Fake) => f.fake.control.inboxes().find((i) => i.owner === "edanisko")?.body ?? "";
  const go = (id: string) => ({ by: "edanisko", at: FORGE_NOW, ruling: id });
  const reclaim = (f: Fake) => f.fake.control.writeForeignLedger({ message: "next run [skip ci]", writes: tip([OWN]), deletes: [] });

  test("go checkpoint: a pending go in coordinator.json; this run's PR sets epics.1.checkpoint.go; the item leaves the inbox", async () => {
    const r: Partial<Ruled> = {};
    const f = await setup(world(), ruling(["/xarabot go checkpoint:1"], r));
    const id = r.ids?.[0] as string;
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect((await coordinatorRecord(f))?.pending_rulings).toEqual([{ verb: "go", unit: "checkpoint:1", ...go(id) }]);
    expect(Object.keys(f.commits[0]?.files ?? {})).toEqual([GATES]);
    expect(gatesOf(f)?.checkpoint).toEqual({ go: go(id) });
    const pr = await prOnBranch(f, BRANCH);
    expect(pr?.title).toBe("reconcile:5: retro gates for merged units");
    expect(pr?.body).toContain(`- epics.1.checkpoint: go by edanisko (${id})`);
    expect(inboxBody(f)).not.toContain("[checkpoint:1]");
    expect(inboxBody(f)).toContain("[retro:1]");
    expect(f.fake.control.inboxComments(r.inbox as number).at(-1)).toContain("Ruling acknowledged: `/xarabot go checkpoint:1`");
  });

  test("go on a rejected retro: the PR sets epics.1.retro.go, and the rejected-retro item leaves the inbox", async () => {
    const r: Partial<Ruled> = {};
    const f = await setup(world(), ruling(["/xarabot go retro:1"], r));
    const id = r.ids?.[0] as string;
    await f.run();
    expect(gatesOf(f)?.retro).toEqual({ verdict: "rejected", unit: "retro:1", recorded_at: RECORDED, go: go(id) });
    expect(inboxBody(f)).not.toContain("[retro:1]");
    expect(inboxBody(f)).toContain(`[retro-item:${A}]`);
  });

  test("block and unblock: both pending; the PR flips each item's blocking", async () => {
    const r: Partial<Ruled> = {};
    const f = await setup(world(), ruling([`/xarabot block retro-item:${A}`, `/xarabot unblock retro-item:${B}`], r));
    await f.run();
    expect((await coordinatorRecord(f))?.pending_rulings?.map((e) => `${e.verb} ${e.unit}`)).toEqual([`block retro-item:${A}`, `unblock retro-item:${B}`]);
    expect(gatesOf(f)?.items?.map((i) => [i.id, i.blocking])).toEqual([
      [A, true],
      [B, false],
    ]);
  });

  test("done and defer: the PR sets each item's status, and both leave the inbox", async () => {
    const r: Partial<Ruled> = {};
    const f = await setup(world(), ruling([`/xarabot done retro-item:${A}`, `/xarabot defer retro-item:${B}`], r));
    await f.run();
    expect(gatesOf(f)?.items?.map((i) => [i.id, i.status])).toEqual([
      [A, "done"],
      [B, "deferred"],
    ]);
    expect(inboxBody(f)).not.toContain("[retro-item:");
  });

  test("dismiss: the dismissal is stored and the item is gone from the inbox; no PR, and the ledger records are unchanged", async () => {
    const r: Partial<Ruled> = {};
    const parked = rec({ unit: "story:1.1", state: "parked", globs: ["src/a/**"], heartbeat_at: FORGE_NOW, park: { kind: "blocked", reason: "intent-gap", inbox_owner: "edanisko", globs_held: [] } });
    const f = await setup(world(), ruling([`/xarabot dismiss retro-item:${A}`], r, async () => [parked]));
    const out = await f.run();
    expect(out.state).toBe("merged");
    expect(f.commits).toEqual([]);
    expect((await coordinatorRecord(f))?.dismissals).toEqual([{ unit: `retro-item:${A}`, subject: "Epic 1 · waiting: Do A.", since: RECORDED }]);
    expect((await coordinatorRecord(f))?.pending_rulings).toBeUndefined();
    expect(inboxBody(f)).not.toContain(`[retro-item:${A}]`);
    expect(inboxBody(f)).toContain(`[retro-item:${B}]`);
    expect((await f.ledger()).get("story:1.1")).toEqual(parked);
  });

  test("dismissal expiry: an item listed again as a new instance drops its dismissal and shows; an unlisted item keeps its own", async () => {
    const stale = { unit: `retro-item:${A}`, subject: "Epic 1 · waiting: An older text.", since: RECORDED };
    const unlisted = { unit: "retro-item:epic-1-retro-item-9-z", subject: "Epic 1 · open: Gone.", since: RECORDED };
    const kept = { unit: `retro-item:${B}`, subject: "Epic 1 · open, blocking: Do B.", since: RECORDED };
    const f = await setup({ ...world(), coordinator: { dismissals: [stale, unlisted, kept] } });
    const out = await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(out.state).toBe("merged");
    expect(swaps(f.events)).toContain("recordRulings coordinator");
    expect((await coordinatorRecord(f))?.dismissals).toEqual([unlisted, kept]);
    expect(inboxBody(f)).toContain(`[retro-item:${A}]`);
    expect(inboxBody(f)).not.toContain(`[retro-item:${B}]`);
  });

  test("a pending ruling survives a run with no PR: the next run writes it again", async () => {
    const r: Partial<Ruled> = {};
    let calls = 0;
    const f = await setup({ ...world(), committer: (c) => (calls++ === 0 ? err("transient", "disk full") : ok({ head_sha: f.head, base_sha: c.ontoSha })) }, ruling(["/xarabot go checkpoint:1"], r));
    const id = r.ids?.[0] as string;
    const first = await f.run();
    expect(first.outcome).toBe("failed");
    expect((await coordinatorRecord(f))?.pending_rulings).toEqual([{ verb: "go", unit: "checkpoint:1", ...go(id) }]);
    reclaim(f);
    const second = await f.run();
    expect(second.state).toBe("merging");
    expect(gatesOf(f, 1)?.checkpoint).toEqual({ go: go(id) });
    // The ruling was answered once, by the first run.
    expect(f.fake.control.inboxComments(r.inbox as number).filter((c) => c.startsWith("🤖"))).toHaveLength(1);
  });

  test("shown on main: the pending entry is dropped (a swap holding only recordRulings), and no PR is opened", async () => {
    const pending = [{ verb: "go" as const, unit: "checkpoint:1", by: "edanisko", at: FORGE_NOW, ruling: "77" }];
    const f = await setup({ ...world(true), coordinator: { pending_rulings: pending } });
    const out = await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(out.state).toBe("merged");
    expect(f.commits).toEqual([]);
    expect(swaps(f.events)).toContain("recordRulings coordinator");
    expect((await coordinatorRecord(f))?.pending_rulings).toBeUndefined();
  });

  test("a pending go seeded and no new comment: the item is not in the Maintainer's inbox", async () => {
    const pending = [{ verb: "go" as const, unit: "checkpoint:1", by: "edanisko", at: FORGE_NOW, ruling: "79" }];
    const f = await setup({ ...world(), coordinator: { pending_rulings: pending } });
    await f.run();
    const body = inboxBody(f);
    expect(body).toContain("[retro:1]");
    expect(body).not.toContain("[checkpoint:1]");
    expect(gatesOf(f)?.checkpoint).toEqual({ go: { by: "edanisko", at: FORGE_NOW, ruling: "79" } });
  });

  test("the batch swap drops a seeded entry main already shows, alongside a new ruling", async () => {
    const shown = { verb: "go" as const, unit: "checkpoint:1", by: "edanisko", at: FORGE_NOW, ruling: "77" };
    const r: Partial<Ruled> = {};
    const f = await setup({ ...world(true), coordinator: { pending_rulings: [shown] } }, ruling([`/xarabot block retro-item:${A}`], r));
    await f.run();
    const id = r.ids?.[0] as string;
    expect((await coordinatorRecord(f))?.pending_rulings).toEqual([{ verb: "block", unit: `retro-item:${A}`, ...go(id) }]);
    expect((await coordinatorRecord(f))?.rulings_cursor).toBe(id);
  });

  test("main's graph does not resolve: a pending ruling is kept, not dropped", async () => {
    const pending = [{ verb: "block" as const, unit: `retro-item:${A}`, by: "edanisko", at: FORGE_NOW, ruling: "80" }];
    const broken = { extra: { ...world().extra, ".xarabot/epics.yaml": "version: 1\nepics:\n  1:\n    depends_on: [2]\n  2:\n    depends_on: [1]\n" } };
    const f = await setup({ ...broken, coordinator: { pending_rulings: pending } });
    expect((await f.input()).snapshot.graph.ok).toBe(false);
    await f.run({ forge: spied(f.fake, f.events, false, true) });
    expect(swaps(f.events)).not.toContain("recordRulings coordinator");
    expect((await coordinatorRecord(f))?.pending_rulings).toEqual(pending);
  });

  test("a pending ruling main does not show yet is written again even with no new comment", async () => {
    const pending = [{ verb: "block" as const, unit: `retro-item:${A}`, by: "edanisko", at: FORGE_NOW, ruling: "78" }];
    const f = await setup({ ...world(), coordinator: { pending_rulings: pending } });
    const out = await f.run();
    expect(out.state).toBe("merging");
    expect(gatesOf(f)?.items?.find((i) => i.id === A)?.blocking).toBe(true);
    expect((await coordinatorRecord(f))?.pending_rulings).toEqual(pending);
  });

  describe("a reconcile PR open keeps the last block/unblock ruling (Epic 4 retro item 1)", () => {
    /** `reconcile:3` parked with its PR open (the first ruling's PR): the ledger work leaves it, so it stays open. */
    const openReconcile = async (fake: FakeForge): Promise<readonly UnitRecord[]> => {
      const r3 = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [coord("reconcile:3", { state: "parked", pr: r3, park: { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] } })];
    };

    test.each([
      // main shows A not blocking; the open PR blocks it; then the Maintainer unblocks it.
      ["block then unblock", "block", "unblock", A],
      // The mirror: main shows B blocking; the open PR unblocks it; then the Maintainer blocks it again.
      ["unblock then block", "unblock", "block", B],
    ] as const)("%s with the first PR open: the last ruling stays pending across runs while main shows it", async (_name, first, last, item) => {
      const r: Partial<Ruled> = {};
      const firstEntry = { verb: first, unit: `retro-item:${item}`, by: "edanisko", at: FORGE_NOW, ruling: "70" };
      const f = await setup({ ...world(), coordinator: { pending_rulings: [firstEntry] } }, ruling([`/xarabot ${last} retro-item:${item}`], r, openReconcile));
      const id = r.ids?.[0] as string;
      const lastEntry = { verb: last, unit: `retro-item:${item}`, ...go(id) };
      const out = await f.run();
      expect(out.state).toBe("merged");
      expect(f.commits).toEqual([]);
      expect((await coordinatorRecord(f))?.pending_rulings).toEqual([lastEntry]);
      // The next run reads no new comment: main shows the last ruling, but the PR carrying the first is still open.
      reclaim(f);
      const second = await f.run();
      expect(second.state).toBe("merged");
      expect((await coordinatorRecord(f))?.pending_rulings).toEqual([lastEntry]);
    });

    test("with no reconcile PR open, the same entry main shows is dropped", async () => {
      const pending = [{ verb: "unblock" as const, unit: `retro-item:${A}`, by: "edanisko", at: FORGE_NOW, ruling: "71" }];
      const f = await setup({ ...world(), coordinator: { pending_rulings: pending } });
      await f.run({ forge: spied(f.fake, f.events, false, true) });
      expect(swaps(f.events)).toContain("recordRulings coordinator");
      expect((await coordinatorRecord(f))?.pending_rulings).toBeUndefined();
    });
  });

  describe("release and rebuild", () => {
    const parkedOn =
      (out: { pr?: number }) =>
      async (fake: FakeForge): Promise<readonly UnitRecord[]> => {
        const pr = await prOn(fake, "story/1.1");
        out.pr = pr.number;
        return [
          rec({
            unit: "story:1.1",
            state: "parked",
            globs: ["src/a/**"],
            generation: 2,
            heartbeat_at: FORGE_NOW,
            pr: pr.number,
            pr_owner: "alice",
            head_sha: pr.head,
            reviewed_sha: pr.head,
            passed_sha: pr.head,
            builder_providers: ["anthropic"],
            attempts: 2,
            loopbacks: 1,
            ci_fixes: 1,
            park: { kind: "blocked", reason: "attempts-cap", inbox_owner: "alice", globs_held: [] },
          }),
        ];
      };

    test("release: released, counters 0, providers kept, the PR left open", async () => {
      const r: Partial<Ruled> = {};
      const p: { pr?: number } = {};
      const f = await setup({}, ruling(["/xarabot release story:1.1"], r, parkedOn(p)));
      await f.run();
      expect((await f.ledger()).get("story:1.1")).toMatchObject({ state: "released", park: null, attempts: 0, loopbacks: 0, ci_fixes: 0, builder_providers: ["anthropic"], generation: 2 });
      const prs = await f.fake.forge.listPrsByBranch("story/1.1", opts());
      expect(prs.ok && prs.value.map((x) => x.state)).toEqual(["open"]);
    });

    test("rebuild: the PR is closed, then released with the SHAs and providers cleared; a second rebuild in the batch is refused", async () => {
      const r: Partial<Ruled> = {};
      const p: { pr?: number } = {};
      const f = await setup({}, ruling(["/xarabot rebuild story:1.1", "/xarabot rebuild story:1.1"], r, parkedOn(p)));
      await f.run();
      expect((await f.ledger()).get("story:1.1")).toMatchObject({ state: "released", reviewed_sha: null, passed_sha: null, builder_providers: [], attempts: 0, pr: p.pr });
      const prs = await f.fake.forge.listPrsByBranch("story/1.1", opts());
      expect(prs.ok && prs.value.map((x) => x.state)).toEqual(["closed"]);
      expect(f.fake.control.inboxComments(r.inbox as number).at(-1)).toContain("story:1.1 is released, not parked. Nothing changed.");
    });

    test("rebuild whose close fails: refused with the reason, the record unchanged", async () => {
      const r: Partial<Ruled> = {};
      const p: { pr?: number } = {};
      const f = await setup({}, ruling(["/xarabot rebuild story:1.1"], r, parkedOn(p)));
      const before = (await f.ledger()).get("story:1.1");
      f.fake.control.injectError("closePr", { kind: "transient", message: "502" });
      await f.run();
      expect((await f.ledger()).get("story:1.1")).toEqual(before);
      expect(f.fake.control.inboxComments(r.inbox as number).at(-1)).toContain(`closing PR #${p.pr} failed: transient: 502. Nothing changed.`);
    });
  });

  test("a refused swap (another run moved the cursor): no ruling applied, no reply, the cursor kept", async () => {
    const r: Partial<Ruled> = {};
    const f = await setup(world(), ruling(["/xarabot go checkpoint:1"], r));
    const spy = spied(f.fake, f.events, false, true);
    let moved = false;
    const out = await f.run({
      forge: {
        ...spy,
        ledgerSwap: async (old, commit, o) => {
          // Another run moves the cursor just before this run's rulings swap: the swap re-reads the tip and refuses.
          if (!moved && commit.message.startsWith("ledger: recordRulings")) {
            moved = true;
            f.fake.control.writeForeignLedger({ message: "another run [skip ci]", writes: { [COORDINATOR_PATH]: serializeCoordinator(claimRec({ rulings_cursor: "999" })) }, deletes: [] });
          }
          return spy.ledgerSwap(old, commit, o);
        },
      },
    });
    expect(out.outcome).toBe("progress");
    expect((await coordinatorRecord(f))?.rulings_cursor).toBe("999");
    expect((await coordinatorRecord(f))?.pending_rulings).toBeUndefined();
    expect(f.commits).toEqual([]);
    expect(f.fake.control.inboxComments(r.inbox as number)).toHaveLength(1);
    expect(f.logs.some((l) => l.includes("rulings: recordRulings refused or failed"))).toBe(true);
  });
});
