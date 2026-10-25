import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { coordinatorGlobs } from "../../src/core/next/coordinator.ts";
import { assembleSnapshot } from "../../src/core/next/snapshot.ts";
import { ok, type Result } from "../../src/core/result.ts";
import { EpicPrsSchema } from "../../src/core/schemas/epic-prs.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { CoordinatorRecord, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent, AgentLaunchSpec, AgentUnit } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck } from "../../src/ports/forge.ts";
import type { Sandbox, SandboxProfile } from "../../src/ports/sandbox.ts";
import type { CommitOutcome } from "../../src/lane/commit.ts";
import type { CommitRequest, Committer } from "../../src/lane/committer.ts";
import { runCoordinatorProcess, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import type { DiffPathsRequest } from "../../src/lane/diff-paths.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { createRetroStep, epicPrsFileName, retroPrText, type RetroStepDeps } from "../../src/lane/retro-step.ts";
import { LIMIT_STOP_REASON, MarkerStop, newTrack, readsPath, type PrStepOutput } from "../../src/lane/session.ts";
import type { TreeFilesRequest, TreeFilesValue } from "../../src/lane/tree-files.ts";
import type { WaitEnd } from "../../src/lane/wait.ts";
import type { PrepareParams, Workspace, WorkspaceErrorKind } from "../../src/lane/workspace.ts";
import { COORD, rec, tip } from "../core/ledger/fixtures.ts";

// ------------------------------------------------------------------ world

const FORGE_NOW = "2026-10-25T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const AUTHORITY = "docs/standing-authority.md";
const EPICS = "_bmad-output/planning-artifacts/epics.md";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
const DOC = "_bmad-output/implementation-artifacts/epic-2-retro-2026-10-25.md";
const EVIDENCE = "docs/maintainer/evidence/epic-2.md";
const U = "retro:2";
const BRANCH = "xarabot/retro-2";
const LANE: Lane = { repo: "xaravel/xarabot", role: "coordinator", owner: COORD.owner, agent: "claude", effort: "high" };
const PASS: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "success" }];
const FAIL: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "failure" }];
const opts = () => ({ signal: AbortSignal.timeout(5000) });

const OLD_ITEM = "epic-1-retro-item-1-old";
const A = "epic-2-retro-item-1-wire-it";
const B = "epic-2-retro-item-2-ask";

/** `sprint-status.yaml` with Epic 2 done and `action_items` holding `ids`. */
function statusText(ids: readonly string[]): string {
  const lines = ["development_status:", "  epic-1: done", "  1-1-first: done", "  epic-2: done", "  2-1-second: done", "  2-2-third: done"];
  lines.push(ids.length === 0 ? "action_items: []" : "action_items:");
  for (const id of ids) lines.push(`  - id: "${id}"`, "    status: open");
  return `${lines.join("\n")}\n`;
}

type MainOpts = { readonly policy?: readonly string[] };

function mainFiles(o: MainOpts = {}): Record<string, string> {
  return {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "v1"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "bootstrapped_epics: [1]", "manifests:", "  dir: stories", ""].join("\n"),
    ".xarabot/policy.yaml": ["schema_version: 1", "unattended_adapters: [claude]", ...(o.policy ?? []), ""].join("\n"),
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    ".xarabot/prompts/house.md": "HOUSE RULE: keep it short.\n",
    [EPICS]: "# Epics\n\n## Epic 1: One\n\n### Story 1.1: First\n\nBody.\n\n## Epic 2: Two\n\n### Story 2.1: Second\n\nBody.\n\n### Story 2.2: Third\n\nBody.\n",
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    "_bmad-output/implementation-artifacts/epic-2-context.md": "# Epic 2 Context: Two\n\nGoal.\n",
    [STATUS]: statusText([OLD_ITEM]),
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    [EVIDENCE]: "# Epic 2 live evidence\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: First\nglobs: ["src/a/**"]\n---\n',
    "stories/2.1.md": '---\nstory_id: "2.1"\nepic: 2\nsprint_key: 2-1-second\ntitle: Second\nglobs: ["src/b/**"]\n---\n',
    "stories/2.2.md": '---\nstory_id: "2.2"\nepic: 2\nsprint_key: 2-2-third\ntitle: Third\ndepends_on: ["2.1"]\nglobs: ["src/c/**"]\n---\n',
  };
}

const CONFIG = { epics_path: EPICS, sprint_status_path: STATUS, retro_gates_path: RETRO, epic_context_path: "_bmad-output/implementation-artifacts/epic-<N>-context.md", retro_doc_glob: "_bmad-output/implementation-artifacts/epic-<N>-retro-*.md", manifests: { dir: "stories" } };
const RETRO_GLOBS = coordinatorGlobs({ kind: "retro", epic: 2 }, CONFIG);

const coord = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: FORGE_NOW, ...over });

function claimRec(): CoordinatorRecord {
  return { schema_version: 4, ...COORD, lane: "coordinator", generation: 1, heartbeat_at: FORGE_NOW, digest_posted_at: "2026-10-25T08:00:00Z", rulings_cursor: null };
}

const OWN = coord(U, { globs: RETRO_GLOBS });
/** The last `reconcile` ran just now: not due, so `next` reaches retro. */
const RECENT = coord("reconcile:4", { state: "merged", heartbeat_at: FORGE_NOW });

type Item = { id: string; text: string; route: "lane" | "maintainer"; blocking: boolean; globs: string[] };
const ITEMS: Item[] = [
  { id: A, text: "Wire it", route: "lane", blocking: true, globs: ["src/x/**"] },
  { id: B, text: "Ask the Maintainer", route: "maintainer", blocking: false, globs: [] },
];

function retroResult(over: { verdict?: string; items?: Item[] } = {}): string {
  return JSON.stringify({ kind: "retro", verdict: over.verdict ?? "accepted-with-open-items", items: over.items ?? ITEMS, denied_actions: [] });
}

// -------------------------------------------------------------- stubs

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Behavior = (ctx: { readonly profile: SandboxProfile; readonly n: number }) => void | Promise<void>;
const writes =
  (text: string): Behavior =>
  ({ profile }) =>
    writeFileSync(profile.resultPath, text);

type Harness = {
  readonly fake: FakeForge;
  readonly laneDir: string;
  readonly prompts: string[];
  readonly profiles: SandboxProfile[];
  /** The prefetched file's text as each run saw it. */
  readonly prefetched: (string | null)[];
  readonly prepares: PrepareParams[];
  readonly commits: CommitRequest[];
  readonly diffs: DiffPathsRequest[];
  readonly trees: TreeFilesRequest[];
  readonly logs: string[];
  readonly events: string[];
  readonly head: string;
  input(over?: Partial<CoordinatorStepInput>): Promise<CoordinatorStepInput>;
  run(over?: Partial<CoordinatorStepInput>, deps?: Partial<RetroStepDeps>): Promise<PrStepOutput>;
  deps(over?: Partial<RetroStepDeps>): RetroStepDeps;
  ledger(): Promise<Map<string, UnitRecord>>;
  journal(): JournalRecord[];
};

type HarnessOpts = MainOpts & {
  readonly records?: readonly UnitRecord[];
  readonly behaviors?: readonly Behavior[];
  readonly committer?: (r: CommitRequest, h: { head: string }) => Result<CommitOutcome, WorkspaceErrorKind>;
  /** The committed head's files; default main's with A and B appended and the retro document. */
  readonly headFiles?: Record<string, string>;
  readonly diff?: readonly string[];
  readonly checks?: readonly ForgeCheck[] | null;
  /** The usage limit each run reports; default none. */
  readonly usageLimits?: readonly ({ resetAt: number | null } | null)[];
  readonly waitEnds?: readonly WaitEnd[];
};

/**
 * `base` with the first ledger swap after a successful `openPr` failing: the
 * forge refuses it (`rejected`), or, with `lose`, another writer bumps
 * `unit`'s generation first, so the unit is lost.
 */
function failRecordAfterOpen(h: { readonly fake: FakeForge; ledger(): Promise<Map<string, UnitRecord>> }, base: Forge, unit: string, lose: boolean): Forge {
  let opened = false;
  return {
    ...base,
    openPr: async (r, o) => {
      const x = await base.openPr(r, o);
      opened = x.ok;
      return x;
    },
    ledgerSwap: async (oldSha, commit, o) => {
      if (!opened) return base.ledgerSwap(oldSha, commit, o);
      opened = false;
      if (!lose) return { ok: false, error: { kind: "rejected", message: "422" } };
      const current = (await h.ledger()).get(unit) as UnitRecord;
      h.fake.control.writeForeignLedger({ message: "bump [skip ci]", writes: tip([{ ...current, generation: current.generation + 1 }]), deletes: [] });
      return base.ledgerSwap(oldSha, commit, o);
    },
  };
}

function spied(fake: FakeForge, events: string[]): Forge {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(fake.forge)) {
    out[name] = (...args: unknown[]) => {
      if (name === "ledgerSwap") events.push(`ledgerSwap ${/^ledger: (\S+ \S+)/.exec((args[1] as { message: string }).message)?.[1] ?? ""}`);
      else if (name !== "snapshot") events.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as Forge;
}

const doc = (verdict: string) => `---\nepic: 2\nverdict: ${verdict}\nheadless: true\n---\n\n# Epic 2 Retrospective\n`;
const defaultHead = (): Record<string, string> => ({ ...mainFiles(), [STATUS]: statusText([OLD_ITEM, A, B]), [DOC]: doc("accepted-with-open-items") });

function harness(o: HarnessOpts = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "xarabot-retro-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "coordinator");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const main = mainFiles(o);
  const fake = createFakeForge({ now: FORGE_NOW, main, ledger: tip(o.records ?? [OWN], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }) });
  const events: string[] = [];
  const forge = spied(fake, events);
  const prompts: string[] = [];
  const profiles: SandboxProfile[] = [];
  const prefetched: (string | null)[] = [];
  const prepares: PrepareParams[] = [];
  const commits: CommitRequest[] = [];
  const diffs: DiffPathsRequest[] = [];
  const trees: TreeFilesRequest[] = [];
  const logs: string[] = [];
  const head = fake.control.makeCommit();
  if (o.checks !== null) fake.control.setChecks(head, o.checks ?? PASS);
  const headFiles = o.headFiles ?? defaultHead();
  let t = T0;
  let usageCalls = 0;
  let waited = 0;

  const agent: Agent = {
    vendor: "claude",
    defaultModel: "claude-opus-5-5",
    minVersion: "2.1.304",
    launchSpec: (unit: AgentUnit, settings, resultPath) =>
      ok({
        argv: ["stub-agent", settings.effort, resultPath],
        stdin: unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`,
        vendor: "claude",
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
      } as AgentLaunchSpec),
    parseUsage: () => ({
      sessionId: null,
      model: "claude-opus-5-5",
      tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
      cost: { usd: 0.25, estimate: false },
      usageLimit: o.usageLimits?.[usageCalls++] ?? null,
    }),
    effortValues: () => ["high"],
    startCheck: () => ok({ model: "claude-opus-5-5", version: "2.1.309" }),
    checkModel,
  };

  const sandbox: Sandbox = {
    async run(spec, profile) {
      prompts.push(spec.stdin ?? "");
      profiles.push(profile);
      const prs = join(profile.tempDir, epicPrsFileName(2));
      prefetched.push(existsSync(prs) ? readFileSync(prs, "utf8") : null);
      const n = prompts.length;
      await o.behaviors?.[n - 1]?.({ profile, n });
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };

  const workspace: Workspace = {
    async prepare(p) {
      prepares.push(p);
      return ok({ sha: p.start, resumed: false });
    },
  };

  const committer: Committer = {
    async commit(r) {
      commits.push(r);
      return o.committer?.(r, { head }) ?? ok({ kind: "committed", base_sha: r.ontoSha, head_sha: head });
    },
  };

  const pick = (all: Record<string, string>, read: (p: string) => boolean): TreeFilesValue => ({
    tree: Object.keys(all).sort(),
    files: Object.fromEntries(Object.entries(all).filter(([p]) => read(p))),
  });

  const deps = (over: Partial<RetroStepDeps> = {}): RetroStepDeps => ({
    forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    workspace,
    waiter: { wait: async () => ({ end: o.waitEnds?.[waited++] ?? "elapsed" }) },
    laneDir,
    lane: LANE,
    committer,
    diffPaths: async (r) => {
      diffs.push(r);
      return ok(o.diff ?? [STATUS, DOC]);
    },
    treeFiles: async (r) => {
      trees.push(r);
      return ok(pick(r.sha === head ? headFiles : main, r.read));
    },
    identity: COORD,
    secrets: ["sekrit-credential"],
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0,
    ...over,
  });

  const input = async (over: Partial<CoordinatorStepInput> = {}): Promise<CoordinatorStepInput> => {
    const s = await fake.forge.snapshot({ ...opts(), read: readsPath });
    if (!s.ok) throw new Error(s.error.message);
    const a = assembleSnapshot({
      repo: LANE.repo,
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
      unit: { unit: U, kind: "retro", globs: record.globs, expect_generation: null, take_over: null, pr: record.pr, why: "test" },
      record,
      snapshot: a.value,
      files: s.value.main.files,
      signal: new AbortController().signal,
      log: (text) => logs.push(text),
      track: newTrack({ unit: U, startedMs: T0, logName: "retro.log", state: "claimed" }),
      ...over,
    };
  };

  return {
    fake,
    laneDir,
    prompts,
    profiles,
    prefetched,
    prepares,
    commits,
    diffs,
    trees,
    logs,
    events,
    head,
    input,
    async run(over, d) {
      const i = await input(over);
      events.length = 0;
      return createRetroStep(deps(d))(i);
    },
    deps,
    async ledger() {
      const s = await fake.forge.snapshot(opts());
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return new Map(l.value.units);
    },
    journal() {
      const path = join(laneDir, "journal.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as JournalRecord);
    },
  };
}

const swaps = (events: readonly string[]) => events.filter((e) => e.startsWith("ledgerSwap ")).map((e) => e.slice("ledgerSwap ".length));

async function prOnBranch(h: Harness, branch: string) {
  const r = await h.fake.forge.listPrsByBranch(branch, opts());
  if (!r.ok) throw new Error(r.error.message);
  return r.value.at(-1) ?? null;
}

/** Story 2.1's merged PR with two reviews, and Story 2.2's open PR: the Epic's history. */
async function storyPrs(h: Harness): Promise<{ merged: number; open: number; mergeSha: string; head21: string }> {
  const f = h.fake.forge;
  const open = async (branch: string) => {
    const sha = h.fake.control.makeCommit();
    const pushed = await f.pushBranch({ branch, expected_sha: null, sha }, opts());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const pr = await f.openPr({ branch, base: "main", title: `Story ${branch}`, body: `Body of ${branch}` }, opts());
    if (!pr.ok) throw new Error(pr.error.message);
    return pr.value;
  };
  const s21 = await open("story/2.1");
  h.fake.control.addReview(s21.number, { author: "edanisko", state: "changes_requested", commit_sha: s21.head_sha, submitted_at: "2026-10-24T09:00:00Z" });
  h.fake.control.addReview(s21.number, { author: "edanisko", state: "approved", commit_sha: s21.head_sha, submitted_at: "2026-10-24T10:00:00Z" });
  const q = await f.enqueue(s21.number, s21.head_sha, opts());
  if (!q.ok) throw new Error(q.error.message);
  const merged = h.fake.control.mergeQueueHead();
  const s22 = await open("story/2.2");
  return { merged: s21.number, open: s22.number, mergeSha: merged?.merge_sha as string, head21: s21.head_sha };
}

// ------------------------------------------------------------------ texts

describe("retro PR text", () => {
  test("names the unit, the verdict and each item; sanitized and redacted", () => {
    const t = retroPrText(U, { verdict: "accepted-with-open-items", items: [{ ...ITEMS[0] as Item, text: "Wire @someone sekrit" }, ITEMS[1] as Item], denied_actions: ["git push"] }, ["sekrit"]);
    expect(t.title).toBe("retro:2: Epic 2 retrospective (accepted-with-open-items)");
    expect(t.body.startsWith("🤖 retro:2: written by a `bmad-retrospective -H 2` session.")).toBe(true);
    expect(t.body).toContain(`- \`${A}\` (lane, blocking; \`src/x/**\`): Wire someone [REDACTED]`);
    expect(t.body).toContain(`- \`${B}\` (maintainer, not blocking; no globs): Ask the Maintainer`);
    expect(t.body).toContain("Denied actions:\n- git push");
    expect(t.message.startsWith(`${t.title}\n\nAction items:\n`)).toBe(true);
    expect(retroPrText(U, { verdict: "rejected", items: [], denied_actions: [] }).body).toContain("Action items: none.");
  });
});

// ------------------------------------------------------------------ the prefetch and the prompt

describe("createRetroStep: the prefetch and the prompt", () => {
  test("AC: $TMP/epic-2-prs.json holds the Epic's PRs with review states and merge SHAs; the prompt names that path; the session gets no GitHub access", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const s = await storyPrs(h);
    await h.run();
    const text = h.prefetched[0];
    if (text == null) throw new Error("no prefetched file during the session");
    const parsed = EpicPrsSchema.parse(JSON.parse(text));
    expect(parsed.epic).toBe(2);
    expect(parsed.prs.map((p) => [p.story, p.number, p.state, p.merge_sha])).toEqual([
      ["2.1", s.merged, "merged", s.mergeSha],
      ["2.2", s.open, "open", null],
    ]);
    expect(parsed.prs[0]).toMatchObject({ title: "Story story/2.1", body: "Body of story/2.1", head_sha: s.head21 });
    expect(parsed.prs[0]?.reviews).toEqual([
      { author: "edanisko", state: "changes_requested", submitted_at: "2026-10-24T09:00:00Z", commit_sha: s.head21 },
      { author: "edanisko", state: "approved", submitted_at: "2026-10-24T10:00:00Z", commit_sha: s.head21 },
    ]);
    const prsPath = join(h.laneDir, "tmp", "epic-2-prs.json");
    const p = h.prompts[0] ?? "";
    expect(p).toContain(`\`${prsPath}\``);
    expect(p).toContain("`bmad-retrospective -H 2`");
    expect(p).toContain("HOUSE RULE: keep it short.");
    // No GitHub host is opened to the session, and it gets no credential but the agent's own.
    expect((h.profiles[0]?.repoHosts ?? []).some((x) => /github/i.test(x))).toBe(false);
    expect(p).not.toContain("sekrit-credential");
    expect(h.prepares.map((x) => [x.unit, x.branch])).toEqual([[U, BRANCH]]);
  });

  test("an Epic with no PRs yet prefetches an empty list", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    await h.run();
    expect(JSON.parse(h.prefetched[0] ?? "null")).toEqual({ schema_version: 1, epic: 2, prs: [] });
  });

  test.each(["listPrsByBranch", "reviews"] as const)("a %s failure in the prefetch is a failed attempt; no session", async (op) => {
    const h = harness({ behaviors: [writes(retroResult())] });
    await storyPrs(h);
    h.fake.control.injectError(op, { kind: "transient", message: "502" });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain(`prefetch: ${op}`);
    expect(h.prompts).toEqual([]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1 });
  });
});

// ------------------------------------------------------------------ the result

describe("createRetroStep: a valid result", () => {
  test("AC: 2 appended items, the doc accepted-with-open-items: the PR opened, the record's retro_result set, merging and enqueued", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    const pr = await prOnBranch(h, BRANCH);
    expect(pr).toMatchObject({ state: "open", head_sha: h.head, title: "retro:2: Epic 2 retrospective (accepted-with-open-items)" });
    expect(h.fake.control.queue()).toEqual([pr?.number as number]);
    expect((await h.ledger()).get(U)).toMatchObject({
      state: "merging",
      pr: pr?.number,
      head_sha: h.head,
      passed_sha: h.head,
      retro_result: { verdict: "accepted-with-open-items", items: ITEMS },
    });
    expect(h.events.filter((e) => e !== "checks" && e !== "listPrsByBranch")).toEqual([
      "branchHead",
      "ledgerSwap heartbeat retro:2",
      "pushBranch",
      "ledgerSwap heartbeat retro:2",
      "openPr",
      "ledgerSwap heartbeat retro:2",
      "ledgerSwap heartbeat retro:2",
      "ledgerSwap startMerging retro:2",
      "enqueue",
    ]);
  });

  test("the commit goes onto fresh main under the coordinator rules of the retro's globs; both trees are read after it", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    await h.run();
    expect(h.commits[0]?.rules).toMatchObject({ role: "coordinator", graphUnit: false, globs: [...RETRO_GLOBS].sort(), retroGatesPath: RETRO });
    expect((h.commits[0]?.message ?? "").startsWith("retro:2: Epic 2 retrospective (accepted-with-open-items)\n")).toBe(true);
    expect(h.trees.map((r) => r.sha)).toEqual([h.commits[0]?.ontoSha as string, h.head]);
    expect([STATUS, DOC, EVIDENCE, "src/x.ts"].map((p) => h.trees[0]?.read(p))).toEqual([true, true, false, false]);
  });

  test("a policy that gates a diff path parks awaiting-approval holding the diff's paths, with a 🤖 comment; never queued", async () => {
    const h = harness({ behaviors: [writes(retroResult())], policy: ['owner_approval_paths: ["**"]'] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const pr = (await prOnBranch(h, BRANCH))?.number as number;
    expect((await h.ledger()).get(U)).toMatchObject({ state: "parked", pr, park: { kind: "awaiting-approval", globs_held: [DOC, STATUS] }, retro_result: { verdict: "accepted-with-open-items" } });
    expect(h.fake.control.comments(pr)[0]?.startsWith("🤖 Unit retro:2: this PR changes paths that need the owner's approval:")).toBe(true);
    expect(h.fake.control.queue()).toEqual([]);
  });

  test("an enqueue conflict parks awaiting-approval with the diff's paths and a 🤖 comment; the PR stays open (never disposable)", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    h.fake.control.injectError("enqueue", { kind: "conflict", message: "not mergeable" });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const pr = await prOnBranch(h, BRANCH);
    expect(pr?.state).toBe("open");
    expect((await h.ledger()).get(U)).toMatchObject({ state: "parked", attempts: 0, park: { kind: "awaiting-approval", globs_held: [DOC, STATUS] }, retro_result: { verdict: "accepted-with-open-items" } });
    expect(h.fake.control.comments(pr?.number as number)[0]).toContain("the merge queue refused this PR");
    expect(h.events).not.toContain("closePr");
  });

  test("CI failing parks blocked verification; the result is kept on the record", async () => {
    const h = harness({ behaviors: [writes(retroResult())], checks: FAIL });
    const out = await h.run();
    expect(out.state).toBe("parked");
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "verification" }, retro_result: { verdict: "accepted-with-open-items" } });
  });

  test("each item's globs are stored normalized, on the record and in the PR text", async () => {
    const raw = [{ ...(ITEMS[0] as Item), globs: ["./src/x/**", "././lib/*.ts"] }, ITEMS[1] as Item];
    const h = harness({ behaviors: [writes(retroResult({ items: raw }))] });
    await h.run();
    expect((await h.ledger()).get(U)?.retro_result?.items[0]?.globs).toEqual(["src/x/**", "lib/*.ts"]);
    const pr = await prOnBranch(h, BRANCH);
    expect(pr?.body).toContain("`src/x/**`, `lib/*.ts`");
    expect(pr?.body).not.toContain("./src");
  });

  test("CI still pending past ci_max_wait_minutes parks blocked ci-timeout", async () => {
    const h = harness({ behaviors: [writes(retroResult())], checks: null });
    const out = await h.run();
    expect((await h.ledger()).get(U)).toMatchObject({ state: "parked", park: { kind: "blocked", reason: "ci-timeout" } });
    expect(out.reason).toContain("still pending after 60 min");
  });

  test("a policy protected_paths entry covering a diff path parks awaiting-approval, with no owner_approval_paths", async () => {
    const h = harness({ behaviors: [writes(retroResult())], policy: ['protected_paths: ["_bmad-output/**"]', "owner_approval_paths: []"] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get(U)?.park).toMatchObject({ kind: "awaiting-approval", globs_held: [DOC, STATUS] });
    expect(h.fake.control.queue()).toEqual([]);
  });

  test("a Standing Authority that no longer loads on fresh main after CI stops the step; the record left claimed", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const i = await h.input();
    const files = mainFiles();
    let done = false;
    const out = await createRetroStep(h.deps())({
      ...i,
      log: (text) => {
        if (text.includes("committed ") && !done) {
          done = true;
          delete files[AUTHORITY];
          h.fake.control.setMain(files);
        }
      },
    });
    expect(out.outcome).toBe("stop");
    expect(out.state).toBe("claimed");
    expect(h.fake.control.queue()).toEqual([]);
  });

  /** CI pending at the first poll; during the first sleep `act` runs, then CI passes. */
  const duringCi = (h: Harness, act: (pr: number, head: string) => Promise<void>) => ({
    sleep: async () => {
      const pr = await prOnBranch(h, BRANCH);
      if (pr === null) throw new Error("no PR");
      await act(pr.number, pr.head_sha);
      h.fake.control.setChecks(h.head, PASS);
    },
  });

  test("on fresh main a PR already merged is marked merged", async () => {
    const h = harness({ behaviors: [writes(retroResult())], checks: [] });
    const out = await h.run({}, duringCi(h, async (pr, head) => {
      expect((await h.fake.forge.enqueue(pr, head, opts())).ok).toBe(true);
      h.fake.control.mergeQueueHead();
    }));
    expect([out.outcome, out.state]).toEqual(["progress", "merged"]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merged", retro_result: { verdict: "accepted-with-open-items" } });
  });

  test("on fresh main a closed PR is a failed attempt", async () => {
    const h = harness({ behaviors: [writes(retroResult())], checks: [] });
    const out = await h.run({}, duringCi(h, async (pr) => {
      expect((await h.fake.forge.closePr(pr, opts())).ok).toBe(true);
    }));
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(/PR #[0-9]+ is closed/);
  });

  test("on fresh main a moved head is a failed attempt", async () => {
    const h = harness({ behaviors: [writes(retroResult())], checks: [] });
    const out = await h.run({}, duringCi(h, async (_pr, head) => {
      expect((await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: head, sha: h.fake.control.makeCommit() }, opts())).ok).toBe(true);
    }));
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(/head is [0-9a-f]+, not /);
    expect(h.fake.control.queue()).toEqual([]);
  });

  test("the record beat fails after openPr: the new PR, which no record carries, is closed, then a failed attempt; no result kept", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const events: string[] = [];
    const out = await h.run({}, { forge: failRecordAfterOpen(h, spied(h.fake, events), U, false) });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1, pr: null, retro_result: null });
    expect((await prOnBranch(h, BRANCH))?.state).toBe("closed");
    // The refused record swap never reaches the spy; the close comes before the failed attempt.
    expect(events.slice(events.indexOf("openPr"))).toEqual(["openPr", "closePr", "ledgerSwap failAttempt retro:2"]);
    expect(out.reason).toContain("which no record carries");
  });

  test("the unit lost at the record beat after openPr: the new PR is closed, no further edit", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const events: string[] = [];
    const out = await h.run({}, { forge: failRecordAfterOpen(h, spied(h.fake, events), U, true) });
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "claimed", pr: null, retro_result: null });
    expect((await prOnBranch(h, BRANCH))?.state).toBe("closed");
    expect(events).not.toContain("ledgerSwap failAttempt retro:2");
  });

  test("openPr fails after the forge opened the PR: the orphan on the branch is closed, fenced, then a failed attempt", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const events: string[] = [];
    const base = spied(h.fake, events);
    const forge: Forge = {
      ...base,
      openPr: async (r, o) => {
        expect((await base.openPr(r, o)).ok).toBe(true);
        return { ok: false, error: { kind: "transient", message: "timeout" } };
      },
    };
    const out = await h.run({}, { forge });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1, pr: null, retro_result: null });
    expect((await prOnBranch(h, BRANCH))?.state).toBe("closed");
    expect(events.slice(events.indexOf("openPr"))).toEqual(["openPr", "listPrsByBranch", "ledgerSwap heartbeat retro:2", "closePr", "ledgerSwap failAttempt retro:2"]);
    expect(out.reason).toContain("which no record carries");
  });

  test("an aborted signal (the unit lost) ends the step failed before the prefetch and any session, with no edit; nothing pushed", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const before = (await h.ledger()).get(U);
    const lost = new AbortController();
    lost.abort();
    const out = await h.run({ signal: lost.signal });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("the unit or the coordinator claim was lost during the retro step");
    expect(h.prompts).toEqual([]);
    expect(h.commits).toEqual([]);
    expect(swaps(h.events)).toEqual([]);
    expect(h.events).not.toContain("listPrsByBranch");
    expect(h.events).not.toContain("pushBranch");
    expect(h.events).not.toContain("openPr");
    expect((await h.ledger()).get(U)).toEqual(before);
  });

  test("the unit lost during the session: failed with no commit, push or PR, and no edit after the session", async () => {
    const lost = new AbortController();
    const h = harness({
      behaviors: [
        (ctx) => {
          writes(retroResult())(ctx);
          lost.abort();
        },
      ],
    });
    const out = await h.run({ signal: lost.signal });
    expect(out.outcome).toBe("failed");
    expect(h.prompts).toHaveLength(1);
    expect(h.commits).toEqual([]);
    expect(h.events).not.toContain("pushBranch");
    expect(h.events).not.toContain("openPr");
    expect(swaps(h.events)).toEqual([]);
    expect(await prOnBranch(h, BRANCH)).toBeNull();
    expect((await h.ledger()).get(U)).toMatchObject({ state: "claimed", pr: null, retro_result: null });
  });

  test("the unit lost after the commit: the fence before the push ends the step failed; nothing pushed, no PR, no edit", async () => {
    const lost = new AbortController();
    const h = harness({
      behaviors: [writes(retroResult())],
      committer: (r, { head }) => {
        lost.abort();
        return ok({ kind: "committed", base_sha: r.ontoSha, head_sha: head });
      },
    });
    const out = await h.run({ signal: lost.signal });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("the unit or the coordinator claim was lost during the retro step");
    expect(h.commits).toHaveLength(1);
    expect(h.events).not.toContain("pushBranch");
    expect(h.events).not.toContain("openPr");
    expect(swaps(h.events)).toEqual([]);
    expect(await prOnBranch(h, BRANCH)).toBeNull();
    expect((await h.ledger()).get(U)).toMatchObject({ state: "claimed", pr: null, retro_result: null });
  });

  test("a STOP during a usage-limit sleep releases the unit and throws MarkerStop", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], waitEnds: ["stopped"] });
    let thrown: unknown;
    try {
      await h.run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MarkerStop);
    expect((thrown as MarkerStop).reason).toBe(LIMIT_STOP_REASON);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 0 });
    expect(h.commits).toEqual([]);
  });

  test("a rejected verdict goes the same way", async () => {
    const h = harness({ behaviors: [writes(retroResult({ verdict: "rejected", items: [] }))], headFiles: { ...mainFiles(), [DOC]: doc("rejected") } });
    const out = await h.run();
    expect(out.state).toBe("merging");
    expect((await h.ledger()).get(U)?.retro_result).toEqual({ verdict: "rejected", items: [] });
  });
});

describe("createRetroStep: validation", () => {
  const failedNothingPushed = async (h: Harness, out: PrStepOutput, why: RegExp) => {
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(why);
    expect(h.events).not.toContain("pushBranch");
    expect(h.events).not.toContain("openPr");
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1, retro_result: null });
  };

  test.each([
    ["an item id of another Epic", [{ ...ITEMS[0], id: "epic-3-retro-item-1-x" }], /its id must start with "epic-2-"/],
    ["a repeated item id", [ITEMS[0], ITEMS[0]], /its id repeats/],
    ["bad globs: .github/**, stories/*.md, **", [{ ...ITEMS[0], globs: [".github/**", "stories/*.md", "**"] }], /glob "\.github\/\*\*" is refused.*glob "stories\/\*\.md" is refused.*glob "\*\*" is refused/],
    ["a glob that does not normalize", [{ ...ITEMS[0], globs: ["/abs/**"] }], /must be repo-relative/],
  ] as const)("before the commit: %s fails the attempt, nothing committed or pushed", async (_name, items, why) => {
    const h = harness({ behaviors: [writes(retroResult({ items: items as unknown as Item[] }))] });
    const out = await h.run();
    await failedNothingPushed(h, out, why);
    expect(h.commits).toEqual([]);
  });

  test("item mismatch: the result lists 1 of 2 appended ids; nothing pushed", async () => {
    const h = harness({ behaviors: [writes(retroResult({ items: [ITEMS[0] as Item] }))] });
    await failedNothingPushed(h, await h.run(), /are not the action items the commit appends/);
    expect(h.commits).toHaveLength(1);
  });

  test("verdict mismatch: doc rejected, result accepted; nothing pushed", async () => {
    const h = harness({ behaviors: [writes(retroResult({ verdict: "accepted" }))], headFiles: { ...defaultHead(), [DOC]: doc("rejected") } });
    await failedNothingPushed(h, await h.run(), /frontmatter verdict is "rejected", not the result's "accepted"/);
  });

  test("no retro document in the commit; nothing pushed", async () => {
    const { [DOC]: _doc, ...noDoc } = defaultHead();
    const h = harness({ behaviors: [writes(retroResult())], headFiles: noDoc });
    await failedNothingPushed(h, await h.run(), /adds or changes 0 retro documents/);
  });

  test("a tree read failure is a failed attempt; nothing pushed", async () => {
    const h = harness({ behaviors: [writes(retroResult())] });
    const out = await h.run({}, { treeFiles: async () => ({ ok: false, error: { kind: "fetch", message: "offline" } }) });
    await failedNothingPushed(h, out, /tree files fetch: offline/);
  });

  test("an empty commit is a failed attempt", async () => {
    const h = harness({ behaviors: [writes(retroResult())], committer: () => ok({ kind: "empty" }) });
    await failedNothingPushed(h, await h.run(), /changed nothing/);
  });

  test("a retro write: the session edits 2.retro.verdict in retro-gates.yaml → park write-check (retro-verdict)", async () => {
    const h = harness({
      behaviors: [writes(retroResult())],
      committer: () => ok({ kind: "refused", refusals: [{ path: RETRO, class: "retro-verdict" }], reverted: [] }),
    });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(out.reason).toContain(`write-check: refused ${RETRO} (retro-verdict)`);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "write-check" } });
    expect(h.events).not.toContain("pushBranch");
  });

  test.each([
    ["no result file", [], /no result at/],
    ["a planning result", [writes(JSON.stringify({ kind: "planning", outcome: "done", summary: "x", denied_actions: [] }))], /result wrong-kind/],
    ["a retro result missing its verdict", [writes(JSON.stringify({ kind: "retro", items: [], denied_actions: [] }))], /result invalid/],
  ] as const)("%s: a failed attempt, released", async (_name, behaviors, why) => {
    const h = harness({ behaviors });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(why);
  });
});

/** The retro PR opened on its branch at `head` (default a new commit, its CI passing). */
async function openRetroPr(h: Harness, head = h.fake.control.makeCommit()): Promise<{ pr: number; head: string }> {
  h.fake.control.setChecks(head, PASS);
  expect((await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts())).ok).toBe(true);
  const opened = await h.fake.forge.openPr({ branch: BRANCH, base: "main", title: "t", body: "b" }, opts());
  if (!opened.ok) throw new Error(opened.error.message);
  return { pr: opened.value.number, head };
}

describe("createRetroStep: resuming an adopted PR", () => {
  const adopt = async (h: Harness, over: Partial<UnitRecord>, at?: string) => {
    const { pr, head } = await openRetroPr(h, at);
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([coord(U, { globs: RETRO_GLOBS, generation: 2, pr, pr_owner: COORD.owner, head_sha: head, ...over })]), deletes: [] });
    return { pr, head };
  };

  test("with its retro_result: no session, CI at the record's head, then the gate (merging, enqueued)", async () => {
    const h = harness();
    const { pr, head } = await adopt(h, { retro_result: { verdict: "accepted", items: [] } });
    const out = await h.run();
    expect(h.prompts).toEqual([]);
    expect(h.prepares).toEqual([]);
    expect(h.commits).toEqual([]);
    expect(out.state).toBe("merging");
    expect(h.fake.control.queue()).toEqual([pr]);
    expect(h.diffs[0]?.headSha).toBe(head);
    expect(h.trees).toEqual([]);
  });

  /** The result the record held at `VALIDATED` before the claim adopted the PR at the harness head, which dropped it. */
  const VALIDATED = "9".repeat(40);
  const KEPT = { verdict: "accepted-with-open-items" as const, items: ITEMS };
  const runMoved = async (h: Harness) => {
    const { pr } = await adopt(h, { retro_result: null }, h.head);
    const i = await h.input();
    const units = i.snapshot.ledger.units.map((r) => (r.unit === U ? { ...r, state: "released" as const, generation: 1, head_sha: VALIDATED, retro_result: KEPT } : r));
    h.events.length = 0;
    const out = await createRetroStep(h.deps())({ ...i, snapshot: { ...i.snapshot, ledger: { ...i.snapshot.ledger, units } } });
    return { pr, out, mainSha: i.snapshot.main_sha };
  };

  test("the head moved, its doc and items unchanged: the result checked again against the moved head onto main, recorded with it, then CI and the gate (C1)", async () => {
    const h = harness();
    const { pr, out, mainSha } = await runMoved(h);
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.prompts).toEqual([]);
    expect(h.commits).toEqual([]);
    expect(h.trees.map((t) => t.sha)).toEqual([mainSha, h.head]);
    expect(h.logs.some((l) => l.includes(`head moved from ${VALIDATED} to ${h.head}`))).toBe(true);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", head_sha: h.head, passed_sha: h.head, retro_result: KEPT });
    expect(h.fake.control.queue()).toEqual([pr]);
  });

  test.each([
    ["its doc now rejected", { ...defaultHead(), [DOC]: doc("rejected") }, /moved head .*frontmatter verdict is "rejected", not the result's "accepted-with-open-items"/],
    ["an item dropped from its action items", { ...defaultHead(), [STATUS]: statusText([OLD_ITEM, A]) }, /moved head .*are not the action items the commit appends/],
    ["a second item appended", { ...defaultHead(), [STATUS]: statusText([OLD_ITEM, A, B, "epic-2-retro-item-3-new"]) }, /moved head .*are not the action items the commit appends/],
    ["its retro document removed", (({ [DOC]: _d, ...rest }) => rest)(defaultHead()), /moved head .*adds or changes 0 retro documents/],
  ] as const)("the head moved, %s: a failed attempt, the stale result neither recorded nor queued (C1)", async (_name, headFiles, why) => {
    const h = harness({ headFiles });
    const { out } = await runMoved(h);
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(why);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", head_sha: h.head, retro_result: null });
    expect(h.fake.control.queue()).toEqual([]);
    expect(h.events).not.toContain("checks");
  });

  test("the head moved, a tree read failing: a failed attempt, nothing queued", async () => {
    const h = harness();
    const { pr } = await adopt(h, { retro_result: null }, h.head);
    const i = await h.input();
    const units = i.snapshot.ledger.units.map((r) => (r.unit === U ? { ...r, head_sha: VALIDATED, retro_result: KEPT } : r));
    const out = await createRetroStep(h.deps({ treeFiles: async () => ({ ok: false, error: { kind: "fetch", message: "offline" } }) }))({
      ...i,
      snapshot: { ...i.snapshot, ledger: { ...i.snapshot.ledger, units } },
    });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("tree files fetch: offline");
    expect(h.fake.control.queue()).not.toContain(pr);
  });

  test("a result before the claim on another PR is not re-checked: no result on the record is a failed attempt", async () => {
    const h = harness();
    const { pr } = await adopt(h, { retro_result: null }, h.head);
    const i = await h.input();
    const units = i.snapshot.ledger.units.map((r) => (r.unit === U ? { ...r, pr: pr + 1, head_sha: VALIDATED, retro_result: KEPT } : r));
    const out = await createRetroStep(h.deps())({ ...i, snapshot: { ...i.snapshot, ledger: { ...i.snapshot.ledger, units } } });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("has no retro_result on the record");
    expect(h.trees).toEqual([]);
  });

  test("without a retro_result: a failed attempt, no session", async () => {
    const h = harness();
    await adopt(h, {});
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("has no retro_result on the record");
    expect(h.prompts).toEqual([]);
    expect(h.fake.control.queue()).toEqual([]);
  });
});

// ------------------------------------------------------------------ through the coordinator process

describe("retro through the coordinator process", () => {
  test("next picks retro:2, the process claims it, the step opens its PR and enqueues it; the journal records the session", async () => {
    const h = harness({ records: [RECENT], behaviors: [writes(retroResult())] });
    let clock = 0;
    const r = await runCoordinatorProcess({
      forge: h.fake.forge,
      agent: { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent,
      store: createFsLaneStore({ laneDir: h.laneDir, hostStop: join(h.laneDir, "..", "STOP") }),
      laneDir: h.laneDir,
      identity: COORD,
      lane: LANE,
      claim: claimRec(),
      steps: { retro: createRetroStep(h.deps()) },
      pid: 12345,
      now: () => T0 + 1000 * clock++,
      sleep: async () => {},
      random: () => 0,
      heartbeat: { sleep: (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))) },
      waiter: { wait: async () => ({ end: "elapsed" }) },
    });
    expect(r.outcome).toBe("progress");
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", generation: 1, globs: [...RETRO_GLOBS].sort(), retro_result: { verdict: "accepted-with-open-items" } });
    const unit = h.journal().find((x) => x.type === "unit") as UnitJournalRecord;
    expect(unit).toMatchObject({ unit: U, outcome: "progress", state: "merging", sessions: 1 });
    expect(swaps(h.events).length).toBeGreaterThan(0);
  });

  const runProcess = (h: Harness) => {
    let clock = 0;
    return runCoordinatorProcess({
      forge: h.fake.forge,
      agent: { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent,
      store: createFsLaneStore({ laneDir: h.laneDir, hostStop: join(h.laneDir, "..", "STOP") }),
      laneDir: h.laneDir,
      identity: COORD,
      lane: LANE,
      claim: claimRec(),
      steps: { retro: createRetroStep(h.deps()) },
      pid: 12345,
      now: () => T0 + 1000 * clock++,
      sleep: async () => {},
      random: () => 0,
      heartbeat: { sleep: (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))) },
      waiter: { wait: async () => ({ end: "elapsed" }) },
    });
  };

  test.each([
    ["its doc and items unchanged: re-checked, recorded with the moved head, merging and enqueued", defaultHead(), "merging"],
    ["its doc now rejected: a failed attempt, the stale result dropped", { ...defaultHead(), [DOC]: doc("rejected") }, "released"],
  ] as const)("a released retro whose open PR's head moved past its validated one is adopted, %s (C1)", async (_name, headFiles, state) => {
    const h = harness({ records: [RECENT], headFiles });
    const { pr } = await openRetroPr(h, h.head);
    const validated = "9".repeat(40);
    const result = { verdict: "accepted-with-open-items" as const, items: ITEMS };
    const released = coord(U, { state: "released", globs: RETRO_GLOBS, pr, pr_owner: COORD.owner, head_sha: validated, passed_sha: validated, retro_result: result });
    h.fake.control.writeForeignLedger({ message: "released [skip ci]", writes: tip([RECENT, released]), deletes: [] });
    await runProcess(h);
    const after = (await h.ledger()).get(U);
    expect(h.prompts).toEqual([]);
    expect(after).toMatchObject({ state, generation: 2, pr, head_sha: h.head, retro_result: state === "merging" ? result : null });
    expect(h.fake.control.queue()).toEqual(state === "merging" ? [pr] : []);
  });
});
