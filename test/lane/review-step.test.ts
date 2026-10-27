import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeForge, FAKE_BOT_LOGIN, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import { err, ok } from "../../src/core/result.ts";
import type { SessionAdapter } from "../../src/core/review/reviewer.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Agent, AgentLaunchSpec, AgentSettings, AgentUnit } from "../../src/ports/agent.ts";
import type { Forge, ForgeError } from "../../src/ports/forge.ts";
import type { Sandbox, SandboxProfile } from "../../src/ports/sandbox.ts";
import { createFsLaneStore, laneLayout, reviewPassPaths } from "../../src/lane/lane-store.ts";
import type { ReviewCheckout, ReviewCheckoutRequest } from "../../src/lane/review-checkout.ts";
import { createReviewStep, type ReviewStepDeps, type ReviewStepInput, type ReviewStepOutput } from "../../src/lane/review-step.ts";
import { MarkerStop, newTrack } from "../../src/lane/session.ts";
import type { WaitEnd } from "../../src/lane/wait.ts";
import { ALICE, rec, tip } from "../core/ledger/fixtures.ts";

// ------------------------------------------------------------------ world

const FORGE_NOW = "2026-10-25T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const AUTHORITY = "docs/standing-authority.md";
const U = "story:3.4";
const BRANCH = "story/3.4";
const SPEC = "_bmad-output/implementation-artifacts/spec-3-4-review-sessions.md";
const OLD_SPEC = "_bmad-output/implementation-artifacts/spec-3-4-first-try.md";
/** The lane's own settings: a `claude` lane with its own model and effort. */
const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: ALICE.owner, agent: "claude", model: "claude-sonnet-5", effort: "medium" };
const CLAUDE_DEFAULT = "claude-opus-5-5";
const CODEX_DEFAULT = "gpt-6.1-sol";

function mainFiles(adapters: readonly string[]): Record<string, string> {
  return {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "v1"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "bootstrapped_epics: [1]", "manifests:", "  dir: stories", ""].join("\n"),
    ".xarabot/policy.yaml": ["schema_version: 1", `unattended_adapters: [${adapters.join(", ")}]`, ""].join("\n"),
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
  };
}

const spec = (status: string, followup?: boolean): string =>
  `---\ntitle: 'Story 3.4'\nstatus: '${status}'\n${followup === undefined ? "" : `followup_review_recommended: ${followup}\n`}---\n\n## Auto Run Result\n\nStatus: ${status}\n\nRisks: the loop.\n`;

type Finding = { severity: "high" | "medium" | "low"; blocking: boolean; file: string; text: string };

function reviewResult(over: { sha?: string; verdict?: string; findings?: Finding[]; denied?: string[] } = {}): (head: string) => string {
  return (head) => JSON.stringify({ kind: "review", reviewed_sha: over.sha ?? head, verdict: over.verdict ?? "pass", findings: over.findings ?? [], denied_actions: over.denied ?? [] });
}

const BLOCKER: Finding = { severity: "high", blocking: true, file: "src/a.ts", text: "the loop never ends." };
const NIT: Finding = { severity: "low", blocking: false, file: "src/b.ts", text: "a name could be clearer." };

// -------------------------------------------------------------- stubs

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One run's result writer: the result text for the head, or nothing. */
type Behavior = ((head: string) => string) | null;

type Launch = { readonly vendor: string; readonly settings: AgentSettings; readonly prompt: string };

type Harness = {
  readonly fake: FakeForge;
  readonly laneDir: string;
  readonly head: string;
  readonly main: string;
  readonly pr: number;
  readonly prompts: string[];
  readonly profiles: SandboxProfile[];
  readonly launches: Launch[];
  readonly checkouts: ReviewCheckoutRequest[];
  readonly logs: string[];
  readonly events: string[];
  /** The record as the forge held it at each `postReview`. */
  readonly atPost: UnitRecord[];
  run(over?: Partial<ReviewStepInput>, deps?: Partial<ReviewStepDeps>): Promise<ReviewStepOutput>;
  record(): Promise<UnitRecord>;
};

type HarnessOpts = {
  readonly adapters?: readonly string[];
  readonly providers?: readonly string[];
  readonly behaviors?: readonly Behavior[];
  /** The spec files the checkout holds (path → text); default one `done` spec, unflagged. */
  readonly specs?: Readonly<Record<string, string>>;
  /** The model each run reports; default the configured one. */
  readonly models?: readonly (string | null)[];
  /** The cost each run reports; default $0.25, billed. */
  readonly costs?: readonly ({ usd: number; estimate: boolean } | null)[];
  readonly sandboxRefuses?: boolean;
  readonly record?: Partial<UnitRecord>;
  readonly usageLimits?: readonly ({ resetAt: number | null } | null)[];
  readonly waitEnds?: readonly WaitEnd[];
};

async function harness(o: HarnessOpts = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "xarabot-review-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const layout = laneLayout(laneDir);
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles(o.adapters ?? ["claude", "codex"]) });
  const head = fake.control.makeCommit();
  const prompts: string[] = [];
  const profiles: SandboxProfile[] = [];
  const launches: Launch[] = [];
  const checkouts: ReviewCheckoutRequest[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const atPost: UnitRecord[] = [];
  let runs = 0;
  let usageCalls = 0;
  let waited = 0;
  let lastModel = "";

  const record = async (): Promise<UnitRecord> => {
    const s = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.units.get(U) as UnitRecord;
  };

  const forge: Forge = {
    ...fake.forge,
    ledgerSwap: (oldSha, commit, opts) => {
      events.push(`ledgerSwap ${/^ledger: (\S+)/.exec(commit.message)?.[1] ?? ""}`);
      return fake.forge.ledgerSwap(oldSha, commit, opts);
    },
    postReview: async (pr, review, opts) => {
      events.push("postReview");
      atPost.push(await record());
      return fake.forge.postReview(pr, review, opts);
    },
  };

  const agentFor = (vendor: SessionAdapter, defaultModel: string): Agent => ({
    vendor,
    defaultModel,
    minVersion: "1.0.0",
    launchSpec: (unit: AgentUnit, settings, resultPath) => {
      lastModel = settings.model ?? defaultModel;
      const prompt = unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`;
      launches.push({ vendor, settings, prompt });
      return ok({
        argv: [`stub-${vendor}`, settings.effort, resultPath],
        stdin: prompt,
        vendor,
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
      } as AgentLaunchSpec);
    },
    parseUsage: () => {
      const n = usageCalls++;
      const reported = o.models?.[n];
      const cost = o.costs?.[n];
      return {
        sessionId: null,
        model: reported === undefined ? lastModel : reported,
        tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
        cost: cost === undefined ? { usd: 0.25, estimate: false } : cost,
        usageLimit: o.usageLimits?.[n] ?? null,
      };
    },
    checkModel: (usage, configured) =>
      usage.model === configured ? ok(usage.model) : err("model-mismatch", `ran ${usage.model ?? "no model"}, not ${configured}`),
    effortValues: () => ["low", "medium", "high"],
    startCheck: () => ok({ model: defaultModel, version: "1.0.0" }),
  });
  const reviewers = { claude: agentFor("claude", CLAUDE_DEFAULT), codex: agentFor("codex", CODEX_DEFAULT) };

  const sandbox: Sandbox = {
    async run(spec, profile) {
      if (o.sandboxRefuses === true) return err("refused", "sandbox: the profile is refused");
      prompts.push(spec.stdin ?? "");
      profiles.push(profile);
      const write = o.behaviors?.[runs++];
      if (write !== undefined && write !== null) writeFileSync(profile.resultPath, write(head));
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };

  const checkout: ReviewCheckout = {
    async prepare(r) {
      checkouts.push(r);
      rmSync(layout.review, { recursive: true, force: true });
      mkdirSync(join(layout.review, ".git"), { recursive: true });
      const tree = { "src/a.ts": "a\n", ...(o.specs ?? { [SPEC]: spec("done") }) };
      for (const [path, text] of Object.entries(tree)) {
        mkdirSync(dirname(join(layout.review, path)), { recursive: true });
        writeFileSync(join(layout.review, path), text);
      }
      return ok({ sha: r.head });
    },
  };

  const signal = () => ({ signal: AbortSignal.timeout(5000) });
  const pushed = await fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, signal());
  if (!pushed.ok) throw new Error(pushed.error.message);
  const opened = await fake.forge.openPr({ branch: BRANCH, base: "main", title: "Story 3.4", body: "b" }, signal());
  if (!opened.ok) throw new Error(opened.error.message);
  const pr = opened.value.number;
  const snap = await fake.forge.snapshot(signal());
  if (!snap.ok) throw new Error(snap.error.message);
  const main = snap.value.main.sha;
  const own = rec({
    unit: U,
    globs: ["src/**"],
    heartbeat_at: FORGE_NOW,
    pr,
    pr_owner: ALICE.owner,
    base_sha: main,
    head_sha: head,
    builder_providers: [...(o.providers ?? ["anthropic"])],
    ...o.record,
  });
  fake.control.writeForeignLedger({ message: "claims [skip ci]", writes: tip([own]), deletes: [] });

  const deps = (over: Partial<ReviewStepDeps> = {}): ReviewStepDeps => ({
    forge,
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    waiter: { wait: async () => ({ end: o.waitEnds?.[waited++] ?? "elapsed" }) },
    laneDir,
    lane: LANE,
    identity: ALICE,
    reviewers,
    checkout,
    secrets: ["sekrit-credential"],
    now: () => T0,
    sleep: async () => {},
    random: () => 0,
    ...over,
  });

  return {
    fake,
    laneDir,
    head,
    main,
    pr,
    prompts,
    profiles,
    launches,
    checkouts,
    logs,
    events,
    atPost,
    async run(over = {}, d = {}) {
      const input: ReviewStepInput = {
        unit: { unit: U, subject: "Story 3.4" },
        storyId: "3.4",
        record: await record(),
        track: newTrack({ unit: U, startedMs: T0, logName: "story-3.4.log", state: "claimed" }),
        signal: new AbortController().signal,
        log: (text) => logs.push(text),
        ...over,
      };
      events.length = 0;
      return createReviewStep(deps(d))(input);
    },
    record,
  };
}

const reviewsOf = async (h: Harness) => {
  const r = await h.fake.forge.reviews(h.pr, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const swaps = (events: readonly string[]) => events.filter((e) => e.startsWith("ledgerSwap ")).map((e) => e.slice("ledgerSwap ".length));

// ------------------------------------------------------------------ the round

describe("createReviewStep: a clean round", () => {
  test("cross pass: a codex session in layout.review at head, one cross-vendor review posted, reviewed_sha and passed_sha the head", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const out = await h.run();
    expect(out.outcome).toBe("progress");
    expect(out.state).toBe("claimed");
    expect(out.review).toEqual({ sha: h.head, blocking: false, crossVendor: true, adapter: "codex", passes: 1, findings: [] });
    // The session: the codex reviewer, its default model at effort high, in the review checkout, never the clone.
    expect(h.launches.map((l) => [l.vendor, l.settings])).toEqual([["codex", { effort: "high" }]]);
    const layout = laneLayout(h.laneDir);
    expect(h.profiles).toHaveLength(1);
    expect(h.profiles[0]?.clone).toBe(layout.review);
    expect(h.profiles[0]?.clone).not.toBe(layout.clone);
    const own = reviewPassPaths(layout, "normal");
    expect(h.profiles[0]).toMatchObject({ vendorHome: own.vendorHome, tempDir: own.tmp, runnerGit: layout.runnerGit, resultPath: own.resultPath });
    expect(h.checkouts.map((c) => [c.head, c.main])).toEqual([[h.head, h.main]]);
    // The prompt passed: the unit, the head, main and the spec.
    const prompt = h.prompts[0] as string;
    expect(prompt).toContain(`Review the change of \`${U}\` at commit \`${h.head}\`.`);
    expect(prompt).toContain(`\`main\` is at \`${h.main}\``);
    expect(prompt).toContain(`The spec for this change is \`${SPEC}\``);
    expect(prompt).not.toContain("# Follow-up review");
    // One review, comment-only, at the head, by the bot, saying cross-vendor.
    expect(await reviewsOf(h)).toEqual([{ author: FAKE_BOT_LOGIN, state: "commented", commit_sha: h.head, submitted_at: FORGE_NOW }]);
    expect(h.fake.control.reviewBodies(h.pr)).toEqual([
      `🤖 Story 3.4: cross-vendor review by codex (${CODEX_DEFAULT}) of ${h.head}.\n\nVerdict: pass.\nOutcome: not blocking.\n\nFindings: none.\n\nDenied actions: none.\n`,
    ]);
    expect(await h.record()).toMatchObject({ state: "claimed", reviewed_sha: h.head, passed_sha: h.head });
  });

  test("ledger order: the fence records reviewed_sha and clears passed_sha before postReview; passed_sha is set after", async () => {
    const h = await harness({ behaviors: [reviewResult()], record: { reviewed_sha: "e".repeat(40), passed_sha: "e".repeat(40) } });
    await h.run();
    expect(h.events.filter((e) => e !== "ledgerSwap snapshot")).toEqual(["ledgerSwap heartbeat", "postReview", "ledgerSwap heartbeat"]);
    expect(h.atPost.map((r) => [r.reviewed_sha, r.passed_sha])).toEqual([[h.head, null]]);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: h.head });
  });

  test("same-vendor: a claude reviewer with the lane's model and effort; the body says same-vendor", async () => {
    const h = await harness({ adapters: ["claude"], behaviors: [reviewResult()] });
    const out = await h.run();
    expect(out.review).toMatchObject({ crossVendor: false, adapter: "claude", blocking: false });
    expect(h.launches.map((l) => [l.vendor, l.settings])).toEqual([["claude", { effort: "medium", model: "claude-sonnet-5" }]]);
    expect(h.fake.control.reviewBodies(h.pr)[0]).toStartWith(`🤖 Story 3.4: same-vendor review by claude (claude-sonnet-5) of ${h.head}.`);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: h.head });
  });

  test("a codex-built unit gets the claude reviewer, cross-vendor, with the lane's settings", async () => {
    const h = await harness({ providers: ["openai"], behaviors: [reviewResult()] });
    const out = await h.run();
    expect(out.review).toMatchObject({ crossVendor: true, adapter: "claude" });
    expect(h.launches[0]?.settings).toEqual({ effort: "medium", model: "claude-sonnet-5" });
  });

  test("agent SHA: a result naming another reviewed_sha; the record and the body use the head, and the log notes it", async () => {
    const other = "9".repeat(40);
    const h = await harness({ behaviors: [reviewResult({ sha: other })] });
    const out = await h.run();
    expect(out.review?.sha).toBe(h.head);
    expect(h.fake.control.reviewBodies(h.pr)[0]).toContain(`of ${h.head}.`);
    expect(h.fake.control.reviewBodies(h.pr)[0]).not.toContain(other);
    expect((await reviewsOf(h))[0]?.commit_sha).toBe(h.head);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: h.head });
    expect(h.logs.some((l) => l.includes(`names reviewed_sha ${other}, not the checked-out ${h.head}`))).toBe(true);
  });

  test("a blocked spec the done one supersedes is fine; no Story id needs no spec at all", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done"), [OLD_SPEC]: spec("blocked") }, behaviors: [reviewResult()] });
    expect((await h.run()).review?.passes).toBe(1);
    const g = await harness({ specs: {}, behaviors: [reviewResult()] });
    const out = await g.run({ unit: { unit: U, subject: "Unit story:3.4" }, storyId: null });
    expect(out.review).toMatchObject({ passes: 1, blocking: false });
    expect(g.prompts[0]).toContain("This unit has no spec file");
    expect(g.fake.control.reviewBodies(g.pr)[0]).toStartWith("🤖 Unit story:3.4: cross-vendor review");
  });
});

describe("createReviewStep: the posted text", () => {
  test("the lane's secret is redacted from the posted body", async () => {
    const h = await harness({ behaviors: [reviewResult({ findings: [{ ...NIT, text: "the log prints sekrit-credential in full." }] })] });
    await h.run();
    const body = h.fake.control.reviewBodies(h.pr)[0] as string;
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("sekrit-credential");
  });

  test("the reviewer's denied actions are posted and noted in the unit log", async () => {
    const h = await harness({ behaviors: [reviewResult({ denied: ["curl\n https://example.com", "write sekrit-credential"] })] });
    await h.run();
    expect(h.fake.control.reviewBodies(h.pr)[0]).toEndWith("\n\nDenied actions:\n- curl https://example.com\n- write [REDACTED]\n");
    expect(h.logs.some((l) => l.includes("normal review denied action: curl https://example.com"))).toBe(true);
  });
});

describe("createReviewStep: blocking", () => {
  test("blocking: a blocking finding; the review is posted, reviewed_sha the head, passed_sha null, output blocking", async () => {
    const h = await harness({ behaviors: [reviewResult({ verdict: "changes-requested", findings: [BLOCKER, NIT] })], record: { passed_sha: "e".repeat(40) } });
    const out = await h.run();
    expect(out.outcome).toBe("progress");
    expect(out.state).toBe("claimed");
    expect(out.review).toEqual({ sha: h.head, blocking: true, crossVendor: true, adapter: "codex", passes: 1, findings: [BLOCKER, NIT] });
    expect(h.fake.control.reviewBodies(h.pr)).toEqual([
      `🤖 Story 3.4: cross-vendor review by codex (${CODEX_DEFAULT}) of ${h.head}.\n\nVerdict: changes requested.\nOutcome: blocking.\n\nFindings:\n- high, blocking, \`src/a.ts\`: the loop never ends.\n- low, not blocking, \`src/b.ts\`: a name could be clearer.\n\nDenied actions: none.\n`,
    ]);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: null });
    expect(swaps(h.events)).toEqual(["heartbeat"]);
  });

  test("a blocking finding with a pass verdict blocks", async () => {
    const h = await harness({ behaviors: [reviewResult({ findings: [BLOCKER] })] });
    expect((await h.run()).review?.blocking).toBe(true);
    expect((await h.record()).passed_sha).toBeNull();
  });

  test("verdict only: changes-requested with no blocking finding is blocking", async () => {
    const h = await harness({ behaviors: [reviewResult({ verdict: "changes-requested", findings: [NIT] })] });
    const out = await h.run();
    expect(out.review?.blocking).toBe(true);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: null });
  });
});

describe("createReviewStep: the follow-up pass", () => {
  test("flagged spec: two sessions on two fresh checkouts of the same head and main, two reviews, passed_sha after both", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done", true) }, behaviors: [reviewResult(), reviewResult({ findings: [NIT] })] });
    const out = await h.run();
    expect(out.review).toEqual({ sha: h.head, blocking: false, crossVendor: true, adapter: "codex", passes: 2, findings: [NIT] });
    expect(h.checkouts.map((c) => [c.head, c.main])).toEqual([
      [h.head, h.main],
      [h.head, h.main],
    ]);
    expect(h.profiles.map((p) => p.clone)).toEqual([laneLayout(h.laneDir).review, laneLayout(h.laneDir).review]);
    expect(h.prompts[0]).not.toContain("# Follow-up review");
    expect(h.prompts[1]).toContain(`The spec \`${SPEC}\` asks for this follow-up review.`);
    const bodies = h.fake.control.reviewBodies(h.pr);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toStartWith("🤖 Story 3.4: cross-vendor review by codex");
    expect(bodies[1]).toStartWith("🤖 Story 3.4: cross-vendor follow-up review by codex");
    expect((await reviewsOf(h)).map((r) => [r.state, r.commit_sha])).toEqual([
      ["commented", h.head],
      ["commented", h.head],
    ]);
    expect(h.events.filter((e) => e !== "ledgerSwap snapshot")).toEqual(["ledgerSwap heartbeat", "postReview", "ledgerSwap heartbeat", "postReview", "ledgerSwap heartbeat"]);
    expect(h.atPost.map((r) => r.passed_sha)).toEqual([null, null]);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: h.head });
  });

  test("flagged, the follow-up blocks: passed_sha stays null", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done", true) }, behaviors: [reviewResult(), reviewResult({ verdict: "changes-requested", findings: [BLOCKER] })] });
    const out = await h.run();
    expect(out.review).toMatchObject({ blocking: true, passes: 2, findings: [BLOCKER] });
    expect(h.fake.control.reviewBodies(h.pr)).toHaveLength(2);
    expect(await h.record()).toMatchObject({ reviewed_sha: h.head, passed_sha: null });
  });

  test("flagged, the normal pass blocks: the follow-up still runs, and passed_sha stays null", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done", true) }, behaviors: [reviewResult({ findings: [BLOCKER] }), reviewResult()] });
    const out = await h.run();
    expect(out.review).toMatchObject({ blocking: true, passes: 2 });
    expect((await h.record()).passed_sha).toBeNull();
  });

  test.each([
    ["unflagged", { [SPEC]: spec("done", false) }],
    ["no flag", { [SPEC]: spec("done") }],
  ])("%s: one session", async (_what, specs) => {
    const h = await harness({ specs, behaviors: [reviewResult(), reviewResult()] });
    expect((await h.run()).review?.passes).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });

  test("flagged, a usage limit restarts the normal pass: the follow-up pass still runs once", async () => {
    const h = await harness({
      specs: { [SPEC]: spec("done", true) },
      behaviors: [null, reviewResult(), reviewResult()],
      usageLimits: [{ resetAt: null }, null, null],
    });
    const out = await h.run();
    expect(out.review).toMatchObject({ blocking: false, passes: 2 });
    expect(h.prompts).toHaveLength(3);
    expect(h.fake.control.reviewBodies(h.pr)).toHaveLength(2);
    expect((await h.record()).passed_sha).toBe(h.head);
  });

  test("no Story id: one session, even with a flagged spec in the tree", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done", true) }, behaviors: [reviewResult(), reviewResult()] });
    const out = await h.run({ storyId: null });
    expect(out.review?.passes).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ failures

describe("createReviewStep: each pass's own writable roots (Epic 3 retro item 1)", () => {
  /** True when one path is the other or lies inside it. */
  const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const roots = (p: SandboxProfile): string[] => [p.clone, p.vendorHome, p.tempDir];

  test("the review profile shares no writable root with the builder profile, nor one pass with the other", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done", true) }, behaviors: [reviewResult(), reviewResult()] });
    const out = await h.run();
    expect(out.review?.passes).toBe(2);
    const layout = laneLayout(h.laneDir);
    // The builder's profile, as the lane process builds it.
    const builder: SandboxProfile = { clone: layout.clone, vendorHome: layout.vendorHome, tempDir: layout.tmp, runnerGit: layout.runnerGit, resultPath: layout.resultPath };
    expect(h.profiles).toHaveLength(2);
    const [normal, followup] = h.profiles as [SandboxProfile, SandboxProfile];
    for (const review of [normal, followup]) {
      expect(review.resultPath.startsWith(`${review.tempDir}/`)).toBe(true);
      for (const r of roots(review)) for (const b of roots(builder)) expect({ r, b, overlaps: overlaps(r, b) }).toEqual({ r, b, overlaps: false });
      expect(overlaps(review.resultPath, builder.tempDir)).toBe(false);
    }
    expect(overlaps(normal.vendorHome, followup.vendorHome)).toBe(false);
    expect(overlaps(normal.tempDir, followup.tempDir)).toBe(false);
    expect([normal, followup].map((p) => [p.vendorHome, p.tempDir, p.resultPath])).toEqual(
      (["normal", "followup"] as const).map((pass) => {
        const own = reviewPassPaths(layout, pass);
        return [own.vendorHome, own.tmp, own.resultPath];
      }),
    );
  });

  test("a pass written into the builder's result path while the review runs is never read: no review, passed_sha unset", async () => {
    const h = await harness();
    const layout = laneLayout(h.laneDir);
    const launched: string[][] = [];
    // A process a builder session left behind: it writes a passing review where the builder's sessions write theirs.
    const forger: Sandbox = {
      async run(spec) {
        launched.push([...spec.argv]);
        mkdirSync(layout.tmp, { recursive: true });
        writeFileSync(layout.resultPath, reviewResult()(h.head));
        return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
      },
    };
    const out = await h.run({}, { sandbox: forger });
    const own = reviewPassPaths(layout, "normal");
    // The launch and the prompt name the pass's own result path, never the builder's.
    expect(launched.map((a) => a.at(-1))).toEqual([own.resultPath]);
    expect(out.outcome).toBe("failed");
    expect(h.logs.join("")).toContain(`no result at ${own.resultPath}`);
    expect(await reviewsOf(h)).toEqual([]);
    expect((await h.record()).passed_sha).toBeNull();
  });
});

describe("createReviewStep: the allowance before each pass (Story 3.5)", () => {
  /** The fake forge whose `main` turns to a policy allowing only `adapters` just before the second snapshot: the session's allowance check, after the set-up's. */
  const dropsAtSession = (h: Harness, adapters: readonly string[]): Forge => {
    let snapshots = 0;
    return {
      ...h.fake.forge,
      snapshot: (o) => {
        snapshots += 1;
        if (snapshots === 2) h.fake.control.setMain(mainFiles(adapters));
        return h.fake.forge.snapshot(o);
      },
    };
  };

  test("fresh main's policy drops the lane's agent at session time: no sandbox run, a failed attempt naming the allowance", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const out = await h.run({}, { forge: dropsAtSession(h, ["codex"]) });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("allowance: agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
    expect(h.prompts).toEqual([]);
    expect(await reviewsOf(h)).toEqual([]);
    expect(await h.record()).toMatchObject({ state: "released", attempts: 1, passed_sha: null });
  });

  test("a policy that keeps the lane's agent but drops the chosen reviewer (codex): no sandbox run, a failed attempt naming the reviewer", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const out = await h.run({}, { forge: dropsAtSession(h, ["claude"]) });
    expect([out.outcome, out.state]).toEqual(["failed", "released"]);
    expect(out.reason).toContain("allowance: agent codex is not in .xarabot/policy.yaml unattended_adapters (allowed: claude)");
    expect(h.prompts).toEqual([]);
  });
});

describe("createReviewStep: failures", () => {
  test.each([
    ["no spec", {}],
    ["two done specs", { [SPEC]: spec("done"), [OLD_SPEC]: spec("done") }],
    ["only a blocked spec", { [SPEC]: spec("blocked") }],
  ])("bad spec (%s): a failed attempt, no session, nothing posted", async (_what, specs) => {
    const h = await harness({ specs, behaviors: [reviewResult()] });
    const out = await h.run();
    expect(out.outcome).toBe("failed");
    expect(out.review).toBeUndefined();
    expect(out.reason).toContain("spec:");
    expect(h.prompts).toEqual([]);
    expect(h.fake.control.reviewBodies(h.pr)).toEqual([]);
    expect(await h.record()).toMatchObject({ state: "released", attempts: 1, reviewed_sha: null, passed_sha: null });
  });

  test("no reviewer: a policy allowing neither ends the step stop, with no session", async () => {
    const h = await harness({ adapters: [], behaviors: [reviewResult()] });
    const out = await h.run();
    expect(out.outcome).toBe("stop");
    expect(out.reason).toContain("no reviewer");
    expect(h.checkouts).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(await h.record()).toMatchObject({ state: "claimed", attempts: 0 });
  });

  test("reviewer not composed: deps.reviewers lacks the choice; stop, no session", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const out = await h.run({}, { reviewers: { claude: undefined } });
    expect(out.outcome).toBe("stop");
    expect(out.reason).toContain("codex reviewer was not composed");
    expect(h.prompts).toEqual([]);
  });

  test.each([
    ["rejected", { kind: "rejected", message: "422" }],
    ["not-found", { kind: "not-found", message: "gone" }],
    ["transient", { kind: "transient", message: "timeout" }],
  ] as const)("post fails (%s): a failed attempt, passed_sha never set", async (_what, error) => {
    const h = await harness({ behaviors: [reviewResult()] });
    h.fake.control.injectError("postReview", error as ForgeError);
    const out = await h.run();
    expect(out.outcome).toBe("failed");
    expect(out.review).toBeUndefined();
    expect(out.reason).toContain(`postReview PR #${h.pr} ${error.kind}`);
    expect(await h.record()).toMatchObject({ state: "released", attempts: 1, passed_sha: null });
  });

  test("a post failing on the follow-up pass leaves passed_sha unset", async () => {
    const h = await harness({ specs: { [SPEC]: spec("done", true) }, behaviors: [reviewResult(), reviewResult()] });
    let posts = 0;
    const base = h.fake.forge;
    const out = await h.run({}, {
      forge: {
        ...base,
        postReview: (pr, r, o) => (++posts === 2 ? Promise.resolve({ ok: false as const, error: { kind: "rejected" as const, message: "422" } }) : base.postReview(pr, r, o)),
      },
    });
    expect(out.outcome).toBe("failed");
    expect(await h.record()).toMatchObject({ state: "released", reviewed_sha: h.head, passed_sha: null });
  });

  test("a lane-stop post error stops the lane", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    h.fake.control.injectError("postReview", { kind: "forbidden", message: "no pull_requests: write" });
    const out = await h.run();
    expect(out.outcome).toBe("stop");
    expect((await h.record()).passed_sha).toBeNull();
  });

  test.each([
    ["no result", { behaviors: [null] }, "no result at"],
    ["a model mismatch", { behaviors: [reviewResult()], models: ["gpt-5-old"] }, "model-mismatch"],
    ["no model reported", { behaviors: [reviewResult()], models: [null] }, "model-mismatch"],
    ["the sandbox refused", { behaviors: [reviewResult()], sandboxRefuses: true }, "sandbox refused"],
    ["an invalid result", { behaviors: [() => JSON.stringify({ kind: "review", verdict: "maybe" })] }, "result invalid"],
    ["a build result", { behaviors: [() => JSON.stringify({ kind: "build", outcome: "done" })] }, "result wrong-kind"],
  ] as const)("session fails (%s): a failed attempt, nothing posted", async (_what, opts, reason) => {
    const h = await harness(opts as HarnessOpts);
    const out = await h.run();
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain(reason);
    expect(h.fake.control.reviewBodies(h.pr)).toEqual([]);
    expect(await h.record()).toMatchObject({ state: "released", attempts: 1, reviewed_sha: null, passed_sha: null });
  });

  test("PR moved: the forge's head is not the record's; a failed attempt, no session", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    await h.record();
    const moved = h.fake.control.makeCommit();
    const pushed = await h.fake.forge.pushBranch({ branch: BRANCH, expected_sha: h.head, sha: moved }, { signal: AbortSignal.timeout(5000) });
    expect(pushed.ok).toBe(true);
    const out = await h.run();
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain(`head is ${moved}, not the record's ${h.head}`);
    expect(h.checkouts).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  test("PR closed: a failed attempt, no session", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    await h.record();
    const closed = await h.fake.forge.closePr(h.pr, { signal: AbortSignal.timeout(5000) });
    expect(closed.ok).toBe(true);
    const out = await h.run();
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain(`PR #${h.pr} is closed`);
    expect(h.prompts).toEqual([]);
  });

  test("a record with no PR or no head: a failed attempt, no session", async () => {
    const h = await harness({ behaviors: [reviewResult()], record: { head_sha: null } });
    const out = await h.run();
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("has no head_sha");
    const g = await harness({ behaviors: [reviewResult()], record: { pr: null, pr_owner: null } });
    expect((await g.run()).reason).toContain("no PR to review");
    expect(g.prompts).toEqual([]);
  });

  test("a failed checkout is a failed attempt", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const out = await h.run({}, { checkout: { prepare: async () => err("fetch", "offline") } });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("prepare fetch: offline");
    expect(h.prompts).toEqual([]);
  });

  test("an aborted unit signal ends the step failed before any session", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const ac = new AbortController();
    ac.abort();
    const out = await h.run({ signal: ac.signal });
    expect(out.outcome).toBe("failed");
    expect(h.prompts).toEqual([]);
  });

  test("a STOP during a usage-limit sleep releases the unit and throws MarkerStop", async () => {
    const h = await harness({ behaviors: [null], usageLimits: [{ resetAt: null }], waitEnds: ["stopped"] });
    const track = newTrack({ unit: U, startedMs: T0, logName: "story-3.4.log", state: "claimed" });
    await expect(h.run({ track })).rejects.toBeInstanceOf(MarkerStop);
    expect((await h.record()).state).toBe("released");
    expect(track.state).toBe("released");
    expect(track.record?.state).toBe("released");
    // The limited run still reaches the unit's journal record (Epic 3 retro item 5).
    expect(track).toMatchObject({ sessions: 1, reviewSessions: 1, tokens: { input: 10, output: 2 }, cost: { usd: 0.25, estimate: false } });
  });

  test("PR mismatch: the forge's PR for the unit is not the record's; a failed attempt, no session", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const base = h.fake.forge;
    const forge: Forge = {
      ...base,
      snapshot: async (o) => {
        const r = await base.snapshot(o);
        if (!r.ok) return r;
        const state = r.value.prs[U];
        return state === undefined ? r : { ok: true, value: { ...r.value, prs: { ...r.value.prs, [U]: { ...state, number: state.number + 100 } } } };
      },
    };
    const out = await h.run({}, { forge });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain(`the forge shows PR #${h.pr + 100} for ${U}, not the record's PR #${h.pr}`);
    expect(h.checkouts).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

});

// ------------------------------------------------- usage on the unit's journal record (Epic 3 retro item 5)

describe("createReviewStep: review usage on the caller's track", () => {
  /** A builder's track after one billed build run. */
  const built = () => {
    const track = newTrack({ unit: U, startedMs: T0, logName: "story-3.4.log", state: "claimed" });
    track.reportedModel = "claude-sonnet-5";
    track.sessions = 1;
    track.tokens = { input: 100, output: 20, cacheRead: 5, cacheCreation: 1 };
    track.cost = { usd: 1, estimate: false };
    return track;
  };

  test("a cross-vendor pass: its runs, tokens and cost added to the caller's; the reviewer and its model in the reason; the builder's reported model kept", async () => {
    const h = await harness({ behaviors: [reviewResult()] });
    const track = built();
    const out = await h.run({ track });
    expect(out.outcome).toBe("progress");
    expect(track).toMatchObject({
      sessions: 2,
      reviewSessions: 1,
      tokens: { input: 110, output: 22, cacheRead: 5, cacheCreation: 1 },
      cost: { usd: 1.25, estimate: false },
      uncosted: false,
      reportedModel: "claude-sonnet-5",
    });
    const line = `normal review of ${h.head} by codex ${CODEX_DEFAULT}: 1 run(s), tokens 10 in, 2 out, 0 cache read, 0 cache creation, cost $0.2500`;
    expect(track.reason).toBe(line);
    expect(h.logs).toContain(`review step: ${line}`);
  });

  test("a follow-up pass: each pass's own line, and both passes' runs summed", async () => {
    const h = await harness({ behaviors: [reviewResult(), reviewResult()], specs: { [SPEC]: spec("done", true) } });
    const track = built();
    await h.run({ track });
    expect(track).toMatchObject({ sessions: 3, reviewSessions: 2, tokens: { input: 120, output: 24 }, cost: { usd: 1.5, estimate: false } });
    expect(track.reason).toBe(
      [
        `normal review of ${h.head} by codex ${CODEX_DEFAULT}: 1 run(s), tokens 10 in, 2 out, 0 cache read, 0 cache creation, cost $0.2500`,
        `followup review of ${h.head} by codex ${CODEX_DEFAULT}: 1 run(s), tokens 10 in, 2 out, 0 cache read, 0 cache creation, cost $0.2500`,
      ].join("; "),
    );
  });

  test("a same-vendor pass on a fresh track: the lane's model; a run with no cost makes the sum an estimate", async () => {
    const h = await harness({ adapters: ["claude"], behaviors: [reviewResult()], costs: [null] });
    const track = newTrack({ unit: U, startedMs: T0, logName: "story-3.4.log", state: "claimed" });
    await h.run({ track });
    expect(track).toMatchObject({ sessions: 1, reviewSessions: 1, tokens: { input: 10, output: 2 }, uncosted: true, cost: null, reportedModel: null });
    expect(track.reason).toBe(`normal review of ${h.head} by claude claude-sonnet-5: 1 run(s), tokens 10 in, 2 out, 0 cache read, 0 cache creation, no cost reported`);
    const billed = built();
    const g = await harness({ adapters: ["claude"], behaviors: [reviewResult()], costs: [null] });
    await g.run({ track: billed });
    expect(billed.cost).toEqual({ usd: 1, estimate: true });
  });

  test("a failed pass still adds its runs, with the model the reviewer reported", async () => {
    const h = await harness({ behaviors: [reviewResult()], models: ["gpt-other"] });
    const track = built();
    const out = await h.run({ track });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("model-mismatch");
    expect(track).toMatchObject({ sessions: 2, reviewSessions: 1, cost: { usd: 1.25, estimate: false }, reportedModel: "claude-sonnet-5" });
    expect(track.reason).toContain(`normal review of ${h.head} by codex ${CODEX_DEFAULT} (reported gpt-other): 1 run(s)`);
  });

  test("a pass with no run adds nothing", async () => {
    const h = await harness({ behaviors: [reviewResult()], sandboxRefuses: true });
    const track = built();
    const out = await h.run({ track });
    expect(out.outcome).toBe("failed");
    expect(track).toMatchObject({ sessions: 1, reviewSessions: 0, tokens: { input: 100, output: 20 }, cost: { usd: 1, estimate: false }, reason: null });
  });
});
