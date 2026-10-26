import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchBotUserId } from "../../src/adapters/forge/github/bot-user.ts";
import { createGitHubFetch } from "../../src/adapters/forge/github/fetch-shas.ts";
import { createGitHubForge } from "../../src/adapters/forge/github/github-forge.ts";
import { request, type Operation } from "../../src/adapters/forge/github/http.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import { laneDirFor } from "../../src/cli/host-paths.ts";
import type { Connect } from "../../src/cli/lane-connection.ts";
import { laneRun } from "../../src/cli/lane-run.ts";
import { loadRepoConfig } from "../../src/core/config/load-repo-config.ts";
import { runnerFileText } from "../../src/core/lane/runner.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { Provider, SessionAdapter } from "../../src/core/review/reviewer.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { UnitRecord } from "../../src/core/schemas/ledger.ts";
import { readsPath } from "../../src/lane/lane-process.ts";
import { laneLayout, type LaneLayout } from "../../src/lane/lane-store.ts";
import { forgeOk, type Forge, type ForgeResult, type GitSha } from "../../src/ports/forge.ts";
import { configDir } from "../../src/sandbox/environment.ts";
import { cleanupScratch, LIVE_LOGIN, liveCredentials, liveRepo, prefixed, type RawCall } from "../support/live-github.ts";
import { overlayMain, recordAlerts } from "./race-harness.ts";
import { SEED_AGENTS, SEED_AGENTS_PATH, SEED_SKILL, SEED_SKILL_PATHS, XV_STORY, xvSpecPath, xvVerifyPath, xvVerifyText } from "./scratch-seed.ts";

/**
 * The cross-vendor verification harness (Story 3.6, FR7, FR8). A live case
 * runs the real `laneRun` against the scratch repo with the real `claude`
 * and `codex` CLIs and the operator's credentials. Its forge is the real
 * GitHub forge with unit branches prefixed, Story 1.6 and the case's policy
 * overlaid on `main` (`withOverlay`), alerts recorded instead of posted, and
 * every push, posted review and enqueue recorded in order (`observe`). Case
 * 3 also holds the first enqueue (`injectLaterChange`), so the real queue
 * read sees the PR ejected and a real CI-fix session makes a later change.
 *
 * What a case must show is one pure function, `caseProblems`, which the
 * live case and its fake-forge rehearsal both assert is empty; the review
 * gate's invariant inside it is `checkReviewGate`.
 */

export const XV_LANE = "builder-1";
export const XV_UNIT = `story:${XV_STORY.id}`;
/** The Story's branch, as the lane names it (unprefixed). */
export const XV_BRANCH = `story/${XV_STORY.id}`;

const MANIFESTS_DIR = "stories";
const EPICS_PATH = "_bmad-output/planning-artifacts/epics.md";
const STATUS_PATH = "_bmad-output/implementation-artifacts/sprint-status.yaml";
const POLICY_PATH = ".xarabot/policy.yaml";

// ------------------------------------------------------------ the cases

export type XvCaseName = "claude" | "codex" | "later-change" | "single-vendor";
/** The rehearsal-only cases (`XV_REHEARSALS`). */
export type XvRehearsalName = "flagged-spec" | "loopback";

export type XvCase = {
  readonly name: XvCaseName | XvRehearsalName;
  /** The lane's agent: the builder. */
  readonly agent: SessionAdapter;
  /** The builder's vendor, which `builder_providers` must name. */
  readonly provider: Provider;
  /** The overlaid policy's `unattended_adapters`. */
  readonly adapters: readonly SessionAdapter[];
  /** The reviewer the case expects, and whether its review is cross-vendor. */
  readonly reviewer: SessionAdapter;
  readonly crossVendor: boolean;
  /** Case 3: the first enqueue is held and a later agent change follows. */
  readonly laterChange: boolean;
  /** The Story's spec flags a follow-up review, so each round posts a review, then a follow-up review. */
  readonly flagged?: boolean;
  /** The first round blocks, and a loopback session's fix is pushed and reviewed before the enqueue. */
  readonly loopback?: boolean;
};

export const XV_CASES: Readonly<Record<XvCaseName, XvCase>> = {
  claude: { name: "claude", agent: "claude", provider: "anthropic", adapters: ["claude", "codex"], reviewer: "codex", crossVendor: true, laterChange: false },
  codex: { name: "codex", agent: "codex", provider: "openai", adapters: ["claude", "codex"], reviewer: "claude", crossVendor: true, laterChange: false },
  "later-change": { name: "later-change", agent: "claude", provider: "anthropic", adapters: ["claude", "codex"], reviewer: "codex", crossVendor: true, laterChange: true },
  "single-vendor": { name: "single-vendor", agent: "claude", provider: "anthropic", adapters: ["claude"], reviewer: "claude", crossVendor: false, laterChange: false },
};

/**
 * Cases rehearsed on the fake forge only (Epic 3 retro item 9): the
 * stand-in skill's spec is unflagged, and a live reviewer's verdict can't be
 * steered to block, so no live case runs them.
 */
export const XV_REHEARSALS: Readonly<Record<XvRehearsalName, XvCase>> = {
  "flagged-spec": { ...XV_CASES.claude, name: "flagged-spec", flagged: true },
  loopback: { ...XV_CASES.claude, name: "loopback", loopback: true },
};

/** A fresh sprint key for case `name`: `1-6-xv-<case>-<8 hex>`. */
export function xvKey(name: XvCase["name"]): string {
  return `${XV_STORY.id.replace(".", "-")}-xv-${name}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

// ------------------------------------------------------------ the overlay

/**
 * The overlay for sprint key `key` and `adapters`: `epics.md` with Story 1.6
 * alone, `sprint-status.yaml` with it `backlog`, its manifest (glob
 * `verify/**`), and `.xarabot/policy.yaml` allowing `adapters` with no
 * expected failing check.
 */
export function xvOverlay(key: string, adapters: readonly SessionAdapter[]): Record<string, string> {
  const s = XV_STORY;
  return {
    [EPICS_PATH]: ["# Epics", "", `## Epic ${s.epic}: Canary`, "", `### Story ${s.id}: ${s.title}`, "", `A real session writes \`${xvVerifyPath(key)}\`.`, ""].join("\n"),
    [STATUS_PATH]: ["development_status:", `  epic-${s.epic}: in-progress`, `  ${key}: backlog`, ""].join("\n"),
    [`${MANIFESTS_DIR}/${s.id}.md`]: ["---", `story_id: "${s.id}"`, `epic: ${s.epic}`, `sprint_key: ${key}`, `title: ${s.title}`, `globs: ["${s.glob}"]`, "---", ""].join("\n"),
    [POLICY_PATH]: ["schema_version: 1", `unattended_adapters: [${adapters.join(", ")}]`, "expected_checks: []", ""].join("\n"),
  };
}

/** `forge`, whose snapshots show `main` with `files` overlaid (`overlayMain`): `stories/**`, `epics.md` and `sprint-status.yaml` replaced, and any other path in `files` written over. */
export function withOverlay(forge: Forge, files: Readonly<Record<string, string>>): Forge {
  return {
    ...forge,
    snapshot: async (opts) => {
      const r = await forge.snapshot(opts);
      if (!r.ok) return r;
      return forgeOk({ ...r.value, main: overlayMain(r.value.main, files, opts.read ?? (() => false)) });
    },
  };
}

// ------------------------------------------------------------ observation

/** One observed forge call, in call order: a push, a posted review, or an enqueue (`held`: not forwarded). */
export type XvEvent =
  | { readonly kind: "push"; readonly branch: string; readonly sha: GitSha }
  | { readonly kind: "review"; readonly pr: number; readonly commit_sha: GitSha; readonly body: string }
  | { readonly kind: "enqueue"; readonly pr: number; readonly head: GitSha; readonly held: boolean };

/** The one result `injectLaterChange` gives a held enqueue: `observe` tells it from a forwarded one by identity. */
const HELD_ENQUEUE: ForgeResult<{ readonly queued: true }> = Object.freeze(forgeOk({ queued: true as const }));

/**
 * `forge`, recording into `events` each `pushBranch`, `postReview` and
 * `enqueue` that returns `ok`, in the order they return, with the names the
 * lane gave (unprefixed when this is the outermost wrapper). Every call is
 * forwarded.
 */
export function observe(forge: Forge, events: XvEvent[]): Forge {
  return {
    ...forge,
    pushBranch: async (lease, opts) => {
      const r = await forge.pushBranch(lease, opts);
      if (r.ok) events.push({ kind: "push", branch: lease.branch, sha: r.value.sha });
      return r;
    },
    postReview: async (pr, review, opts) => {
      const r = await forge.postReview(pr, review, opts);
      if (r.ok) events.push({ kind: "review", pr, commit_sha: review.commit_sha, body: review.body });
      return r;
    },
    enqueue: async (pr, head, opts) => {
      const r = await forge.enqueue(pr, head, opts);
      if (r.ok) events.push({ kind: "enqueue", pr, head, held: r === HELD_ENQUEUE });
      return r;
    },
  };
}

/** The check `injectLaterChange` fails on the held head. */
export const VERIFY_CHECK = "xarabot-verify";

/** The line the CI log asks the CI-fix session to add to `verify/<key>.md`. */
export function verifiedLine(key: string): string {
  return `Verified for ${key}.`;
}

/** The injected `xarabot-verify` log: it asks for one added line in `verify/<key>.md`, and nothing else. */
export function verifyLogText(key: string): string {
  return [
    `${VERIFY_CHECK}: FAILED`,
    "",
    `${xvVerifyPath(key)} must end with this line, which is missing:`,
    "",
    verifiedLine(key),
    "",
    `Fix: add that one line at the end of ${xvVerifyPath(key)}, keeping the line already there. Change no other file. This check has no command to re-run here.`,
    "",
  ].join("\n");
}

/** What the injector has done so far; shared by every forge a lane's connection makes. */
export type LaterChangeState = {
  /** The held enqueue: the PR and the head it was asked for. */
  held: { readonly pr: number; readonly head: GitSha } | null;
  /** Whether the dequeue after the hold was answered (unforwarded). */
  dequeued: boolean;
};

export function laterChangeState(): LaterChangeState {
  return { held: null, dequeued: false };
}

/**
 * Case 3's later change: the first `enqueue` is held (not forwarded; `ok`,
 * queued) and the next `dequeue` of that PR answers `queued: false`
 * unforwarded, so the real `queueState` reads the PR as ejected. From the
 * hold on, `checks(<held head>)` adds a completed `xarabot-verify` check with
 * conclusion `failure`, and `prefetch` for that SHA writes
 * `<dir>/xarabot-verify.log` (`verifyLogText`) and returns only it. Every
 * other call is forwarded.
 */
export function injectLaterChange(forge: Forge, key: string, state: LaterChangeState): Forge {
  const heldHead = (sha: GitSha): boolean => state.held !== null && state.held.head === sha;
  return {
    ...forge,
    enqueue: async (pr, head, opts) => {
      if (state.held !== null) return forge.enqueue(pr, head, opts);
      state.held = { pr, head };
      return HELD_ENQUEUE;
    },
    dequeue: async (pr, opts) => {
      if (state.held === null || state.dequeued || state.held.pr !== pr) return forge.dequeue(pr, opts);
      state.dequeued = true;
      return forgeOk({ queued: false as const });
    },
    checks: async (sha, opts) => {
      const r = await forge.checks(sha, opts);
      if (!r.ok || !heldHead(sha)) return r;
      return forgeOk({ checks: [...r.value.checks, { name: VERIFY_CHECK, status: "completed" as const, conclusion: "failure" }] });
    },
    prefetch: async (req, opts) => {
      if (!heldHead(req.sha)) return forge.prefetch(req, opts);
      const path = join(req.dir, `${VERIFY_CHECK}.log`);
      mkdirSync(req.dir, { recursive: true });
      writeFileSync(path, verifyLogText(key));
      return forgeOk({ files: [path] });
    },
  };
}

// ------------------------------------------------------------ the review gate's invariant

/** A posted review's first line, parsed. */
export type ReviewHead = {
  readonly subject: string;
  readonly vendor: "cross-vendor" | "same-vendor";
  readonly pass: "review" | "follow-up review";
  readonly adapter: string;
  readonly model: string;
  readonly sha: GitSha;
};

const REVIEW_HEAD = /^🤖 (.+?): (cross-vendor|same-vendor) (review|follow-up review) by ([a-z]+) \((.*)\) of ([0-9a-f]{40}|[0-9a-f]{64})\.$/;

/** The first line of a review body (`reviewComment`), parsed; `null` when it is not one. */
export function reviewHead(body: string): ReviewHead | null {
  const m = REVIEW_HEAD.exec(body.split("\n")[0] ?? "");
  if (m === null) return null;
  const [, subject, vendor, pass, adapter, model, sha] = m as unknown as [string, string, ReviewHead["vendor"], ReviewHead["pass"], string, string, string];
  return { subject, vendor, pass, adapter, model, sha };
}

/** Whether a review body says `Verdict: pass.` and `Outcome: not blocking.`, each on its own line. */
export function reviewPassed(body: string): boolean {
  const lines = body.split("\n");
  return lines.includes("Verdict: pass.") && lines.includes("Outcome: not blocking.");
}

/**
 * The review gate's invariant over observed events (pure): every enqueue,
 * held or forwarded, has a review of its PR posted before it at exactly its
 * head, the last such review says `Verdict: pass.` and `Outcome: not
 * blocking.`, and no push to a different SHA lies between that review and
 * the enqueue. Each violation is one line; none is `[]`.
 */
export function checkReviewGate(events: readonly XvEvent[]): string[] {
  const violations: string[] = [];
  events.forEach((e, i) => {
    if (e.kind !== "enqueue") return;
    const what = `enqueue #${i} of PR #${e.pr} at ${e.head}${e.held ? " (held)" : ""}`;
    let at = -1;
    for (let k = i - 1; k >= 0; k -= 1) {
      const r = events[k] as XvEvent;
      if (r.kind === "review" && r.pr === e.pr && r.commit_sha === e.head) {
        at = k;
        break;
      }
    }
    if (at === -1) {
      violations.push(`${what}: no review was posted at that SHA before it`);
      return;
    }
    const review = events[at] as Extract<XvEvent, { kind: "review" }>;
    if (!reviewPassed(review.body)) violations.push(`${what}: the last review at that SHA (event #${at}) is not a pass that is not blocking`);
    for (let k = at + 1; k < i; k += 1) {
      const p = events[k] as XvEvent;
      if (p.kind === "push" && p.sha !== e.head) violations.push(`${what}: a push of ${p.sha} to ${p.branch} (event #${k}) lies between the review (event #${at}) and the enqueue`);
    }
  });
  return violations;
}

// ------------------------------------------------------------ what a case must show

/** What a run left: `laneRun`'s exit code, the `outcome` file, the ledger's files, the observed events and the journal. */
export type XvObserved = {
  readonly code: number;
  /** The lane's `outcome` file text; `null` when there is none. */
  readonly outcome: string | null;
  /** The ledger tip's files (path → JSON text). */
  readonly ledger: Readonly<Record<string, string>>;
  readonly events: readonly XvEvent[];
  /** The lane's `journal.jsonl` text; `null` when there is none. */
  readonly journal: string | null;
};

/** The ledger's `story:1.6` record, or `null` (also when the ledger does not parse). */
export function xvRecord(ledger: Readonly<Record<string, string>>): UnitRecord | null {
  const parsed = parseLedger(ledger);
  return parsed.ok ? (parsed.value.units.get(XV_UNIT) ?? null) : null;
}

/**
 * Every way a run breaks case `c` (pure); `[]` when it shows what the case
 * must. The lane exits 0 with outcome `progress`; the ledger holds only
 * `story:1.6`, `merged`, its `builder_providers` naming the builder's
 * vendor and its `passed_sha` and `enqueued_sha` equal to its `head_sha`;
 * every posted review's first line is the case's `🤖 Story 1.6:
 * <cross-vendor|same-vendor> review by <adapter> (…) of <sha>.` at the SHA
 * it was posted on, and one passed at the merged head; `checkReviewGate`
 * finds no violation; every forwarded enqueue is at the merged head; the
 * journal's one `story:1.6` line is `result: done`, `state: merged`. Case 3
 * also needs one held enqueue at a head H1 other than the merged head,
 * `ci_fixes` and `attempts` of at least 1, and after the hold a push of the
 * merged head, then a passing review at it, then its forwarded enqueue; any
 * other case, no held enqueue. A flagged case needs a follow-up review after
 * each review at its SHA, and a passing review then a passing follow-up
 * review at the merged head; any other, no follow-up review. A loopback case
 * needs `loopbacks` of at least 1 and a blocking review at an earlier head,
 * then a push of the merged head, then a passing review at it.
 */
export function caseProblems(c: XvCase, o: XvObserved): string[] {
  const problems: string[] = [];
  if (o.code !== 0) problems.push(`laneRun exited ${o.code}, not 0`);
  if (o.outcome !== "progress\n") problems.push(`the outcome is ${JSON.stringify(o.outcome)}, not "progress"`);

  // The ledger.
  const parsed = parseLedger(o.ledger);
  let record: UnitRecord | null = null;
  if (!parsed.ok) problems.push(`the ledger does not parse: ${parsed.error.message}`);
  else {
    const units = [...parsed.value.units.keys()].sort();
    if (units.length !== 1 || units[0] !== XV_UNIT) problems.push(`the ledger holds ${JSON.stringify(units)}, not only ${XV_UNIT}`);
    record = parsed.value.units.get(XV_UNIT) ?? null;
  }
  const head = record?.head_sha ?? null;
  if (record !== null) {
    if (record.state !== "merged") problems.push(`${XV_UNIT} is ${record.state}, not merged`);
    if (!record.builder_providers.includes(c.provider)) problems.push(`builder_providers ${JSON.stringify(record.builder_providers)} does not name ${c.provider}`);
    if (head === null) problems.push(`${XV_UNIT} has no head_sha`);
    if (record.passed_sha !== head) problems.push(`passed_sha ${record.passed_sha ?? "null"} is not head_sha ${head ?? "null"}`);
    if (record.enqueued_sha !== head) problems.push(`enqueued_sha ${record.enqueued_sha ?? "null"} is not head_sha ${head ?? "null"}`);
  }

  // The posted reviews.
  const word = c.crossVendor ? "cross-vendor" : "same-vendor";
  const subject = `Story ${XV_STORY.id}`;
  o.events.forEach((e, i) => {
    if (e.kind !== "review") return;
    const h = reviewHead(e.body);
    if (h === null) {
      problems.push(`review #${i}: its first line is not a review line: ${JSON.stringify(e.body.split("\n")[0] ?? "")}`);
      return;
    }
    if (h.subject !== subject) problems.push(`review #${i}: names ${JSON.stringify(h.subject)}, not ${subject}`);
    if (h.vendor !== word) problems.push(`review #${i}: is ${h.vendor}, not ${word}`);
    if (h.adapter !== c.reviewer) problems.push(`review #${i}: is by ${h.adapter}, not ${c.reviewer}`);
    if (h.sha !== e.commit_sha) problems.push(`review #${i}: names ${h.sha} but was posted on ${e.commit_sha}`);
  });
  const passedAt = (sha: GitSha | null, after = -1): number =>
    o.events.findIndex((e, i) => i > after && e.kind === "review" && e.commit_sha === sha && reviewPassed(e.body));
  if (head !== null && passedAt(head) === -1) problems.push(`no passing review was posted at the merged head ${head}`);

  // The follow-up passes.
  const posted = o.events.flatMap((e, i) => (e.kind === "review" ? [{ i, sha: e.commit_sha, pass: reviewHead(e.body)?.pass ?? null, passed: reviewPassed(e.body) }] : []));
  if (c.flagged === true) {
    for (const p of posted) {
      if (p.pass === "review" && !posted.some((q) => q.i > p.i && q.sha === p.sha && q.pass === "follow-up review")) problems.push(`flagged spec: review #${p.i} of ${p.sha} has no follow-up review after it`);
    }
    const last = (pass: ReviewHead["pass"]) => posted.filter((p) => p.sha === head && p.pass === pass).at(-1);
    const normal = last("review");
    const followup = last("follow-up review");
    if (head !== null && (normal?.passed !== true || followup?.passed !== true || followup.i < normal.i)) {
      problems.push(`flagged spec: no passing review, then a passing follow-up review, at the merged head ${head}`);
    }
  } else {
    for (const p of posted) if (p.pass === "follow-up review") problems.push(`review #${p.i}: a follow-up review in a case with no flagged spec`);
  }

  // The loopback.
  if (c.loopback === true) {
    if (record !== null && record.loopbacks < 1) problems.push(`loopback: loopbacks is ${record.loopbacks}, not at least 1`);
    const blocked = posted.find((p) => !p.passed && p.sha !== head);
    if (blocked === undefined) problems.push("loopback: no blocking review was posted at an earlier head");
    else {
      const pushAt = o.events.findIndex((e, i) => i > blocked.i && e.kind === "push" && e.sha === head);
      if (pushAt === -1) problems.push(`loopback: no push of the merged head ${head ?? "null"} after the blocking review #${blocked.i}`);
      else if (passedAt(head, pushAt) === -1) problems.push(`loopback: no passing review at the merged head ${head ?? "null"} after its push`);
    }
  }

  // The gate and the enqueues.
  for (const v of checkReviewGate(o.events)) problems.push(`review gate: ${v}`);
  const enqueues = o.events.filter((e): e is Extract<XvEvent, { kind: "enqueue" }> => e.kind === "enqueue");
  const forwarded = enqueues.filter((e) => !e.held);
  if (forwarded.length === 0) problems.push("no enqueue was forwarded to the merge queue");
  for (const e of forwarded) if (e.head !== head) problems.push(`an enqueue was forwarded at ${e.head}, not the merged head ${head ?? "null"}`);

  // The journal.
  const lines: Record<string, unknown>[] = [];
  for (const l of (o.journal ?? "").split("\n")) {
    if (l.trim() === "") continue;
    try {
      lines.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      problems.push(`a journal line is not JSON: ${l.slice(0, 200)}`);
    }
  }
  const unitLines = lines.filter((l) => l["type"] === "unit" && l["unit"] === XV_UNIT);
  if (unitLines.length !== 1) problems.push(`the journal has ${unitLines.length} unit lines for ${XV_UNIT}, not 1`);
  for (const l of unitLines) {
    if (l["result"] !== "done" || l["state"] !== "merged") problems.push(`the journal's ${XV_UNIT} line is result ${JSON.stringify(l["result"])}, state ${JSON.stringify(l["state"])}, not done, merged`);
  }

  // The later change.
  const held = enqueues.filter((e) => e.held);
  if (!c.laterChange) {
    if (held.length > 0) problems.push(`${held.length} enqueue(s) were held in a case with no later change`);
    return problems;
  }
  if (held.length !== 1) {
    problems.push(`later change: ${held.length} held enqueues, not 1`);
    return problems;
  }
  const h1 = (held[0] as (typeof held)[number]).head;
  const heldAt = o.events.findIndex((e) => e.kind === "enqueue" && e.held);
  if (h1 === head) problems.push(`later change: the merged head is the held head ${h1}, so no later change was made`);
  if (record !== null && record.ci_fixes < 1) problems.push(`later change: ci_fixes is ${record.ci_fixes}, not at least 1`);
  if (record !== null && record.attempts < 1) problems.push(`later change: attempts is ${record.attempts}, not at least 1`);
  const pushAt = o.events.findIndex((e, i) => i > heldAt && e.kind === "push" && e.sha === head);
  const rereviewAt = pushAt === -1 ? -1 : passedAt(head, pushAt);
  const enqueueAt = rereviewAt === -1 ? -1 : o.events.findIndex((e, i) => i > rereviewAt && e.kind === "enqueue" && !e.held && e.head === head);
  if (pushAt === -1) problems.push(`later change: no push of the merged head ${head ?? "null"} after the held enqueue`);
  else if (rereviewAt === -1) problems.push(`later change: no passing re-review at the merged head ${head ?? "null"} after its push`);
  else if (enqueueAt === -1) problems.push(`later change: no forwarded enqueue at the merged head ${head ?? "null"} after its re-review`);
  return problems;
}

// ------------------------------------------------------------ what the build wrote

/**
 * What the lane's clone must hold after a run of sprint key `key` (pure;
 * `read` gives a clone path's text, or `null`): `verify/<key>.md` starting
 * with `xvVerifyText(key)` (a CI fix may add a line after it), and the
 * Story's spec naming the key, so a spec an earlier run left on `main`
 * never counts. `[]` when both hold.
 */
export function cloneProblems(key: string, read: (path: string) => string | null): string[] {
  const problems: string[] = [];
  const verify = read(xvVerifyPath(key));
  if (verify === null) problems.push(`the clone has no ${xvVerifyPath(key)}`);
  else if (!verify.startsWith(xvVerifyText(key))) problems.push(`${xvVerifyPath(key)} does not start with ${JSON.stringify(xvVerifyText(key))}: ${JSON.stringify(verify.slice(0, 200))}`);
  const [epic, story] = XV_STORY.id.split(".") as [string, string];
  const specPath = xvSpecPath(epic, story);
  const spec = read(specPath);
  if (spec === null) problems.push(`the clone has no ${specPath}`);
  else if (!spec.includes(key)) problems.push(`${specPath} does not name ${key}, so this run's session did not write it`);
  return problems;
}

/** A `cloneProblems` reader over the folder `clone`. */
export function readIn(clone: string): (path: string) => string | null {
  return (path) => {
    const full = join(clone, path);
    try {
      return lstatSync(full).isFile() ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
}

// ------------------------------------------------------------ live

/** The vendors whose credentials a live case copies. */
export const XV_VENDORS: readonly SessionAdapter[] = ["claude", "codex"];

/**
 * Copies every regular file in `<fromConfig>/xarabot/vendors/<vendor>/`, for
 * `claude` and `codex`, to the same place under `toConfig`, each mode 600 in
 * a mode-700 folder. A vendor folder that is missing or holds no regular
 * file throws, naming it. Returns the copied paths.
 */
export function copyVendorCredentials(fromConfig: string, toConfig: string): string[] {
  const copied: string[] = [];
  for (const vendor of XV_VENDORS) {
    const from = join(fromConfig, "xarabot", "vendors", vendor);
    const to = join(toConfig, "xarabot", "vendors", vendor);
    let names: string[];
    try {
      names = readdirSync(from).filter((n) => lstatSync(join(from, n)).isFile());
    } catch (e) {
      throw new Error(`no ${vendor} credential: ${from}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (names.length === 0) throw new Error(`no ${vendor} credential: ${from} holds no file`);
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const n of names.sort()) {
      copyFileSync(join(from, n), join(to, n));
      chmodSync(join(to, n), 0o600);
      copied.push(join(to, n));
    }
  }
  return copied;
}

/** Runs one named step; a failure inside it is reported as `step "<name>": ...`, with `context()` after it. */
export async function step<T>(name: string, run: () => T | Promise<T>, context?: () => string): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const extra = context === undefined ? "" : context();
    throw new Error(`step "${name}": ${e instanceof Error ? e.message : String(e)}${extra === "" ? "" : `\n${extra}`}`, { cause: e });
  }
}

export function must<T>(r: ForgeResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error.kind}: ${r.error.message}`);
  return r.value;
}

export const callSignal = (): AbortSignal => AbortSignal.timeout(60_000);

/** How often the watcher looks for `outcome` and `wait.pid`. */
const WATCH_MS = 250;
/** The lane's own deadline; the test's 50-minute timeout leaves room for cleanup after it. */
export const XV_LANE_DEADLINE_MS = 40 * 60_000;
/** A live case's test timeout. */
export const XV_CASE_TIMEOUT_MS = 50 * 60_000;

/** One live case's run, handed to the case's checks before cleanup. */
export type LiveRun = {
  readonly key: string;
  readonly code: number;
  readonly out: readonly string[];
  readonly errOut: readonly string[];
  readonly layout: LaneLayout;
  readonly events: readonly XvEvent[];
  readonly alerts: readonly string[];
  readonly observed: XvObserved;
  /** The ledger's `story:1.6` record after the run. */
  readonly record: UnitRecord | null;
  /** The real (prefixed) Story branch. */
  readonly branch: string;
  /** The unprefixed GitHub forge on the case's ledger branch: reads only. */
  readonly inner: Forge;
  /** The lane's output, the observed events, the alerts and the tail of each unit log. */
  readonly diagnostics: () => string;
};

/**
 * One live case on the scratch repo (`XARABOT_LIVE_GITHUB_REPO`): the CLIs
 * and both vendors' credentials checked, scratch `main` loaded, a host in a
 * temp folder (`host.yaml` with one `builder-1` lane of the case's agent at
 * effort `low`, the `runner` file at `main`'s `runner_version`, copies of
 * the operator's vendor credentials, the caller's `PATH`), then the real
 * `laneRun` to its trailing wait and a STOP. Each case has a fresh sprint
 * key, ledger branch `xarabot/test-<uuid>` and unit branch prefix
 * `xarabot-test/<uuid>/`. `after` runs the case's checks on the run; the
 * scratch branches are cleaned up whether it passes or fails.
 */
export async function runLiveLane(c: XvCase, after: (run: LiveRun) => Promise<void>): Promise<void> {
  const repo = liveRepo();
  const slug = `${repo.owner}/${repo.name}`;
  const credentials = await liveCredentials();
  const key = xvKey(c.name);
  const ledgerBranch = `xarabot/test-${crypto.randomUUID()}`;
  const prefix = `xarabot-test/${crypto.randomUUID()}/`;
  const touched = new Set<string>([`${prefix}${XV_BRANCH}`]);
  const tokens = createTokenSource({ credentials, repo });
  const raw: RawCall = async (op: Operation, path: string, body?: unknown) => {
    const s = callSignal();
    const token = must(await tokens.get(s), "installation token");
    const r = must(await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token, signal: s, body }), op.name);
    return { status: r.status, body: r.body };
  };
  const inner = createGitHubForge({ repo, credentials, ledgerBranch });

  const root = realpathSync(mkdtempSync(join(tmpdir(), `xarabot-xv-${c.name}-`)));
  const home = join(root, "home");
  const xdg = join(root, "config");
  const lane: Lane = { repo: slug, role: "builder", owner: LIVE_LOGIN, agent: c.agent, effort: "low" };
  const laneDir = laneDirFor(join(home, ".xarabot"), lane, XV_LANE);
  const layout = laneLayout(laneDir);
  const out: string[] = [];
  const errOut: string[] = [];
  const events: XvEvent[] = [];
  const alerts: string[] = [];
  const PATH = process.env.PATH ?? "/usr/bin:/bin";

  const diagnostics = (): string => {
    const parts = [
      `--- case ${c.name}, sprint key ${key}, ledger ${ledgerBranch}, prefix ${prefix} ---`,
      `--- laneRun stdout ---\n${out.join("\n")}`,
      `--- laneRun stderr ---\n${errOut.join("\n")}`,
      `--- observed events ---\n${events.map((e, i) => `#${i} ${e.kind === "review" ? `review PR #${e.pr} at ${e.commit_sha}: ${e.body.split("\n").slice(0, 4).join(" | ")}` : e.kind === "push" ? `push ${e.branch} ${e.sha}` : `enqueue PR #${e.pr} at ${e.head}${e.held ? " (held)" : ""}`}`).join("\n")}`,
      `--- recorded alerts ---\n${alerts.join("\n")}`,
    ];
    try {
      for (const f of readdirSync(layout.logs).sort()) parts.push(`--- ${f} (tail) ---\n${readFileSync(join(layout.logs, f), "utf8").slice(-6000)}`);
    } catch {
      // No logs.
    }
    return parts.join("\n");
  };

  let laneDone: Promise<number> | null = null;
  try {
    // 1. The CLIs on the caller's PATH, and both vendors' credentials.
    const fromConfig = await step("the CLIs and the vendor credentials", () => {
      for (const cli of XV_VENDORS) if (Bun.which(cli, { PATH }) === null) throw new Error(`${cli} is not on PATH (${PATH})`);
      const dir = configDir(process.env);
      if (dir === null) throw new Error("neither XDG_CONFIG_HOME nor HOME is set, so the vendor credentials cannot be found");
      for (const v of XV_VENDORS) if (!existsSync(join(dir, "xarabot", "vendors", v))) throw new Error(`no ${v} credential folder ${join(dir, "xarabot", "vendors", v)}`);
      return dir;
    });

    // 2. The scratch main.
    const runnerVersion = await step("scratch main loads", async () => {
      const seeded: Readonly<Record<string, string>> = { [SEED_SKILL_PATHS[0]]: SEED_SKILL, [SEED_SKILL_PATHS[1]]: SEED_SKILL, [SEED_AGENTS_PATH]: SEED_AGENTS };
      // `readsPath` skips `.claude/` and `.agents/`, so the seeded paths are asked for too.
      const snap = must(await inner.snapshot({ signal: callSignal(), read: (p) => readsPath(p) || Object.hasOwn(seeded, p) }), "snapshot");
      const loaded = loadRepoConfig({ repo: slug, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!loaded.ok) throw new Error(`loadRepoConfig: ${loaded.error.kind}: ${loaded.error.message} (seed the scratch repo with bun test/e2e/scratch-seed.ts)`);
      for (const [p, text] of Object.entries(seeded)) {
        const found = snap.main.files[p];
        if (found === undefined) throw new Error(`scratch main has no ${p} (re-seed the scratch repo with bun test/e2e/scratch-seed.ts)`);
        if (found !== text) throw new Error(`scratch main's ${p} is not the seed's (re-seed the scratch repo with bun test/e2e/scratch-seed.ts)`);
      }
      return loaded.value.repo.config.runner_version;
    });

    // 3. The host.
    await step("host setup", () => {
      mkdirSync(home, { recursive: true });
      const hostYaml = join(xdg, "xarabot", "host.yaml");
      mkdirSync(dirname(hostYaml), { recursive: true });
      writeFileSync(
        hostYaml,
        [
          "schema_version: 1",
          `host_id: ${crypto.randomUUID()}`,
          "lanes:",
          `  ${XV_LANE}:`,
          `    repo: ${slug}`,
          "    role: builder",
          `    owner: ${LIVE_LOGIN}`,
          `    agent: ${c.agent}`,
          "    effort: low",
          "",
        ].join("\n"),
      );
      copyVendorCredentials(fromConfig, xdg);
      mkdirSync(laneDir, { recursive: true });
      writeFileSync(join(laneDir, "runner"), runnerFileText(runnerVersion));
    });

    // 4. The connection: the real App credentials, the overlay, recorded alerts, the injector (case 3) and the observer outermost.
    const files = xvOverlay(key, c.adapters);
    const state = laterChangeState();
    const wrap = (base: Forge): Forge => {
      const overlaid = withOverlay(recordAlerts(base, alerts), files);
      return observe(c.laterChange ? injectLaterChange(overlaid, key, state) : overlaid, events);
    };
    const connect: Connect = async (l) => {
      if (l.repo !== slug) return { ok: false, message: `cross-vendor connect: lane repo ${l.repo} is not ${slug}` };
      return {
        ok: true,
        connection: {
          forge: (o) =>
            wrap(
              prefixed(
                createGitHubForge({
                  repo,
                  credentials,
                  ledgerBranch,
                  ...(o.runnerGit !== undefined ? { runnerGit: o.runnerGit } : {}),
                  ...(o.maintainer !== undefined ? { maintainer: o.maintainer } : {}),
                }),
                prefix,
                touched,
              ),
            ),
          token: (signal) => tokens.get(signal),
          fetchShas: (gitDir) => createGitHubFetch({ repo, credentials, gitDir }),
          botUserId: (signal) => fetchBotUserId({ slug: credentials.app.slug, signal }),
        },
      };
    };
    const env: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: xdg, PATH, LANG: "en_US.UTF-8" };

    // 5. The run, with STOP written once the outcome is in and the trailing wait has begun.
    const code = await step(
      "laneRun to its trailing wait",
      async () => {
        let stopped = false;
        let finished = false;
        const done = laneRun([slug, XV_LANE], { env, connect, out: (l) => out.push(l), errOut: (l) => errOut.push(l) });
        laneDone = done;
        void done
          .finally(() => {
            finished = true;
          })
          .catch(() => {});
        const deadline = Date.now() + XV_LANE_DEADLINE_MS;
        while (!finished) {
          if (!stopped && existsSync(layout.outcome) && existsSync(join(laneDir, "wait.pid"))) {
            writeFileSync(layout.stop, "cross-vendor\n");
            stopped = true;
          }
          if (Date.now() > deadline) {
            if (!stopped) writeFileSync(layout.stop, "cross-vendor deadline\n");
            throw new Error(`laneRun did not exit within ${XV_LANE_DEADLINE_MS / 60_000} min`);
          }
          await Bun.sleep(WATCH_MS);
        }
        const exit = await done;
        if (!stopped) throw new Error(`the lane exited ${exit} before its trailing wait began, so no STOP was written`);
        return exit;
      },
      diagnostics,
    );

    // 6. What the run left.
    const observed = await step(
      "the ledger, outcome and journal read",
      async (): Promise<XvObserved> => {
        const snap = must(await inner.snapshot({ signal: callSignal() }), "snapshot");
        const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
        return { code, outcome: read(layout.outcome), ledger: snap.ledger.files, events: [...events], journal: read(layout.journal) };
      },
      diagnostics,
    );
    await after({
      key,
      code,
      out,
      errOut,
      layout,
      events,
      alerts,
      observed,
      record: xvRecord(observed.ledger),
      branch: `${prefix}${XV_BRANCH}`,
      inner,
      diagnostics,
    });
  } finally {
    // A lane past the deadline gets 30 s after its STOP to exit; cleanup runs either way.
    if (laneDone !== null) {
      const pending = Symbol("pending");
      const settled = await Promise.race([(laneDone as Promise<number>).catch(() => 0), Bun.sleep(30_000).then(() => pending)]);
      if (settled === pending) console.error(`cross-vendor ${c.name}: laneRun is still running; cleanup may be incomplete (the lane may push or claim after it)`);
    }
    try {
      await cleanupScratch({ forge: inner, raw, touched, ledgerBranch, signal: callSignal });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
