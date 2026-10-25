---
title: 'Story 2.7: Planning units'
type: 'feature'
created: '2026-10-24'
baseline_revision: 'fdcb807efa7eb7f069aa16e5b8288813f22983b8'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A failed planning session never reaches the attempts cap: it releases its record, the next run is n + 1, and a session that keeps failing re-runs after every failed wait (15 min).
    evidence: |-
      failAttempt releases with attempts + 1; nextPlanning ignores released records and numbers a new id; reconcile deletes the released one. The cap trips only on one id (stale takeovers, or failures after the PR opened). The 2026-10-25 id rule and the release AC select this reading; a cap across runs needs a Maintainer decision.
    location: >-
      src/core/next/coordinator.ts (nextPlanning), src/lane/planning-step.ts
    severity: medium
  - summary: >-
      A gated status planning PR (owner_approval_paths ["**"] in this repo) can go stale against reconcile's status PRs; after approval a conflicting enqueue re-parks it, and the status kind stays held until rule rebuild.
    evidence: |-
      isDisposable is true only for approved_sha null; takeApproved sets approved_sha, so the reconcile take path re-parks on conflict (Story 2.6). The 2026-10-25 decision makes only ungated status PRs disposable.
    location: >-
      src/core/ledger/edits.ts (isDisposable), src/lane/reconcile-step.ts (take)
    severity: medium
  - summary: >-
      lane run's planning-step wiring (secrets, sandbox, clone) is tested only for existence, so dropping the credential from secrets would go unnoticed.
    evidence: |-
      test/cli/lane-run.test.ts checks only that steps.planning is a function; the builder PR step's secrets wiring has the same gap from before Story 2.7.
    location: >-
      src/cli/lane-run.ts:294-311
    severity: medium
  - summary: >-
      A readiness park's findings live only in the coordinator's host-local journal, not on the ledger or GitHub, so Story 4.2's inbox cannot show them.
    evidence: |-
      AR6 has no text field on the park, and Story 4.2 renders the inbox from parked records, as for builder blocked parks. Settled once the Maintainer says whether findings must reach the ledger or GitHub.
    location: >-
      src/lane/planning-step.ts (afterSession)
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** The coordinator's planning position is a stub. `next` never returns a planning unit, and `lane run` wires no planning step. So the Maintainer still runs `bmad-sprint-planning` by hand, compiles each Epic's context file and writes the manifests for new Story headings. Nothing parks a blocked planning run (`readiness`), and the ledger schema has no room for the new cause (FR2, NFR5, AR14, AR30).

**Approach:**
- `next` gains the planning position. A graph unit comes before a status unit. A blocked park, or any live record of a kind, holds that kind.
- A new coordinator step, `planning`, runs one sandboxed session through the shared runner (Story 2.6a).
  - A status unit runs `bmad-sprint-planning` headless and compiles the due Epic contexts.
  - A graph unit writes the missing manifests.
- The step then commits behind the coordinator write check, pushes, opens the PR and polls CI with no fix session.
  - A graph PR always parks for approval.
  - A status PR is gated only by policy. When nothing gates it, it enqueues itself and is disposable, like `reconcile`'s PR.
- `reconcile` learns the planning records: the disposable queue check, and deleting `released` records.
- The ledger `schema_version` goes to 2. The reader accepts 1 and 2.

## Boundaries & Constraints

**Always:**
- **Ids, slugs and branches.** Ids are `planning:status.<n>` and `planning:graph.<n>`. `n` is the highest `n` of that slug on the ledger, in any state, plus 1. The branch is `<branches.xarabot>planning-<slug>.<n>`. The push leases from `Forge.branchHead` when the record has no PR, so a reused `n` works. A record's kind comes from its slug; a record with any other slug counts as graph when it holds `xarabot:graph`, else as status.
- **Graph due.** The graph resolved, and `graph.unmanifested` has a heading in an Epic not listed in `bootstrapped_epics`.
- **Status due.** Either reason makes a status unit due:
  - a `missingStatusEntries` key of an Epic not in `bootstrapped_epics`, unless a `merged` graph planning record is not yet done on `main` (`reconcile` writes those keys);
  - an Epic not in `bootstrapped_epics` whose context is not `valid`, which has a manifested Story not `done`, and which no `dependency-epic` or `retro-rejected` hold keeps back. Those holds are the builder's, factored into one shared helper.
- **Holds, per kind.** No new unit of a kind is due while a record of that kind is `parked` (any park kind), `merging`, or live `claimed`.
  - A stale `claimed` record with no open PR is taken over instead: same id, `take_over: "claimed"`.
  - `released` and `merged` records never hold.
  - A due unit whose globs overlap another record's held globs is not due either; an `overlap` reason is recorded.
- **Prompts.** `core/prompt` gets a pure `buildPlanningPrompt`, plus new parts in the package template.
  - **Status:** run stock `bmad-sprint-planning` headless. Return readiness findings in the result (`outcome: blocked`, the findings in `summary`) and never save a findings file. For each due Epic, follow `.claude/skills/bmad-build-auto/compile-epic-context.md` with the Epic number, `epics_path`, the folder of `epics_path` and the context output path.
  - **Graph:** run no skill and never run `bmad-sprint-planning`. Name each heading with no manifest (id, Epic, line). Ask for `<manifests.dir>/<id>.md` with the manifest frontmatter, and for `depends_on` on each Story that builds on an earlier one, in the same Epic or an Epic it depends on. Allow edits to `epics_path` and `.xarabot/epics.yaml` and state that file's schema. Allow no other file.
  - Both prompts: rules and repo sections as for a story, then the `planning` result step with its JSON Schema, last. No CI, merge, queue, PR, push, approval, claim, `next`, ledger or select/pick/choose word.
- **Step outcomes.** A missing or invalid result, a commit conflict, or a push or PR failure is a failed attempt (`failAttempt`).
  - `blocked` parks `blocked` `readiness`. Its journal reason is `blocked readiness: <summary>`.
  - `nothing-due`, or `done` with an empty commit: `finishRecurring`, then `deleteMerged` of the step's own record.
  - A write-check refusal parks `write-check`.
  - CI failing parks `verification`; CI timing out parks `ci-timeout`.
- **Enqueue.** Every push, PR change and enqueue is fenced with a `beat`. The enqueue passes the head SHA. The Standing Authority is re-checked on fresh `main` before the gate.
- **Resuming an adopted PR.** A unit the open-PR position adopts runs no session. Its CI is polled at the record's `head_sha`, and the gate follows.
- **Schema v2 (ledger only).** `LEDGER_SCHEMA_VERSION = 2`. `UnitRecordSchema` and `CoordinatorRecordSchema` accept 1 or 2. `parseLedger` stops on any other integer. Every ledger record written (fresh, stamped and `coordinator.json`) carries 2. `readiness` joins `RUNNER_CAUSES`. The other files stay at version 1.

**Never:**
- No `approved_graph`, graph-delta comment or merge-result validation (Story 2.8). No retro or retro-item step. No inbox issue body or digest (Story 4.2). No findings field on the record.
- No CI-fix session or loopback for planning. No change to `.github/`, `AGENTS.md`, `_bmad/`, the spec folder or the `runner_version` pin.
- Never run `bmad-create-epics-and-stories` or `bmad-correct-course`. Never give the session a GitHub token.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Graph first | unmanifested 3.1, Epic 3 missing from status | `planning:graph.1` | — |
| Context only | Epic 2 context missing, Story 2.1 backlog, every key present | `planning:status.1` | — |
| Bootstrapped | heading or missing context only in Epic 1, `bootstrapped_epics: [1]` | idle | — |
| Readiness park | `planning:status.2` parked `blocked` `readiness`, status due | idle; `planning:graph.1` still due if graph due | — |
| Release | `planning:status.2` released, status due | `planning:status.3` | — |
| Stale claim | `planning:graph.1` claimed 30 min stale, no PR | `planning:graph.1`, `take_over: claimed` | — |
| Ungated status ejected | `merging`, `approved_sha: null`, not queued | `reconcile` closes the PR, `releaseDisposable` | no attempt |
| Gated graph ejected | `merging`, `approved_sha` set | re-park `awaiting-approval` (Story 2.6) | — |
| Released planning, PR not open | `released`, PR closed or none | `reconcile` closes open branch PRs, `deleteReleasedRecurring` | — |
| Released planning, PR open | `released`, PR open | left: the open-PR position resumes it | — |
| Ledger v1 and v2 | records at 1 and 2 | both parse; a write stamps 2 | v0 and v3 stop (`ledger-schema-version`) |

</intent-contract>

## Code Map

- `src/core/schemas/ledger.ts`: `RUNNER_CAUSES`, both record schemas (`schema_version`). `PLANNING_BODY` already accepts `status.<n>` and `graph.<n>`.
- `src/core/ledger/codec.ts:37`: the `parseRecord` version stop. `src/core/ledger/edits.ts`:
  - `fresh` (line 201), `stamp` and the `coordinator.json` writer (line 866) stamp the version;
  - `requireReconcileWriter`, `releaseReconcile` and `deleteReleasedReconcile` (line 742ff) get generalized.
- `src/core/schemas/common.ts`: `SCHEMA_VERSION` stays 1 for every non-ledger file.
- `src/core/next/next.ts` (`nextBuilder`, lines 150–185): the Epic-level `dependency-epic` and `retro-rejected` holds move to a new `src/core/next/epic-gates.ts`. A new module avoids a `next` ↔ `coordinator` import cycle.
- `src/core/next/coordinator.ts`: `nextCoordinator` step 3 is the stub. Reuse `missingStatusEntries`, `coordinatorGlobs`, `isGraphPlanning`, `doneOnMain` and `heldGlobs`/`isStale` (`edits.ts`).
- `src/core/reconcile/plan.ts`: `checkQueue` (reconcile only today), `checkGated`, `deleteReleased`, `releaseDead`. `src/lane/reconcile-step.ts`: `closeBranchPrs`, which uses `reconcileBranch`, `checkQueue`, `take` (conflict) and `release`.
- `src/lane/coordinator-process.ts`: `CoordinatorStepInput` (adds `track`) and the step `catch`, which must rethrow a `Halt` (`MarkerStop`, `Abandon`).
- `src/lane/session.ts`: `createSessionRunner`, `SessionContext`, `stepKit`, `End`, `MarkerStop` and `LIMIT_STOP_REASON`.
- `src/lane/reconcile-step.ts:523–657`: the model for poll → fresh main → gate → `startMerging` → enqueue, and for disposable conflict handling.
- `src/lane/pr-step.ts`: the model for the lease (`branchHead`), push and open, `shown()` and `sanitizeAgentText`.
- `src/lane/committer.ts` (`Committer`, any `WriteRules`), `src/core/lane/write-check.ts` (`coordinatorWriteRules`), `src/lane/diff-paths.ts` (`DiffPaths`), `src/core/ci/approval.ts`, `src/lane/merge-step.ts` (`gateComment`, `ENQUEUE_TRIES`).
- `src/core/prompt/build-prompt.ts` and `template.ts`: the strict `TemplateSchema`, single-pass placeholders and `PLACEHOLDERS`.
- `src/cli/lane-run.ts` (coordinator branch): wire `planning` next to `reconcile`, with sandbox, workspace, committer, diff paths and credential secrets as the builder gets them.
- Tests:
  - `test/core/next/{coordinator.test.ts,fixtures.ts}`: the case table. The default world needs status entries, or the old "idle" rows turn into status units.
  - `test/core/ledger/*`, `test/lane/{heartbeat,pr-step,lane-process}.test.ts` and `test/core/next/snapshot.test.ts`: these use version 2 as "unknown" and move to 3.
  - `test/lane/reconcile-step.test.ts` and `test/core/reconcile/plan.test.ts`.
  - `test/lane/lane-process.test.ts`: the harness model for agent, sandbox and workspace stubs.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts`:
  - ledger schema v2 and `readiness`;
  - rename `releaseReconcile` → `releaseDisposable` (reconcile or status planning) and `deleteReleasedReconcile` → `deleteReleasedRecurring` (reconcile or planning);
  - update the callers.
- `src/core/next/epic-gates.ts` (new), `next.ts`: the shared Epic hold helper, and the `planning-held` reason code.
- `src/core/next/coordinator.ts`: `planningSlug`, `planningDue(snapshot)` (what is due, per kind, for the prompt too), `nextPlanningNumber`, and the planning position.
- `src/core/reconcile/plan.ts`, `src/lane/reconcile-step.ts`:
  - disposable = a `reconcile` record, or a status planning record with `approved_sha: null`;
  - `deleteReleased` covers planning records whose PR is not open;
  - `unitBranch(prefix, unit)` replaces `reconcileBranch` in `closeBranchPrs`.
- `src/core/prompt/template.ts`, `build-prompt.ts`: `planning_status`, `planning_graph` and `result_planning`, and `buildPlanningPrompt`.
- `src/lane/planning-step.ts` (new): `createPlanningStep`.
- `src/lane/coordinator-process.ts`: pass `track`, and rethrow a `Halt`.
- `src/cli/lane-run.ts`: wire the step.
- Tests:
  - `test/core/next/coordinator.test.ts`: every row of the matrix and the AC's case table;
  - prompt tests, including a banned-word table for planning prompts;
  - `test/lane/planning-step.test.ts` (new), on the fake forge with stub agent, sandbox, workspace, committer and diff paths;
  - the reconcile plan and step rows;
  - schema v1, v2 and v3 rows; existing tests migrated.

**Acceptance Criteria:**
- Given a status unit, when its result is `blocked`, then the record parks `blocked` `readiness` with no globs held. Its journal record's reason carries the findings.
- Given a status unit's `done` result whose commit changes only the status files and context files, when CI passes and policy gates nothing, then the record ends `merging`, its PR enqueued at the head.
- Given a graph unit, when CI passes, then it parks `awaiting-approval` holding its diff's paths. A 🤖 comment is posted.
- Given a session diff touching a graph input and a status file, when committed, then nothing is pushed and the record parks `write-check`.
- Given the Maintainer runs `xarabot rule release planning:status.2`, when the coordinator next runs, then `planning:status.3` may be due. A later `reconcile` deletes `planning:status.2`.
- Given a STOP during the session's usage-limit sleep, when the step ends, then the unit is released and the run ends `stop`, not as a lane stop.
- Given `bun test`, `tsc` and `oxlint`, when run, then they report 0 fail and no error.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 27 findings — high 0, medium 5, low 14, false 7, maybe-false 1
- findings:
  - `[low]` `[reject]` Graph PR with an empty diff against fresh `main` parks for approval of nothing (blind) — real but rare (`main` must gain the same change during CI); the outcome is safe: the PR waits for the Maintainer, who can close it. Finishing the unit instead adds a new branch.
  - `[medium]` `[defer]` A gated status PR goes stale against `reconcile`'s status PRs; once approved, a conflict re-parks it (Story 2.6) and the status kind stays held until `rule rebuild` (blind) — the 2026-10-25 decision makes only ungated status PRs disposable. Making gated ones disposable too needs the Maintainer.
  - `[medium]` `[defer]` Failed planning sessions never reach the attempts cap: each failure releases, and the next run is `n` + 1 (blind) — the Design Notes record this reading of the id rule and the `release` AC. A cap across runs needs a Maintainer decision.
  - `[low]` `[patch]` `dispose` releases the record even when `closePr` failed, so the open-PR position resumes it each round with no attempt counted (blind) — a failed `closePr` now ends in a failed attempt; test added.
  - `[low]` `[patch]` Readiness findings are stored uncapped, and the docs disagree on where they go (blind) — the journal reason is capped at the body limit; `self-host.md` names the coordinator journal.
  - `[low]` `[patch]` The `self-host.md` paragraph lacks the journal's location, the steps after a `readiness` park, the full `rule release` command, missing Story keys and the `manifests` requirement (blind) — paragraph tightened.
  - `[low]` `[patch]` The ledger v2 rollout and rollback are not written down (blind) — `self-host.md` now says to advance every lane's pin together and never pin back before 2.7.
  - `[false]` `[reject]` The Epic context rewrite drops rules later Stories need (blind) — it is the stock `compile-epic-context.md` output, which scopes aggressively, and the runner's builder write check reverts a builder diff's change to the context file anyway.
  - `[low]` `[reject]` The status prompt names neither `sprint_status_path` nor the missing keys, and hard-codes `.claude/skills` (blind) — a mismatched tracking path is refused by the coordinator write check (fails closed); only the Claude adapter exists until Epic 3.
  - `[low]` `[reject]` An empty `path_map` fails every graph run, and the graph prompt omits `infrastructure` (blind) — `path_key` with an empty map is a degenerate config no manifest can use; an Infrastructure Story needs the Maintainer's approval in any case.
  - `[low]` `[patch]` Untested planning-step branches, among them `openPr` failing after the forge opened the PR (blind) — grouped with the verification-gap orphan finding: that test is added. The other branches mirror `reconcile`'s tested code.
  - `[false]` `[reject]` `planningKindOf(record) ?? "status"` runs a non-planning record as status (blind) — the process calls the planning step only for `planning:<slug>.<n>` units, whose kind is never `null`.
  - `[low]` `[reject]` Duplication: the version literal `1`, `PlanningHeading` against `PlanningPromptHeading`, and `reconcileBranch` passing through (blind) — no caller diverges today; cosmetic.
  - `[low]` `[reject]` The `pick` test helper spreads `records` three times (blind) — cosmetic; same result.
  - `[medium]` `[patch]` An approval given while a coordinator-written first park's CI still ran is ignored, because `parked_at` treats every coordinator-lane park as a re-park (edge) — `parked_at` now applies only to a coordinator re-park (`passed_sha` set); plan rows added.
  - `[low]` `[reject]` The unit keeper may beat a deleted record after `finish` and abandon the unit (edge) — the window between the delete and the process's `checkHeld` is milliseconds against a 5-minute beat. A beat during the trailing wait comes after the journal record.
  - `[low]` `[reject]` Graph PR with an empty diff parks with an empty path list (edge) — same as the first blind row.
  - `[low]` `[reject]` An empty summary gives a bare title `planning:status.N: ` (edge) — the result schema requires a non-blank summary; only text made entirely of redacted or control characters reaches this.
  - `[low]` `[patch]` The planning step's orphan cleanup after a failed `openPr` is never exercised (verification-gap) — test added: the forge opens the PR, then errors, and the PR is closed behind a fence.
  - `[medium]` `[defer]` `lane run`'s planning-step wiring (`secrets`, sandbox, clone) is checked only for existence (verification-gap) — the builder PR step's `secrets` wiring has the same gap from before this change; the clean fix covers both steps.
  - `[maybe-false]` `[defer]` The AC's "inbox item that carries the findings": the findings are only in the host-local journal (intent) — Story 4.2's inbox renders `parked` records, which have no text field (AR6), as for builder blocked parks. It is settled once the Maintainer says whether findings must reach the ledger or GitHub. Medium if true (unverified).
  - `[false]` `[reject]` Added due rules (a pending graph merge, the Epic-level holds, no `manifests`, other slugs) go beyond the ACs (intent) — each is a reading of "naming what is due" and "wait only on its Epic context file", and each is tested; none contradicts an AC.
  - `[medium]` `[defer]` The attempts cap versus fresh ids (intent) — grouped with the blind "never reach the attempts cap" row.
  - `[false]` `[reject]` A graph PR parks whatever the policy (intent) — AD-13 makes a graph unit approval-gated; stricter than the 0.x every-path wording, not a gap.
  - `[false]` `[reject]` No test runs a real agent, `bmad-sprint-planning` or GitHub (intent) — live cases need `XARABOT_LIVE=1`. The stock headless mode was checked: a `FAIL` gate or a `blocked` halt maps to the prompt's `blocked`, and the prompt forbids the findings file.
  - `[false]` `[reject]` The Epic context file edit and the docs paragraph sit outside the Story's runner surface (intent) — the context file is this run's workflow output and is reverted by the write check on squash; the docs paragraph matches earlier Stories' practice.
  - `[false]` `[reject]` Advancing `runner_version` is only documented (intent) — the 2026-10-25 decision makes it the Maintainer's step right after the merge.

## Design Notes

- **Failed attempts make a fresh run.** A failed planning session releases its record (`attempts` + 1). The next run is `n` + 1, and `reconcile` deletes the superseded `released` record. That follows the 2026-10-25 id rule and the `release` AC. So the attempts cap trips only on one record (stale takeovers, or failures after the PR opened). A session that keeps failing re-runs after each failed wait (15 min). The Maintainer can tighten this later.
- **Ungated vs gated status PRs** are told apart by `approved_sha`: only `takeApproved` sets it.
- **The step runs outside `kit.run` until its session ends,** so `MarkerStop` and `Abandon` reach the process. Its `checkHeld` ends the step (`End`, `failed`) once `input.signal` aborts; the process's own `checkHeld(t)` then abandons the unit.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (live cases skipped)
- `bun --bun tsc` -- expected: no error
- `bun --bun oxlint` -- expected: no warning or error

## Auto Run Result

Status: done

**Summary.** The coordinator now runs planning units.
- `next` has a planning position: a graph unit before a status unit, a per-kind hold, the takeover of a stale claim, and an overlap check.
- A new `planning` step runs one sandboxed session through the shared runner. A status unit runs `bmad-sprint-planning` headless and compiles the due Epic contexts; a graph unit writes the missing manifests.
- The step then commits behind the coordinator write check, pushes with a `branchHead` lease, opens the PR and polls CI with no fix session.
  - A graph PR always parks for approval. A status PR parks only when policy gates it; otherwise it enqueues itself and is disposable.
  - A `blocked` result parks `readiness`.
- `reconcile` handles disposable status PRs and deletes `released` planning records whose PR is not open.
- The ledger `schema_version` is now 2, and the reader accepts 1 and 2.

**Files changed.**
- `src/core/schemas/ledger.ts`: `LEDGER_SCHEMA_VERSION` 2, both record schemas accept 1 or 2, the `readiness` cause, and the planning slug and kind helpers.
- `src/core/ledger/codec.ts`: the version stop accepts 1 and 2.
- `src/core/ledger/edits.ts`: every write stamps 2; `isDisposable`, `releaseDisposable` and `deleteReleasedRecurring`.
- `src/core/schemas/common.ts`: a doc comment saying `SCHEMA_VERSION` 1 is for non-ledger files.
- `src/core/next/epic-gates.ts` (new): the Epic holds the builder and planning share.
- `src/core/next/next.ts`: uses `epicHolds`; adds the `planning-held` code.
- `src/core/next/coordinator.ts`: `planningDue`, `nextPlanning`, `nextPlanningNumber` and `unitBranch`. Graph planning is due only when `manifests` is configured.
- `src/core/reconcile/plan.ts`: the disposable queue check, deleting `released` planning records, and `parked_at` only for a coordinator re-park (`passed_sha` set).
- `src/lane/reconcile-step.ts`: the renamed edits, and `unitBranch` in `closeBranchPrs`.
- `src/core/prompt/template.ts`, `src/core/prompt/build-prompt.ts`: the planning template parts and `buildPlanningPrompt`.
- `src/lane/planning-step.ts` (new): `createPlanningStep`.
- `src/lane/coordinator-process.ts`: passes `track` to steps and rethrows a step's `Halt`.
- `src/cli/lane-run.ts`: wires the planning step.
- `docs/maintainer/self-host.md`: the planning units, the readiness workflow and the v2 rollout.
- Tests:
  - new: `test/lane/planning-step.test.ts`;
  - case-table rows in `test/core/next/coordinator.test.ts`;
  - reconcile plan and step rows, prompt tests and schema v1/v2/v3 rows;
  - "unknown version" fixtures moved from 2 to 3.

**Review findings.** One pass with 27 findings:
- Patched:
  - medium: an approval during CI was ignored for a coordinator first park;
  - low: `dispose` when `closePr` fails, the capped readiness findings, the `self-host.md` paragraph, the v2 rollback note, and the orphan-PR test after a failed `openPr`.
- Deferred (frontmatter `deferred`): the attempts cap across runs, stale gated status PRs, the `lane run` secrets wiring test, and findings visible outside the journal.
- Rejected, each with its reason in the Review Triage Log:
  - low: the empty graph diff (two findings), the status prompt path, the empty `path_map`, duplication, the test helper, the keeper beat after a delete, and an empty summary;
  - false: the Epic context rewrite, the `planningKindOf` fallback, the added due rules, the graph park, no live run, edits outside the runner, and the `runner_version` doc.

**Follow-up review recommended:** false. Patched: 1 medium, 6 low, 0 high.

**Verification.**
- `bun test`: 3572 pass, 277 skip (live cases), 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Every row of the edge-case table is covered by a test that ran.

**Residual risks.**
- **Live behavior is untested.** Every new test runs a stub agent on the fake forge, so the real `bmad-sprint-planning` headless run, `compile-epic-context.md`, and the graph manifest sessions run for the first time live.
- **Repeated failures.** A planning session that keeps failing re-runs every 15 min with no cap (deferred). An enqueue that keeps conflicting while `closePr` keeps failing counts attempts but never parks, because `failAttempt` from `merging` always releases.
- **Rollout.** Every lane must advance `runner_version` together right after the merge: a runner without 2.7 stops on a v2 record.
- **Prompt path.** The status prompt names `.claude/skills/bmad-build-auto/compile-epic-context.md`, so it suits only the Claude adapter.
