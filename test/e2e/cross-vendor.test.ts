import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { loadRepoConfig } from "../../src/core/config/load-repo-config.ts";
import { storySpecGlob } from "../../src/core/config/story-spec-path.ts";
import { checkBuildSpec, specMatches } from "../../src/core/lane/build-check.ts";
import { ok } from "../../src/core/result.ts";
import { followupRecommended } from "../../src/core/review/review-spec.ts";
import { reviewComment } from "../../src/core/review/review-comment.ts";
import type { SessionAdapter } from "../../src/core/review/reviewer.ts";
import { CONFIG_DEFAULTS } from "../../src/core/schemas/config.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { LaneIdentity, UnitRecord } from "../../src/core/schemas/ledger.ts";
import { createCiStep } from "../../src/lane/ci-step.ts";
import type { Committer } from "../../src/lane/committer.ts";
import { CI_FIX_LOG, readsPath, runLaneProcess } from "../../src/lane/lane-process.ts";
import { createFsLaneStore, laneLayout } from "../../src/lane/lane-store.ts";
import { createMergeStep } from "../../src/lane/merge-step.ts";
import type { Merger } from "../../src/lane/merger.ts";
import { headPassedGate } from "../../src/lane/passed-gate.ts";
import { createPrStep } from "../../src/lane/pr-step.ts";
import { createReviewGateStep } from "../../src/lane/review-gate.ts";
import type { Workspace } from "../../src/lane/workspace.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import type { Forge, GitSha } from "../../src/ports/forge.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";
import { rec, tip } from "../core/ledger/fixtures.ts";
import { unchangedGraph } from "../lane/graph-stub.ts";
import { reviewStub } from "../lane/review-stub.ts";
import { canSandbox } from "../support/sandbox.ts";
import { liveGithubEnabled } from "../support/live-github.ts";
import {
  caseProblems,
  checkReviewGate,
  cloneProblems,
  copyVendorCredentials,
  injectLaterChange,
  laterChangeState,
  must,
  observe,
  readIn,
  reviewHead,
  reviewPassed,
  runLiveLane,
  step,
  verifiedLine,
  verifyLogText,
  VERIFY_CHECK,
  withOverlay,
  XV_BRANCH,
  XV_CASE_TIMEOUT_MS,
  XV_CASES,
  XV_LANE,
  XV_UNIT,
  xvKey,
  xvOverlay,
  type LiveRun,
  type XvCase,
  type XvEvent,
  type XvObserved,
} from "./cross-vendor-harness.ts";
import { storyFor } from "./race-harness.ts";
import { SEED_AGENTS, SEED_AGENTS_PATH, SEED_SKILL, SEED_SKILL_PATHS, scratchSeed, XV_STORY, xvSkillFiles, xvSpecPath, xvSpecText, xvVerifyPath, xvVerifyText } from "./scratch-seed.ts";

/**
 * Cross-vendor verification (Story 3.6, FR7, FR8). Non-live: the stand-in
 * skill's output, the overlay through `loadRepoConfig` and `next`, the
 * review gate's invariant, the review line parse and `caseProblems`, the
 * observer and the later-change injector on the fake forge, and the four
 * cases rehearsed on the fake forge through the real `runLaneProcess` with
 * the real PR, CI, review-gate and merge steps. Live (`XARABOT_LIVE=1` with
 * `XARABOT_LIVE_GITHUB_REPO` and `XARABOT_LIVE_GITHUB_LOGIN`, on the host,
 * outside any sandbox): the same four cases through the real `laneRun` with
 * the real `claude` and `codex` CLIs on the scratch repo.
 */

const ROOT = join(import.meta.dir, "..", "..");
const REPO = "acme/scratch";
const LOGIN = "alice";
const HOST = "33333333-3333-4333-8333-333333333333";
const IDENTITY: LaneIdentity = { owner: LOGIN, host: HOST, lane: XV_LANE };
const FAKE_NOW = "2026-10-25T10:00:00Z";
const T0 = Date.parse(FAKE_NOW);
/** The golden key of the spec's Design Notes. */
const GOLDEN_KEY = "1-6-xv-claude-0a1b2c3d";
const opts = () => ({ signal: AbortSignal.timeout(5000) });
const CASES: readonly XvCase[] = Object.values(XV_CASES);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeIn(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fakeScratch(): FakeForge {
  return createFakeForge({ now: FAKE_NOW, main: scratchSeed({ repo: REPO, login: LOGIN }) });
}

// ------------------------------------------------------------ the stand-in skill

describe("the stand-in skill", () => {
  test("the seed holds it at both skill paths, one text, and an AGENTS.md", () => {
    const seed = scratchSeed({ repo: REPO, login: LOGIN });
    for (const p of SEED_SKILL_PATHS) expect(seed[p]).toBe(SEED_SKILL);
    expect(seed[SEED_AGENTS_PATH]).toBe(SEED_AGENTS);
    expect(SEED_SKILL.startsWith("---\nname: bmad-build-auto\ndescription: ")).toBe(true);
  });

  test("its golden result for the sample key: the verify file and a done spec the build check takes", () => {
    const files = xvSkillFiles(GOLDEN_KEY);
    expect(Object.keys(files).sort()).toEqual(["_bmad-output/implementation-artifacts/spec-1-6-verify.md", "verify/1-6-xv-claude-0a1b2c3d.md"]);
    expect(files["verify/1-6-xv-claude-0a1b2c3d.md"]).toBe("Built for 1-6-xv-claude-0a1b2c3d.\n");
    const glob = storySpecGlob(CONFIG_DEFAULTS.story_spec_path, XV_STORY.id);
    if (!glob.ok) throw new Error(glob.error.message);
    expect(specMatches(glob.value, Object.keys(files).sort())).toEqual([xvSpecPath("1", "6")]);
    const spec = files[xvSpecPath("1", "6")] as string;
    const checked = checkBuildSpec("done", spec);
    expect(checked.ok ? checked.value.status : checked.error.message).toBe("done");
    expect(followupRecommended(spec)).toBe(false);
    expect(spec).toContain("followup_review_recommended: false");
  });

  test("the skill text spells out exactly what it writes", () => {
    for (const line of xvSpecText("<e>", "<s>", "<key>").split("\n")) {
      if (line !== "") expect(SEED_SKILL).toContain(`\n   ${line}\n`);
    }
    expect(SEED_SKILL).toContain(`\n   ${xvVerifyText("<key>")}`);
    expect(SEED_SKILL).toContain("`verify/<key>.md`");
    expect(SEED_SKILL).toContain(`\`${xvSpecPath("<e>", "<s>")}\``);
    expect(SEED_SKILL).toContain("Build Story <e>.<s> (`<key>`)");
    expect(SEED_SKILL).toContain("Halt `done`.");
  });

  test("a key that is not <e>-<s>-<slug> is refused", () => {
    expect(() => xvSkillFiles("canary")).toThrow();
    expect(() => xvSkillFiles("1-6-Bad")).toThrow();
  });
});

// ------------------------------------------------------------ the overlay

describe("the overlay", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s: the overlaid main loads and next picks story:1.6 with the case's policy", async (_name, c) => {
    const key = xvKey(c.name);
    expect(key).toMatch(new RegExp(`^1-6-xv-${c.name}-[0-9a-f]{8}$`));
    const fake = fakeScratch();
    const forge = withOverlay(fake.forge, xvOverlay(key, c.adapters));
    const snap = must(await forge.snapshot({ ...opts(), read: readsPath }), "snapshot");
    const repo = loadRepoConfig({ repo: REPO, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
    if (!repo.ok) throw new Error(`${repo.error.kind}: ${repo.error.message}`);
    expect(repo.value.repo.policy.unattended_adapters).toEqual([...c.adapters]);
    expect(repo.value.repo.policy.expected_checks).toEqual([]);
    expect(snap.main.tree.filter((p) => p.startsWith("stories/"))).toEqual([`stories/${XV_STORY.id}.md`]);
    const story = storyFor({ repo: REPO, snap, identity: IDENTITY });
    expect([story.unit, story.sprint_key, story.globs]).toEqual([XV_UNIT, key, [XV_STORY.glob]]);
  });
});

// ------------------------------------------------------------ the gate, the review line and caseProblems

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);

function body(o: { sha: string; adapter?: SessionAdapter; cross?: boolean; blocking?: boolean; subject?: string }): string {
  return reviewComment({
    subject: o.subject ?? "Story 1.6",
    sha: o.sha,
    crossVendor: o.cross ?? true,
    adapter: o.adapter ?? "codex",
    model: "gpt-6.1-sol",
    pass: "normal",
    result: {
      verdict: o.blocking === true ? "changes-requested" : "pass",
      findings: o.blocking === true ? [{ severity: "high", blocking: true, file: "verify/x.md", text: "wrong." }] : [],
      denied_actions: [],
    },
  });
}
const push = (sha: string): XvEvent => ({ kind: "push", branch: XV_BRANCH, sha });
const review = (sha: string, o: Partial<Parameters<typeof body>[0]> = {}): XvEvent => ({ kind: "review", pr: 7, commit_sha: sha, body: body({ sha, ...o }) });
const enqueue = (head: string, held = false): XvEvent => ({ kind: "enqueue", pr: 7, head, held });

describe("checkReviewGate", () => {
  test.each([
    ["review then enqueue", [push(H1), review(H1), enqueue(H1)], []],
    ["a held enqueue, a fix, a re-review and its enqueue", [push(H1), review(H1), enqueue(H1, true), push(H2), review(H2), enqueue(H2)], []],
    ["a blocking review, a loopback push and a passing review", [push(H1), review(H1, { blocking: true }), push(H2), review(H2), enqueue(H2)], []],
    ["a push of the same SHA between them", [push(H1), review(H1), push(H1), enqueue(H1)], []],
    ["an enqueue with no review", [push(H1), enqueue(H1)], ["no review was posted at that SHA"]],
    ["an enqueue after a blocking review", [push(H1), review(H1, { blocking: true }), enqueue(H1)], ["not a pass"]],
    ["a review at another SHA", [push(H1), review(H1), push(H2), enqueue(H2)], ["no review was posted at that SHA"]],
    ["a push between the review and the enqueue", [push(H1), review(H1), push(H2), push(H1), enqueue(H1)], [`a push of ${H2}`]],
    ["a review of another PR", [push(H1), { ...review(H1), pr: 8 } as XvEvent, enqueue(H1)], ["no review was posted at that SHA"]],
    ["a review posted after the enqueue", [push(H1), enqueue(H1), review(H1)], ["no review was posted at that SHA"]],
    ["a pass, then a blocking review at the same SHA, then the enqueue", [push(H1), review(H1), review(H1, { blocking: true }), enqueue(H1)], ["not a pass"]],
    ["a blocking review, then a pass at the same SHA, then the enqueue", [push(H1), review(H1, { blocking: true }), review(H1), enqueue(H1)], []],
    ["a held enqueue with no review", [push(H1), enqueue(H1, true)], ["(held): no review was posted at that SHA"]],
  ] as const)("%s", (_name, events, fragments) => {
    const v = checkReviewGate(events);
    expect(v.length).toBe(fragments.length);
    fragments.forEach((f, i) => expect(v[i]).toContain(f));
  });
});

describe("reviewHead", () => {
  test("parses reviewComment's first line", () => {
    expect(reviewHead(body({ sha: H1 }))).toEqual({ subject: "Story 1.6", vendor: "cross-vendor", pass: "review", adapter: "codex", model: "gpt-6.1-sol", sha: H1 });
    expect(reviewHead(body({ sha: H2, adapter: "claude", cross: false }))?.vendor).toBe("same-vendor");
    expect(reviewPassed(body({ sha: H1 }))).toBe(true);
    expect(reviewPassed(body({ sha: H1, blocking: true }))).toBe(false);
  });

  test.each([
    ["no robot", `Story 1.6: cross-vendor review by codex (m) of ${H1}.`],
    ["a short SHA", "🤖 Story 1.6: cross-vendor review by codex (m) of 1111111."],
    ["another vendor word", `🤖 Story 1.6: other-vendor review by codex (m) of ${H1}.`],
    ["no final dot", `🤖 Story 1.6: cross-vendor review by codex (m) of ${H1}`],
    ["empty", ""],
  ] as const)("%s is not a review line", (_name, text) => {
    expect(reviewHead(text)).toBeNull();
  });
});

/** A good observed run of `c`: what the rehearsals and the live cases must show. */
function goodRun(c: XvCase): XvObserved {
  const head = c.laterChange ? H2 : H1;
  const record = rec({
    unit: XV_UNIT,
    state: "merged",
    globs: [XV_STORY.glob],
    pr: 7,
    head_sha: head,
    reviewed_sha: head,
    passed_sha: head,
    enqueued_sha: head,
    builder_providers: [c.provider],
    attempts: c.laterChange ? 1 : 0,
    ci_fixes: c.laterChange ? 1 : 0,
  });
  const r = (sha: string): XvEvent => review(sha, { adapter: c.reviewer, cross: c.crossVendor });
  const events = c.laterChange ? [push(H1), r(H1), enqueue(H1, true), push(H2), r(H2), enqueue(H2)] : [push(H1), r(H1), enqueue(H1)];
  return {
    code: 0,
    outcome: "progress\n",
    ledger: tip([record]),
    events,
    journal: `${JSON.stringify({ type: "unit", unit: XV_UNIT, result: "done", state: "merged" })}\n`,
  };
}

function withRecord(o: XvObserved, over: Partial<UnitRecord>): XvObserved {
  const parsed = JSON.parse(o.ledger["units/story__1.6.json"] as string) as UnitRecord;
  return { ...o, ledger: tip([rec({ ...parsed, ...over })]) };
}

describe("caseProblems", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s: a good run has no problem", (_name, c) => {
    expect(caseProblems(c, goodRun(c))).toEqual([]);
  });

  const claude = XV_CASES.claude;
  const later = XV_CASES["later-change"];
  test.each([
    ["a non-zero exit", claude, (o: XvObserved) => ({ ...o, code: 1 }), "laneRun exited 1"],
    ["an outcome other than progress", claude, (o: XvObserved) => ({ ...o, outcome: "failed\n" }), "the outcome is"],
    ["not merged", claude, (o: XvObserved) => withRecord(o, { state: "merging" }), "is merging, not merged"],
    ["another unit in the ledger", claude, (o: XvObserved) => ({ ...o, ledger: { ...o.ledger, ...tip([rec({ unit: "story:1.1" })]) } }), "not only story:1.6"],
    ["the builder's vendor missing", XV_CASES.codex, (o: XvObserved) => withRecord(o, { builder_providers: ["anthropic"] }), "does not name openai"],
    ["passed_sha not the head", claude, (o: XvObserved) => withRecord(o, { passed_sha: H3 }), "passed_sha"],
    ["enqueued_sha not the head", claude, (o: XvObserved) => withRecord(o, { enqueued_sha: H3 }), "enqueued_sha"],
    ["the wrong vendor word", claude, (o: XvObserved) => ({ ...o, events: [push(H1), review(H1, { cross: false }), enqueue(H1)] }), "same-vendor, not cross-vendor"],
    ["the wrong adapter", claude, (o: XvObserved) => ({ ...o, events: [push(H1), review(H1, { adapter: "claude" }), enqueue(H1)] }), "by claude, not codex"],
    ["another subject", claude, (o: XvObserved) => ({ ...o, events: [push(H1), review(H1, { subject: "Story 1.1" }), enqueue(H1)] }), 'names "Story 1.1"'],
    [
      "a review line naming another SHA",
      claude,
      (o: XvObserved) => ({ ...o, events: [push(H1), { kind: "review", pr: 7, commit_sha: H1, body: body({ sha: H3 }) } as XvEvent, review(H1), enqueue(H1)] }),
      `names ${H3} but was posted on ${H1}`,
    ],
    ["no review at the merged head", claude, (o: XvObserved) => ({ ...o, events: [push(H1), enqueue(H1)] }), "no passing review was posted at the merged head"],
    ["a gate violation", claude, (o: XvObserved) => ({ ...o, events: [push(H1), review(H1), push(H3), enqueue(H1)] }), "review gate:"],
    ["no forwarded enqueue", claude, (o: XvObserved) => ({ ...o, events: [push(H1), review(H1)] }), "no enqueue was forwarded"],
    ["an enqueue at another head", claude, (o: XvObserved) => ({ ...o, events: [push(H3), review(H3), enqueue(H3), push(H1), review(H1), enqueue(H1)] }), `forwarded at ${H3}`],
    ["a journal line that is not done, merged", claude, (o: XvObserved) => ({ ...o, journal: `${JSON.stringify({ type: "unit", unit: XV_UNIT, result: "done", state: "parked" })}\n` }), "not done, merged"],
    ["no journal line", claude, (o: XvObserved) => ({ ...o, journal: null }), "0 unit lines"],
    ["a held enqueue in a case with no later change", claude, (o: XvObserved) => ({ ...o, events: [push(H1), review(H1), enqueue(H1, true), enqueue(H1)] }), "held in a case with no later change"],
    ["case 3 without a held enqueue", later, (o: XvObserved) => ({ ...o, events: [push(H2), review(H2), enqueue(H2)] }), "0 held enqueues"],
    [
      "case 3 without a re-review",
      later,
      (o: XvObserved) => ({ ...o, events: [push(H1), review(H1), enqueue(H1, true), review(H2), push(H2), enqueue(H2)] }),
      "no passing re-review",
    ],
    ["case 3 merged at the held head", later, (o: XvObserved) => withRecord({ ...o, events: [push(H1), review(H1), enqueue(H1, true), enqueue(H1)] }, { head_sha: H1, passed_sha: H1, enqueued_sha: H1 }), "no later change was made"],
    ["case 3 with no CI fix", later, (o: XvObserved) => withRecord(o, { ci_fixes: 0 }), "ci_fixes is 0"],
    ["case 3 with no attempt", later, (o: XvObserved) => withRecord(o, { attempts: 0 }), "attempts is 0"],
    ["case 3 with no push of the merged head after the hold", later, (o: XvObserved) => ({ ...o, events: [push(H2), review(H1), enqueue(H1, true), review(H2), enqueue(H2)] }), "no push of the merged head"],
  ] as const)("%s", (_name, c, mutate, fragment) => {
    const problems = caseProblems(c, mutate(goodRun(c)));
    expect(problems.join("\n")).toContain(fragment);
  });
});

describe("cloneProblems", () => {
  const key = GOLDEN_KEY;
  const good = xvSkillFiles(key);
  const verify = xvVerifyPath(key);
  const spec = xvSpecPath("1", "6");
  test.each([
    ["the stand-in skill's files", good, []],
    ["a CI fix's added line after the first", { ...good, [verify]: `${good[verify]}${verifiedLine(key)}\n` }, []],
    ["no verify file", { [spec]: good[spec] as string }, [`the clone has no ${verify}`]],
    ["a verify file with another first line", { ...good, [verify]: "Built for another key.\n" }, [`${verify} does not start with`]],
    ["no spec", { [verify]: good[verify] as string }, [`the clone has no ${spec}`]],
    ["a spec an earlier run left", { ...good, [spec]: xvSpecText("1", "6", "1-6-xv-claude-ffffffff") }, [`${spec} does not name ${key}`]],
  ] as const)("%s", (_name, files, fragments) => {
    const problems = cloneProblems(key, (p) => (files as Readonly<Record<string, string>>)[p] ?? null);
    expect(problems.length).toBe(fragments.length);
    fragments.forEach((f, i) => expect(problems[i]).toContain(f));
  });
});

// ------------------------------------------------------------ the observer and the injector

/** The fake forge with one open PR on the Story branch at `head`; its number. */
async function openPr(fake: FakeForge, forge: Forge, head: GitSha): Promise<number> {
  must(await forge.pushBranch({ branch: XV_BRANCH, expected_sha: null, sha: head }, opts()), "pushBranch");
  return must(await fake.forge.openPr({ branch: XV_BRANCH, base: "main", title: "t", body: "b" }, opts()), "openPr").number;
}

describe("observe", () => {
  test("records pushes, posted reviews and enqueues in order, and forwards every call", async () => {
    const fake = fakeScratch();
    const events: XvEvent[] = [];
    const forge = observe(fake.forge, events);
    const head = fake.control.makeCommit();
    const pr = await openPr(fake, forge, head);
    must(await forge.postReview(pr, { commit_sha: head, body: "🤖 a review" }, opts()), "postReview");
    must(await forge.enqueue(pr, head, opts()), "enqueue");
    const failed = await forge.enqueue(pr, fake.control.makeCommit(), opts());
    expect(failed.ok).toBe(false);
    expect(events).toEqual([
      { kind: "push", branch: XV_BRANCH, sha: head },
      { kind: "review", pr, commit_sha: head, body: "🤖 a review" },
      { kind: "enqueue", pr, head, held: false },
    ]);
    expect(fake.control.queue()).toEqual([pr]);
    expect(fake.control.reviewBodies(pr)).toEqual(["🤖 a review"]);
  });
});

describe("injectLaterChange", () => {
  test("holds the first enqueue and the dequeue after it; fails xarabot-verify on the held head only after the hold; writes the log in the asked dir", async () => {
    const fake = fakeScratch();
    const key = xvKey("later-change");
    const state = laterChangeState();
    const events: XvEvent[] = [];
    const forge = observe(injectLaterChange(fake.forge, key, state), events);
    const h1 = fake.control.makeCommit();
    const other = fake.control.makeCommit();
    const pass = [{ name: "check", status: "completed" as const, conclusion: "success" }];
    fake.control.setChecks(h1, pass);
    fake.control.setChecks(other, pass);
    const pr = await openPr(fake, forge, h1);

    // Before the hold: checks and prefetch pass through.
    expect(must(await forge.checks(h1, opts()), "checks").checks).toEqual(pass);
    const before = tempDir("xarabot-xv-inject-");
    expect(must(await forge.prefetch({ kind: "ci-log", sha: h1, dir: join(before, "logs") }, opts()), "prefetch").files).toEqual([]);

    // The hold: not forwarded, so the real queue read sees the PR ejected.
    expect(must(await forge.enqueue(pr, h1, opts()), "enqueue")).toEqual({ queued: true });
    expect(state.held).toEqual({ pr, head: h1 });
    expect(fake.control.queue()).toEqual([]);
    expect(must(await forge.queueState(pr, opts()), "queueState")).toEqual({ state: "open", head_sha: h1, queued: false });
    expect(must(await forge.dequeue(pr, opts()), "dequeue")).toEqual({ queued: false });
    expect(state.dequeued).toBe(true);

    // After it: a failing xarabot-verify on the held head only, and its log.
    expect(must(await forge.checks(h1, opts()), "checks").checks).toEqual([...pass, { name: VERIFY_CHECK, status: "completed", conclusion: "failure" }]);
    expect(must(await forge.checks(other, opts()), "checks").checks).toEqual(pass);
    const dir = join(tempDir("xarabot-xv-inject-"), "ci-log-x");
    const files = must(await forge.prefetch({ kind: "ci-log", sha: h1, dir }, opts()), "prefetch").files;
    expect(files).toEqual([join(dir, `${VERIFY_CHECK}.log`)]);
    expect(readFileSync(join(dir, `${VERIFY_CHECK}.log`), "utf8")).toBe(verifyLogText(key));
    expect(verifyLogText(key)).toContain(xvVerifyPath(key));
    expect(verifyLogText(key)).toContain(verifiedLine(key));
    const otherDir = join(tempDir("xarabot-xv-inject-"), "other");
    expect(must(await forge.prefetch({ kind: "ci-log", sha: other, dir: otherDir }, opts()), "prefetch").files).toEqual([]);

    // Later calls are forwarded: the second enqueue queues the PR, a later dequeue takes it out.
    expect(must(await forge.enqueue(pr, h1, opts()), "enqueue")).toEqual({ queued: true });
    expect(fake.control.queue()).toEqual([pr]);
    must(await forge.dequeue(pr, opts()), "dequeue");
    expect(fake.control.queue()).toEqual([]);
    expect(events.filter((e) => e.kind === "enqueue")).toEqual([
      { kind: "enqueue", pr, head: h1, held: true },
      { kind: "enqueue", pr, head: h1, held: false },
    ]);
  });
});

// ------------------------------------------------------------ rehearsals

/** The fake CI: each SHA pushed gets a completed, passing `check`, as the scratch repo's workflow gives it. */
function fakeCi(fake: FakeForge): Forge {
  return {
    ...fake.forge,
    pushBranch: async (lease, o) => {
      const r = await fake.forge.pushBranch(lease, o);
      if (r.ok) fake.control.setChecks(r.value.sha, [{ name: "check", status: "completed", conclusion: "success" }]);
      return r;
    },
  };
}

const MODELS: Readonly<Record<SessionAdapter, string>> = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol" };

/** A stub builder agent of `adapter`: it reports its default model and no usage limit. */
function stubAgent(adapter: SessionAdapter): Agent {
  return {
    vendor: adapter,
    defaultModel: MODELS[adapter],
    minVersion: "1.0.0",
    launchSpec: (unit, settings, resultPath) =>
      ok({
        argv: [`stub-${adapter}`, settings.effort, resultPath],
        stdin: unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`,
        vendor: adapter,
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
      } as AgentLaunchSpec),
    parseUsage: () => ({ sessionId: null, model: MODELS[adapter], tokens: null, cost: null, usageLimit: null }),
    checkModel: (usage, configured) => (usage.model === configured ? ok(configured) : { ok: false, error: { kind: "model-mismatch", message: `ran ${usage.model ?? "none"}` } }),
    effortValues: () => ["low", "medium", "high"],
    startCheck: () => ok({ model: MODELS[adapter], version: "1.0.0" }),
  };
}

type Rehearsal = {
  readonly key: string;
  readonly fake: FakeForge;
  readonly observed: XvObserved;
  readonly record: UnitRecord | null;
  /** Each builder session's prompt, in order. */
  readonly prompts: readonly string[];
  /** For each builder session, whether its temp folder held a CI log asking for the verified line. */
  readonly asked: readonly boolean[];
  /** Each review pass's prompt, in order. */
  readonly reviewPrompts: readonly string[];
  /** The lane's clone after the run. */
  readonly clone: string;
};

/**
 * One case on the fake forge: the real `runLaneProcess` with the real PR,
 * CI, review-gate and merge steps, over the case's overlay, the observer and
 * (case 3) the injector; a stub builder of the case's adapter whose sandbox
 * writes what the stand-in skill writes (and, in a CI fix, the line its log
 * asks for); `reviewStub` as the reviewer; a fake clock; and the fake queue
 * merging the enqueued head at the merge step's sleep.
 */
async function rehearse(c: XvCase): Promise<Rehearsal> {
  const root = tempDir(`xarabot-xv-rehearsal-${c.name}-`);
  const laneDir = join(root, "lanes", XV_LANE);
  const hostStop = join(root, "home", ".xarabot", "STOP");
  const key = xvKey(c.name);
  const fake = fakeScratch();
  const events: XvEvent[] = [];
  const overlaid = withOverlay(fakeCi(fake), xvOverlay(key, c.adapters));
  const forge = observe(c.laterChange ? injectLaterChange(overlaid, key, laterChangeState()) : overlaid, events);
  const lane: Lane = { repo: REPO, role: "builder", owner: LOGIN, agent: c.agent, effort: "low" };
  const skill = xvSkillFiles(key);

  const prompts: string[] = [];
  const asked: boolean[] = [];
  const sandbox: Sandbox = {
    async run(spec, profile) {
      const prompt = spec.stdin ?? "";
      prompts.push(prompt);
      // The clone is the head's in a fix (the workspace stub starts it empty): the skill's files, plus the line a CI log asks for.
      const files: Record<string, string> = { ...skill };
      const log = join(profile.tempDir, CI_FIX_LOG);
      const asks = existsSync(log) && readFileSync(log, "utf8").includes(verifiedLine(key));
      asked.push(asks);
      if (asks) files[xvVerifyPath(key)] += `${verifiedLine(key)}\n`;
      for (const [path, text] of Object.entries(files)) writeIn(profile.clone, path, text);
      writeFileSync(profile.resultPath, JSON.stringify({ kind: "build", outcome: "done", summary: `Build ${key}`, body: "", verification: ["none"], denied_actions: [] }));
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };
  const workspace: Workspace = {
    async prepare(p) {
      const clone = laneLayout(laneDir).clone;
      rmSync(clone, { recursive: true, force: true });
      writeIn(clone, "README.md", "scratch\n");
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
  const stub = reviewStub({ forge, laneDir, hostStop, lane, identity: IDENTITY, results: [], files: () => skill, now });
  const r = await runLaneProcess({
    forge,
    agent: stubAgent(c.agent),
    sandbox,
    store: createFsLaneStore({ laneDir, hostStop }),
    workspace,
    prStep: createPrStep({ forge, committer, identity: IDENTITY, repo: REPO, provider: c.provider, sleep: async () => {}, random: () => 0 }),
    ciStep: createCiStep({ forge, merger, identity: IDENTITY, repo: REPO, now, sleep, random: () => 0 }),
    reviewGate: createReviewGateStep({ forge, identity: IDENTITY, repo: REPO, review: stub.review, passed: headPassedGate, now, sleep: async () => {}, random: () => 0 }),
    mergeStep: createMergeStep({
      forge,
      diffPaths: async () => ok(Object.keys(skill).sort()),
      graphTrees: unchangedGraph(),
      identity: IDENTITY,
      repo: REPO,
      agent: c.agent,
      passed: headPassedGate,
      now,
      sleep: async (ms) => {
        t += ms;
        fake.control.mergeQueueHead();
      },
      random: () => 0,
    }),
    laneDir,
    identity: IDENTITY,
    lane,
    pid: 12345,
    now,
    sleep: async () => {},
    random: () => 0,
    waiter: { wait: async () => ({ end: "elapsed" as const }) },
  });
  const layout = laneLayout(laneDir);
  const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const snap = must(await fake.forge.snapshot(opts()), "snapshot");
  const observed: XvObserved = { code: r.laneStop === undefined ? 0 : 1, outcome: read(layout.outcome), ledger: snap.ledger.files, events, journal: read(layout.journal) };
  const record = observed.ledger["units/story__1.6.json"] === undefined ? null : (JSON.parse(observed.ledger["units/story__1.6.json"]) as UnitRecord);
  return { key, fake, observed, record, prompts, asked, reviewPrompts: stub.prompts, clone: layout.clone };
}

describe("rehearsals on the fake forge", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s: the case shows what it must, merged at the reviewed head", async (_name, c) => {
    const run = await rehearse(c);
    expect(caseProblems(c, run.observed)).toEqual([]);
    expect(cloneProblems(run.key, readIn(run.clone))).toEqual([]);
    const record = run.record as UnitRecord;
    const prs = must(await run.fake.forge.listPrsByBranch(XV_BRANCH, opts()), "listPrsByBranch");
    expect(prs.map((p) => [p.number, p.state, p.head_sha])).toEqual([[record.pr as number, "merged", record.head_sha as string]]);
    const head = reviewHead(run.fake.control.reviewBodies(record.pr as number).at(-1) ?? "");
    expect([head?.vendor, head?.adapter, head?.sha]).toEqual([c.crossVendor ? "cross-vendor" : "same-vendor", c.reviewer, record.head_sha as string]);
    expect(run.prompts[0]).toContain(`Build Story ${XV_STORY.id} (\`${run.key}\`)`);
    if (c.laterChange) {
      expect(run.prompts.length).toBe(2);
      expect(run.prompts[1]).toContain(`Repair Story ${XV_STORY.id}`);
      expect(run.asked).toEqual([false, true]);
      expect(run.reviewPrompts.length).toBe(2);
    } else {
      expect(run.prompts.length).toBe(1);
      expect(run.asked).toEqual([false]);
      expect(run.reviewPrompts.length).toBe(1);
    }
  });
});

// ------------------------------------------------------------ copying the vendor credentials

describe("copyVendorCredentials", () => {
  test("copies each vendor's regular files, mode 600; a missing vendor throws naming it", () => {
    const root = tempDir("xarabot-xv-creds-");
    const from = join(root, "from");
    writeIn(from, "xarabot/vendors/claude/oauth-token", "sk-ant-oat-x\n");
    writeIn(from, "xarabot/vendors/codex/auth.json", "{}\n");
    const copied = copyVendorCredentials(from, join(root, "to"));
    expect(copied).toEqual([join(root, "to/xarabot/vendors/claude/oauth-token"), join(root, "to/xarabot/vendors/codex/auth.json")]);
    for (const p of copied) expect(lstatSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "to/xarabot/vendors/codex/auth.json"), "utf8")).toBe("{}\n");
    rmSync(join(from, "xarabot/vendors/codex"), { recursive: true });
    expect(() => copyVendorCredentials(from, join(root, "to2"))).toThrow("no codex credential");
  });

  test.each([
    ["an empty vendor folder", (dir: string) => mkdirSync(dir, { recursive: true })],
    [
      "a vendor folder holding only a symlink",
      (dir: string) => {
        mkdirSync(dir, { recursive: true });
        symlinkSync(join(dirname(dir), "claude", "oauth-token"), join(dir, "auth.json"));
      },
    ],
  ] as const)("%s throws that it holds no file", (_name, make) => {
    const root = tempDir("xarabot-xv-creds-");
    const from = join(root, "from");
    writeIn(from, "xarabot/vendors/claude/oauth-token", "sk-ant-oat-x\n");
    make(join(from, "xarabot/vendors/codex"));
    expect(() => copyVendorCredentials(from, join(root, "to"))).toThrow(/no codex credential: .* holds no file/);
  });
});

// ------------------------------------------------------------ skip reporting

/** Every live case's name starts with this; nothing else in this file does, so `-t` picks them alone. */
const LIVE_PREFIX = "live cross-vendor:";

describe("live switch", () => {
  const nested = (extra: Record<string, string>, unset: readonly string[]): { code: number; output: string } => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !unset.includes(k)) env[k] = v;
    Object.assign(env, extra);
    const r = Bun.spawnSync([process.execPath, "test", "test/e2e/cross-vendor.test.ts", "-t", `^${LIVE_PREFIX}`], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    return { code: r.exitCode ?? -1, output: r.stdout.toString() + r.stderr.toString() };
  };
  const SCRATCH = { XARABOT_LIVE_GITHUB_REPO: "acme/scratch", XARABOT_LIVE_GITHUB_LOGIN: "alice" };

  test("XARABOT_LIVE unset: every live case reports skipped", () => {
    const r = nested(SCRATCH, ["XARABOT_LIVE"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b4 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  });

  test("XARABOT_LIVE=1 inside a sandbox (XARABOT_SANDBOXED=1): every live case reports skipped", () => {
    const r = nested({ ...SCRATCH, XARABOT_LIVE: "1", XARABOT_SANDBOXED: "1" }, []);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b4 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  });
});

// ------------------------------------------------------------ live

const liveCase = test.skipIf(!canSandbox || !liveGithubEnabled) as typeof test;

/** The GitHub reads every live case makes after its run: the PR merged at the head, and a commented review at it. */
async function githubShowsMergedAndReviewed(run: LiveRun): Promise<void> {
  const record = run.record;
  if (record === null || record.pr === null || record.head_sha === null) throw new Error(`step "the record": ${XV_UNIT} has no PR or head_sha\n${run.diagnostics()}`);
  const pr = record.pr;
  const head = record.head_sha;
  await step(
    "GitHub shows the PR merged at the reviewed head",
    async () => {
      const prs = must(await run.inner.listPrsByBranch(run.branch, { signal: AbortSignal.timeout(60_000) }), "listPrsByBranch");
      const found = prs.find((p) => p.number === pr);
      if (found === undefined) throw new Error(`no PR #${pr} on ${run.branch}`);
      expect([found.state, found.head_sha]).toEqual(["merged", head]);
    },
    run.diagnostics,
  );
  await step(
    "GitHub lists a commented review at the reviewed head",
    async () => {
      const reviews = must(await run.inner.reviews(pr, { signal: AbortSignal.timeout(60_000) }), "reviews");
      expect(reviews.some((r) => r.state === "commented" && r.commit_sha === head)).toBe(true);
    },
    run.diagnostics,
  );
}

async function meetsCase(c: XvCase, run: LiveRun): Promise<void> {
  await step(
    `the run shows case ${c.name}`,
    () => {
      expect(caseProblems(c, run.observed)).toEqual([]);
    },
    run.diagnostics,
  );
  await step(
    "the lane's clone holds what this run's build wrote",
    () => {
      expect(cloneProblems(run.key, readIn(run.layout.clone))).toEqual([]);
    },
    run.diagnostics,
  );
  await githubShowsMergedAndReviewed(run);
  // The evidence line: what the Maintainer records for the case.
  const r = run.record as UnitRecord;
  const reviews = run.events.filter((e) => e.kind === "review").map((e) => (e.kind === "review" ? (e.body.split("\n")[0] ?? "") : ""));
  const held = run.events.filter((e) => e.kind === "enqueue" && e.held).map((e) => (e.kind === "enqueue" ? e.head : ""));
  console.log(
    `cross-vendor ${c.name}: ${run.key} PR #${r.pr} merged at ${r.head_sha}; builder_providers ${JSON.stringify(r.builder_providers)}; attempts ${r.attempts}, loopbacks ${r.loopbacks}, ci_fixes ${r.ci_fixes}${held.length > 0 ? `; held enqueue at ${held.join(", ")}` : ""}\n${reviews.map((l) => `  ${l}`).join("\n")}`,
  );
}

liveCase(
  `${LIVE_PREFIX} claude builds Story 1.6, codex reviews it, and it merges at the reviewed SHA`,
  async () => {
    const c = XV_CASES.claude;
    await runLiveLane(c, (run) => meetsCase(c, run));
  },
  XV_CASE_TIMEOUT_MS,
);

liveCase(
  `${LIVE_PREFIX} codex builds Story 1.6, claude reviews it, and it merges at the reviewed SHA`,
  async () => {
    const c = XV_CASES.codex;
    await runLiveLane(c, (run) => meetsCase(c, run));
  },
  XV_CASE_TIMEOUT_MS,
);

liveCase(
  `${LIVE_PREFIX} a later agent change after a passed review is reviewed again before its enqueue`,
  async () => {
    const c = XV_CASES["later-change"];
    await runLiveLane(c, (run) => meetsCase(c, run));
  },
  XV_CASE_TIMEOUT_MS,
);

liveCase(
  `${LIVE_PREFIX} a claude-only policy gets a same-vendor claude review on a separate fresh checkout, then merges on its checks`,
  async () => {
    const c = XV_CASES["single-vendor"];
    await runLiveLane(c, async (run) => {
      await meetsCase(c, run);
      await step(
        "the review checkout is separate, at the reviewed head, with hooks off",
        () => {
          const dir = run.layout.review;
          expect(dir).not.toBe(run.layout.clone);
          expect(lstatSync(join(dir, ".git")).isDirectory()).toBe(true);
          const git = (args: readonly string[]): string => {
            const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
            return r.stdout.toString().trim();
          };
          expect(git(["rev-parse", "HEAD"])).toBe(run.record?.head_sha as string);
          expect(git(["config", "--get", "core.hooksPath"])).toBe("/dev/null");
        },
        run.diagnostics,
      );
    });
  },
  XV_CASE_TIMEOUT_MS,
);
