import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import { err, ok, type Result } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { BuildResult } from "../../src/core/schemas/session-result.ts";
import type { CiFix, CiSessionDone } from "../../src/lane/ci-step.ts";
import { createGitPassedGate, headPassedGate, type PassedGate } from "../../src/lane/passed-gate.ts";
import { createReviewGateStep, type LoopbackRequest, type ReviewGateDeps, type ReviewGateInput, type ReviewGateOutput } from "../../src/lane/review-gate.ts";
import type { ReviewRound, ReviewStep, ReviewStepInput, ReviewStepOutput } from "../../src/lane/review-step.ts";
import { Halt, MarkerStop, newTrack } from "../../src/lane/session.ts";
import { ALICE, rec, tip } from "../core/ledger/fixtures.ts";
import { cleanup, commit, setup } from "./git-fixture.ts";
import { BLOCKER, NIT, reviewPass, reviewSpec, reviewStub } from "./review-stub.ts";

// ------------------------------------------------------------------ world

const FORGE_NOW = "2026-10-25T10:00:00Z";
const T0 = Date.parse(FORGE_NOW);
const AUTHORITY = "docs/standing-authority.md";
const U = "story:3.5";
const BRANCH = "story/3.5";
const SPEC = "_bmad-output/implementation-artifacts/spec-3-5-the-review-gate.md";
const LANE: Lane = { repo: "xaravel/xarabot", role: "builder", owner: ALICE.owner, agent: "claude", effort: "high" };

function mainFiles(): Record<string, string> {
  return {
    ".xarabot/config.yaml": ["schema_version: 1", 'runner_version: "v1"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "bootstrapped_epics: [1]", "manifests:", "  dir: stories", ""].join("\n"),
    ".xarabot/policy.yaml": "schema_version: 1\nunattended_adapters: [claude, codex]\n",
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterEach(cleanup);

const DONE: BuildResult = { kind: "build", outcome: "done", summary: "Fixed it", body: "", verification: ["bun test"], denied_actions: [] };

type Harness = {
  readonly fake: FakeForge;
  readonly laneDir: string;
  readonly hostStop: string;
  readonly head: string;
  readonly sessions: LoopbackRequest[];
  readonly fixes: CiFix[];
  readonly logs: string[];
  run(over?: Partial<ReviewGateInput>, deps?: Partial<ReviewGateDeps>): Promise<ReviewGateOutput>;
  record(): Promise<UnitRecord>;
  /** Pushes a new head to the PR's branch and records it, as a pushed fix does. */
  moveHead(): Promise<string>;
};

type HarnessOpts = {
  readonly record?: Partial<UnitRecord>;
  /** The loopback session's results, in order; default a `done` result with a spec. */
  readonly sessions?: readonly (Result<CiSessionDone> | (() => never))[];
};

async function harness(o: HarnessOpts = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "xarabot-gate-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const fake = createFakeForge({ now: FORGE_NOW, main: mainFiles() });
  const signal = () => ({ signal: AbortSignal.timeout(5000) });
  let head = fake.control.makeCommit();
  const pushed = await fake.forge.pushBranch({ branch: BRANCH, expected_sha: null, sha: head }, signal());
  if (!pushed.ok) throw new Error(pushed.error.message);
  const opened = await fake.forge.openPr({ branch: BRANCH, base: "main", title: "Story 3.5", body: "b" }, signal());
  if (!opened.ok) throw new Error(opened.error.message);
  const snap = await fake.forge.snapshot(signal());
  if (!snap.ok) throw new Error(snap.error.message);
  const own = rec({
    unit: U,
    globs: ["src/**"],
    heartbeat_at: FORGE_NOW,
    pr: opened.value.number,
    pr_owner: ALICE.owner,
    base_sha: snap.value.main.sha,
    head_sha: head,
    builder_providers: ["anthropic"],
    ...o.record,
  });
  fake.control.writeForeignLedger({ message: "claims [skip ci]", writes: tip([own]), deletes: [] });

  const sessions: LoopbackRequest[] = [];
  const fixes: CiFix[] = [];
  const logs: string[] = [];
  const record = async (): Promise<UnitRecord> => {
    const s = await fake.forge.snapshot(signal());
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.units.get(U) as UnitRecord;
  };
  const deps = (over: Partial<ReviewGateDeps>): ReviewGateDeps => ({
    forge: fake.forge,
    identity: ALICE,
    repo: LANE.repo,
    review: async () => {
      throw new Error("no review expected");
    },
    passed: headPassedGate,
    secrets: ["sekrit-credential"],
    now: () => T0,
    sleep: async () => {},
    random: () => 0,
    ...over,
  });
  const h: Harness = {
    fake,
    laneDir,
    hostStop,
    get head() {
      return head;
    },
    sessions,
    fixes,
    logs,
    record,
    async moveHead() {
      const next = fake.control.makeCommit();
      const p = await fake.forge.pushBranch({ branch: BRANCH, expected_sha: head, sha: next }, signal());
      if (!p.ok) throw new Error(p.error.message);
      const r = await record();
      fake.control.writeForeignLedger({ message: "fix [skip ci]", writes: tip([{ ...r, head_sha: next }]), deletes: [] });
      head = next;
      return next;
    },
    async run(over = {}, d = {}) {
      const input: ReviewGateInput = {
        unit: { unit: U, subject: "Story 3.5" },
        storyId: "3.5",
        record: await record(),
        track: newTrack({ unit: U, startedMs: T0, logName: "story-3.5.log", state: "claimed" }),
        signal: new AbortController().signal,
        log: (text) => logs.push(text),
        needsSpec: true,
        session: async (req) => {
          const i = sessions.length;
          sessions.push(req);
          const r = o.sessions?.[i];
          if (typeof r === "function") return r();
          return r ?? ok({ result: DONE, specPath: SPEC, superseded: [] });
        },
        pushFix: async (fix) => {
          fixes.push(fix);
          return { outcome: "progress", state: "claimed", record: { ...fix.record, head_sha: "f".repeat(40) } };
        },
        ...over,
      };
      return createReviewGateStep(deps(d))(input);
    },
  };
  return h;
}

/** A stub review step: one round per call, in order, each blocking or not; it records `passed_sha` on a pass as the real one does. */
function stubReview(h: Harness, rounds: readonly (boolean | ReviewStepOutput | (() => never))[]): { review: ReviewStep; calls: ReviewStepInput[] } {
  const calls: ReviewStepInput[] = [];
  const review: ReviewStep = async (input) => {
    const i = calls.length;
    calls.push(input);
    const r = rounds[i];
    if (typeof r === "function") return r();
    if (typeof r === "object") return r;
    const blocking = r ?? false;
    const head = input.record.head_sha as string;
    let record = input.record;
    if (!blocking) {
      const cur = await h.record();
      record = { ...cur, passed_sha: head };
      h.fake.control.writeForeignLedger({ message: "passed [skip ci]", writes: tip([record]), deletes: [] });
    }
    const round: ReviewRound = { sha: head, blocking, crossVendor: true, adapter: "codex", passes: 1, findings: blocking ? [BLOCKER, NIT] : [NIT] };
    return { outcome: "progress", state: "claimed", record, review: round };
  };
  return { review, calls };
}

// ------------------------------------------------------------------ the gate

describe("createReviewGateStep (Story 3.5)", () => {
  test("a head equal to passed_sha passes with no review", async () => {
    const h = await harness();
    const r = await h.record();
    h.fake.control.writeForeignLedger({ message: "passed [skip ci]", writes: tip([{ ...r, passed_sha: r.head_sha }]), deletes: [] });
    const { review, calls } = stubReview(h, []);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(out.pushed).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(h.sessions).toHaveLength(0);
  });

  test("an unreviewed head with a clean round: progress claimed, passed_sha the head, no loopback", async () => {
    const h = await harness();
    const { review, calls } = stubReview(h, [false]);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(out.pushed).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ storyId: "3.5", unit: { unit: U } });
    expect(h.sessions).toHaveLength(0);
    expect(await h.record()).toMatchObject({ state: "claimed", loopbacks: 0, passed_sha: h.head });
  });

  test("a blocking round with loopbacks 0: loopbacks 1, a loopback session at the head with the findings text, the fix pushed", async () => {
    const h = await harness();
    const { review } = stubReview(h, [true]);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed", pushed: true });
    expect(await h.record()).toMatchObject({ state: "claimed", loopbacks: 1, ci_fixes: 0, passed_sha: null });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]?.start).toBe(h.head);
    expect(h.sessions[0]?.findingsText).toBe(
      `# Review findings for Story 3.5 at ${h.head}\n\n- high, blocking, \`src/a.ts\`: the loop never ends.\n- low, not blocking, \`src/b.ts\`: a name could be clearer.\n`,
    );
    expect(h.fixes).toHaveLength(1);
    expect(h.fixes[0]).toMatchObject({ result: DONE, specPath: SPEC, record: { loopbacks: 1 } });
    expect(out.record?.head_sha).toBe("f".repeat(40));
  });

  test("the findings text redacts the lane's secrets from the review's finding text", async () => {
    const h = await harness();
    const r = await h.record();
    const leaky: ReviewStep = async (input) => ({
      outcome: "progress",
      state: "claimed",
      record: r,
      review: {
        sha: input.record.head_sha as string,
        blocking: true,
        crossVendor: true,
        adapter: "codex",
        passes: 1,
        findings: [{ severity: "high", blocking: true, file: "src/a.ts", text: "the log prints sekrit-credential in full" }],
      },
    });
    const out = await h.run({}, { review: leaky });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed", pushed: true });
    expect(h.sessions[0]?.findingsText).not.toContain("sekrit-credential");
    expect(h.sessions[0]?.findingsText).toContain("- high, blocking, `src/a.ts`: the log prints ");
  });

  test.each([true, false])("after 2 loopbacks the next round (blocking %p) parks blocked review-cap in the owner's inbox; no session", async (blocking) => {
    const h = await harness({ record: { loopbacks: 2 } });
    const { review } = stubReview(h, [blocking]);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(await h.record()).toMatchObject({ state: "parked", loopbacks: 2, park: { kind: "blocked", reason: "review-cap", inbox_owner: ALICE.owner } });
    expect(h.sessions).toHaveLength(0);
    expect(h.fixes).toHaveLength(0);
  });

  test.each([
    ["blocked", { ...DONE, outcome: "blocked", blocked: { kind: "intent-gap", text: "unclear" } } as BuildResult, "intent-gap"],
    ["no-op", { ...DONE, outcome: "no-op" } as BuildResult, "no-op"],
  ] as const)("a %s loopback parks blocked %s; nothing pushed", async (_name, result, reason) => {
    const h = await harness({ sessions: [ok({ result, specPath: null, superseded: [] })] });
    const { review } = stubReview(h, [true]);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "progress", state: "parked" });
    expect(await h.record()).toMatchObject({ state: "parked", loopbacks: 1, park: { kind: "blocked", reason } });
    expect(h.fixes).toHaveLength(0);
  });

  test("a done loopback with no spec when a spec is needed is a failed attempt; with needsSpec false it is pushed", async () => {
    const h = await harness({ sessions: [ok({ result: DONE, specPath: null, superseded: [] })] });
    const { review } = stubReview(h, [true]);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("no spec file");
    expect(h.fixes).toHaveLength(0);

    const h2 = await harness({ sessions: [ok({ result: DONE, specPath: null, superseded: [] })] });
    const r2 = stubReview(h2, [true]);
    expect(await h2.run({ storyId: null, needsSpec: false }, { review: r2.review })).toMatchObject({ outcome: "progress", state: "claimed", pushed: true });
    expect(r2.calls[0]?.storyId).toBeNull();
  });

  test("a failed loopback session is a failed attempt", async () => {
    const h = await harness({ sessions: [err("session", "no result")] });
    const { review } = stubReview(h, [true]);
    const out = await h.run({}, { review });
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("loopback session session: no result");
  });

  test("a review ending other than progress claimed is passed through as it is", async () => {
    const h = await harness();
    const r = await h.record();
    const ended: ReviewStepOutput = { outcome: "stop", state: "claimed", record: r, reason: "no reviewer" };
    const { review } = stubReview(h, [ended]);
    expect(await h.run({}, { review })).toBe(ended);
    expect(h.sessions).toHaveLength(0);
  });

  test("a Halt from the review, or from the loopback session, reaches the caller", async () => {
    const h = await harness();
    const { review } = stubReview(h, [
      () => {
        throw new MarkerStop("stop", "STOP during a usage-limit sleep");
      },
    ]);
    await expect(h.run({}, { review })).rejects.toBeInstanceOf(MarkerStop);

    const h2 = await harness({
      sessions: [
        () => {
          throw new Halt("stop", "lane stop");
        },
      ],
    });
    const r2 = stubReview(h2, [true]);
    await expect(h2.run({}, { review: r2.review })).rejects.toBeInstanceOf(Halt);
  });

  test("a passed gate error is a failed attempt, with no review", async () => {
    const h = await harness();
    const { review, calls } = stubReview(h, [false]);
    const passed: PassedGate = async () => err("fetch", "offline");
    const out = await h.run({}, { review, passed });
    expect(out).toMatchObject({ outcome: "failed", state: "released" });
    expect(out.reason).toContain("passed gate fetch: offline");
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ with the real review step

describe("createReviewGateStep with createReviewStep (Story 3.5)", () => {
  /** The gate composed with the real review step, its checkout holding the Story's spec. */
  async function composed(results: readonly ((head: string) => string)[], files: () => Record<string, string>) {
    const h = await harness();
    const stub = reviewStub({ forge: h.fake.forge, laneDir: h.laneDir, hostStop: h.hostStop, lane: LANE, identity: ALICE, results, files, now: () => T0 });
    return { h, stub };
  }

  test("a flagged spec, both passes clean: two passes, then progress claimed with passed_sha the head", async () => {
    const { h, stub } = await composed([reviewPass([NIT]), reviewPass()], () => ({ [SPEC]: reviewSpec("done", true) }));
    const out = await h.run({}, { review: stub.review });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(out.pushed).toBeUndefined();
    expect(stub.prompts).toHaveLength(2);
    expect(stub.prompts[1]).toContain("# Follow-up review");
    expect(await h.record()).toMatchObject({ passed_sha: h.head, reviewed_sha: h.head, loopbacks: 0 });
    expect(h.sessions).toHaveLength(0);
  });

  test("a flagged spec, the follow-up blocking: a loopback; the next round on the new head runs both passes again", async () => {
    const { h, stub } = await composed([reviewPass(), reviewPass([BLOCKER]), reviewPass(), reviewPass()], () => ({ [SPEC]: reviewSpec("done", true) }));
    const first = await h.run({}, { review: stub.review });
    expect(first).toMatchObject({ outcome: "progress", state: "claimed", pushed: true });
    expect(stub.prompts).toHaveLength(2);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]?.findingsText).toContain("- high, blocking, `src/a.ts`: the loop never ends.");
    expect(await h.record()).toMatchObject({ loopbacks: 1, passed_sha: null });

    const next = await h.moveHead();
    const second = await h.run({}, { review: stub.review });
    expect(second).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(second.pushed).toBeUndefined();
    expect(stub.prompts).toHaveLength(4);
    expect(stub.prompts[3]).toContain("# Follow-up review");
    expect(await h.record()).toMatchObject({ loopbacks: 1, passed_sha: next });
  });

  test.each([
    ["an unflagged spec", "3.5", () => ({ [SPEC]: reviewSpec("done", false) })],
    ["no spec (a retro item)", null, () => ({})],
  ] as const)("%s: one pass", async (_name, storyId, files) => {
    const { h, stub } = await composed([reviewPass()], files);
    const out = await h.run({ storyId, needsSpec: storyId !== null }, { review: stub.review });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(stub.prompts).toHaveLength(1);
    expect(await h.record()).toMatchObject({ passed_sha: h.head });
  });
});

// ------------------------------------------------------------------ with the git passed gate

describe("createReviewGateStep with createGitPassedGate (Epic 3 retro item 4)", () => {
  /** `main` after ejection `i`: one file per ejection. */
  const mainAt = (i: number): Record<string, string> => {
    const out: Record<string, string> = { "src/a.ts": "a\n", "src/b.ts": "b\n" };
    for (let k = 1; k <= i; k += 1) out[`src/m${k}.ts`] = `m${k}\n`;
    return out;
  };
  /** The reviewed change merged with `main` after ejection `i`. */
  const mergedAt = (i: number): Record<string, string> => ({ ...mainAt(i), "src/a.ts": "a reviewed\n" });

  test.each([2, 3])("%p queue ejections in a row, each merging main in cleanly: no review at any head; a change smuggled into the next merge is reviewed", async (n) => {
    const repo = await setup();
    const base = await commit(repo.gitDir, mainAt(0));
    const reviewed = await commit(repo.gitDir, mergedAt(0), [base]);
    const h = await harness({ record: { head_sha: reviewed, passed_sha: reviewed } });
    // The step's fresh main is the fake forge's; the gate checks against runner.git's copy of it.
    let main = base;
    const git = createGitPassedGate({ gitDir: repo.gitDir, fetch: async () => err("fetch", "offline") });
    const passed: PassedGate = (r) => git({ ...r, mainSha: main });
    const setHead = async (sha: string): Promise<void> => {
      const r = await h.record();
      h.fake.control.writeForeignLedger({ message: "merge main [skip ci]", writes: tip([{ ...r, head_sha: sha }]), deletes: [] });
    };
    const { review, calls } = stubReview(h, [false]);

    let head = reviewed;
    for (let i = 1; i <= n; i += 1) {
      main = await commit(repo.gitDir, mainAt(i), [main]);
      head = await commit(repo.gitDir, mergedAt(i), [head, main]);
      await setHead(head);
      const out = await h.run({}, { review, passed });
      expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
      expect(out.pushed).toBeUndefined();
      expect(h.logs.some((l) => l.includes(`passed gate: ${head} passed (clean-merge): no review`))).toBe(true);
    }
    expect(calls).toHaveLength(0);
    expect(await h.record()).toMatchObject({ passed_sha: reviewed, loopbacks: 0 });

    main = await commit(repo.gitDir, mainAt(n + 1), [main]);
    const smuggled = await commit(repo.gitDir, { ...mergedAt(n + 1), "src/evil.ts": "x\n" }, [head, main]);
    await setHead(smuggled);
    const out = await h.run({}, { review, passed });
    expect(out).toMatchObject({ outcome: "progress", state: "claimed" });
    expect(calls).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("passed gate: unreviewed:") && l.includes("its tree differs"))).toBe(true);
  });
});
