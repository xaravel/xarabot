import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel } from "../../src/adapters/agent/claude/usage.ts";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { checkWrite } from "../../src/core/lane/write-check.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import { headPassedGate } from "../../src/lane/passed-gate.ts";
import { reviewStub, stubReviewStep } from "./review-stub.ts";
import { assembleSnapshot } from "../../src/core/next/snapshot.ts";
import { ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { JournalRecord, UnitJournalRecord } from "../../src/core/schemas/journal.ts";
import type { CoordinatorRecord, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Snapshot } from "../../src/core/schemas/snapshot.ts";
import type { Agent, AgentLaunchSpec, AgentUnit } from "../../src/ports/agent.ts";
import type { Forge, ForgeCheck } from "../../src/ports/forge.ts";
import type { Sandbox, SandboxProfile } from "../../src/ports/sandbox.ts";
import type { CommitRequest, Committer } from "../../src/lane/committer.ts";
import { runCoordinatorProcess, type CoordinatorStepInput } from "../../src/lane/coordinator-process.ts";
import type { DiffPathsRequest } from "../../src/lane/diff-paths.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import type { MergeOutcome, MergeRequest, Merger } from "../../src/lane/merger.ts";
import { createRetroItemStep, findRetroItem, retroItemPrText, type RetroItemStepDeps } from "../../src/lane/retro-item-step.ts";
import { CI_FIX_LOG, LIMIT_STOP_REASON, MarkerStop, newTrack, readsPath, type PrStepOutput } from "../../src/lane/session.ts";
import type { WaitEnd } from "../../src/lane/wait.ts";
import type { PrepareParams, Workspace } from "../../src/lane/workspace.ts";
import { COORD, rec, tip } from "../core/ledger/fixtures.ts";
import { unchangedGraph } from "./graph-stub.ts";
import { ledgerProviders, watchPushes } from "./push-providers.ts";

// ------------------------------------------------------------------ world

const FORGE_NOW = "2026-10-25T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const AUTHORITY = "docs/standing-authority.md";
const EPICS = "_bmad-output/planning-artifacts/epics.md";
const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
const X = "epic-2-retro-item-1-fix-x";
const U = `retro-item:${X}`;
const BRANCH = `xarabot/retro-item-${X}`;
const GLOBS = ["src/x/**"];
const LANE: Lane = { repo: "xaravel/xarabot", role: "coordinator", owner: COORD.owner, agent: "claude", effort: "high" };
const PASS: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "success" }];
const FAIL: ForgeCheck[] = [{ name: "ci", status: "completed", conclusion: "failure" }];
const opts = () => ({ signal: AbortSignal.timeout(5000) });

/** `retro-gates.yaml` with Epic 2's retro and item X in `status`. */
function gatesText(status = "open", route = "lane"): string {
  return [
    "schema_version: 1",
    "epics:",
    '  "2":',
    "    retro:",
    "      verdict: accepted-with-open-items",
    '      unit: "retro:2"',
    "      recorded_at: 2026-10-24T00:00:00Z",
    "    items:",
    `      - id: ${X}`,
    "        text: Fix the x helper so it handles empty input",
    `        route: ${route}`,
    "        blocking: false",
    `        globs: ${JSON.stringify(GLOBS)}`,
    `        status: ${status}`,
    "",
  ].join("\n");
}

type MainOpts = {
  /** Extra `policy.yaml` lines. */
  readonly policy?: readonly string[];
  readonly gates?: string | null;
  readonly steps?: readonly string[];
  readonly lockfileCommand?: readonly string[];
};

function mainFiles(o: MainOpts = {}): Record<string, string> {
  const files: Record<string, string> = {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "v1"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "bootstrapped_epics: [1]", "manifests:", "  dir: stories", ...(o.lockfileCommand === undefined ? [] : [`lockfile_command: ${JSON.stringify(o.lockfileCommand)}`]), ""].join("\n"),
    ".xarabot/policy.yaml": ["schema_version: 1", "unattended_adapters: [claude]", ...(o.policy ?? []), ""].join("\n"),
    ".xarabot/human-live-steps.yaml": ["schema_version: 1", ...(o.steps === undefined ? ["steps: []"] : ["steps:", ...o.steps.map((id) => `  - id: ${id}\n    text: Do ${id} by hand.`)]), ""].join("\n"),
    ".xarabot/prompts/house.md": "HOUSE RULE: keep it short.\n",
    [EPICS]: "# Epics\n\n## Epic 1: One\n\n### Story 1.1: First\n\nBody.\n\n## Epic 2: Two\n\n### Story 2.1: Second\n\nBody.\n",
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    "_bmad-output/implementation-artifacts/epic-2-context.md": "# Epic 2 Context: Two\n\nGoal.\n",
    [STATUS]: "development_status:\n  epic-1: done\n  1-1-first: done\n  epic-2: done\n  2-1-second: done\n",
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    "docs/maintainer/evidence/epic-2.md": "# Epic 2 live evidence\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: First\nglobs: ["src/a/**"]\n---\n',
    "stories/2.1.md": '---\nstory_id: "2.1"\nepic: 2\nsprint_key: 2-1-second\ntitle: Second\nglobs: ["src/b/**"]\n---\n',
  };
  if (o.gates !== null) files[RETRO] = o.gates ?? gatesText();
  return files;
}

const coord = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: FORGE_NOW, ...over });

function claimRec(): CoordinatorRecord {
  return { schema_version: 4, ...COORD, lane: "coordinator", generation: 1, heartbeat_at: FORGE_NOW, digest_posted_at: "2026-10-25T08:00:00Z", rulings_cursor: null };
}

const OWN = coord(U, { globs: GLOBS });
/** The last `reconcile` ran just now: not due, so `next` reaches the retro items. */
const RECENT = coord("reconcile:4", { state: "merged", heartbeat_at: FORGE_NOW });

const built = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: "build", outcome: "done", summary: "Handle empty input in x", body: "The x helper now returns [] for empty input.", verification: ["bun test"], denied_actions: [], ...over });

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
  /** Each sandboxed run's argv. */
  readonly argvs: (readonly string[])[];
  /** The CI-fix log in `tmp` as each run saw it. */
  readonly ciLogs: (string | null)[];
  readonly prepares: PrepareParams[];
  readonly commits: CommitRequest[];
  readonly merges: MergeRequest[];
  readonly diffs: DiffPathsRequest[];
  readonly logs: string[];
  readonly events: string[];
  /** The heads the committer returns, in order. */
  readonly heads: readonly string[];
  run(over?: Partial<CoordinatorStepInput>, deps?: Partial<RetroItemStepDeps>): Promise<PrStepOutput>;
  deps(over?: Partial<RetroItemStepDeps>): RetroItemStepDeps;
  ledger(): Promise<Map<string, UnitRecord>>;
  journal(): JournalRecord[];
};

type HarnessOpts = MainOpts & {
  readonly records?: readonly UnitRecord[];
  readonly behaviors?: readonly Behavior[];
  /** The paths each commit changes, checked against the request's rules; default one path in the globs. */
  readonly changed?: readonly string[];
  /** An empty commit. */
  readonly empty?: boolean;
  /** Which commits, by index, conflict with the `main` they go onto; default none. */
  readonly conflicts?: readonly number[];
  readonly diff?: readonly string[];
  /** Each committed head's checks, in order; default all pass. */
  readonly checks?: readonly (readonly ForgeCheck[])[];
  readonly merges?: readonly MergeOutcome[];
  readonly usageLimits?: readonly ({ resetAt: number | null } | null)[];
  readonly waitEnds?: readonly WaitEnd[];
};

function spied(fake: FakeForge, events: string[]): Forge {
  const out = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(fake.forge)) {
    out[name] = (...args: unknown[]) => {
      if (name === "ledgerSwap") events.push(`ledgerSwap ${/^ledger: (\S+)/.exec((args[1] as { message: string }).message)?.[1] ?? ""}`);
      else if (name !== "snapshot") events.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as Forge;
}

function harness(o: HarnessOpts = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "xarabot-retro-item-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "coordinator");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles(o), ledger: tip(o.records ?? [OWN], { [COORDINATOR_PATH]: serializeCoordinator(claimRec()) }) });
  const events: string[] = [];
  const forge = spied(fake, events);
  const prompts: string[] = [];
  const argvs: (readonly string[])[] = [];
  const ciLogs: (string | null)[] = [];
  const prepares: PrepareParams[] = [];
  const commits: CommitRequest[] = [];
  const merges: MergeRequest[] = [];
  const diffs: DiffPathsRequest[] = [];
  const logs: string[] = [];
  const heads = [fake.control.makeCommit(), fake.control.makeCommit(), fake.control.makeCommit(), fake.control.makeCommit()];
  heads.forEach((h, i) => {
    fake.control.setChecks(h, o.checks?.[i] ?? PASS);
    fake.control.setCiLog(h, "ci", `ci log of ${h}\n`);
  });
  const mergeReplies = [...(o.merges ?? [])];
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
      argvs.push(spec.argv);
      if (spec.argv[0] === "bun") {
        // The lockfile command: it rewrites the lockfile in the clone.
        mkdirSync(profile.clone, { recursive: true });
        writeFileSync(join(profile.clone, "bun.lock"), "regenerated\n");
        return ok({ pid: 998, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
      }
      prompts.push(spec.stdin ?? "");
      const log = join(profile.tempDir, CI_FIX_LOG);
      ciLogs.push(existsSync(log) ? readFileSync(log, "utf8") : null);
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

  // The commit's write check runs the request's own rules over the changed paths.
  const committer: Committer = {
    async commit(r) {
      commits.push(r);
      const refusals = checkWrite(
        r.rules,
        (o.changed ?? ["src/x/a.ts"]).map((path) => ({ path, mode: "100644" })),
      );
      if (refusals.length > 0) return ok({ kind: "refused", refusals, reverted: [] });
      if (o.empty === true) return ok({ kind: "empty" });
      if (o.conflicts?.includes(commits.length - 1) === true) return ok({ kind: "conflict", paths: ["src/x/a.ts"], start: prepares.at(-1)?.start as string });
      return ok({ kind: "committed", base_sha: r.ontoSha, head_sha: heads[commits.length - 1] as string });
    },
  };

  const merger: Merger = {
    async merge(r) {
      merges.push(r);
      return ok(mergeReplies.shift() ?? { kind: "up-to-date" });
    },
  };

  const deps = (over: Partial<RetroItemStepDeps> = {}): RetroItemStepDeps => ({
    forge,
    agent,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    workspace,
    waiter: { wait: async () => ({ end: o.waitEnds?.[waited++] ?? "elapsed" }) },
    laneDir,
    lane: LANE,
    committer,
    merger,
    diffPaths: async (r) => {
      diffs.push(r);
      return ok(o.diff ?? ["src/x/a.ts"]);
    },
    graphTrees: unchangedGraph(),
    identity: COORD,
    provider: "anthropic",
    // A clean review round on the unspied forge: it records passed_sha, and the call log stays the step's own.
    review: stubReviewStep({ forge: fake.forge, identity: COORD }).review,
    passed: headPassedGate,
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
      unit: { unit: U, kind: "retro-item", globs: record.globs, expect_generation: null, take_over: null, pr: record.pr, why: "test" },
      record,
      snapshot: a.value,
      files: s.value.main.files,
      signal: new AbortController().signal,
      log: (text) => logs.push(text),
      track: newTrack({ unit: U, startedMs: T0, logName: "retro-item.log", state: "claimed" }),
      ...over,
    };
  };

  return {
    fake,
    laneDir,
    prompts,
    argvs,
    ciLogs,
    prepares,
    commits,
    merges,
    diffs,
    logs,
    events,
    heads,
    async run(over, d) {
      const i = await input(over);
      events.length = 0;
      return createRetroItemStep(deps(d))(i);
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

async function prOnBranch(h: Harness) {
  const r = await h.fake.forge.listPrsByBranch(BRANCH, opts());
  if (!r.ok) throw new Error(r.error.message);
  return r.value.at(-1) ?? null;
}

/** The assembled snapshot of the fake forge's current state. */
async function snapshotOf(h: Harness): Promise<Snapshot> {
  const s = await h.fake.forge.snapshot({ ...opts(), read: readsPath });
  if (!s.ok) throw new Error(s.error.message);
  const v = s.value;
  const a = assembleSnapshot({
    repo: LANE.repo,
    now: v.now,
    tree: [...v.main.tree],
    files: { ...v.main.files },
    main_sha: v.main.sha,
    blob_shas: v.main.blob_shas,
    ledger_tip: v.ledger.tip,
    ledger_files: v.ledger.files,
    prs: v.prs,
    escalations: null,
    lane: COORD,
    role: "coordinator",
  });
  if (!a.ok) throw new Error(a.error.message);
  return a.value;
}

async function mainRetroGates(h: Harness): Promise<string | undefined> {
  const s = await h.fake.forge.snapshot({ ...opts(), read: readsPath });
  if (!s.ok) throw new Error(s.error.message);
  return s.value.main.files[RETRO];
}

const GATED = ['owner_approval_paths: ["**"]'];

// ------------------------------------------------------------------ texts

describe("retroItemPrText and findRetroItem", () => {
  test("message and title <unit>: <summary>; the body the summary, the body and the item's action text; sanitized and redacted", () => {
    const t = retroItemPrText(U, { id: X, text: "Fix the\n x helper" }, { summary: "Handle @someone sekrit", body: "Body." }, ["sekrit"]);
    expect(t.message).toBe(`${U}: Handle @someone sekrit`);
    expect(t.title).toBe(`${U}: Handle someone [REDACTED]`);
    expect(t.body).toBe(`Handle someone [REDACTED]\n\nBody.\n\nRetro action item \`${X}\`: Fix the x helper`);
    expect(retroItemPrText(U, { id: X, text: "T" }, { summary: "S", body: "  " }).body).toBe(`S\n\nRetro action item \`${X}\`: T`);
  });
});

// ------------------------------------------------------------------ the session and the PR

describe("createRetroItemStep: a done session", () => {
  test("AC (Happy): CI passes, owner_approval_paths ** : the PR is opened and parked awaiting-approval with the gate comment; retro-gates.yaml still shows the item open", async () => {
    const h = harness({ policy: GATED, behaviors: [writes(built())] });
    const before = await mainRetroGates(h);
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    const pr = await prOnBranch(h);
    expect(pr).toMatchObject({ state: "open", head_sha: h.heads[0], title: `${U}: Handle empty input in x` });
    expect(pr?.body).toContain("Retro action item `epic-2-retro-item-1-fix-x`: Fix the x helper so it handles empty input");
    const record = (await h.ledger()).get(U);
    expect(record).toMatchObject({ state: "parked", pr: pr?.number, head_sha: h.heads[0], park: { kind: "awaiting-approval", globs_held: ["src/x/a.ts"] } });
    const comments = h.fake.control.comments(pr?.number as number);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toStartWith(`🤖 Unit ${U}: pushed ${(h.heads[0] as string).slice(0, 7)} from lane coordinator.`);
    expect(comments[1]).toStartWith(`🤖 Unit ${U}: this PR changes paths that need the owner's approval: src/x/a.ts.`);
    expect(h.fake.control.queue()).toEqual([]);
    // No write to retro-gates.yaml: the claimed item stays open on main.
    expect(await mainRetroGates(h)).toBe(before);
    expect(findRetroItem(await snapshotOf(h), U)?.item.status).toBe("open");
  });

  test("the prompt runs no skill and names the unit and the item, with the repo sections; the session starts at main on the unit's branch", async () => {
    const h = harness({ behaviors: [writes(built())] });
    await h.run();
    const p = h.prompts[0] ?? "";
    expect(p).toContain("Run no skill.");
    expect(p).not.toMatch(/bmad-/);
    expect(p).toContain(`\`${U}\``);
    expect(p).toContain(`\`${X}\``);
    expect(p).toContain("Fix the x helper so it handles empty input");
    expect(p).toContain("`src/x/**`");
    expect(p).toContain("HOUSE RULE: keep it short.");
    expect(p).not.toContain("sekrit-credential");
    expect(h.prepares.map((x) => [x.unit, x.branch])).toEqual([[U, BRANCH]]);
  });

  test("Ungated: merging, enqueued at its head, and the step ends with no queue watch", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    const pr = await prOnBranch(h);
    expect(h.fake.control.queue()).toEqual([pr?.number as number]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", passed_sha: h.heads[0], ci_fixes: 0 });
    expect(h.events).not.toContain("queueState");
    expect(h.events.filter((e) => e !== "checks" && e !== "comment")).toEqual([
      "branchHead",
      "ledgerSwap heartbeat",
      "pushBranch",
      "ledgerSwap heartbeat",
      "openPr",
      "ledgerSwap heartbeat",
      "ledgerSwap heartbeat",
      "ledgerSwap startMerging",
      "enqueue",
    ]);
    // The CI step merged main into the PR first; the merge commit names the unit.
    expect(h.merges[0]?.message).toContain(`into the PR for Unit ${U}`);
  });

  test("Ungated, enqueue error: a failed attempt", async () => {
    const h = harness({ behaviors: [writes(built())] });
    h.fake.control.injectError("enqueue", { kind: "rejected", message: "no queue" });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1 });
  });

  test("the commit goes onto fresh main under the coordinator rules of the record's globs plus every builder refusal; message <unit>: <summary>", async () => {
    const h = harness({ behaviors: [writes(built())] });
    await h.run();
    const rules = h.commits[0]?.rules;
    expect(rules).toMatchObject({ role: "coordinator", graphUnit: false, globs: GLOBS, retroGatesPath: RETRO });
    expect(rules?.role === "coordinator" ? rules.refused : null).toMatchObject({ standingAuthorityPath: AUTHORITY, coordinatorFiles: [STATUS, RETRO, EPICS] });
    expect(h.commits[0]?.message).toBe(`${U}: Handle empty input in x`);
  });

  test.each([
    ["agent config inside the globs", ["src/x/CLAUDE.md"], "src/x/CLAUDE.md (agent-config)"],
    ["a path outside the globs", ["src/y.ts"], "src/y.ts (outside-unit)"],
  ] as const)("Write check: %s parks write-check, nothing pushed", async (_name, changed, refused) => {
    const h = harness({ behaviors: [writes(built())], changed });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(out.reason).toContain(`write-check: refused ${refused}`);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "write-check" } });
    expect(h.events).not.toContain("pushBranch");
  });

  test("an empty commit parks no-op", async () => {
    const h = harness({ behaviors: [writes(built())], empty: true });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "no-op" } });
  });

  test("openPr fails after the forge opened the PR: the orphan is closed, then a failed attempt", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const real = h.fake.forge.openPr;
    const out = await h.run(undefined, {
      forge: {
        ...h.fake.forge,
        openPr: async (p, o) => {
          await real(p, o);
          return { ok: false, error: { kind: "transient", message: "502 after create" } };
        },
      },
    });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await prOnBranch(h))?.state).toBe("closed");
  });

  test("the record beat fails after openPr: the new PR, which no record carries, is closed, then a failed attempt", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const out = await h.run(undefined, { forge: failRecordAfterOpen(h, spied(h.fake, h.events), U, false) });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 1, pr: null });
    expect((await prOnBranch(h))?.state).toBe("closed");
    // The refused record swap never reaches the spy; the close comes before the failed attempt.
    expect(h.events.slice(h.events.indexOf("openPr"))).toEqual(["openPr", "closePr", "ledgerSwap failAttempt"]);
    expect(out.reason).toContain("which no record carries");
  });

  test("the unit lost at the record beat after openPr: the new PR is closed, no further edit", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const out = await h.run(undefined, { forge: failRecordAfterOpen(h, spied(h.fake, h.events), U, true) });
    expect([out.outcome, out.state]).toEqual(["failed", null]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "claimed", generation: 2, pr: null });
    expect((await prOnBranch(h))?.state).toBe("closed");
    expect(h.events).not.toContain("ledgerSwap failAttempt");
  });

  test("a commit conflicting with fresh main: committed onto the session's start instead, the PR opened, and the CI step's merge of main runs a conflict session, never an attempt", async () => {
    const h = harness({
      conflicts: [0],
      merges: [{ kind: "needs-session", candidate_sha: "c".repeat(40), paths: ["src/x/a.ts"], lockfiles: [] }, { kind: "up-to-date" }],
      behaviors: [writes(built()), writes(built({ summary: "Resolve the conflict" }))],
    });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    const start = h.prepares[0]?.start as string;
    expect(h.commits.map((c) => c.ontoSha).slice(0, 2)).toEqual([(await snapshotOf(h)).main_sha, start]);
    expect(h.logs.some((l) => l.includes(`committing onto the session's start ${start} for the CI step's merge of main`))).toBe(true);
    expect(h.prompts).toHaveLength(2);
    expect(h.ciLogs[1]).toContain("merged into this unit's PR");
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", attempts: 0, ci_fixes: 1 });
  });

  test("a commit conflicting again onto the session's start: a failed attempt, nothing pushed", async () => {
    const h = harness({ conflicts: [0, 1], behaviors: [writes(built())] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("and again onto the session's start");
    expect(h.events).not.toContain("pushBranch");
  });

  test("a re-claim with a stale branch: the push leases from its head and the PR opens", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const stale = h.fake.control.makeCommit();
    expect((await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: stale }, opts())).ok).toBe(true);
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.logs.some((l) => l.includes(`${BRANCH} is at ${stale}: the push leases from it`))).toBe(true);
    expect(await prOnBranch(h)).toMatchObject({ state: "open", head_sha: h.heads[0] });
  });

  test("a session result echoing the credential: the PR title, body and status comment are redacted", async () => {
    const leak = "sekrit-credential";
    const h = harness({ behaviors: [writes(built({ summary: `Fix x ${leak}`, body: `Body ${leak}.`, denied_actions: [`curl ${leak}`] }))] });
    await h.run();
    const pr = await prOnBranch(h);
    const comments = h.fake.control.comments(pr?.number as number);
    for (const text of [pr?.title, pr?.body, comments[0]]) {
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(leak);
    }
    expect(h.commits[0]?.secrets).toEqual([leak]);
  });

  test("an aborted signal (the claim lost): a failed attempt, nothing pushed", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const lost = new AbortController();
    lost.abort();
    const out = await h.run({ signal: lost.signal });
    expect(out.outcome).toBe("failed");
    expect(h.events).not.toContain("pushBranch");
    expect(h.events).not.toContain("openPr");
  });
});

describe("createRetroItemStep: other results", () => {
  test("Blocked intent-gap: parked blocked intent-gap, no commit", async () => {
    const h = harness({ behaviors: [writes(built({ outcome: "blocked", blocked: { kind: "intent-gap", text: "unclear" } }))] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "intent-gap", text: "unclear" } });
    expect(h.commits).toEqual([]);
  });

  test("no-op: parked no-op", async () => {
    const h = harness({ behaviors: [writes(built({ outcome: "no-op" }))] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "no-op" } });
  });

  test("a human-live-step result naming an offered step parks human-live-step; one not offered is a failed attempt", async () => {
    const hls = (id: string) => writes(built({ outcome: "blocked", blocked: { kind: "human-live-step", text: "needs DNS", step_id: id } }));
    const offered = harness({ steps: ["dns"], behaviors: [hls("dns")] });
    const a = await offered.run();
    expect([a.outcome, a.state]).toEqual(["progress", "parked"]);
    expect(offered.prompts[0]).toContain("`dns`: Do dns by hand.");
    expect((await offered.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "human-live-step" } });
    const made = harness({ behaviors: [hls("made-up")] });
    const b = await made.run();
    expect([b.outcome, b.state]).toEqual(["failed", "released"]);
    expect(b.reason).toContain('names step_id "made-up"');
  });

  test.each([
    ["no result file", [], /no result at/],
    ["a retro result", [writes(JSON.stringify({ kind: "retro", verdict: "accepted", items: [], denied_actions: [] }))], /result wrong-kind/],
  ] as const)("%s: a failed attempt", async (_name, behaviors, why) => {
    const h = harness({ behaviors });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(why);
  });

  test.each([
    ["the item is missing", { gates: null }, /lists no item/],
    ["the item is done", { gates: gatesText("done") }, /is done, not open/],
  ] as const)("%s: a failed attempt, no session", async (_name, main, why) => {
    const h = harness({ ...main, behaviors: [writes(built())] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toMatch(why);
    expect(h.prompts).toEqual([]);
  });

  test("a STOP during a usage-limit sleep releases the unit and throws MarkerStop", async () => {
    const h = harness({ usageLimits: [{ resetAt: null }], waitEnds: ["stopped"] });
    let thrown: unknown = null;
    try {
      await h.run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MarkerStop);
    expect((thrown as MarkerStop).reason).toBe(LIMIT_STOP_REASON);
    expect((await h.ledger()).get(U)?.state).toBe("released");
  });
});

describe("createRetroItemStep: CI", () => {
  test("the build push and the CI fix's push each fence the lane's vendor into builder_providers before the branch moves", async () => {
    const h = harness({ checks: [FAIL, PASS], behaviors: [writes(built()), writes(built({ summary: "Fix the lint" }))] });
    const watched = watchPushes(h.deps().forge, h.fake, U);
    const out = await h.run(undefined, { forge: watched.forge });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(watched.seen).toEqual([["anthropic"], ["anthropic"]]);
    expect((await h.ledger()).get(U)).toMatchObject({ ci_fixes: 1, builder_providers: ["anthropic"] });
  });

  test("a codex coordinator's CI fix onto a record anthropic built: [anthropic, openai] at the fix's push", async () => {
    const h = harness({
      records: [{ ...OWN, builder_providers: ["anthropic"] }],
      checks: [FAIL, PASS],
      behaviors: [writes(built()), writes(built({ summary: "Fix the lint" }))],
    });
    const watched = watchPushes(h.deps().forge, h.fake, U);
    const out = await h.run(undefined, { forge: watched.forge, provider: "openai" });
    expect(out.outcome).toBe("progress");
    expect(watched.seen).toEqual([["anthropic", "openai"], ["anthropic", "openai"]]);
    expect((await h.ledger()).get(U)?.builder_providers).toEqual(["anthropic", "openai"]);
  });

  test("CI fails: one CI-fix session in ci-fix mode, the fix pushed to the same PR, ci_fixes 1", async () => {
    const h = harness({ checks: [FAIL, PASS], behaviors: [writes(built()), writes(built({ summary: "Fix the lint" }))] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("Repair the action item");
    expect(h.prompts[1]).toContain(join(h.laneDir, "tmp", CI_FIX_LOG));
    expect(h.ciLogs[1]).toContain(`ci log of ${h.heads[0]}`);
    expect(h.prepares.map((p) => p.start)).toEqual([h.prepares[0]?.start as string, h.heads[0] as string]);
    const pr = await prOnBranch(h);
    expect(pr?.head_sha).toBe(h.heads[1]);
    expect(h.events.filter((e) => e === "openPr")).toHaveLength(1);
    expect(h.events).not.toContain("updatePr");
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", ci_fixes: 1, head_sha: h.heads[1], passed_sha: h.heads[1] });
    expect(h.fake.control.queue()).toEqual([pr?.number as number]);
  });

  test("CI fails at the cap: parked ci-fix-cap, no session", async () => {
    const h = harness({ records: [coord(U, { globs: GLOBS, ci_fixes: 2 })], checks: [FAIL], behaviors: [writes(built())] });
    const out = await h.run();
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "ci-fix-cap" } });
    expect(h.prompts).toHaveLength(1);
  });

  test("a conflict merging main: a conflict session in ci-fix mode naming the unit's PR", async () => {
    const h = harness({
      merges: [{ kind: "needs-session", candidate_sha: "c".repeat(40), paths: ["src/x/a.ts"], lockfiles: [] }, { kind: "up-to-date" }],
      behaviors: [writes(built()), writes(built({ summary: "Resolve the conflict" }))],
    });
    const out = await h.run();
    expect(out.state).toBe("merging");
    expect(h.ciLogs[1]).toContain("merged into this unit's PR");
    expect(h.prepares[1]?.start).toBe("c".repeat(40));
    expect((await h.ledger()).get(U)?.ci_fixes).toBe(1);
  });
});

describe("createRetroItemStep: the review gate (Story 3.5)", () => {
  test("a clean review after CI, then the enqueue: one round, no Story id, enqueued_sha the head", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const out = await h.run(undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ storyId: null, unit: { unit: U, subject: `Unit ${U}` } });
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", loopbacks: 0, passed_sha: h.heads[0], enqueued_sha: h.heads[0] });
  });

  test("retro-item loopback: a blocking review runs the retro_item_loopback prompt, loopbacks + 1, the fix pushed, then CI and review again", async () => {
    const h = harness({ behaviors: [writes(built()), writes(built({ summary: "Fix the review findings" }))] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD, blocking: (n) => n === 0 });
    const out = await h.run(undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("Revise the action item");
    expect(h.prompts[1]).toContain(join(h.laneDir, "tmp", "review-findings.md"));
    expect(h.prompts[1]).toContain("`src/x/**`");
    expect(h.prepares[1]?.start).toBe(h.heads[0]);
    expect(stub.calls.map((c) => c.record.head_sha)).toEqual([h.heads[0] ?? null, h.heads[1] ?? null]);
    expect(h.events.filter((e) => e === "openPr")).toHaveLength(1);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", loopbacks: 1, ci_fixes: 0, head_sha: h.heads[1], passed_sha: h.heads[1], enqueued_sha: h.heads[1] });
  });

  test("the same cap: after 2 loopbacks a blocking round parks review-cap; no enqueue", async () => {
    const h = harness({ records: [coord(U, { globs: GLOBS, loopbacks: 2 })], behaviors: [writes(built())] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD, blocking: () => true });
    const out = await h.run(undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(h.prompts).toHaveLength(1);
    expect(h.fake.control.queue()).toEqual([]);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "blocked", reason: "review-cap" }, loopbacks: 2 });
  });

  test("the same cap: after 2 loopbacks a passing round passes, and the head is enqueued", async () => {
    const h = harness({ records: [coord(U, { globs: GLOBS, loopbacks: 2 })], behaviors: [writes(built())] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD });
    const out = await h.run(undefined, { review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.prompts).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", park: null, loopbacks: 2, passed_sha: h.heads[0], enqueued_sha: h.heads[0] });
  });

  test("the allowance before the session: fresh main's policy drops the lane's agent at session time: no sandbox run, a failed attempt naming it", async () => {
    const h = harness({ behaviors: [writes(built())] });
    let snapshots = 0;
    const forge: Forge = {
      ...h.fake.forge,
      snapshot: (o) => {
        // The first snapshot in the step is the build session's allowance check.
        if (++snapshots === 1) h.fake.control.setMain({ ...mainFiles(), ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [codex]\n" });
        return h.fake.forge.snapshot(o);
      },
    };
    const out = await h.run(undefined, { forge });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
    expect(h.prompts).toEqual([]);
  });

  test("a STOP during the loopback session's usage-limit sleep: the unit released, attempts unchanged, and the step throws MarkerStop", async () => {
    // Run 1 builds; run 2, the loopback, hits a usage limit with no result, and the sleep ends on a STOP.
    const h = harness({ behaviors: [writes(built())], usageLimits: [null, { resetAt: null }], waitEnds: ["stopped"] });
    const stub = stubReviewStep({ forge: h.fake.forge, identity: COORD, blocking: () => true });
    const run = h.run(undefined, { review: stub.review });
    await expect(run).rejects.toBeInstanceOf(MarkerStop);
    await expect(run).rejects.toMatchObject({ reason: LIMIT_STOP_REASON });
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("Revise the action item");
    expect((await h.ledger()).get(U)).toMatchObject({ state: "released", attempts: 0, loopbacks: 1 });
  });

  test("a Halt from the review reaches the process", async () => {
    const h = harness({ behaviors: [writes(built())] });
    const review = async (): Promise<never> => {
      throw new MarkerStop("stop", "STOP during a usage-limit sleep");
    };
    await expect(h.run(undefined, { review })).rejects.toBeInstanceOf(MarkerStop);
  });
});

describe("createRetroItemStep: merging main into the PR", () => {
  test("a merge commit is pushed to the retro-item branch, recorded, and its head polled", async () => {
    const merged = "9".repeat(40);
    const h = harness({ merges: [{ kind: "merged", head_sha: merged, resolved: [STATUS] }], behaviors: [writes(built())] });
    h.fake.control.setChecks(merged, PASS);
    const out = await h.run();
    expect(out.state).toBe("merging");
    expect((await prOnBranch(h))?.head_sha).toBe(merged);
    expect(h.events.filter((e) => e === "pushBranch")).toHaveLength(2);
    expect((await h.ledger()).get(U)).toMatchObject({ head_sha: merged, passed_sha: merged, ci_fixes: 0 });
    expect(h.fake.control.comments((await prOnBranch(h))?.number as number).some((c) => c.startsWith(`🤖 Unit ${U}: merged main`))).toBe(true);
  });

  test("a lockfile conflict: the lockfile command runs in the sandbox at the candidate and its texts reach the second merge", async () => {
    const candidate = "c".repeat(40);
    const h = harness({
      lockfileCommand: ["bun", "install"],
      merges: [{ kind: "lockfile", candidate_sha: candidate, paths: ["bun.lock"] }, { kind: "up-to-date" }],
      behaviors: [writes(built())],
    });
    const out = await h.run();
    expect(out.state).toBe("merging");
    expect(h.argvs.filter((a) => a[0] === "bun")).toEqual([["bun", "install"]]);
    expect(h.prepares.map((p) => p.start).at(-1)).toBe(candidate);
    expect(h.merges).toHaveLength(2);
    expect(h.merges[1]?.lockfiles).toEqual({ "bun.lock": "regenerated\n" });
    expect(h.prompts).toHaveLength(1);
  });
});

describe("findRetroItem", () => {
  test("the listed item with its Epic; null for a malformed id, an Epic with no items, or an id not listed", async () => {
    const extra = '  "3":\n    retro:\n      verdict: accepted\n      unit: "retro:3"\n      recorded_at: 2026-10-24T00:00:00Z\n';
    const h = harness({ gates: gatesText() + extra });
    const snap = await snapshotOf(h);
    const found = findRetroItem(snap, U);
    expect([found?.epic, found?.item.id, found?.item.status]).toEqual([2, X, "open"]);
    expect(findRetroItem(snap, "retro-item:not-an-item-id")).toBeNull();
    expect(findRetroItem(snap, "retro-item:epic-3-retro-item-1-z")).toBeNull();
    expect(findRetroItem(snap, "retro-item:epic-2-retro-item-9-y")).toBeNull();
  });
});

/** `files` with a policy allowing both reviewers, so the reviewer choice is cross-vendor whichever vendor built the unit. */
const bothReviewers = (files: Record<string, string>): Record<string, string> => ({ ...files, ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [claude, codex]\n" });

/** `forge` with each `checks` call first reading `unit`'s `builder_providers` from the ledger on `fake` into `seen`. */
function watchChecks(forge: Forge, fake: FakeForge, unit: string, seen: (readonly string[] | undefined)[]): Forge {
  return {
    ...forge,
    checks: async (sha, o) => {
      seen.push(await ledgerProviders(fake, unit));
      return forge.checks(sha, o);
    },
  };
}

describe("createRetroItemStep: an adopted PR", () => {
  /** Opens the item's PR at a fresh head whose CI passes, and writes the record adopting it, built by `built`; the PR number. */
  const adopt = async (h: Harness, built: readonly string[]): Promise<number> => {
    const head = h.fake.control.makeCommit();
    h.fake.control.setChecks(head, PASS);
    expect((await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts())).ok).toBe(true);
    const opened = await h.fake.forge.openPr({ branch: BRANCH, base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    const record = coord(U, { globs: GLOBS, generation: 2, pr: opened.value.number, pr_owner: COORD.owner, head_sha: head, builder_providers: [...built] });
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([record]), deletes: [] });
    return opened.value.number;
  };

  test.each([
    ["no builder_providers (an adopted PR with no prior record, or a pre-3.3 record): the lane's vendor fenced in before CI", [], ["anthropic"], "codex"],
    ["builder_providers codex wrote: the set unchanged", ["openai"], ["openai"], "claude"],
  ] as const)("retro item 29: an adopted PR with %s; the review is cross-vendor by the other vendor", async (_name, built, after, reviewer) => {
    const h = harness();
    h.fake.control.setMain(bothReviewers(mainFiles()));
    const pr = await adopt(h, built);
    const seen: (readonly string[] | undefined)[] = [];
    const stub = reviewStub({ forge: h.fake.forge, laneDir: h.laneDir, hostStop: join(h.laneDir, "..", "STOP"), lane: LANE, identity: COORD, results: [] });
    const out = await h.run(undefined, { forge: watchChecks(h.deps().forge, h.fake, U, seen), review: stub.review });
    expect([out.outcome, out.state]).toEqual(["progress", "merging"]);
    expect(h.prompts).toEqual([]);
    expect(seen[0]).toEqual([...after]);
    // The vendor fence is the only edit before CI, and only for an empty set.
    expect(h.events.slice(0, h.events.indexOf("checks"))).toEqual(built.length === 0 ? ["ledgerSwap heartbeat"] : []);
    expect(stub.prompts).toHaveLength(1);
    expect(h.fake.control.reviewBodies(pr)[0]).toStartWith(`🤖 Unit ${U}: cross-vendor review by ${reviewer}`);
    expect((await h.ledger()).get(U)?.builder_providers).toEqual([...after]);
  });

  test("Adopted: a released record with its PR open runs no session; CI, then the gate", async () => {
    const h = harness({ policy: GATED });
    const head = h.fake.control.makeCommit();
    h.fake.control.setChecks(head, PASS);
    expect((await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts())).ok).toBe(true);
    const opened = await h.fake.forge.openPr({ branch: BRANCH, base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([coord(U, { globs: GLOBS, generation: 2, pr: opened.value.number, pr_owner: COORD.owner, head_sha: head })]), deletes: [] });
    const out = await h.run();
    expect(h.prompts).toEqual([]);
    expect(h.commits).toEqual([]);
    expect([out.outcome, out.state]).toEqual(["progress", "parked"]);
    expect(h.diffs[0]?.headSha).toBe(head);
    expect((await h.ledger()).get(U)).toMatchObject({ park: { kind: "awaiting-approval" } });
  });

  test("an adopted PR whose item globs were edited since the claim: the CI-fix prompt names the record's globs, which the commit is checked against", async () => {
    const h = harness({ checks: [PASS], behaviors: [writes(built({ summary: "Fix the lint" }))] });
    const head = h.fake.control.makeCommit();
    h.fake.control.setChecks(head, FAIL);
    h.fake.control.setCiLog(head, "ci", "ci log\n");
    expect((await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, opts())).ok).toBe(true);
    const opened = await h.fake.forge.openPr({ branch: BRANCH, base: "main", title: "t", body: "b" }, opts());
    if (!opened.ok) throw new Error(opened.error.message);
    h.fake.control.writeForeignLedger({ message: "adopt [skip ci]", writes: tip([coord(U, { globs: ["src/old/**"], generation: 2, pr: opened.value.number, pr_owner: COORD.owner, head_sha: head })]), deletes: [] });
    await h.run();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("`src/old/**`");
    expect(h.prompts[0]).not.toContain("`src/x/**`");
    expect(h.commits[0]?.rules).toMatchObject({ globs: ["src/old/**"] });
  });
});

// ------------------------------------------------------------------ through the coordinator process

describe("retro items through the coordinator process", () => {
  test("AC: next picks the item on its branch, the process claims it and runs its step instead of idling; merging stops the keeper", async () => {
    const h = harness({ records: [RECENT], behaviors: [writes(built())] });
    let clock = 0;
    const r = await runCoordinatorProcess({
      forge: h.fake.forge,
      agent: { vendor: "claude", defaultModel: "claude-opus-5-5" } as Agent,
      store: createFsLaneStore({ laneDir: h.laneDir, hostStop: join(h.laneDir, "..", "STOP") }),
      laneDir: h.laneDir,
      identity: COORD,
      lane: LANE,
      claim: claimRec(),
      steps: { "retro-item": createRetroItemStep(h.deps()) },
      pid: 12345,
      now: () => T0 + 1000 * clock++,
      sleep: async () => {},
      random: () => 0,
      heartbeat: { sleep: (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))) },
      waiter: { wait: async () => ({ end: "elapsed" }) },
    });
    expect(r.outcome).toBe("progress");
    expect(h.prepares.map((p) => p.branch)).toEqual([BRANCH]);
    expect((await h.ledger()).get(U)).toMatchObject({ state: "merging", generation: 1, globs: GLOBS });
    const unit = h.journal().find((x) => x.type === "unit") as UnitJournalRecord;
    expect(unit).toMatchObject({ unit: U, outcome: "progress", state: "merging", sessions: 1 });
    expect(readFileSync(join(h.laneDir, "logs", unit.log.split("/").at(-1) as string), "utf8")).toContain("the unit is merging: its keeper stopped");
  });
});
