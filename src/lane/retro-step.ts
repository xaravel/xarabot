import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalPaths } from "../core/ci/approval.ts";
import { pollDelayMs } from "../core/ci/checks.ts";
import type { RepoConfig } from "../core/config/load-repo-config.ts";
import { coordinatorWriteRules } from "../core/lane/write-check.ts";
import { describeMissing, missingGlobs } from "../core/manifests/coverage.ts";
import { normalizeGlob } from "../core/manifests/globs.ts";
import { park, release, startMerging } from "../core/ledger/edits.ts";
import { unitBranch } from "../core/next/coordinator.ts";
import { buildRetroPrompt, type PromptSection } from "../core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE } from "../core/prompt/template.ts";
import { checkRetroDiff, checkRetroResult, retroDocGlob, type RetroTree } from "../core/retro/validate.ts";
import { addProvider } from "../core/review/reviewer.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import { describeIssues } from "../core/schemas/common.ts";
import { EpicPrsSchema, type EpicPr, type EpicPrs } from "../core/schemas/epic-prs.ts";
import type { RetroRecordResult } from "../core/schemas/retro-gates.ts";
import type { RetroResult } from "../core/schemas/session-result.ts";
import type { Snapshot } from "../core/schemas/snapshot.ts";
import type { AgentSettings } from "../ports/agent.ts";
import { isBackoffKind } from "../ports/forge.ts";
import type { SandboxProfile } from "../ports/sandbox.ts";
import type { Committer } from "./committer.ts";
import type { CoordinatorStep, CoordinatorStepInput, SessionStepDeps } from "./coordinator-process.ts";
import type { DiffPaths } from "./diff-paths.ts";
import { laneLayout } from "./lane-store.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep } from "./ledger-cas.ts";
import { ENQUEUE_TRIES, gateComment } from "./merge-step.ts";
import { shown } from "./pr-step.ts";
import { reparkComment } from "./reconcile-step.ts";
import { coordinatorChecks } from "./review-gate.ts";
import {
  createSessionRunner,
  describeError,
  End,
  Halt,
  LIMIT_STOP_REASON,
  MarkerStop,
  message,
  sessionAllowance,
  stepKit,
  stepOps,
  unitSubject,
  type PromptOutcome,
  type PrStepOutput,
  type SessionContext,
  type SessionOutcome,
} from "./session.ts";
import type { TreeFiles } from "./tree-files.ts";

/**
 * The retro step (Story 2.9, FR10, AR13, AR15, AR30): one sandboxed
 * `bmad-retrospective -H <N>` session through the shared runner for
 * `retro:<N>`, then the commit, PR, CI and gate, with no CI-fix session and
 * no loopback.
 *
 * - Before the session the runner prefetches the Epic's PRs (those on its
 *   Story branches, in graph order, each with its reviews); the prompt
 *   callback writes them, after `prepare`, to `<tmp>/epic-<N>-prs.json`,
 *   checked against `EpicPrsSchema`. Any forge failure is a failed attempt.
 *   The session never touches GitHub.
 * - The `retro` result is checked before the commit (`checkRetroResult`:
 *   item ids, globs that normalize and are not refused; then each lane
 *   item's globs against fresh `main`'s tree under `missingGlobs`, so they
 *   name each `src/` path's tests and wiring) and, after the
 *   commit and before any push, against the commit through `TreeFiles`
 *   (`checkRetroDiff`: the items are the action items the commit appends,
 *   exactly one retro document is added or changed, and its verdict is the
 *   result's). A failure is a failed attempt, with nothing pushed.
 * - The publish works as a status planning unit's: the coordinator write
 *   check (a refusal parks `write-check`), the leased push, the PR, then a
 *   `record` beat that also stores the result as the record's
 *   `retro_result`, which `reconcile` writes to `retro-gates.yaml` after the
 *   merge; a PR that beat fails to record is closed, since no record carries
 *   it. CI failing parks `verification`, timing out `ci-timeout`. After
 *   CI, fresh `main` is re-read; a path policy gates parks
 *   `awaiting-approval`, else the PR is fenced, written `merging` and
 *   enqueued at its head. A conflicting enqueue parks `awaiting-approval`
 *   with the diff's paths and a 🤖 comment: a retro is one-shot and never
 *   disposable. Its diff holds no graph input, so it skips the graph-change
 *   gate.
 * - After CI and the PR checks on fresh `main` (Story 3.5): the passed gate
 *   at the head; a head no review passed gets one review round (the normal
 *   pass), and a blocking round parks `blocked` `review-findings` for the
 *   Maintainer, with no loopback. A round that passes starts CI and the
 *   checks again on fresh `main`, where the gate passes the head. Then,
 *   before any gate, fresh `main`'s policy must still allow the lane's agent
 *   and a reviewer (`allowanceReason`, else a failed attempt); the enqueue
 *   fence records `enqueued_sha`. Both steps share these checks
 *   (`coordinatorChecks`).
 * - A unit adopted with its open PR runs no session. The ledger keeps a
 *   `retro_result` only at the PR and head it was validated at, so with one
 *   its CI is polled at the record's `head_sha` and the gate follows. When
 *   the PR's head moved, the adopting claim dropped it: the result the record
 *   held before the claim is checked again (`checkRetroDiff`) against the
 *   moved head onto fresh `main`, and recorded with that head before CI and
 *   the gate; a mismatch, or no result to check, is a failed attempt. Before
 *   either, an empty `builder_providers` gets the lane's vendor in a fence
 *   (Epic 2 retro item 29).
 *
 * Every push, PR change and enqueue is fenced; the push's fence adds the
 * lane's vendor to the record's `builder_providers` (AD-16). Like the
 * planning step, the session runs outside `kit.run`, so a `Halt` reaches
 * the coordinator process; anything else never throws.
 */

export type RetroStepDeps = SessionStepDeps & {
  /** `main`'s and the commit's trees, for the post-commit check. */
  readonly treeFiles: TreeFiles;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const PROMPT_SECTION = /^\.xarabot\/prompts\/([^/]+\.md)$/;

/** The prefetched PR file's name in the lane's `tmp`. */
export function epicPrsFileName(epic: number): string {
  return `epic-${epic}-prs.json`;
}

/** The Epic of a `retro:<N>` id. */
export function retroEpic(unit: string): number {
  return Number(unit.slice(unit.indexOf(":") + 1));
}

/** The Story ids of Epic `epic`, in graph order; `[]` when the graph did not resolve. */
export function epicStories(snapshot: Snapshot, epic: number): string[] {
  if (!snapshot.graph.ok) return [];
  return [...(snapshot.graph.value.epics.find((e) => e.number === epic)?.stories ?? [])];
}

/** A glob in normalized form; one that does not normalize is kept as it is (the result check refuses it first). */
function normalizedGlob(glob: string): string {
  const n = normalizeGlob(glob);
  return n.ok ? n.value : glob;
}

const oneLine = (text: string, secrets: readonly string[]): string => sanitizeAgentText(text, { secrets }).replace(/\s+/g, " ").trim();

/** The commit message, PR title and PR body for a retro unit's result. */
export function retroPrText(
  unit: string,
  result: Pick<RetroResult, "verdict" | "items" | "denied_actions">,
  secrets: readonly string[] = [],
): { readonly message: string; readonly title: string; readonly body: string } {
  const epic = retroEpic(unit);
  const title = capText(`${unit}: Epic ${epic} retrospective (${result.verdict})`, FORGE_TEXT_LIMITS.title);
  const items = result.items.map((i) => {
    const globs = i.globs.length === 0 ? "no globs" : i.globs.map((g) => `\`${oneLine(g, secrets).replaceAll("`", "'")}\``).join(", ");
    return `- \`${i.id}\` (${i.route}, ${i.blocking ? "blocking" : "not blocking"}; ${globs}): ${oneLine(i.text, secrets)}`;
  });
  const listed = items.length === 0 ? "Action items: none." : ["Action items:", ...items].join("\n");
  const denied = result.denied_actions.map((a) => oneLine(a, secrets)).filter((a) => a !== "");
  const body = [
    `🤖 ${unit}: written by a \`bmad-retrospective -H ${epic}\` session.`,
    "",
    `Verdict: \`${result.verdict}\`.`,
    "",
    listed,
    "",
    "The runner queues this PR once its checks pass, unless policy gates a path it changes. Once it merges, `reconcile` records the verdict and the items in `retro-gates.yaml`.",
    "",
    denied.length === 0 ? "Denied actions: none." : ["Denied actions:", ...denied.map((a) => `- ${a}`)].join("\n"),
    "",
  ].join("\n");
  return { message: `${title}\n\n${listed}\n`, title, body: capText(body, FORGE_TEXT_LIMITS.body) };
}

export function createRetroStep(deps: RetroStepDeps): CoordinatorStep {
  const { forge, identity, committer } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const secrets = deps.secrets ?? [];
  const layout = laneLayout(deps.laneDir);
  const settings: AgentSettings = { effort: deps.lane.effort, ...(deps.lane.model !== undefined ? { model: deps.lane.model } : {}) };

  return async (input: CoordinatorStepInput): Promise<PrStepOutput> => {
    const unit = input.unit.unit;
    const epic = retroEpic(unit);
    const snapshot = input.snapshot;
    const config = snapshot.config;
    const branch = unitBranch(config.branches.xarabot, unit);
    const kit = stepKit({
      name: "retro step",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
      seen: snapshot.now,
      mainSha: snapshot.main_sha,
    });
    const { generation, reasons, note, end, forgeNow, call, swap, failed, held, beat } = kit;
    const { aborted, parkBlocked, freshMain, poll, closeOrphans, recordPr } = stepOps({
      kit,
      forge,
      identity,
      repo: deps.lane.repo,
      signal: input.signal,
      abortReason: "the unit or the coordinator claim was lost during the retro step",
      clock,
      sleep,
    });

    /** Parks `awaiting-approval` holding `paths`, with `comment` on the PR. */
    const parkForApproval = async (pr: number, paths: readonly string[], why: string, comment: string): Promise<never> => {
      await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "awaiting-approval", diffPaths: paths }));
      reasons.push(why);
      note(`parked awaiting-approval: ${why}`);
      const commented = await call("comment", (o) => forge.comment(pr, comment, o));
      if (!commented.ok) {
        reasons.push(`comment on PR #${pr} failed: ${describeError(commented.error)}`);
        note(`comment failed: ${describeError(commented.error)}`);
      }
      throw end("progress", kit.record.state);
    };

    /** CI at `head`, fresh `main`, the gate, then `merging` and the enqueue, or the approval park. */
    const ciAndGate = async (pr: number, head: string): Promise<never> => {
      // 1-2. CI, fresh main and the PR on it, the passed gate or a review round, and the allowance.
      const { snap, config: repo } = await coordinatorChecks({
        kit,
        ops: { aborted, parkBlocked, freshMain, poll },
        identity,
        agent: deps.lane.agent,
        passed: deps.passed,
        review: deps.review,
        input: { unit: { unit, subject: unitSubject(unit) }, storyId: null, track: input.track, signal: input.signal, log: input.log },
        pr,
        head,
        ciWaitMs: config.ci_max_wait_minutes * MINUTE_MS,
        expectedChecks: snapshot.policy.expected_checks,
        callTimeoutMs,
      });

      // 3. The approval gate: only when policy gates a path. No graph-change gate: the diff holds no graph input.
      let changed: Awaited<ReturnType<DiffPaths>>;
      try {
        changed = await deps.diffPaths({ headSha: head, mainSha: snap.main.sha, signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]) });
      } catch (e) {
        changed = { ok: false, error: { kind: "transient", message: `diff paths threw: ${message(e)}` } };
      }
      aborted();
      if (!changed.ok) return await failed(`diff paths ${changed.error.kind}: ${changed.error.message}`);
      const policy = repo.repo.policy;
      const gated = approvalPaths(changed.value, [...policy.owner_approval_paths, ...policy.effective_protected_paths]);
      if (gated.length > 0) {
        return await parkForApproval(pr, changed.value, `awaiting approval: ${gated.map(shown).join(", ")}`, gateComment(`Unit ${unit}`, gated));
      }

      // 4. Fence, merging, enqueue at the head; the queue is not watched.
      await beat("fence", { enqueued_sha: head });
      await held("startMerging", startMerging({ unit, by: identity, now: forgeNow(), generation }));
      note(`merging at ${head}`);
      for (let n = 0; ; n += 1) {
        aborted();
        if (n > 0) await beat("fence");
        const r = await call("enqueue", (o) => forge.enqueue(pr, head, o));
        if (r.ok) {
          reasons.push(`PR #${pr} enqueued at ${head}`);
          note(`enqueued PR #${pr} at ${head}`);
          throw end("progress", kit.record.state);
        }
        if (r.error.kind === "conflict") {
          // A retro is one-shot: its PR is never disposable, so a conflict parks it for the Maintainer.
          note(`enqueue conflict: ${r.error.message}`);
          return await parkForApproval(pr, changed.value, `enqueue PR #${pr} ${describeError(r.error)}: parked awaiting approval`, reparkComment(unit, "conflict"));
        }
        if (!isBackoffKind(r.error.kind) || n + 1 >= ENQUEUE_TRIES) return await failed(`enqueue ${describeError(r.error)}`);
        const delay = r.error.kind === "rate-limited" ? Math.max(pollDelayMs(n), r.error.retry_after * 1000) : pollDelayMs(n);
        note(`enqueue ${describeError(r.error)}; retrying in ${delay} ms`);
        await sleep(delay, input.signal);
      }
    };

    /** One commit's tree and the files the post-commit check reads. */
    const treeAt = async (sha: string, read: (path: string) => boolean): Promise<RetroTree> => {
      let r: Awaited<ReturnType<TreeFiles>>;
      try {
        r = await deps.treeFiles({ sha, read, signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]) });
      } catch (e) {
        r = { ok: false, error: { kind: "transient", message: `tree files threw: ${message(e)}` } };
      }
      aborted();
      if (!r.ok) return await failed(`tree files ${r.error.kind}: ${r.error.message}`);
      return r.value;
    };

    /** `checkRetroDiff`'s failures for `result` against `head` onto `onto`, the two trees read through `TreeFiles`. */
    const diffFailures = async (result: RetroRecordResult, repoConfig: RepoConfig["repo"]["config"], onto: string, head: string): Promise<string[]> => {
      const docGlob = new Bun.Glob(retroDocGlob(repoConfig.retro_doc_glob, epic));
      const read = (path: string) => path === repoConfig.sprint_status_path || docGlob.match(path);
      const before = await treeAt(onto, read);
      const after = await treeAt(head, read);
      return checkRetroDiff({ epic, result, config: repoConfig, onto: before, head: after });
    };

    /**
     * An adopted PR whose head moved from `validated`, where its result was
     * checked, to `head`: the result checked again against `head` onto fresh
     * `main`, then recorded with `head`, then CI and the gate.
     */
    const recheck = async (pr: number, result: RetroRecordResult, validated: string, head: string): Promise<never> => {
      note(`PR #${pr} head moved from ${validated} to ${head}: checking its result again`);
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const onto = fresh.value.snap.main.sha;
      const post = await diffFailures(result, fresh.value.config.repo.config, onto, head);
      if (post.length > 0) return await failed(`retro result against PR #${pr}'s moved head ${head}: ${post.join("; ")}`);
      note(`the result matches PR #${pr}'s moved head ${head} onto ${onto}`);
      await beat("record", { head_sha: head, retro_result: result });
      return await ciAndGate(pr, head);
    };

    /** The result checked, then the commit onto fresh `main` behind the write check and against the result, the leased push, the PR, then CI and the gate. */
    const publish = async (result: RetroResult): Promise<never> => {
      // 1. Fresh main: the write check's rules and the refused globs come from it.
      const fresh = await freshMain();
      if (!fresh.ok) return await failed(`snapshot ${describeError(fresh.error)}`);
      const { snap, config: repo } = fresh.value;
      const onto = snap.main.sha;
      note(`fresh main ${onto}`);
      const repoConfig = repo.repo.config;

      // 2. The result on its own: item ids and globs.
      const pre = checkRetroResult(epic, result, repoConfig, repo.repo.policy);
      if (pre.length > 0) return await failed(`retro result: ${pre.join("; ")}`);
      // Every glob normalized (the check passed it): the record and the PR carry what retro-gates.yaml will.
      const normalized: RetroResult = { ...result, items: result.items.map((i) => ({ ...i, globs: i.globs.map(normalizedGlob) })) };
      // Each lane item's globs name its src/ paths' tests and wiring (Epic 3 retro item 14).
      const uncovered = normalized.items.flatMap((i) => {
        const missing = i.route === "lane" ? missingGlobs(i.globs, snap.main.tree) : [];
        return missing.length === 0 ? [] : [`item ${i.id}: its globs miss ${describeMissing(missing)}`];
      });
      if (uncovered.length > 0) return await failed(`retro result: ${uncovered.join("; ")}`);

      // 3. Commit, behind the coordinator write check.
      const rules = coordinatorWriteRules({ config: repoConfig, globs: kit.record.globs, graphUnit: false });
      const text = retroPrText(unit, normalized, secrets);
      let committed: Awaited<ReturnType<Committer["commit"]>>;
      try {
        committed = await committer.commit({
          unit,
          ontoSha: onto,
          message: text.message,
          secrets,
          rules,
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        });
      } catch (e) {
        committed = { ok: false, error: { kind: "transient", message: `commit threw: ${message(e)}` } };
      }
      aborted();
      if (!committed.ok) return await failed(`commit ${committed.error.kind}: ${committed.error.message}`);
      const c = committed.value;
      if (c.kind === "conflict") return await failed(`commit conflict onto ${onto}: ${c.paths.map(shown).join(", ")}`);
      if (c.kind === "refused") {
        for (const r of c.refusals) note(`write-check: refused ${shown(r.path)} (${r.class})`);
        return await parkBlocked("write-check", `write-check: refused ${c.refusals.map((r) => `${shown(r.path)} (${r.class})`).join(", ")}`);
      }
      if (c.kind === "empty") return await failed("the retro session changed nothing onto main");
      const head = c.head_sha;
      note(`committed ${head} onto ${c.base_sha}`);

      // 4. The result against the commit, before any push.
      const post = await diffFailures(result, repoConfig, c.base_sha, head);
      if (post.length > 0) return await failed(`retro result against the commit: ${post.join("; ")}`);
      note("the result matches the commit");

      // 5. The lease: the branch's real head (a branch an earlier attempt left).
      const leased = await call("branchHead", (o) => forge.branchHead(branch, o));
      if (!leased.ok) return await failed(`branchHead ${describeError(leased.error)}`);
      const expected = leased.value;
      if (expected !== null) note(`${branch} is at ${expected}: the push leases from it`);

      // 6. Fence, adding the lane's vendor to the builders before the branch moves (AD-16), then push with the lease.
      await beat("fence", { builder_providers: addProvider(kit.record.builder_providers, deps.provider) });
      aborted();
      const pushed = await call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: expected, sha: head }, o));
      if (!pushed.ok) return await failed(`pushBranch ${branch} ${describeError(pushed.error)}`);
      note(`pushed ${head} to ${branch}`);

      // 7. Fence, then open the PR and record it with the result.
      await beat("fence");
      aborted();
      const opened = await call("openPr", (o) => forge.openPr({ branch, base: "main", title: text.title, body: text.body }, o));
      if (!opened.ok) {
        // The forge may have opened it anyway: no record carries it, so close any open PR on the branch.
        await closeOrphans(branch);
        return await failed(`openPr ${describeError(opened.error)}`);
      }
      const pr = opened.value.number;
      note(`opened PR #${pr}`);
      const retroResult: RetroRecordResult = { verdict: normalized.verdict, items: normalized.items };
      await recordPr(pr, { pr, pr_owner: identity.owner, head_sha: head, base_sha: c.base_sha, retro_result: retroResult });
      return await ciAndGate(pr, head);
    };

    /**
     * An adopted PR's builders (AD-16, Epic 2 retro item 29): an empty
     * `builder_providers` (an adopted PR with no prior record, or a record a
     * runner older than Story 3.3 wrote) gets the lane's vendor in a fence,
     * so the review round's reviewer is cross-vendor relative to this lane; a
     * non-empty set is left as it is.
     */
    const adoptVendor = async (): Promise<void> => {
      if (kit.record.builder_providers.length > 0) return;
      note(`PR #${kit.record.pr ?? "none"} adopted with no builder_providers: adding ${deps.provider}`);
      await beat("fence", { builder_providers: addProvider(kit.record.builder_providers, deps.provider) });
    };

    /** `kit.run` for a body that may throw a `Halt` (from the review round): it reaches the process. */
    const runKit = async (body: () => Promise<PrStepOutput>): Promise<PrStepOutput> => {
      try {
        return await body();
      } catch (e) {
        if (e instanceof End) return e.out;
        if (e instanceof Halt) throw e;
        return kit.run(() => failed(`unexpected error: ${message(e)}`));
      }
    };

    // ------------------------------------------------------------ the unit

    // A unit adopted with its open PR runs no session: with its result, CI at the record's head, then the gate.
    const adopted = input.record.pr;
    const adoptedHead = input.record.head_sha;
    if (adopted !== null) {
      note(`resuming PR #${adopted} at ${adoptedHead ?? "no head"}: no session`);
      const kept = input.record.retro_result;
      // The record as the snapshot shows it, before this claim: its result at another head of the same PR was validated there, not here.
      const before = snapshot.ledger.units.find((r) => r.unit === unit);
      const moved = before?.retro_result != null && before.pr === adopted && before.head_sha !== null && before.head_sha !== adoptedHead ? before : null;
      return runKit(async () => {
        if (adoptedHead === null) return await failed(`PR #${adopted} has no head_sha on the record`);
        if (moved === null && kept === null) return await failed(`PR #${adopted} has no retro_result on the record`);
        await adoptVendor();
        return moved !== null ? await recheck(adopted, moved.retro_result as RetroRecordResult, moved.head_sha as string, adoptedHead) : await ciAndGate(adopted, adoptedHead);
      });
    }

    // The prefetch: the Epic's Story branches' PRs, each with its reviews.
    type Prefetched = { readonly ok: true; readonly value: EpicPrs } | { readonly ok: false; readonly reason: string };
    const prefetch = async (): Promise<Prefetched> => {
      const prs: EpicPr[] = [];
      for (const story of epicStories(snapshot, epic)) {
        aborted();
        const storyBranch = `${config.branches.story}${story}`;
        const listed = await call("listPrsByBranch", (o) => forge.listPrsByBranch(storyBranch, o));
        if (!listed.ok) return { ok: false, reason: `prefetch: listPrsByBranch ${storyBranch} ${describeError(listed.error)}` };
        for (const p of listed.value) {
          const reviews = await call("reviews", (o) => forge.reviews(p.number, o));
          if (!reviews.ok) return { ok: false, reason: `prefetch: reviews PR #${p.number} ${describeError(reviews.error)}` };
          prs.push({
            story,
            number: p.number,
            title: p.title,
            body: p.body,
            state: p.state,
            head_sha: p.head_sha,
            merge_sha: p.merge_sha,
            reviews: reviews.value.map((r) => ({ author: r.author, state: r.state, submitted_at: r.submitted_at, commit_sha: r.commit_sha })),
          });
        }
      }
      const checked = EpicPrsSchema.safeParse({ schema_version: 1, epic, prs });
      if (!checked.success) return { ok: false, reason: `prefetch: ${describeIssues(checked.error)}` };
      return { ok: true, value: checked.data };
    };

    let fetched: Prefetched;
    try {
      fetched = await prefetch();
    } catch (e) {
      if (e instanceof End) return e.out;
      fetched = { ok: false, reason: `prefetch threw: ${message(e)}` };
    }
    if (!fetched.ok) {
      const why = fetched.reason;
      return kit.run(() => failed(why));
    }
    const epicPrs = fetched.value;
    note(`prefetched ${epicPrs.prs.length} PR(s) of Epic ${epic}`);

    const budget = AbortSignal.timeout(config.unit_budget_hours * HOUR_MS);
    /** Set when a STOP ended a usage-limit sleep and the unit was released. */
    let limitStopped = false;
    const profile: SandboxProfile = {
      clone: layout.clone,
      vendorHome: layout.vendorHome,
      tempDir: layout.tmp,
      runnerGit: layout.runnerGit,
      resultPath: layout.resultPath,
      repoHosts: config.proxy_hosts,
    };
    const ctx: SessionContext = {
      track: input.track,
      branch,
      profile,
      budget,
      overBudget: () => `unit budget of ${config.unit_budget_hours} h passed`,
      signals: () => [input.signal],
      // The process's own check abandons the unit once the step ends.
      checkHeld: async () => aborted(),
      onLimitStop: async () => {
        const r = await swap(release({ unit, by: identity, now: forgeNow(), generation }));
        if (r.kind !== "ok") reasons.push(`release: ${r.message}`);
        input.track.record = kit.record;
        input.track.state = r.kind === "ok" ? kit.record.state : null;
        limitStopped = true;
      },
      // Before each fresh session: fresh main's policy must still allow the lane's agent and a reviewer (Story 3.5).
      allowed: sessionAllowance({ forge, repo: deps.lane.repo, agent: deps.lane.agent, builderProviders: () => kit.record.builder_providers, callTimeoutMs }),
    };
    const runner = createSessionRunner({
      agent: deps.agent,
      sandbox: deps.sandbox,
      store: deps.store,
      workspace: deps.workspace,
      waiter: deps.waiter,
      layout,
      settings,
      ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
      clock,
      note: (text) => note(text),
      log: (text) => {
        try {
          deps.store.appendLog(input.track.logName, text);
        } catch {
          // A log that cannot be written never ends the step.
        }
      },
      reportStore: (r, what) => {
        if (!r.ok && r.error !== undefined) note(`lane store: ${what}: ${r.error.kind}: ${r.error.message}`);
      },
    });

    const sections: PromptSection[] = [];
    for (const path of Object.keys(input.files).sort()) {
      const m = PROMPT_SECTION.exec(path);
      const text = input.files[path];
      if (m !== null && text !== undefined) sections.push({ name: m[1] as string, text });
    }
    /** After `prepare` emptied `tmp`: the prefetched PRs written there, then the prompt naming them. */
    const prompt = (): PromptOutcome => {
      const prsPath = join(layout.tmp, epicPrsFileName(epic));
      try {
        writeFileSync(prsPath, `${JSON.stringify(epicPrs, null, 2)}\n`);
      } catch (e) {
        return { ok: false, reason: `prefetch: cannot write ${prsPath}: ${message(e)}` };
      }
      const built = buildRetroPrompt({ template: PACKAGE_TEMPLATE, unit: { kind: "retro", id: unit, epic, prs_path: prsPath }, sections, result_path: layout.resultPath });
      return built.ok ? { ok: true, value: built.value } : { ok: false, reason: `prompt ${built.error.kind}: ${built.error.message}` };
    };

    // The session runs outside `kit.run`: a `Halt` reaches the process.
    let ran: SessionOutcome<"retro">;
    try {
      ran = await runner.session(ctx, { at: snapshot.main_sha, kind: "retro", prompt });
    } catch (e) {
      if (e instanceof End) return e.out;
      if (e instanceof Halt) throw e;
      return kit.run(() => failed(`session threw: ${message(e)}`));
    }
    if (limitStopped) {
      note(`stop: ${LIMIT_STOP_REASON}`);
      throw new MarkerStop("stop", LIMIT_STOP_REASON);
    }
    if (!ran.ok) {
      const why = ran.reason;
      return kit.run(() => failed(why));
    }
    const result = ran.result;
    note(`result: ${result.verdict}, ${result.items.length} item(s)`);
    return runKit(() => publish(result));
  };
}
