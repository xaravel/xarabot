import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { assembleSnapshot } from "../../src/core/next/snapshot.ts";
import { parseSprintStatus } from "../../src/core/next/sprint-status.ts";
import { err, ok, type Result } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord } from "../../src/core/schemas/journal.ts";
import type { CoordinatorRecord, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck } from "../../src/ports/forge.ts";
import { runCoordinatorProcess, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import { readsPath, type PrStepOutput } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { ReconcileCommit, ReconcileCommitRequest, ReconcileCommitter } from "../../src/lane/reconcile-commit.ts";
import { createReconcileStep, reconcileBranch, reconcilePrText, type ReconcileStepDeps } from "../../src/lane/reconcile-step.ts";
import type { WorkspaceErrorKind } from "../../src/lane/workspace.ts";
import { COORD, rec, tip } from "../core/ledger/fixtures.ts";

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
};

const STATUS_BACKLOG = "# sprint status\ndevelopment_status:\n  epic-1: in-progress\n  1-1-first: backlog\n";
const STATUS_DONE = "# sprint status\ndevelopment_status:\n  epic-1: in-progress\n  1-1-first: done\n";

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
  return files;
}

/** A coordinator-held record. */
const coord = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: FORGE_NOW, ...over });

/** This run's claimed record, as the coordinator process claims it. */
const OWN = coord(U, { state: "claimed" });

function claimRec(): CoordinatorRecord {
  return { schema_version: 1, ...COORD, lane: "coordinator", generation: 1, heartbeat_at: FORGE_NOW, digest_posted_at: null, rulings_cursor: null };
}

/** The edit name in a ledger commit message, `ledger: <name> <unit> [skip ci]`. */
const editName = (message: string) => /^ledger: (\S+ \S+)/.exec(message)?.[1] ?? message;

/** The fake forge, recording each call in order; a ledger swap is `ledgerSwap <edit> <unit>`. */
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
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip([OWN, ...records], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }), deletes: [] });
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
      };
    },
    async run(deps = {}) {
      const input = await f.input();
      events.length = 0;
      return createReconcileStep({
        forge,
        committer,
        identity: COORD,
        repo: "xaravel/xarabot",
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

// ------------------------------------------------------------------ texts

describe("reconcile texts", () => {
  test("the branch is <branches.xarabot>reconcile-<n>", () => {
    expect(reconcileBranch("xarabot/", "reconcile:12")).toBe("xarabot/reconcile-12");
  });

  test("the PR text names the unit and each change, sanitized, and says no agent wrote it", () => {
    const t = reconcilePrText(U, STATUS, ["1-1-first: backlog -> done", "@someone fixes #3: added as done"]);
    expect(t.title).toBe("reconcile:5: sprint status for merged units");
    expect(t.body.startsWith("🤖 reconcile:5:")).toBe(true);
    expect(t.body).toContain("no agent session");
    expect(t.body).toContain("- 1-1-first: backlog -> done");
    expect(t.body).not.toContain("@someone");
    expect(t.body).toContain("the runner queues this PR once its checks pass, unless a Protected Path gates it.");
    expect(t.message.startsWith(`${t.title}\n\n- 1-1-first: backlog -> done\n`)).toBe(true);
  });

  test("the PR body and title are capped at the forge's limits", () => {
    const t = reconcilePrText(`reconcile:${"9".repeat(300)}`, STATUS, Array.from({ length: 3000 }, (_, i) => `k-${i}-${"x".repeat(20)}: backlog -> done`));
    expect(t.title.length).toBe(256);
    expect(t.body.length).toBe(65_536);
    expect(t.body.endsWith("\n\n[truncated by xarabot]")).toBe(true);
  });
});

// ------------------------------------------------------------------ the matrix

describe("createReconcileStep: the matrix", () => {
  test("Story merged: merged; a PR from xarabot/reconcile-<n> setting the key done; enqueued after CI with no approval; U merging", async () => {
    let story = 0;
    const f = await setup({}, async (fake) => {
      story = (await prOn(fake, "story/1.1", true)).number;
      return [rec({ unit: "story:1.1", globs: [], state: "parked", pr: story, park: { kind: "blocked", reason: "other", inbox_owner: "alice", globs_held: [] } })];
    });
    const main = (await f.input()).snapshot.main_sha;
    const out = await f.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(await stateOf(f, "story:1.1")).toBe("merged");
    // The commit: only sprint-status.yaml, onto the snapshot's main, 1-1-first done, the comment kept.
    expect(f.commits).toHaveLength(1);
    const c = f.commits[0] as ReconcileCommitRequest;
    expect(c.ontoSha).toBe(main);
    expect(c.unit).toBe(U);
    expect(Object.keys(c.files)).toEqual([STATUS]);
    expect(c.files[STATUS]).toBe(STATUS_DONE);
    // The PR, its record and the queue.
    const pr = await prOnBranch(f, BRANCH);
    expect(pr).toMatchObject({ state: "open", head_sha: f.head, base: "main", title: "reconcile:5: sprint status for merged units" });
    expect(f.fake.control.queue()).toEqual([pr?.number ?? -1]);
    expect(f.fake.control.comments(pr?.number ?? 0)).toEqual([]);
    const own = (await f.ledger()).get(U);
    expect(own).toMatchObject({ state: "merging", pr: pr?.number, pr_owner: COORD.owner, head_sha: f.head, base_sha: main, passed_sha: f.head, attempts: 0 });
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
    expect(f.events.slice(0, 5)).toEqual(["ledgerSwap markMerged story:1.1", "queueState", "ledgerSwap heartbeat reconcile:5", "closePr", "ledgerSwap releaseReconcile reconcile:3"]);
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
    expect(f.messages()).not.toContain("ledger: releaseReconcile reconcile:3 [skip ci]");
  });

  test("Earlier PR queued at another head: dequeued, closed and released", async () => {
    let r3 = { number: 0, head: "" };
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      r3 = await prOn(fake, "xarabot/reconcile-3");
      expect((await fake.forge.enqueue(r3.number, r3.head, opts())).ok).toBe(true);
      return [coord("reconcile:3", { state: "merging", pr: r3.number, head_sha: "d".repeat(40), passed_sha: "d".repeat(40) })];
    });
    await f.run();
    expect(f.events.slice(0, 6)).toEqual(["queueState", "ledgerSwap heartbeat reconcile:5", "dequeue", "ledgerSwap heartbeat reconcile:5", "closePr", "ledgerSwap releaseReconcile reconcile:3"]);
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
    expect(swaps(f.events)).toContain("deleteReleasedReconcile reconcile:3");
    expect(f.events.includes("closePr")).toBe(keepOpen);
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
    ["a released record", "released", "deleteReleasedReconcile"],
    ["a dead run's record", "claimed", "releaseDeadReconcile"],
  ] as const)("Orphan PR: %s with no pr, a PR open on its branch: found by listing the branch, closed, then the record acted on", async (_name, state, edit) => {
    let orphan = 0;
    const f = await setup({ status: STATUS_DONE }, async (fake) => {
      orphan = (await prOn(fake, "xarabot/reconcile-3")).number;
      return [coord("reconcile:3", { state, pr: null, heartbeat_at: minutesBefore(30) })];
    });
    await f.run();
    expect((await prOnBranch(f, "xarabot/reconcile-3"))).toMatchObject({ number: orphan, state: "closed" });
    expect(f.events.slice(0, 4)).toEqual(["listPrsByBranch", "ledgerSwap heartbeat reconcile:5", "closePr", `ledgerSwap ${edit} reconcile:3`]);
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
    expect(swaps(f.events)).not.toContain("deleteReleasedReconcile reconcile:3");
  });

  test("Orphan PR: two open PRs for one target, the second close fails: the target is left and its open PR stops a new PR", async () => {
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
    expect(out.reason).toContain(`reconcile:3's PR #${nums[1]} is open: no new reconcile PR this run`);
    expect(await stateOf(f, "reconcile:3")).toBe("released");
    expect(f.commits).toEqual([]);
    expect(await prOnBranch(f, BRANCH)).toBeNull();
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
    expect(f.events.slice(-4)).toEqual(["enqueue", "ledgerSwap heartbeat reconcile:5", "closePr", "ledgerSwap releaseReconcile reconcile:5"]);
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
    const out = await createReconcileStep({ forge: f.fake.forge, committer: { commit: async () => err("git", "unused") }, identity: COORD, repo: "xaravel/xarabot" })({ ...input, signal: ac.signal });
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

// ------------------------------------------------------------------ acceptance

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
      steps: { reconcile: createReconcileStep({ forge: fake.forge, committer, identity: COORD, repo: "xaravel/xarabot", now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0 }) },
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
    expect(status.ok && status.value.development_status).toEqual({ "epic-1": "in-progress", "1-1-first": "done" });
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

  async function snapshotFiles(fake: FakeForge) {
    const s = await fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    return { ledger: s.value.ledger.files };
  }
});
