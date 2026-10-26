import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok } from "../../src/core/result.ts";
import type { SessionAdapter } from "../../src/core/review/reviewer.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { LaneIdentity } from "../../src/core/schemas/ledger.ts";
import type { Agent, AgentLaunchSpec } from "../../src/ports/agent.ts";
import type { Forge } from "../../src/ports/forge.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";
import { createFsLaneStore, laneLayout } from "../../src/lane/lane-store.ts";
import type { ReviewCheckout } from "../../src/lane/review-checkout.ts";
import { createReviewStep, type ReviewRound, type ReviewStep, type ReviewStepInput } from "../../src/lane/review-step.ts";
import { End, stepKit } from "../../src/lane/session.ts";

/**
 * A real review step (Story 3.4) on stub reviewer agents, a stub sandbox
 * and a stub checkout, for the review gate's tests (Story 3.5). Each
 * sandbox run writes the next review result for the head it reviews.
 */

export type Finding = { readonly severity: "high" | "medium" | "low"; readonly blocking: boolean; readonly file: string; readonly text: string };

export const BLOCKER: Finding = { severity: "high", blocking: true, file: "src/a.ts", text: "the loop never ends." };
export const NIT: Finding = { severity: "low", blocking: false, file: "src/b.ts", text: "a name could be clearer." };

/** One review pass's result: `pass` with `findings`, or `changes-requested` when any blocks. */
export function reviewPass(findings: readonly Finding[] = []): (head: string) => string {
  return (head) =>
    JSON.stringify({ kind: "review", reviewed_sha: head, verdict: findings.some((f) => f.blocking) ? "changes-requested" : "pass", findings, denied_actions: [] });
}

/** A spec file's text; `followup` sets `followup_review_recommended`. */
export function reviewSpec(status: string, followup?: boolean): string {
  return `---\ntitle: 'Story'\nstatus: '${status}'\n${followup === undefined ? "" : `followup_review_recommended: ${followup}\n`}---\n\n## Auto Run Result\n\nStatus: ${status}\n\nRisks: the loop.\n`;
}

export type ReviewStubOpts = {
  readonly forge: Forge;
  readonly laneDir: string;
  readonly hostStop: string;
  readonly lane: Lane;
  readonly identity: LaneIdentity;
  /** The result each review run writes, in order; past the end, a clean pass. */
  readonly results: readonly ((head: string) => string)[];
  /** The files the review checkout holds (path → text). */
  readonly files?: () => Readonly<Record<string, string>>;
  readonly now?: () => number;
  /** Runs after each review run wrote its result; `n` counts runs from 0. */
  readonly onRun?: (n: number) => void;
};

export type ReviewStub = {
  readonly review: ReviewStep;
  /** Every reviewer prompt, in order. */
  readonly prompts: string[];
};

export function reviewStub(o: ReviewStubOpts): ReviewStub {
  const prompts: string[] = [];
  const layout = laneLayout(o.laneDir);
  let runs = 0;
  let lastModel = "";
  let head = "";
  const agentFor = (vendor: SessionAdapter, defaultModel: string): Agent => ({
    vendor,
    defaultModel,
    minVersion: "1.0.0",
    launchSpec: (unit, settings, resultPath) => {
      lastModel = settings.model ?? defaultModel;
      const prompt = unit.kind === "fresh" ? unit.prompt : `resume ${unit.sessionId}`;
      return ok({
        argv: [`stub-${vendor}`, settings.effort, resultPath],
        stdin: prompt,
        vendor,
        vendorHomeEnv: "STUB_HOME",
        credential: { file: "token", env: "STUB_TOKEN" },
        apiHosts: ["api.example.com"],
      } as AgentLaunchSpec);
    },
    parseUsage: () => ({ sessionId: null, model: lastModel, tokens: null, cost: null, usageLimit: null }),
    checkModel: (usage, configured) => (usage.model === configured ? ok(usage.model) : err("model-mismatch", `ran ${usage.model ?? "no model"}, not ${configured}`)),
    effortValues: () => ["low", "medium", "high"],
    startCheck: () => ok({ model: defaultModel, version: "1.0.0" }),
  });
  const sandbox: Sandbox = {
    async run(spec, profile) {
      prompts.push(spec.stdin ?? "");
      const n = runs++;
      const write = o.results[n] ?? reviewPass();
      writeFileSync(profile.resultPath, write(head));
      o.onRun?.(n);
      return ok({ pid: 999, exitCode: 0, signal: null, startedAt: 0, endedAt: 1, durationMs: 1, stdout: "", stderr: "" });
    },
  };
  const checkout: ReviewCheckout = {
    async prepare(r) {
      head = r.head;
      rmSync(layout.review, { recursive: true, force: true });
      mkdirSync(join(layout.review, ".git"), { recursive: true });
      for (const [path, text] of Object.entries({ "src/a.ts": "a\n", ...o.files?.() })) {
        mkdirSync(dirname(join(layout.review, path)), { recursive: true });
        writeFileSync(join(layout.review, path), text);
      }
      return ok({ sha: r.head });
    },
  };
  const review = createReviewStep({
    forge: o.forge,
    sandbox,
    store: createFsLaneStore({ laneDir: o.laneDir, hostStop: o.hostStop }),
    waiter: { wait: async () => ({ end: "elapsed" }) },
    laneDir: o.laneDir,
    lane: o.lane,
    identity: o.identity,
    reviewers: { claude: agentFor("claude", "claude-opus-5-5"), codex: agentFor("codex", "gpt-6.1-sol") },
    checkout,
    ...(o.now !== undefined ? { now: o.now } : {}),
    sleep: async () => {},
    random: () => 0,
  });
  return { review, prompts };
}

export type StubReviewOpts = {
  /** The forge the stub records on; give the unspied one to keep a test's call log as it was. */
  readonly forge: Forge;
  readonly identity: LaneIdentity;
  /** Whether the `n`th round (from 0) blocks; default none. */
  readonly blocking?: (n: number) => boolean;
  /** The `n`th round's findings; default a blocker and a nit when it blocks, else a nit. */
  readonly findings?: (n: number) => readonly Finding[];
};

/**
 * A stub review step: one round per call with no session. Like the real
 * one, it records `reviewed_sha` at the head and, on a round with no
 * blocking finding, `passed_sha` too, through a fenced heartbeat.
 */
export function stubReviewStep(o: StubReviewOpts): { readonly review: ReviewStep; readonly calls: ReviewStepInput[] } {
  const calls: ReviewStepInput[] = [];
  const review: ReviewStep = async (input) => {
    const n = calls.length;
    calls.push(input);
    const blocking = o.blocking?.(n) ?? false;
    const head = input.record.head_sha as string;
    const snap = await o.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    const kit = stepKit({
      name: "stub review",
      forge: o.forge,
      identity: o.identity,
      record: input.record,
      log: input.log,
      clock: Date.now,
      callTimeoutMs: 5000,
      sleep: async () => {},
      random: () => 0,
      ...(snap.ok ? { seen: snap.value.now } : {}),
    });
    try {
      await kit.beat("record", { reviewed_sha: head, passed_sha: blocking ? null : head });
    } catch (e) {
      if (e instanceof End) return e.out;
      throw e;
    }
    const findings = o.findings?.(n) ?? (blocking ? [BLOCKER, NIT] : [NIT]);
    const round: ReviewRound = { sha: head, blocking, crossVendor: true, adapter: "codex", passes: 1, findings: [...findings] };
    return { outcome: "progress", state: "claimed", record: kit.record, review: round };
  };
  return { review, calls };
}
